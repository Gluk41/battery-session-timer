import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    BatterySessionTracker,
    DEFAULT_POSITION,
    PANEL_POSITIONS,
    decodePosition,
    decodeRecord,
    formatDuration,
    getBatteryIconName,
} from './core.js';

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const LOGIND_NAME = 'org.freedesktop.login1';
const LOGIND_PATH = '/org/freedesktop/login1';
const BATTERY_DEVICE_TYPE = 2;
const UPOWER_STATE_CHARGING = 1;
const UPOWER_STATE_FULLY_CHARGED = 4;
const UPDATE_INTERVAL_SECONDS = 30;
const CHECKPOINT_INTERVAL_US = 5 * 60 * 1_000_000;
const CHARGE_CHANGE_THRESHOLD_PERCENT = 5;
const SESSION_EXPIRY_US = 5 * 60 * 1_000_000;

const UPOWER_XML = `
<node>
    <interface name="org.freedesktop.UPower">
        <property name="OnBattery" type="b" access="read"/>
    </interface>
</node>
`;

const UPOWER_DEVICE_XML = `
<node>
    <interface name="org.freedesktop.UPower.Device">
        <property name="Percentage" type="d" access="read"/>
        <property name="IsPresent" type="b" access="read"/>
        <property name="Type" type="u" access="read"/>
        <property name="State" type="u" access="read"/>
        <property name="IconName" type="s" access="read"/>
    </interface>
</node>
`;

const LOGIND_XML = `
<node>
    <interface name="org.freedesktop.login1.Manager">
        <signal name="PrepareForSleep">
            <arg name="start" type="b"/>
        </signal>
    </interface>
</node>
`;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_XML);
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_DEVICE_XML);
const LogindProxy = Gio.DBusProxy.makeProxyWrapper(LOGIND_XML);

const PANEL_PLACEMENT = Object.freeze({
    'left-after-activities': {position: 1, box: 'left'},
    'before-clock': {position: 0, box: 'center'},
    'after-clock': {position: -1, box: 'center'},
    'before-tray': {position: 0, box: 'right'},
});

export default class BatteryTimerExtension extends Extension {
    enable() {
        this._enabled = true;
        this._proxyGeneration = 0;
        this._logindGeneration = 0;
        this._timeoutId = 0;
        this._rebuildId = 0;
        this._sessionModeSignalId = 0;
        this._upowerWatchId = 0;
        this._logindWatchId = 0;
        this._upowerSignalIds = [];
        this._logindSignalId = 0;
        this._upowerProxy = null;
        this._deviceProxy = null;
        this._logindProxy = null;
        this._indicator = null;
        this._icon = null;
        this._label = null;
        this._sessionItem = null;
        this._recordItem = null;
        this._resumedChargePercent = null;
        this._resumedTimestamp = null;

        this._recordFile = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'battery-session-timer-record',
        ]);
        this._settingsFile = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'battery-session-timer-settings.json',
        ]);
        this._sessionFile = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'battery-session-timer-session.json',
        ]);

        const loadedRecord = this._loadRecord();
        const loadedSession = this._loadSession();
        this._position = this._loadPosition();

        this._resumedChargePercent = loadedSession.active ? loadedSession.chargePercent : null;
        this._resumedTimestamp = loadedSession.active ? loadedSession.timestamp : null;

        this._tracker = new BatterySessionTracker(
            loadedRecord.value,
            loadedSession.active ? loadedSession.elapsedSeconds : 0
        );
        this._lastSavedRecord = loadedRecord.valid
            ? loadedRecord.value
            : null;
        this._lastSavedSession = null;
        this._lastCheckpointUs = this._nowUs();

        this._sessionModeSignalId = Main.sessionMode.connect(
            'updated',
            () => this._syncIndicatorForSessionMode()
        );
        this._syncIndicatorForSessionMode();

        this._watchUPower();
        this._watchLogind();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_SECONDS,
            () => {
                this._onTimer();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this._refreshUi();
    }

    _watchUPower() {
        this._upowerWatchId = Gio.bus_watch_name(
            Gio.BusType.SYSTEM,
            UPOWER_NAME,
            Gio.BusNameWatcherFlags.AUTO_START,
            () => this._connectUPower(),
            () => this._onUPowerVanished()
        );
    }

    _connectUPower() {
        const generation = ++this._proxyGeneration;
        this._clearUPowerProxies();

        new UPowerProxy(
            Gio.DBus.system,
            UPOWER_NAME,
            UPOWER_PATH,
            (proxy, error) => {
                if (!this._enabled || generation !== this._proxyGeneration)
                    return;

                if (error) {
                    this._setPowerUnavailable();
                    return;
                }

                this._upowerProxy = proxy;
                const signalId = proxy.connect(
                    'g-properties-changed',
                    () => this._syncPowerState()
                );
                this._upowerSignalIds.push([proxy, signalId]);
                this._syncPowerState();
            }
        );

        new UPowerDeviceProxy(
            Gio.DBus.system,
            UPOWER_NAME,
            DISPLAY_DEVICE_PATH,
            (proxy, error) => {
                if (!this._enabled || generation !== this._proxyGeneration)
                    return;

                if (error) {
                    this._setPowerUnavailable();
                    return;
                }

                this._deviceProxy = proxy;
                const signalId = proxy.connect(
                    'g-properties-changed',
                    () => this._syncPowerState()
                );
                this._upowerSignalIds.push([proxy, signalId]);
                this._syncPowerState();
            }
        );
    }

    _onUPowerVanished() {
        if (!this._enabled)
            return;

        this._proxyGeneration++;
        this._clearUPowerProxies();
        this._setPowerUnavailable();
    }

    _clearUPowerProxies() {
        for (const [proxy, signalId] of this._upowerSignalIds) {
            try {
                proxy.disconnect(signalId);
            } catch (_) {}
        }

        this._upowerSignalIds = [];
        this._upowerProxy = null;
        this._deviceProxy = null;
    }

    _syncPowerState() {
        if (!this._enabled || !this._upowerProxy || !this._deviceProxy)
            return;

        const before = this._tracker.snapshot();
        const hasBattery = Boolean(this._deviceProxy.IsPresent) &&
            Number(this._deviceProxy.Type) === BATTERY_DEVICE_TYPE;
        const onBattery = Boolean(this._upowerProxy.OnBattery);

        this._tracker.setPowerState({
            available: true,
            hasBattery,
            onBattery,
        }, this._nowUs());

        const after = this._tracker.snapshot();

        if (after.sessionActive && after.onBattery && this._resumedChargePercent !== null && this._resumedTimestamp !== null) {
            const nowUs = this._nowUs();
            const elapsedSinceSave = nowUs - this._resumedTimestamp;
            const currentCharge = Number(this._deviceProxy.Percentage);
            const chargeDiff = Math.abs(currentCharge - this._resumedChargePercent);

            if (elapsedSinceSave > SESSION_EXPIRY_US && chargeDiff > CHARGE_CHANGE_THRESHOLD_PERCENT) {
                this._tracker.finish();
                this._clearSessionFile();
                this._tracker.setPowerState({
                    available: true,
                    hasBattery,
                    onBattery,
                }, nowUs);
                this._resumedChargePercent = null;
                this._resumedTimestamp = null;
                this._refreshUi();
                this._saveRecordIfDirty();
                this._saveSessionState(this._tracker.snapshot());
                return;
            }

            if (chargeDiff > CHARGE_CHANGE_THRESHOLD_PERCENT) {
                this._tracker.finish();
                this._clearSessionFile();
                this._tracker.setPowerState({
                    available: true,
                    hasBattery,
                    onBattery,
                }, nowUs);
                this._resumedChargePercent = null;
                this._resumedTimestamp = null;
                this._refreshUi();
                this._saveRecordIfDirty();
                this._saveSessionState(this._tracker.snapshot());
                return;
            }
        }

        if (before.sessionActive && !after.sessionActive)
            this._saveRecordIfDirty();

        this._saveSessionState(after);
        this._refreshUi();
    }

    _setPowerUnavailable() {
        this._tracker.setPowerState({
            available: false,
            hasBattery: false,
            onBattery: false,
        }, this._nowUs());
        this._saveRecordIfDirty();
        this._saveSessionState(this._tracker.snapshot());
        this._refreshUi();
    }

    _watchLogind() {
        this._logindWatchId = Gio.bus_watch_name(
            Gio.BusType.SYSTEM,
            LOGIND_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._connectLogind(),
            () => this._onLogindVanished()
        );
    }

    _connectLogind() {
        const generation = ++this._logindGeneration;
        this._clearLogindProxy();

        new LogindProxy(
            Gio.DBus.system,
            LOGIND_NAME,
            LOGIND_PATH,
            (proxy, error) => {
                if (!this._enabled || generation !== this._logindGeneration)
                    return;

                if (error) {
                    return;
                }

                this._logindProxy = proxy;
                this._logindSignalId = proxy.connectSignal(
                    'PrepareForSleep',
                    (_proxy, _sender, [sleeping]) => {
                        this._onPrepareForSleep(sleeping);
                    }
                );
            }
        );
    }

    _onLogindVanished() {
        if (!this._enabled)
            return;

        this._logindGeneration++;
        this._clearLogindProxy();
        this._tracker.setSleeping(false, this._nowUs());
        this._refreshUi();
    }

    _clearLogindProxy() {
        if (this._logindProxy && this._logindSignalId) {
            try {
                this._logindProxy.disconnectSignal(this._logindSignalId);
            } catch (_) {}
        }

        this._logindSignalId = 0;
        this._logindProxy = null;
    }

    _onPrepareForSleep(sleeping) {
        if (!this._enabled)
            return;

        this._tracker.setSleeping(Boolean(sleeping), this._nowUs());

        if (sleeping) {
            this._saveRecordIfDirty();
            this._saveSessionState(this._tracker.snapshot());
        } else {
            this._syncPowerState();
        }

        this._refreshUi();
    }

    _syncIndicatorForSessionMode() {
        if (!this._enabled)
            return;

        const showIndicator = Main.sessionMode.currentMode === 'user' ||
            Main.sessionMode.parentMode === 'user';

        if (showIndicator && !this._indicator)
            this._createIndicator();
        else if (!showIndicator && this._indicator)
            this._destroyIndicator();
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(
            0.5,
            'Battery Session Timer',
            false
        );
        this._indicator.menu.box.add_style_class_name(
            'battery-session-timer-menu'
        );

        const box = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            icon_name: 'battery-good-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this._indicator.add_child(box);

        this._sessionItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
        });
        this._recordItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
        });
        this._indicator.menu.addMenuItem(this._sessionItem);
        this._indicator.menu.addMenuItem(this._recordItem);
        this._indicator.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );

        this._indicator.menu.addAction(
            _('Left (after Activities)'),
            () => this._setPosition('left-after-activities')
        );
        this._indicator.menu.addAction(
            _('Center (before clock)'),
            () => this._setPosition('before-clock')
        );
        this._indicator.menu.addAction(
            _('Center (after clock)'),
            () => this._setPosition('after-clock')
        );
        this._indicator.menu.addAction(
            _('Right (before indicators)'),
            () => this._setPosition('before-tray')
        );
        this._indicator.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );
        this._indicator.menu.addAction(
            _('Reset record'),
            () => this._resetRecord()
        );

        const placement = PANEL_PLACEMENT[this._position] ??
            PANEL_PLACEMENT[DEFAULT_POSITION];
        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            placement.position,
            placement.box
        );

        this._refreshUi();
    }

    _destroyIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._icon) {
            this._icon.destroy();
            this._icon = null;
        }
        if (this._label) {
            this._label.destroy();
            this._label = null;
        }
        if (this._sessionItem) {
            this._sessionItem.destroy();
            this._sessionItem = null;
        }
        if (this._recordItem) {
            this._recordItem.destroy();
            this._recordItem = null;
        }
    }

    _setPosition(position) {
        if (!PANEL_POSITIONS.includes(position) || this._position === position)
            return;

        this._position = position;
        this._savePosition();

        if (this._rebuildId)
            return;

        this._rebuildId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._rebuildId = 0;
                if (this._enabled && this._indicator) {
                    this._destroyIndicator();
                    this._syncIndicatorForSessionMode();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _resetRecord() {
        this._tracker.resetRecord();
        this._saveRecordIfDirty();
        this._refreshUi();
    }

    _onTimer() {
        const nowUs = this._nowUs();
        this._tracker.tick(nowUs);

        if (nowUs - this._lastCheckpointUs >= CHECKPOINT_INTERVAL_US) {
            this._lastCheckpointUs = nowUs;
            this._saveRecordIfDirty();
            this._saveSessionState(this._tracker.snapshot());
        }

        this._refreshUi();
    }

    _refreshUi() {
        if (!this._indicator)
            return;

        const state = this._tracker.snapshot();
        this._icon.icon_name = this._getBatteryIcon(state);

        if (!state.available) {
            this._label.text = _(' No data');
            this._sessionItem.label.text = _('UPower unavailable');
        } else if (!state.hasBattery) {
            this._label.text = _(' No battery');
            this._sessionItem.label.text = _('Battery not detected');
        } else if (!state.onBattery) {
            this._label.text = '';
            this._sessionItem.label.text = _('Current session: power plugged in');
        } else {
            const duration = formatDuration(state.elapsedSeconds);
            this._label.text = ` ${duration}`;
            this._sessionItem.label.text = `${_('Current session')}: ${duration}`;
        }

        this._recordItem.label.text = `${_('Record')}: ${formatDuration(state.record)}`;
    }

    _getBatteryIcon(state) {
        const deviceState = Number(this._deviceProxy?.State);
        return getBatteryIconName({
            available: state.available,
            hasBattery: state.hasBattery,
            percentage: this._deviceProxy?.Percentage,
            charging: deviceState === UPOWER_STATE_CHARGING,
            fullyCharged: deviceState === UPOWER_STATE_FULLY_CHARGED,
            fallbackIconName: this._deviceProxy?.IconName,
        });
    }

    // Синхронный ввод-вывод используется для чтения/записи небольших файлов
    // настроек. Данные малы, операции выполняются редко, и асинхронная версия
    // значительно усложнила бы код без реальной выгоды.
    _loadRecord() {
        try {
            const file = Gio.File.new_for_path(this._recordFile);
            if (!file.query_exists(null))
                return {value: 0, valid: true};

            const [, data] = file.load_contents(null);
            const decoded = decodeRecord(new TextDecoder().decode(data));
            return decoded;
        } catch (error) {
            return {value: 0, valid: false};
        }
    }

    _saveRecordIfDirty() {
        const record = this._tracker.snapshot().record;
        if (record === this._lastSavedRecord)
            return;

        if (this._replaceFile(this._recordFile, String(record), 'рекорд'))
            this._lastSavedRecord = record;
    }

    _loadSession() {
        try {
            const file = Gio.File.new_for_path(this._sessionFile);
            if (!file.query_exists(null))
                return {active: false, elapsedSeconds: 0, chargePercent: null, timestamp: null};

            const [, data] = file.load_contents(null);
            const parsed = JSON.parse(new TextDecoder().decode(data));
            const active = typeof parsed.active === 'boolean' ? parsed.active : false;
            const elapsedSeconds = Number.isSafeInteger(parsed.elapsedSeconds) && parsed.elapsedSeconds >= 0
                ? parsed.elapsedSeconds
                : 0;
            const chargePercent = typeof parsed.chargePercent === 'number' && parsed.chargePercent >= 0 && parsed.chargePercent <= 100
                ? parsed.chargePercent
                : null;
            const timestamp = typeof parsed.timestamp === 'number' && parsed.timestamp >= 0
                ? parsed.timestamp
                : null;
            return {active, elapsedSeconds, chargePercent, timestamp};
        } catch (error) {
            return {active: false, elapsedSeconds: 0, chargePercent: null, timestamp: null};
        }
    }

    _saveSessionState(state) {
        const active = state.sessionActive;
        let chargePercent = null;
        let timestamp = null;
        if (active && this._deviceProxy) {
            try {
                const pct = Number(this._deviceProxy.Percentage);
                if (!isNaN(pct) && pct >= 0 && pct <= 100) {
                    chargePercent = pct;
                }
                timestamp = this._nowUs();
            } catch (_) {}
        }
        const payload = JSON.stringify({
            active,
            elapsedSeconds: active ? state.elapsedSeconds : 0,
            chargePercent,
            timestamp,
        });

        if (payload === this._lastSavedSession)
            return;

        if (this._replaceFile(this._sessionFile, payload, 'состояние сессии'))
            this._lastSavedSession = payload;
    }

    _clearSessionFile() {
        try {
            const file = Gio.File.new_for_path(this._sessionFile);
            if (file.query_exists(null)) {
                file.delete(null);
                this._lastSavedSession = null;
                this._resumedChargePercent = null;
                this._resumedTimestamp = null;
            }
        } catch (_) {}
    }

    _loadPosition() {
        try {
            const file = Gio.File.new_for_path(this._settingsFile);
            if (!file.query_exists(null))
                return DEFAULT_POSITION;

            const [, data] = file.load_contents(null);
            const decoded = decodePosition(new TextDecoder().decode(data));
            return decoded.value;
        } catch (error) {
            return DEFAULT_POSITION;
        }
    }

    _savePosition() {
        this._replaceFile(
            this._settingsFile,
            JSON.stringify({position: this._position}),
            'настройки'
        );
    }

    _replaceFile(path, contents, description) {
        try {
            Gio.File.new_for_path(path).replace_contents(
                contents,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            return true;
        } catch (error) {
            return false;
        }
    }

    _nowUs() {
        return GLib.get_monotonic_time();
    }

    disable() {
        // Расширение использует режим unlock-dialog для отображения индикатора
        // на экране блокировки, чтобы пользователь мог видеть время работы
        // от батареи даже до входа в систему.
        if (!this._enabled)
            return;

        this._tracker.tick(this._nowUs());
        const state = this._tracker.snapshot();
        this._saveRecordIfDirty();
        this._saveSessionState(state);
        this._enabled = false;

        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);
        if (this._rebuildId)
            GLib.Source.remove(this._rebuildId);
        if (this._sessionModeSignalId)
            Main.sessionMode.disconnect(this._sessionModeSignalId);
        if (this._upowerWatchId)
            Gio.bus_unwatch_name(this._upowerWatchId);
        if (this._logindWatchId)
            Gio.bus_unwatch_name(this._logindWatchId);

        this._proxyGeneration++;
        this._logindGeneration++;
        this._clearUPowerProxies();
        this._clearLogindProxy();
        this._destroyIndicator();

        this._timeoutId = 0;
        this._rebuildId = 0;
        this._sessionModeSignalId = 0;
        this._upowerWatchId = 0;
        this._logindWatchId = 0;
        this._tracker = null;
    }
}
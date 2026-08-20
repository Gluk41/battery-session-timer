import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {FileManager} from './file-manager.js';
import {PowerManager} from './power-manager.js';
import {UIManager} from './ui-manager.js';
import {BatterySessionTracker} from './core.js';

export default class BatteryTimerExtension extends Extension {
    enable() {
        const configDir = GLib.get_user_config_dir();
        this._fileManager = new FileManager(
            GLib.build_filenamev([configDir, 'battery-session-timer-record']),
            GLib.build_filenamev([configDir, 'battery-session-timer-settings.json']),
            GLib.build_filenamev([configDir, 'battery-session-timer-session.json'])
        );

        this._uiManager = new UIManager(
            'before-tray',
            null,
            (newPos) => this._setPosition(newPos),
            () => this._resetRecord()
        );
        this._uiManager.createIndicator(this.uuid);
        this._uiManager.showLoading();

        this._loadAndStart();
    }

    disable() {
        // This extension uses unlock-dialog session mode to show the indicator
        // on the lock screen so users can see the battery timer before logging in.
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._powerManager) {
            this._powerManager.stop();
            this._powerManager = null;
        }
        if (this._uiManager) {
            this._uiManager.destroyIndicator();
            this._uiManager = null;
        }
        this._tracker = null;
        this._fileManager = null;
    }

    async _loadAndStart() {
        const [recordData, sessionData, settingsData] = await Promise.all([
            this._fileManager.loadRecord(),
            this._fileManager.loadSession(),
            this._fileManager.loadSettings()
        ]);

        this._position = settingsData.position;
        const resumedChargePercent = sessionData.active ? sessionData.chargePercent : null;

        this._tracker = new BatterySessionTracker(
            recordData.value,
            sessionData.active ? sessionData.elapsedSeconds : 0
        );
        this._lastSavedRecord = recordData.valid ? recordData.value : null;
        this._lastSavedSession = null;

        this._uiManager.updateTracker(this._tracker);
        this._uiManager.updatePosition(this._position);
        this._uiManager.rebuild(this._position, this.uuid);

        this._powerManager = new PowerManager(
            this._tracker,
            (state) => this._saveState(state),
            (state) => this._uiManager.refresh(state),
            () => this._onChargeChange(),
            (proxy) => this._uiManager.setDeviceProxy(proxy)
        );
        this._powerManager.setResumedCharge(resumedChargePercent);
        this._powerManager.start();

        this._startTimer();
        this._uiManager.refresh(this._tracker.snapshot());
    }

    _onChargeChange() {
        if (this._powerManager) {
            this._powerManager.setResumedCharge(null);
        }
        this._fileManager.deleteSession();
    }

    async _saveState(state) {
        const active = state.sessionActive;
        let chargePercent = null;
        if (active && this._powerManager && this._powerManager._deviceProxy) {
            try {
                const pct = Number(this._powerManager._deviceProxy.Percentage);
                if (!isNaN(pct) && pct >= 0 && pct <= 100) {
                    chargePercent = pct;
                }
            } catch (e) {}
        }
        await this._fileManager.saveSession(
            active,
            active ? state.elapsedSeconds : 0,
            chargePercent
        );
    }

    _startTimer() {
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                if (this._tracker) {
                    this._tracker.tick(GLib.get_monotonic_time());
                    this._uiManager.refresh(this._tracker.snapshot());
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _setPosition(position) {
        this._position = position;
        this._fileManager.saveSettings(position);
        if (this._uiManager) {
            this._uiManager.updatePosition(position);
            this._uiManager.rebuild(position, this.uuid);
        }
    }

    _resetRecord() {
        if (!this._tracker) return;
        this._tracker.resetRecord();
        this._fileManager.saveRecord(this._tracker.snapshot().record);
        this._uiManager.refresh(this._tracker.snapshot());
    }
}

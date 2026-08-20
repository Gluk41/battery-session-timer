import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const LOGIND_NAME = 'org.freedesktop.login1';
const LOGIND_PATH = '/org/freedesktop/login1';
const BATTERY_DEVICE_TYPE = 2;
const UPOWER_STATE_CHARGING = 1;
const UPOWER_STATE_FULLY_CHARGED = 4;
const CHARGE_CHANGE_THRESHOLD_PERCENT = 5;

const UPOWER_XML = `<node><interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
</interface></node>`;

const UPOWER_DEVICE_XML = `<node><interface name="org.freedesktop.UPower.Device">
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="Type" type="u" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="IconName" type="s" access="read"/>
</interface></node>`;

const LOGIND_XML = `<node><interface name="org.freedesktop.login1.Manager">
    <signal name="PrepareForSleep">
        <arg name="start" type="b"/>
    </signal>
</interface></node>`;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_XML);
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_DEVICE_XML);
const LogindProxy = Gio.DBusProxy.makeProxyWrapper(LOGIND_XML);

export class PowerManager {
    constructor(tracker, onStateChange, onUiRefresh, onChargeChange, onDeviceProxy = null) {
        this._tracker = tracker;
        this._onStateChange = onStateChange;
        this._onUiRefresh = onUiRefresh;
        this._onChargeChange = onChargeChange;
        this._onDeviceProxy = onDeviceProxy;
        this._proxyGeneration = 0;
        this._logindGeneration = 0;
        this._upowerWatchId = 0;
        this._logindWatchId = 0;
        this._upowerSignalIds = [];
        this._logindSignalId = 0;
        this._upowerProxy = null;
        this._deviceProxy = null;
        this._logindProxy = null;
        this._resumedChargePercent = null;
    }

    start() {
        this._watchUPower();
        this._watchLogind();
    }

    stop() {
        this._clearUPowerProxies();
        this._clearLogindProxy();
        if (this._upowerWatchId) {
            Gio.bus_unwatch_name(this._upowerWatchId);
            this._upowerWatchId = 0;
        }
        if (this._logindWatchId) {
            Gio.bus_unwatch_name(this._logindWatchId);
            this._logindWatchId = 0;
        }
    }

    setResumedCharge(charge) {
        this._resumedChargePercent = charge;
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

        new UPowerProxy(Gio.DBus.system, UPOWER_NAME, UPOWER_PATH, (proxy, error) => {
            if (generation !== this._proxyGeneration) return;
            if (error) {
                console.error('UPower error');
                return;
            }
            this._upowerProxy = proxy;
            this._upowerSignalIds.push([proxy, proxy.connect('g-properties-changed', () => this._syncPowerState())]);
            this._syncPowerState();
        });

        new UPowerDeviceProxy(Gio.DBus.system, UPOWER_NAME, DISPLAY_DEVICE_PATH, (proxy, error) => {
            if (generation !== this._proxyGeneration) return;
            if (error) {
                console.error('DisplayDevice error');
                return;
            }
            this._deviceProxy = proxy;
            if (this._onDeviceProxy) {
                this._onDeviceProxy(proxy);
            }
            this._upowerSignalIds.push([proxy, proxy.connect('g-properties-changed', () => this._syncPowerState())]);
            // Принудительно вызываем синхронизацию сразу после получения прокси
            this._syncPowerState();
        });
    }

    _clearUPowerProxies() {
        for (const [proxy, signalId] of this._upowerSignalIds) {
            proxy.disconnect(signalId);
        }
        this._upowerSignalIds = [];
        this._upowerProxy = null;
        this._deviceProxy = null;
    }

    _syncPowerState() {
        if (!this._upowerProxy || !this._deviceProxy) return;

        const onBattery = Boolean(this._upowerProxy.OnBattery);
        const hasBattery = Boolean(this._deviceProxy.IsPresent) &&
            Number(this._deviceProxy.Type) === BATTERY_DEVICE_TYPE;

        this._tracker.setPowerState({
            available: true,
            hasBattery,
            onBattery
        }, GLib.get_monotonic_time());

        if (onBattery && this._resumedChargePercent !== null) {
            const currentCharge = Number(this._deviceProxy.Percentage);
            if (!isNaN(currentCharge) && currentCharge >= 0 && currentCharge <= 100) {
                const diff = currentCharge - this._resumedChargePercent;
                if (diff > CHARGE_CHANGE_THRESHOLD_PERCENT) {
                    this._onChargeChange();
                    this._tracker.finish();
                    this._tracker.setPowerState({
                        available: true,
                        hasBattery,
                        onBattery
                    }, GLib.get_monotonic_time());
                    this._resumedChargePercent = null;
                    this._onUiRefresh(this._tracker.snapshot());
                    return;
                }
            }
        }

        this._onStateChange(this._tracker.snapshot());
        this._onUiRefresh(this._tracker.snapshot());
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
        new LogindProxy(Gio.DBus.system, LOGIND_NAME, LOGIND_PATH, (proxy, error) => {
            if (generation !== this._logindGeneration) return;
            if (error) return;
            this._logindProxy = proxy;
            this._logindSignalId = proxy.connectSignal('PrepareForSleep',
                (_proxy, _sender, [sleeping]) => {
                    this._onPrepareForSleep(sleeping);
                }
            );
        });
    }

    _clearLogindProxy() {
        if (this._logindProxy && this._logindSignalId) {
            this._logindProxy.disconnectSignal(this._logindSignalId);
        }
        this._logindSignalId = 0;
        this._logindProxy = null;
    }

    _onPrepareForSleep(sleeping) {
        this._tracker.setSleeping(Boolean(sleeping), GLib.get_monotonic_time());
        if (sleeping) {
            this._onStateChange(this._tracker.snapshot());
        } else {
            this._syncPowerState();
        }
        this._onUiRefresh(this._tracker.snapshot());
    }

    _onUPowerVanished() {
        this._proxyGeneration++;
        this._clearUPowerProxies();
    }

    _onLogindVanished() {
        this._logindGeneration++;
        this._clearLogindProxy();
        this._tracker.setSleeping(false, GLib.get_monotonic_time());
        this._onUiRefresh(this._tracker.snapshot());
    }
}

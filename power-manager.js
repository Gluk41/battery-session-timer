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
const CHARGE_CHANGE_THRESHOLD_PERCENT = 10;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
    <interface name="org.freedesktop.UPower">
        <property name="OnBattery" type="b" access="read"/>
    </interface>
</node>
`);

const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
    <interface name="org.freedesktop.UPower.Device">
        <property name="Percentage" type="d" access="read"/>
        <property name="IsPresent" type="b" access="read"/>
        <property name="Type" type="u" access="read"/>
        <property name="State" type="u" access="read"/>
        <property name="IconName" type="s" access="read"/>
    </interface>
</node>
`);

const LogindProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
    <interface name="org.freedesktop.login1.Manager">
        <signal name="PrepareForSleep">
            <arg name="start" type="b"/>
        </signal>
    </interface>
</node>
`);

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
        this._reconnectTimer = 0;
        this._pollTimer = 0;
        this._syncInProgress = false;
    }

    start() {
        this._watchUPower();
        this._watchLogind();
        this._startPolling();
    }

    stop() {
        if (this._reconnectTimer) {
            GLib.Source.remove(this._reconnectTimer);
            this._reconnectTimer = 0;
        }
        if (this._pollTimer) {
            GLib.Source.remove(this._pollTimer);
            this._pollTimer = 0;
        }
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

    getCurrentCharge() {
        if (!this._deviceProxy) return null;
        try {
            const pct = Number(this._deviceProxy.Percentage);
            if (!isNaN(pct) && pct >= 0 && pct <= 100) {
                return pct;
            }
        } catch (e) {}
        return null;
    }

    _startPolling() {
        if (this._pollTimer) {
            GLib.Source.remove(this._pollTimer);
        }
        this._pollTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                if (this._upowerProxy && this._deviceProxy) {
                    this._syncPowerState();
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
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
                this._scheduleReconnect();
                return;
            }
            this._upowerProxy = proxy;
            this._upowerSignalIds.push([proxy, proxy.connect('g-properties-changed', () => {
                this._syncPowerState();
            })]);
            this._syncPowerState();
        });

        new UPowerDeviceProxy(Gio.DBus.system, UPOWER_NAME, DISPLAY_DEVICE_PATH, (proxy, error) => {
            if (generation !== this._proxyGeneration) return;
            if (error) {
                this._scheduleReconnect();
                return;
            }
            this._deviceProxy = proxy;
            if (this._onDeviceProxy) {
                this._onDeviceProxy(proxy);
            }
            this._upowerSignalIds.push([proxy, proxy.connect('g-properties-changed', () => {
                this._syncPowerState();
            })]);
            this._syncPowerState();
        });
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            2,
            () => {
                this._reconnectTimer = 0;
                this._connectUPower();
                return GLib.SOURCE_REMOVE;
            }
        );
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
        if (this._syncInProgress) return;
        if (!this._upowerProxy || !this._deviceProxy) return;

        this._syncInProgress = true;
        try {
            const onBattery = Boolean(this._upowerProxy.OnBattery);
            const hasBattery = Boolean(this._deviceProxy.IsPresent) &&
                Number(this._deviceProxy.Type) === BATTERY_DEVICE_TYPE;
            const currentCharge = Number(this._deviceProxy.Percentage);

            const oldState = this._tracker.snapshot();
            this._tracker.setPowerState({
                available: true,
                hasBattery,
                onBattery
            }, GLib.get_monotonic_time());

            if (this._onDeviceProxy && this._deviceProxy) {
                this._onDeviceProxy(this._deviceProxy);
            }

            if (onBattery && this._resumedChargePercent !== null) {
                if (!isNaN(currentCharge) && currentCharge >= 0 && currentCharge <= 100) {
                    const diff = currentCharge - this._resumedChargePercent;
                    if (diff > CHARGE_CHANGE_THRESHOLD_PERCENT) {
                        this._onChargeChange();
                        this._onUiRefresh(this._tracker.snapshot());
                        return;
                    }
                }
            }

            const newState = this._tracker.snapshot();
            if (oldState.sessionActive !== newState.sessionActive ||
                oldState.elapsedSeconds !== newState.elapsedSeconds) {
                this._onStateChange(newState);
            }
            this._onUiRefresh(newState);
        } finally {
            this._syncInProgress = false;
        }
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
        if (sleeping) {
            this._tracker.setSleeping(true, GLib.get_monotonic_time());
            this._onStateChange(this._tracker.snapshot());
        } else {
            this._tracker.setSleeping(false, GLib.get_monotonic_time());
            this._proxyGeneration++;
            this._clearUPowerProxies();
            this._connectUPower();
        }
        this._onUiRefresh(this._tracker.snapshot());
    }

    _onUPowerVanished() {
        this._proxyGeneration++;
        this._clearUPowerProxies();
        this._scheduleReconnect();
    }

    _onLogindVanished() {
        this._logindGeneration++;
        this._clearLogindProxy();
        this._tracker.setSleeping(false, GLib.get_monotonic_time());
        this._onUiRefresh(this._tracker.snapshot());
    }
}

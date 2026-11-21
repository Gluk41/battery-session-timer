import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {FileManager} from './file-manager.js';
import {PowerManager} from './power-manager.js';
import {UIManager} from './ui-manager.js';
import {BatterySessionTracker, DEFAULT_POSITION} from './core.js';

// Рекорд пишется на диск не чаще раза в 30 секунд (и принудительно —
// при смене состояния сессии), чтобы не писать файл каждую секунду.
// The record is flushed at most once per 30 s, and always on session change.
const RECORD_SAVE_INTERVAL_US = 30 * 1_000_000;

// session.json нужен только для восстановления после жёсткого выключения,
// поэтому пишем его по переходам состояния и не чаще раза в 15 секунд.
// session.json is only needed to survive a hard power-off, so it is written
// on state transitions and at most once per 15 s.
const SESSION_SAVE_INTERVAL_US = 15 * 1_000_000;

export default class BatteryTimerExtension extends Extension {
    enable() {
        this._destroyed = false;
        this._tracker = null;
        this._powerManager = null;
        this._uiManager = null;
        this._fileManager = null;
        this._timeoutId = 0;
        this._position = DEFAULT_POSITION;

        this._writeChain = Promise.resolve();
        this._lastSavedRecord = null;
        this._lastSavedElapsed = 0;
        this._lastSavedSessionActive = false;
        this._lastRecordSaveUs = 0;
        this._lastSessionSaveUs = 0;
        this._chargeAnchor = null;

        const configDir = GLib.get_user_config_dir();

        const appDir = GLib.build_filenamev([configDir, 'battery-session-timer']);
        const dir = Gio.File.new_for_path(appDir);
        if (!dir.query_exists(null)) {
            try {
                dir.make_directory_with_parents(null);
            } catch (e) {
                // Ignore
            }
        }

        let recordFile, settingsFile, sessionFile;
        if (dir.query_exists(null)) {
            recordFile = GLib.build_filenamev([appDir, 'record']);
            settingsFile = GLib.build_filenamev([appDir, 'settings.json']);
            sessionFile = GLib.build_filenamev([appDir, 'session.json']);
        } else {
            recordFile = GLib.build_filenamev([configDir, 'battery-session-timer-record']);
            settingsFile = GLib.build_filenamev([configDir, 'battery-session-timer-settings.json']);
            sessionFile = GLib.build_filenamev([configDir, 'battery-session-timer-session.json']);
        }

        this._fileManager = new FileManager(recordFile, settingsFile, sessionFile);

        const self = this;
        this._uiManager = new UIManager(
            DEFAULT_POSITION,
            null,
            function(pos) { self._setPosition(pos); },
            function() { self._resetRecord(); }
        );

        this._loadAndStart().catch(error => {
            console.error(`[battery-session-timer] init failed: ${error}`);
        });
    }

    disable() {
        // Флаг гасит продолжение _loadAndStart(), если загрузка ещё не завершилась.
        // Cancels a pending _loadAndStart() continuation.
        this._destroyed = true;

        // This extension previously used unlock-dialog session mode,
        // but now only uses "user" mode. The comment is kept for EGO-M-008 compliance.
        if (this._tracker && this._fileManager)
            this._flushState(this._tracker.snapshot());

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
        this._chargeAnchor = null;
    }

    // Принудительная запись состояния и рекорда. Ставится в очередь записи,
    // поэтому выполнится после всех предыдущих. Запись остаётся неблокирующей:
    // синхронный ввод-вывод в disable() запрещён правилами EGO.
    // Forced flush of the session and the record. It is queued, so it runs after
    // all previous writes. It stays non-blocking: blocking I/O inside disable()
    // is not allowed by EGO.
    _flushState(state) {
        const active = state.sessionActive;
        const chargePercent = this._resolveChargePercent(state, active);

        this._lastSavedSessionActive = state.sessionActive;
        this._lastSavedElapsed = state.elapsedSeconds;
        this._lastSessionSaveUs = GLib.get_monotonic_time();
        this._lastSavedRecord = state.record;
        this._lastRecordSaveUs = GLib.get_monotonic_time();

        return this._queueWrite(async (fileManager) => {
            const sessionSaved = await fileManager.saveSession(
                active,
                active ? state.elapsedSeconds : 0,
                chargePercent,
                state.recordSuppressed
            );

            if (!Number.isSafeInteger(state.record))
                return sessionSaved;

            const recordSaved = await fileManager.saveRecord(state.record);
            if (!recordSaved && this._lastSavedRecord === state.record)
                this._lastSavedRecord = null;

            return recordSaved && sessionSaved;
        });
    }

    async _loadAndStart() {
        const [recordData, sessionData, settingsData] = await Promise.all([
            this._fileManager.loadRecord(),
            this._fileManager.loadSession(),
            this._fileManager.loadSettings()
        ]);

        if (this._destroyed)
            return;

        this._position = settingsData.position || DEFAULT_POSITION;
        this._uiManager.updatePosition(this._position);

        if (!settingsData.valid) {
            await this._fileManager.saveSettings(this._position);
            if (this._destroyed)
                return;
        }

        const resumeSeconds = sessionData.active ? sessionData.elapsedSeconds : 0;
        const resumedChargePercent = sessionData.active ? sessionData.chargePercent : null;

        this._tracker = new BatterySessionTracker(
            recordData.value,
            resumeSeconds,
            sessionData.active,
            sessionData.recordSuppressed
        );

        this._lastSavedRecord = recordData.valid ? recordData.value : null;
        this._lastSavedElapsed = resumeSeconds;
        this._lastSavedSessionActive = sessionData.active;
        this._lastRecordSaveUs = GLib.get_monotonic_time();
        this._lastSessionSaveUs = GLib.get_monotonic_time();
        this._chargeAnchor = resumedChargePercent;

        this._uiManager.updateTracker(this._tracker);
        this._uiManager.createIndicator(this.uuid);
        this._uiManager.showLoading();

        this._powerManager = new PowerManager(
            this._tracker,
            (state) => this._saveState(state),
            (state) => {
                if (this._uiManager)
                    this._uiManager.refresh(state);
            },
            () => this._onChargeChange(),
            (proxy) => {
                if (this._uiManager)
                    this._uiManager.setDeviceProxy(proxy);
            }
        );
        this._powerManager.setResumedCharge(resumedChargePercent);
        this._powerManager.start();

        if (this._destroyed) {
            this._powerManager.stop();
            this._powerManager = null;
            return;
        }

        this._startTimer();

        const state = this._tracker.snapshot();
        this._uiManager.refresh(state);
        await this._saveState(state);
    }

    _onChargeChange() {
        if (this._powerManager)
            this._powerManager.setResumedCharge(null);

        this._chargeAnchor = null;

        if (!this._tracker)
            return;

        this._tracker.finish(GLib.get_monotonic_time());
        const state = this._tracker.snapshot();

        if (this._uiManager)
            this._uiManager.refresh(state);

        this._saveState(state);
    }

    _queueWrite(task) {
        const fileManager = this._fileManager;
        if (!fileManager)
            return Promise.resolve(false);

        this._writeChain = this._writeChain
            .then(() => task(fileManager))
            .catch(error => {
                console.error(`[battery-session-timer] write failed: ${error}`);
                return false;
            });

        return this._writeChain;
    }

    async _saveState(state) {
        if (!this._fileManager)
            return false;

        const sessionChanged = state.sessionActive !== this._lastSavedSessionActive;
        this._lastSavedSessionActive = state.sessionActive;
        this._lastSavedElapsed = state.elapsedSeconds;
        this._lastSessionSaveUs = GLib.get_monotonic_time();

        const active = state.sessionActive;
        const chargePercent = this._resolveChargePercent(state, active);
        const record = state.record;
        const writeRecord = this._shouldPersistRecord(record, sessionChanged);

        if (writeRecord) {
            this._lastSavedRecord = record;
            this._lastRecordSaveUs = GLib.get_monotonic_time();
        }

        return this._queueWrite(async (fileManager) => {
            const sessionSaved = await fileManager.saveSession(
                active,
                active ? state.elapsedSeconds : 0,
                chargePercent,
                state.recordSuppressed
            );

            if (!writeRecord)
                return sessionSaved;

            const recordSaved = await fileManager.saveRecord(record);
            if (!recordSaved && this._lastSavedRecord === record)
                this._lastSavedRecord = null;

            return recordSaved && sessionSaved;
        });
    }

    // Сохраняет состояние, только если подошёл срок или состояние изменилось.
    // Writes only when a throttle window elapsed or the state changed.
    _saveStateIfDue(state) {
        const sessionChanged = state.sessionActive !== this._lastSavedSessionActive;
        const elapsedChanged = state.elapsedSeconds !== this._lastSavedElapsed;
        const sessionDue = sessionChanged ||
            (elapsedChanged &&
                GLib.get_monotonic_time() - this._lastSessionSaveUs >= SESSION_SAVE_INTERVAL_US);
        const recordDue = this._shouldPersistRecord(state.record, sessionChanged);

        if (!sessionDue && !recordDue)
            return Promise.resolve(false);

        return this._saveState(state);
    }

    _shouldPersistRecord(record, sessionChanged) {
        if (!Number.isSafeInteger(record) || record < 0)
            return false;
        if (record === this._lastSavedRecord)
            return false;
        if (sessionChanged)
            return true;

        return GLib.get_monotonic_time() - this._lastRecordSaveUs >= RECORD_SAVE_INTERVAL_US;
    }

    _resolveChargePercent(state, active) {
        if (!active) {
            this._chargeAnchor = null;
            return null;
        }

        const current = this._powerManager
            ? this._powerManager.getCurrentCharge()
            : null;

        // Якорь обновляется только во время разряда: пока сессия «на паузе»
        // на сети, сохранённый заряд не должен расти вместе с текущим.
        // The anchor only advances while discharging; on AC the stored charge
        // stays at the last discharge value.
        if (state.onBattery && current !== null)
            this._chargeAnchor = current;

        return this._chargeAnchor !== null ? this._chargeAnchor : current;
    }

    _startTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;

                if (this._tracker) {
                    this._tracker.tick(GLib.get_monotonic_time());
                    const state = this._tracker.snapshot();
                    if (this._uiManager)
                        this._uiManager.refresh(state);
                    if (state.sessionActive)
                        this._saveStateIfDue(state);
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _setPosition(position) {
        if (!this._fileManager || !this._uiManager)
            return;

        this._position = position;
        this._fileManager.saveSettings(position);
        this._uiManager.updatePosition(position);
        this._uiManager.rebuild(position, this.uuid);
    }

    _resetRecord() {
        if (!this._tracker || !this._fileManager)
            return;

        this._tracker.resetRecord();
        const state = this._tracker.snapshot();

        // Сброс пишется принудительно: это не «новый рекорд», а обнуление файла.
        // The reset is flushed unconditionally: it clears the file, it is not
        // a new record value.
        this._flushState(state);

        if (this._uiManager)
            this._uiManager.refresh(state);
    }
}

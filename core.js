export const DEFAULT_POSITION = 'before-tray';

export const PANEL_POSITIONS = Object.freeze([
    'left-after-activities',
    'before-clock',
    'after-clock',
    'before-tray',
]);

// Единственное место, где описано, куда кладётся индикатор.
// The single source of truth for indicator placement.
export const PANEL_PLACEMENT = Object.freeze({
    'left-after-activities': Object.freeze({position: 1, box: 'left'}),
    'before-clock': Object.freeze({position: 0, box: 'center'}),
    'after-clock': Object.freeze({position: -1, box: 'center'}),
    'before-tray': Object.freeze({position: 0, box: 'right'}),
});

// Единицы по умолчанию — русские; английские передаёт UIManager.
// Default units are Russian; the UI layer passes localized ones.
export const DEFAULT_DURATION_UNITS = Object.freeze({hours: 'ч', minutes: 'м'});

const MICROSECONDS_PER_SECOND = 1_000_000;

export function decodeRecord(contents) {
    // Пустой файл не считается валидным рекордом: Number('') === 0.
    // An empty file is not a valid record: Number('') === 0.
    const text = String(contents).trim();
    const value = Number(text);
    const valid = text.length > 0 && Number.isSafeInteger(value) && value >= 0;

    return {
        value: valid ? value : 0,
        valid,
    };
}

export function decodePosition(contents) {
    try {
        const {position} = JSON.parse(String(contents));
        const valid = PANEL_POSITIONS.includes(position);

        return {
            value: valid ? position : DEFAULT_POSITION,
            valid,
        };
    } catch (error) {
        return {
            value: DEFAULT_POSITION,
            valid: false,
        };
    }
}

export function decodeSession(contents) {
    const fallback = {
        active: false,
        elapsedSeconds: 0,
        chargePercent: null,
        recordSuppressed: false,
    };

    try {
        const {active, elapsedSeconds, chargePercent, recordSuppressed} =
            JSON.parse(String(contents));
        const valid = typeof active === 'boolean' &&
            Number.isSafeInteger(elapsedSeconds) && elapsedSeconds >= 0;

        return {
            value: valid
                ? {
                    active,
                    elapsedSeconds,
                    chargePercent: typeof chargePercent === 'number' &&
                        chargePercent >= 0 && chargePercent <= 100
                        ? chargePercent
                        : null,
                    recordSuppressed: recordSuppressed === true,
                }
                : {...fallback},
            valid,
        };
    } catch (error) {
        return {
            value: {...fallback},
            valid: false,
        };
    }
}

export function formatDuration(seconds, units = DEFAULT_DURATION_UNITS) {
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0
        ? Math.floor(seconds)
        : 0;
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);

    if (hours === 0)
        return `${minutes}${units.minutes}`;

    return `${hours}${units.hours} ${minutes}${units.minutes}`;
}

export function getBatteryIconName({
    available,
    hasBattery,
    percentage,
    charging = false,
    fullyCharged = false,
    fallbackIconName = '',
}) {
    if (!available || !hasBattery)
        return 'battery-empty-symbolic';

    if (typeof percentage !== 'number' ||
        !Number.isFinite(percentage) ||
        percentage < 0 || percentage > 100) {
        return typeof fallbackIconName === 'string' && fallbackIconName.length > 0
            ? fallbackIconName
            : 'battery-empty-symbolic';
    }

    const fillLevel = 10 * Math.floor(percentage / 10);
    if (fillLevel === 100 && (charging || fullyCharged))
        return 'battery-level-100-charged-symbolic';

    const chargingSuffix = charging ? '-charging' : '';
    return `battery-level-${fillLevel}${chargingSuffix}-symbolic`;
}

export class BatterySessionTracker {
    constructor(record = 0, resumeElapsedSeconds = 0, resumeActive = false,
                resumeRecordSuppressed = false) {
        this._record = decodeRecord(record).value;
        this._available = false;
        this._hasBattery = false;
        this._onBattery = false;
        this._sleeping = false;
        this._sessionActive = false;
        this._recordSuppressed = false;
        this._elapsedUs = 0;
        this._segmentStartUs = null;

        this._pendingResumeUs = Number.isSafeInteger(resumeElapsedSeconds) &&
            resumeElapsedSeconds > 0
            ? resumeElapsedSeconds * MICROSECONDS_PER_SECOND
            : 0;

        // Подавление записи восстанавливается из session.json: без этого
        // сброс рекорда откатывался бы при следующем запуске расширения.
        // Record suppression is restored from session.json so that a reset
        // is not undone by the resume logic on the next start.
        this._resumeSuppressed = Boolean(resumeRecordSuppressed) &&
            this._pendingResumeUs > 0;

        if (this._pendingResumeUs > 0 && resumeActive) {
            this._sessionActive = true;
            this._recordSuppressed = this._resumeSuppressed;
            this._elapsedUs = this._pendingResumeUs;
            this._pendingResumeUs = 0;
            this._maybeUpdateRecord();
        }
    }

    setPowerState({available, hasBattery, onBattery}, nowUs) {
        const now = this._normaliseNow(nowUs);

        if (this._sessionActive && this._segmentStartUs === null && !this._sleeping) {
            this._segmentStartUs = now;
        }

        this._accrue(now);

        this._available = Boolean(available);
        this._hasBattery = this._available && Boolean(hasBattery);
        const wasOnBattery = this._onBattery;
        this._onBattery = this._hasBattery && Boolean(onBattery);

        if (!this._available) {
            this._segmentStartUs = null;
            this._pendingResumeUs = 0;
            return this.snapshot();
        }

        if (!this._hasBattery) {
            this._endSession();
            this._pendingResumeUs = 0;
            return this.snapshot();
        }

        if (!wasOnBattery && this._onBattery) {
            if (!this._sessionActive)
                this._startSession(now);
            return this.snapshot();
        }

        if (wasOnBattery && !this._onBattery) {
            this._segmentStartUs = null;
            return this.snapshot();
        }

        if (this._onBattery && !this._sessionActive) {
            this._startSession(now);
        } else if (!this._sleeping && this._segmentStartUs === null && this._sessionActive && this._onBattery) {
            this._segmentStartUs = now;
        }

        return this.snapshot();
    }

    setSleeping(sleeping, nowUs) {
        const nextSleeping = Boolean(sleeping);
        const now = this._normaliseNow(nowUs);

        if (nextSleeping === this._sleeping)
            return this.snapshot();

        this._accrue(now);
        this._sleeping = nextSleeping;

        if (this._sleeping) {
            this._segmentStartUs = null;
        } else if (this._sessionActive && this._available &&
                   this._hasBattery && this._onBattery) {
            this._segmentStartUs = now;
        }

        return this.snapshot();
    }

    tick(nowUs) {
        this._accrue(this._normaliseNow(nowUs));
        return this.snapshot();
    }

    resetRecord() {
        this._record = 0;

        if (this._sessionActive) {
            this._recordSuppressed = true;
            this._resumeSuppressed = true;
        }

        return this.snapshot();
    }

    finish(nowUs) {
        this._accrue(this._normaliseNow(nowUs));
        this._endSession();
        return this.snapshot();
    }

    snapshot() {
        return Object.freeze({
            available: this._available,
            hasBattery: this._hasBattery,
            onBattery: this._onBattery,
            sleeping: this._sleeping,
            sessionActive: this._sessionActive,
            recordEligible: !this._recordSuppressed,
            recordSuppressed: this._recordSuppressed,
            elapsedSeconds: Math.floor(this._elapsedUs / MICROSECONDS_PER_SECOND),
            record: this._record,
        });
    }

    _normaliseNow(nowUs) {
        if (!Number.isFinite(nowUs) || nowUs < 0)
            throw new TypeError('nowUs must be a non-negative finite number');

        return Math.floor(nowUs);
    }

    _startSession(nowUs) {
        this._sessionActive = true;

        if (this._pendingResumeUs > 0) {
            this._elapsedUs = this._pendingResumeUs;
            this._pendingResumeUs = 0;
            this._recordSuppressed = this._resumeSuppressed;
        } else {
            // Новая сессия — рекорд снова считается с нуля.
            // Fresh session — the record is counted again.
            this._recordSuppressed = false;
        }

        this._segmentStartUs = this._sleeping ? null : nowUs;
        this._maybeUpdateRecord();
    }

    _endSession() {
        this._sessionActive = false;
        this._recordSuppressed = false;
        this._resumeSuppressed = false;
        this._elapsedUs = 0;
        this._segmentStartUs = null;
        this._pendingResumeUs = 0;
    }

    _accrue(nowUs) {
        if (!this._sessionActive || this._segmentStartUs === null)
            return;

        const delta = Math.max(0, nowUs - this._segmentStartUs);
        this._elapsedUs += delta;
        this._segmentStartUs = nowUs;
        this._maybeUpdateRecord();
    }

    _maybeUpdateRecord() {
        if (this._recordSuppressed || this._elapsedUs <= 0)
            return;

        const elapsedSeconds = Math.floor(
            this._elapsedUs / MICROSECONDS_PER_SECOND
        );
        if (elapsedSeconds > this._record)
            this._record = elapsedSeconds;
    }
}

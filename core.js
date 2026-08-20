export const DEFAULT_POSITION = 'before-tray';

export const PANEL_POSITIONS = Object.freeze([
    'left-after-activities',
    'before-clock',
    'after-clock',
    'before-tray',
]);

const MICROSECONDS_PER_SECOND = 1_000_000;

export function decodeRecord(contents) {
    const value = Number(String(contents).trim());
    const valid = Number.isSafeInteger(value) && value >= 0;

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
    try {
        const {active, elapsedSeconds} = JSON.parse(String(contents));
        const valid = typeof active === 'boolean' &&
            Number.isSafeInteger(elapsedSeconds) && elapsedSeconds >= 0;

        return {
            value: valid
                ? {active, elapsedSeconds}
                : {active: false, elapsedSeconds: 0},
            valid,
        };
    } catch (error) {
        return {
            value: {active: false, elapsedSeconds: 0},
            valid: false,
        };
    }
}

export function formatDuration(seconds) {
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0
        ? Math.floor(seconds)
        : 0;
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);

    if (hours === 0)
        return `${minutes}м`;

    return `${hours}ч ${minutes}м`;
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
    constructor(record = 0, resumeElapsedSeconds = 0) {
        this._record = decodeRecord(record).value;
        this._available = false;
        this._hasBattery = false;
        this._onBattery = false;
        this._sleeping = false;
        this._sessionActive = false;
        this._recordEligible = true;
        this._elapsedUs = 0;
        this._segmentStartUs = null;

        this._pendingResumeUs = Number.isSafeInteger(resumeElapsedSeconds) &&
            resumeElapsedSeconds > 0
            ? resumeElapsedSeconds * MICROSECONDS_PER_SECOND
            : 0;
    }

    setPowerState({available, hasBattery, onBattery}, nowUs) {
        const now = this._normaliseNow(nowUs);
        this._accrue(now);

        this._available = Boolean(available);
        this._hasBattery = this._available && Boolean(hasBattery);
        this._onBattery = this._hasBattery && Boolean(onBattery);

        if (!this._available) {
            this._segmentStartUs = null;
            this._pendingResumeUs = 0;
            return this.snapshot();
        }

        if (!this._hasBattery || !this._onBattery) {
            this._endSession();
            this._pendingResumeUs = 0;
            return this.snapshot();
        }

        if (!this._sessionActive)
            this._startSession(now);
        else if (!this._sleeping && this._segmentStartUs === null)
            this._segmentStartUs = now;

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

        if (this._sessionActive)
            this._recordEligible = false;

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
            recordEligible: this._recordEligible,
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
        this._recordEligible = true;
        this._elapsedUs = this._pendingResumeUs;
        this._pendingResumeUs = 0;
        this._segmentStartUs = this._sleeping ? null : nowUs;

        if (this._elapsedUs > 0) {
            const elapsedSeconds = Math.floor(
                this._elapsedUs / MICROSECONDS_PER_SECOND
            );
            if (elapsedSeconds > this._record)
                this._record = elapsedSeconds;
        }
    }

    _endSession() {
        this._sessionActive = false;
        this._recordEligible = true;
        this._elapsedUs = 0;
        this._segmentStartUs = null;
    }

    _accrue(nowUs) {
        if (!this._sessionActive || this._segmentStartUs === null)
            return;

        const delta = Math.max(0, nowUs - this._segmentStartUs);
        this._elapsedUs += delta;
        this._segmentStartUs = nowUs;

        if (!this._recordEligible)
            return;

        const elapsedSeconds = Math.floor(
            this._elapsedUs / MICROSECONDS_PER_SECOND
        );
        if (elapsedSeconds > this._record)
            this._record = elapsedSeconds;
    }
}

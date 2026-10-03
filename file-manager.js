import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { PANEL_POSITIONS } from './core.js';

export class FileManager {
    constructor(recordFile, settingsFile, sessionFile) {
        this._recordFile = recordFile;
        this._settingsFile = settingsFile;
        this._sessionFile = sessionFile;
    }

    _ensureDirectory(filePath) {
        const file = Gio.File.new_for_path(filePath);
        const parent = file.get_parent();
        if (parent && !parent.query_exists(null)) {
            try {
                parent.make_directory_with_parents(null);
                return true;
            } catch (e) {
                return false;
            }
        }
        return true;
    }

    _loadFileAsync(filePath) {
        return new Promise((resolve) => {
            const file = Gio.File.new_for_path(filePath);
            if (!file.query_exists(null)) {
                resolve(null);
                return;
            }
            file.load_contents_async(null, (source, result) => {
                try {
                    const [, data] = source.load_contents_finish(result);
                    resolve(new TextDecoder().decode(data));
                } catch (e) {
                    resolve(null);
                }
            });
        });
    }

    _saveFileAsync(filePath, contents) {
        return new Promise((resolve) => {
            if (!this._ensureDirectory(filePath)) {
                resolve(false);
                return;
            }
            const file = Gio.File.new_for_path(filePath);
            const bytes = new TextEncoder().encode(contents);
            file.replace_contents_async(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
                (source, result) => {
                    try {
                        source.replace_contents_finish(result);
                        resolve(true);
                    } catch (e) {
                        resolve(false);
                    }
                }
            );
        });
    }

    async saveSettings(position) {
        if (!PANEL_POSITIONS.includes(position)) {
            position = 'before-tray';
        }
        const payload = JSON.stringify({ position });
        return this._saveFileAsync(this._settingsFile, payload);
    }

    async saveSession(active, elapsedSeconds, chargePercent) {
        const safeElapsed = Number.isSafeInteger(elapsedSeconds) && elapsedSeconds >= 0
            ? elapsedSeconds
            : 0;
        const payload = JSON.stringify({
            active: Boolean(active),
            elapsedSeconds: safeElapsed,
            chargePercent: chargePercent !== null && chargePercent !== undefined
                ? Number(chargePercent)
                : null
        });
        return this._saveFileAsync(this._sessionFile, payload);
    }

    async loadRecord() {
        const data = await this._loadFileAsync(this._recordFile);
        if (data === null) return { value: 0, valid: true };
        const value = Number(data.trim());
        const valid = Number.isSafeInteger(value) && value >= 0;
        return { value: valid ? value : 0, valid };
    }

    async saveRecord(record) {
        return this._saveFileAsync(this._recordFile, String(record));
    }

    async loadSession() {
        const data = await this._loadFileAsync(this._sessionFile);
        if (data === null) return { active: false, elapsedSeconds: 0, chargePercent: null };
        try {
            const parsed = JSON.parse(data);
            return {
                active: typeof parsed.active === 'boolean' ? parsed.active : false,
                elapsedSeconds: Number.isSafeInteger(parsed.elapsedSeconds) && parsed.elapsedSeconds >= 0
                    ? parsed.elapsedSeconds
                    : 0,
                chargePercent: typeof parsed.chargePercent === 'number' && parsed.chargePercent >= 0 && parsed.chargePercent <= 100
                    ? parsed.chargePercent
                    : null,
            };
        } catch (e) {
            return { active: false, elapsedSeconds: 0, chargePercent: null };
        }
    }

    async deleteSession() {
        const file = Gio.File.new_for_path(this._sessionFile);
        if (file.query_exists(null)) {
            try {
                file.delete(null);
                return true;
            } catch (e) {
                return false;
            }
        }
        return true;
    }

    async loadSettings() {
        const data = await this._loadFileAsync(this._settingsFile);
        if (data === null) return { position: 'before-tray', valid: true };
        try {
            const parsed = JSON.parse(data);
            const position = parsed.position || 'before-tray';
            const valid = PANEL_POSITIONS.includes(position);
            return {
                position: valid ? position : 'before-tray',
                valid: valid
            };
        } catch (e) {
            return { position: 'before-tray', valid: false };
        }
    }
}

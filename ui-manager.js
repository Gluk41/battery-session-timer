import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatDuration, getBatteryIconName } from './core.js';

const PANEL_POSITIONS = ['left-after-activities', 'before-clock', 'after-clock', 'before-tray'];
const PANEL_PLACEMENT = {
    'left-after-activities': { position: 1, box: 'left' },
    'before-clock': { position: 0, box: 'center' },
    'after-clock': { position: -1, box: 'center' },
    'before-tray': { position: 0, box: 'right' },
};

export class UIManager {
    constructor(position, tracker, onSetPosition, onResetRecord) {
        this._position = position || 'before-tray';
        this._tracker = tracker;
        this._onSetPosition = onSetPosition;
        this._onResetRecord = onResetRecord;
        this._indicator = null;
        this._icon = null;
        this._label = null;
        this._sessionItem = null;
        this._recordItem = null;
        this._rebuildId = 0;
        this._deviceProxy = null;
        this._isLoading = true;
    }

    _getSystemLanguage() {
        try {
            const lang = GLib.get_language_names()[0] || 'en_US';
            if (lang.startsWith('ru')) return 'ru';
            return 'en';
        } catch (e) {
            return 'en';
        }
    }

    _getLocalizedText(key) {
        const lang = this._getSystemLanguage();
        const texts = {
            'loading': {
                'ru': ' Загрузка...',
                'en': ' Loading...'
            },
            'connecting_upower': {
                'ru': 'Подключение к UPower...',
                'en': 'Connecting to UPower...'
            },
            'record': {
                'ru': 'Рекорд: ',
                'en': 'Record: '
            },
            'upower_unavailable': {
                'ru': 'UPower недоступен',
                'en': 'UPower unavailable'
            },
            'no_battery': {
                'ru': 'Нет батареи',
                'en': 'No battery'
            },
            'battery_not_detected': {
                'ru': 'Батарея не обнаружена',
                'en': 'Battery not detected'
            },
            'power_connected': {
                'ru': 'Текущая сессия: питание подключено',
                'en': 'Current session: power connected'
            },
            'session_inactive': {
                'ru': 'Текущая сессия: неактивна',
                'en': 'Current session: inactive'
            },
            'current_session': {
                'ru': 'Текущая сессия: ',
                'en': 'Current session: '
            },
            'reset_record': {
                'ru': 'Сбросить рекорд',
                'en': 'Reset record'
            },
            'positions': {
                'left-after-activities': {
                    'ru': 'Слева (после Обзора)',
                    'en': 'Left (after Activities)'
                },
                'before-clock': {
                    'ru': 'По центру (перед часами)',
                    'en': 'Center (before clock)'
                },
                'after-clock': {
                    'ru': 'По центру (после часов)',
                    'en': 'Center (after clock)'
                },
                'before-tray': {
                    'ru': 'Справа (перед индикаторами)',
                    'en': 'Right (before indicators)'
                }
            }
        };
        
        const keys = key.split('.');
        let result = texts;
        for (const k of keys) {
            if (result && result[k]) {
                result = result[k];
            } else {
                return key;
            }
        }
        
        if (typeof result === 'object' && result[lang]) {
            return result[lang];
        }
        return typeof result === 'string' ? result : key;
    }

    updateTracker(tracker) {
        this._tracker = tracker;
    }

    updatePosition(position) {
        this._position = position;
    }

    setDeviceProxy(proxy) {
        this._deviceProxy = proxy;
        this._isLoading = false;
        if (this._tracker) {
            this.refresh(this._tracker.snapshot());
        }
    }

    showLoading() {
        if (!this._indicator) return;
        this._isLoading = true;
        this._icon.icon_name = 'battery-good-symbolic';
        this._label.text = this._getLocalizedText('loading');
        this._sessionItem.label.text = this._getLocalizedText('connecting_upower');
        if (this._tracker) {
            this._recordItem.label.text = this._getLocalizedText('record') + 
                formatDuration(this._tracker.snapshot().record);
        } else {
            this._recordItem.label.text = this._getLocalizedText('record') + '0';
        }
    }

    _createIndicatorNow(uuid) {
        this._indicator = new PanelMenu.Button(0.5, 'Battery Session Timer', false);
        this._indicator.menu.box.add_style_class_name('battery-session-timer-menu');

        const box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        this._icon = new St.Icon({
            icon_name: 'battery-good-symbolic',
            style_class: 'system-status-icon'
        });
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this._indicator.add_child(box);

        this._sessionItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._recordItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._indicator.menu.addMenuItem(this._sessionItem);
        this._indicator.menu.addMenuItem(this._recordItem);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        PANEL_POSITIONS.forEach(pos => {
            const label = this._getPositionLabel(pos);
            this._indicator.menu.addAction(label, () => this._onSetPosition(pos));
        });

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addAction(this._getLocalizedText('reset_record'), 
            () => this._onResetRecord());

        const placement = PANEL_PLACEMENT[this._position] || PANEL_PLACEMENT['before-tray'];
        Main.panel.addToStatusArea(uuid, this._indicator, placement.position, placement.box);

        this.showLoading();
    }

    createIndicator(uuid) {
        if (this._position === 'before-tray') {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (!this._indicator) {
                    this._createIndicatorNow(uuid);
                }
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._createIndicatorNow(uuid);
        }
    }

    _getPositionLabel(pos) {
        return this._getLocalizedText(`positions.${pos}`);
    }

    refresh(state) {
        if (!this._indicator || !this._tracker) {
            this.showLoading();
            return;
        }

        if (this._isLoading || !this._deviceProxy) {
            this.showLoading();
            return;
        }

        const deviceState = Number(this._deviceProxy.State);
        const percentage = this._deviceProxy.Percentage;

        this._icon.icon_name = getBatteryIconName({
            available: state.available,
            hasBattery: state.hasBattery,
            percentage: percentage,
            charging: deviceState === 1,
            fullyCharged: deviceState === 4,
            fallbackIconName: this._deviceProxy.IconName,
        });

        if (!state.available) {
            this._label.text = this._getLocalizedText('upower_unavailable');
            this._sessionItem.label.text = this._getLocalizedText('upower_unavailable');
        } else if (!state.hasBattery) {
            this._label.text = this._getLocalizedText('no_battery');
            this._sessionItem.label.text = this._getLocalizedText('battery_not_detected');
        } else if (!state.onBattery) {
            this._label.text = '';
            this._sessionItem.label.text = this._getLocalizedText('power_connected');
        } else if (!state.sessionActive) {
            this._label.text = '';
            this._sessionItem.label.text = this._getLocalizedText('session_inactive');
        } else {
            const duration = formatDuration(state.elapsedSeconds);
            this._label.text = ` ${duration}`;
            this._sessionItem.label.text = this._getLocalizedText('current_session') + duration;
        }

        this._recordItem.label.text = this._getLocalizedText('record') + 
            formatDuration(state.record);
    }

    rebuild(position, uuid) {
        this._position = position;
        if (this._rebuildId) {
            GLib.Source.remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            if (this._indicator) {
                const oldIndicator = this._indicator;
                this._indicator = null;
                oldIndicator.destroy();
                this.createIndicator(uuid);
                if (this._tracker) {
                    this.refresh(this._tracker.snapshot());
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroyIndicator() {
        if (this._rebuildId) {
            GLib.Source.remove(this._rebuildId);
            this._rebuildId = 0;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._icon = null;
        this._label = null;
        this._sessionItem = null;
        this._recordItem = null;
    }
}

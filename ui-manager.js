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
        this._label.text = ' Загрузка...';
        this._sessionItem.label.text = 'Подключение к UPower...';
        if (this._tracker) {
            this._recordItem.label.text = `Рекорд: ${formatDuration(this._tracker.snapshot().record)}`;
        } else {
            this._recordItem.label.text = 'Рекорд: 0';
        }
    }

    createIndicator(uuid) {
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
        this._indicator.menu.addAction('Сбросить рекорд', () => this._onResetRecord());

        const placement = PANEL_PLACEMENT[this._position] || PANEL_PLACEMENT['before-tray'];
        Main.panel.addToStatusArea(uuid, this._indicator, placement.position, placement.box);

        this.showLoading();
    }

    _getPositionLabel(pos) {
        const map = {
            'left-after-activities': 'Слева (после Обзора)',
            'before-clock': 'По центру (перед часами)',
            'after-clock': 'По центру (после часов)',
            'before-tray': 'Справа (перед индикаторами)',
        };
        return map[pos] || pos;
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
            this._label.text = ' Нет данных';
            this._sessionItem.label.text = 'UPower недоступен';
        } else if (!state.hasBattery) {
            this._label.text = ' Нет батареи';
            this._sessionItem.label.text = 'Батарея не обнаружена';
        } else if (!state.onBattery) {
            this._label.text = '';
            this._sessionItem.label.text = 'Текущая сессия: питание подключено';
        } else {
            const duration = formatDuration(state.elapsedSeconds);
            this._label.text = ` ${duration}`;
            this._sessionItem.label.text = `Текущая сессия: ${duration}`;
        }

        this._recordItem.label.text = `Рекорд: ${formatDuration(state.record)}`;
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
                this.destroyIndicator();
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

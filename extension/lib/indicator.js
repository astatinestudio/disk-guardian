// Top panel indicator: live temperatures in the panel + rich popup with one card per disk.
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {_} from './i18n.js';
import * as fmt from './format.js';
import {box, label, ellipsize, wrap, icon, iconButton, badge, setLevelClass, HealthBar, localize} from './widgets.js';

const HEALTH_RANK = {unknown: 0, good: 0, warning: 1, critical: 2};

const DiskCard = GObject.registerClass(
class DiskCard extends PopupMenu.PopupBaseMenuItem {
    _init(ctx, disk) {
        super._init({style_class: 'lh-card'});
        this._ctx = ctx;
        this.key = disk.key;

        this._icon = new St.Icon({style_class: 'lh-card-icon', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._icon);

        const main = box(true, {style_class: 'lh-card-main', x_expand: true});
        this.add_child(main);

        const top = box(false, {style_class: 'lh-card-top'});
        this._title = ellipsize(label('', 'lh-card-title', {x_expand: true}));
        this._star = iconButton('non-starred-symbolic', _('Set as default disk'), () => {
            ctx.settings.set_string('default-disk', this.key);
            ctx.settings.set_boolean('float-enabled', true);
        }, 'lh-icon-button lh-star');
        top.add_child(this._title);
        top.add_child(this._star);
        main.add_child(top);

        const sub = box(false, {style_class: 'lh-card-sub'});
        this._kind = badge('', 'kind');
        this._sub = ellipsize(label('', 'lh-card-subtext', {x_expand: true}));
        sub.add_child(this._kind);
        sub.add_child(this._sub);
        main.add_child(sub);

        const stats = box(false, {style_class: 'lh-card-stats'});
        const healthBox = box(false, {style_class: 'lh-card-health', x_expand: true});
        this._bar = new HealthBar();
        this._score = label('', 'lh-card-score');
        healthBox.add_child(this._bar.actor);
        healthBox.add_child(this._score);
        stats.add_child(healthBox);

        const tempBox = box(false, {style_class: 'lh-card-stat'});
        tempBox.add_child(icon('lh-thermometer-symbolic', 'lh-card-stat-icon'));
        this._temp = label('', 'lh-card-temp');
        tempBox.add_child(this._temp);
        stats.add_child(tempBox);

        const hoursBox = box(false, {style_class: 'lh-card-stat'});
        hoursBox.add_child(icon('lh-clock-symbolic', 'lh-card-stat-icon'));
        this._hours = label('', 'lh-card-hours');
        hoursBox.add_child(this._hours);
        stats.add_child(hoursBox);
        main.add_child(stats);

        this.connect('activate', () => ctx.openDetails(this.key));
        this.update(disk);
    }

    update(disk) {
        const {settings} = this._ctx;
        const unit = settings.get_string('temp-unit');
        this._icon.icon_name = fmt.kindIcon(disk);
        this._title.text = fmt.displayName(settings, disk);
        this._kind.text = fmt.kindLabel(disk);
        const parts = [disk.name, fmt.bytes(disk.capacity)];
        if (disk.bus === 'usb')
            parts.push(_('USB'));
        this._sub.text = parts.join(' · ');

        const isDefault = settings.get_string('default-disk') === disk.key;
        this._star.child.icon_name = isDefault ? 'starred-symbolic' : 'non-starred-symbolic';
        setLevelClass(this._star, 'lh-star', isDefault ? 'good' : null);

        const h = disk.health ?? {};
        this._bar.set(h.score ?? 0, h.level);
        this._score.text = h.score === null || h.score === undefined
            ? fmt.levelLabel(h.level)
            : `${fmt.percent(h.score)} · ${fmt.levelLabel(h.level)}`;
        setLevelClass(this._score, 'lh-text', h.level ?? 'unknown');

        const t = disk.temperature ?? {};
        if (t.current === null || t.current === undefined) {
            this._temp.text = t.standby ? '💤' : '—';
            setLevelClass(this._temp, 'lh-text', 'unknown');
        } else {
            this._temp.text = fmt.temp(t.current, unit);
            setLevelClass(this._temp, 'lh-text', fmt.tempLevel(settings, disk));
        }
        this._hours.text = disk.power_on_hours === null || disk.power_on_hours === undefined
            ? '—' : fmt.hours(disk.power_on_hours);
    }
});

export const DiskGuardianIndicator = GObject.registerClass(
class DiskGuardianIndicator extends PanelMenu.Button {
    _init(ctx) {
        super._init(0.5, 'Disk Guardian', false);
        this._ctx = ctx;
        const {settings, store} = ctx;
        this.add_style_class_name('lh-indicator');

        this._panelBox = box(false, {style_class: 'panel-status-menu-box lh-panel-box'});
        this._icon = new St.Icon({icon_name: 'drive-harddisk-symbolic', style_class: 'system-status-icon lh-panel-icon'});
        this._temps = box(false, {style_class: 'lh-panel-temps', y_align: Clutter.ActorAlign.CENTER});
        this._panelBox.add_child(this._icon);
        this._panelBox.add_child(this._temps);
        this.add_child(this._panelBox);

        this.menu.box.add_style_class_name('lh-menu');
        // Persian: RTL popup + Persian font; the panel button itself keeps the
        // Shell's direction (it sits among the other panel icons), only the font.
        localize(this.menu.box);
        localize(this._panelBox, {direction: false});

        // header
        this._header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'lh-header'});
        const titles = box(true, {x_expand: true});
        titles.add_child(label(_('Disk Guardian'), 'lh-header-title'));
        this._headerSub = label('', 'lh-header-sub');
        titles.add_child(this._headerSub);
        this._header.add_child(titles);
        this._header.add_child(iconButton('view-refresh-symbolic', _('Refresh now'), () => {
            ctx.request({action: 'refresh'});
            store.refresh();
        }));
        this._header.add_child(iconButton('emblem-system-symbolic', _('Settings'), () => {
            this.menu.close();
            ctx.openPrefs();
        }));
        this.menu.addMenuItem(this._header);

        // notice (service missing / stale)
        this._notice = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'lh-notice'});
        const nb = box(true, {x_expand: true});
        this._noticeTitle = wrap(label('', 'lh-notice-title'));
        this._noticeBody = wrap(label('', 'lh-notice-body'));
        nb.add_child(this._noticeTitle);
        nb.add_child(this._noticeBody);
        this._notice.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', style_class: 'lh-notice-icon'}));
        this._notice.add_child(nb);
        this.menu.addMenuItem(this._notice);

        this._diskSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._diskSection);
        this._cards = new Map();
        this._cardKeys = '';

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._floatSwitch = new PopupMenu.PopupSwitchMenuItem(_('Floating widget'), settings.get_boolean('float-enabled'));
        this._floatSwitch.connect('toggled', (_item, state) => settings.set_boolean('float-enabled', state));
        this.menu.addMenuItem(this._floatSwitch);

        // desktop app: the cross-platform Tauri app (disk-guardian package) or the
        // older GTK app (io.github.diskguardian.DiskGuardian, has the live activity view)
        const appSys = Shell.AppSystem.get_default();
        const newApp = ['disk-guardian.desktop', 'Disk Guardian.desktop'].map(id => appSys.lookup_app(id)).find(Boolean);
        const gtkApp = appSys.lookup_app('io.github.diskguardian.DiskGuardian.desktop');
        const shellApp = newApp ?? gtkApp;
        if (shellApp) {
            const openApp = new PopupMenu.PopupImageMenuItem(_('Open Disk Guardian app'), 'drive-harddisk-symbolic');
            openApp.connect('activate', () => shellApp.activate());
            this.menu.addMenuItem(openApp);
        }
        if (!newApp && gtkApp) {
            const live = new PopupMenu.PopupImageMenuItem(_('Live disk activity'), 'utilities-system-monitor-symbolic');
            live.connect('activate', () => {
                try {
                    GLib.spawn_command_line_async('disk-guardian --activity');
                } catch (e) {
                    logError(e, 'Disk Guardian: cannot open live activity');
                }
            });
            this.menu.addMenuItem(live);
        }

        this._storeId = store.connect('changed', () => this._sync());
        this._settingsId = settings.connect('changed', () => this._sync());
        this._sync();
    }

    _sync() {
        const {store, settings} = this._ctx;
        this._syncPanel();

        // header
        if (store.status === 'ok' || store.status === 'stale')
            this._headerSub.text = `${_('{n} disks', {n: store.disks.length})} · ${_('updated {t}', {t: fmt.ago(store.generated)})}`;
        else
            this._headerSub.text = store.status === 'loading' ? _('Loading…') : '';

        // notice
        if (store.status === 'missing' || store.status === 'error') {
            this._noticeTitle.text = _('Collector service is not running');
            this._noticeBody.text = _('Install the disk-guardian package or run: sudo systemctl enable --now disk-guardian');
            this._notice.show();
        } else if (store.status === 'stale') {
            this._noticeTitle.text = _('Data is outdated — the collector may have stopped');
            this._noticeBody.text = 'sudo systemctl status disk-guardian';
            this._notice.show();
        } else if (store.status === 'ok' && store.disks.length === 0) {
            this._noticeTitle.text = _('No disks found');
            this._noticeBody.text = '';
            this._notice.show();
        } else {
            this._notice.hide();
        }

        // cards
        const keys = store.disks.map(d => d.key).join('|');
        if (keys !== this._cardKeys) {
            this._cardKeys = keys;
            this._diskSection.removeAll();
            this._cards.clear();
            for (const d of store.disks) {
                const card = new DiskCard(this._ctx, d);
                this._cards.set(d.key, card);
                this._diskSection.addMenuItem(card);
            }
        } else {
            for (const d of store.disks)
                this._cards.get(d.key)?.update(d);
        }

        this._floatSwitch.setToggleState(settings.get_boolean('float-enabled'));
    }

    _syncPanel() {
        const {store, settings} = this._ctx;
        const unit = settings.get_string('temp-unit');
        const mode = settings.get_string('panel-mode');
        const showNames = settings.get_boolean('panel-show-names');
        const colorize = settings.get_boolean('panel-colorize');
        const hidden = settings.get_strv('hidden-disks');

        // icon reflects the worst health of all disks
        let worst = 'good';
        for (const d of store.disks) {
            const l = d.health?.level ?? 'unknown';
            if (HEALTH_RANK[l] > HEALTH_RANK[worst])
                worst = l;
        }
        if (store.status === 'missing' || store.status === 'error')
            worst = 'unknown';
        setLevelClass(this._icon, 'lh-panel-icon', worst === 'good' ? null : worst);
        this._icon.icon_name = store.status === 'missing' || store.status === 'error'
            ? 'dialog-warning-symbolic' : 'drive-harddisk-symbolic';

        this._temps.destroy_all_children();
        let disks = store.disks.filter(d => !hidden.includes(d.key));
        if (mode === 'icon') {
            disks = [];
        } else if (mode === 'max') {
            const withTemp = disks.filter(d => typeof d.temperature?.current === 'number');
            withTemp.sort((a, b) => b.temperature.current - a.temperature.current);
            disks = withTemp.slice(0, 1);
        } else if (mode === 'default') {
            const d = store.getDefaultDisk();
            disks = d ? [d] : [];
        }

        for (const d of disks) {
            const t = d.temperature ?? {};
            let text;
            if (typeof t.current === 'number')
                text = fmt.temp(t.current, unit, true);
            else if (t.standby)
                text = '💤';
            else
                continue;
            const item = box(false, {style_class: 'lh-panel-item'});
            if (showNames)
                item.add_child(label(fmt.shortName(settings, d), 'lh-panel-name'));
            const tl = label(text, 'lh-panel-temp');
            if (colorize)
                setLevelClass(tl, 'lh-temp', fmt.tempLevel(settings, d));
            item.add_child(tl);
            this._temps.add_child(item);
        }
    }

    destroy() {
        if (this._storeId) {
            this._ctx.store.disconnect(this._storeId);
            this._storeId = 0;
        }
        if (this._settingsId) {
            this._ctx.settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        super.destroy();
    }
});

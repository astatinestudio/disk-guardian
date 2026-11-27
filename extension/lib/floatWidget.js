// Draggable floating widget that shows everything about the default disk.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_} from './i18n.js';
import * as fmt from './format.js';
import {
    box, label, ellipsize, wrap, icon, setIcon, iconButton, setLevelClass, kvRow, setScrollChild,
    HealthRing, Sparkline, PartitionBar, partitionLegend, localize,
} from './widgets.js';

const REBUILD_KEYS = new Set([
    'default-disk', 'float-compact', 'float-expanded', 'disk-aliases', 'temp-unit', 'language',
    'temp-warn-hdd', 'temp-crit-hdd', 'temp-warn-ssd', 'temp-crit-ssd', 'temp-warn-nvme', 'temp-crit-nvme',
]);

export class FloatingWidget {
    constructor(ctx) {
        this._ctx = ctx;
        const {settings, store} = ctx;
        this._signature = null;
        this._live = [];
        this._drag = null;
        this._grab = null;

        this.actor = box(true, {style_class: 'lh-float', reactive: true, track_hover: true});
        localize(this.actor);
        this._addChrome();

        this.actor.connect('button-press-event', (a, e) => this._onPress(e));
        this.actor.connect('motion-event', (a, e) => this._onMotion(e));
        this.actor.connect('button-release-event', (a, e) => this._onRelease(e));

        this._storeId = store.connect('changed', () => this._update(false));
        this._settingsId = settings.connect('changed', (s, key) => {
            if (key === 'float-opacity')
                this._applyOpacity();
            else if (REBUILD_KEYS.has(key))
                this._update(true);
            else if (key === 'float-x' || key === 'float-y')
                this._place();
        });
        this._overviewIds = [
            Main.overview.connect('showing', () => {
                if (settings.get_boolean('float-hide-overview'))
                    this.actor.hide();
            }),
            Main.overview.connect('hidden', () => this.actor.show()),
        ];
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());

        this._applyOpacity();
        this._update(true);
        this._place();
    }

    /**
     * addChrome() options differ between GNOME versions: GNOME 50 removed
     * "affectsInputRegion" and throws on unknown options *after* the actor was
     * already added to the stage. Try the richest option set first and undo the
     * half-done add before falling back.
     */
    _addChrome() {
        const lm = Main.layoutManager;
        const attempts = [
            {affectsInputRegion: true, trackFullscreen: true},
            {trackFullscreen: true},
            {},
        ];
        let lastError = null;
        for (const params of attempts) {
            try {
                lm.addChrome(this.actor, params);
                return;
            } catch (e) {
                lastError = e;
                this.actor.get_parent()?.remove_child(this.actor);
            }
        }
        throw lastError;
    }

    _applyOpacity() {
        this.actor.opacity = Math.round(255 * this._ctx.settings.get_int('float-opacity') / 100);
    }

    // ---------------------------------------------------------------- dragging
    _onPress(event) {
        if (event.get_button() !== 1 || this._ctx.settings.get_boolean('float-locked'))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._drag = {dx: x - this.actor.x, dy: y - this.actor.y};
        this._grab = global.stage.grab(this.actor);
        this.actor.add_style_pseudo_class('dragging');
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this.actor.set_position(Math.round(x - this._drag.dx), Math.round(y - this._drag.dy));
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
        this.actor.remove_style_pseudo_class('dragging');
        const [x, y] = this._clamp(this.actor.x, this.actor.y);
        this.actor.set_position(x, y);
        const {settings} = this._ctx;
        settings.set_int('float-x', x);
        settings.set_int('float-y', y);
        return Clutter.EVENT_STOP;
    }

    _size() {
        const [, w] = this.actor.get_preferred_width(-1);
        const [, h] = this.actor.get_preferred_height(w);
        return [w, h];
    }

    _clamp(x, y) {
        const [w, h] = this._size();
        const maxX = Math.max(0, global.stage.width - w);
        const maxY = Math.max(0, global.stage.height - Math.min(h, 80));
        return [Math.round(Math.min(Math.max(0, x), maxX)), Math.round(Math.min(Math.max(0, y), maxY))];
    }

    _place() {
        if (this._drag)
            return;
        const {settings} = this._ctx;
        let x = settings.get_int('float-x');
        let y = settings.get_int('float-y');
        if (x < 0 || y < 0) {
            const mon = Main.layoutManager.primaryMonitor;
            if (!mon)
                return;
            const [w] = this._size();
            x = mon.x + mon.width - w - 32;
            y = mon.y + Main.panel.height + 32;
        }
        [x, y] = this._clamp(x, y);
        this.actor.set_position(x, y);
    }

    // ---------------------------------------------------------------- content
    _update(force) {
        const {store, settings} = this._ctx;
        const disk = store.getDefaultDisk();
        const sig = disk
            ? [disk.key, disk.smart_updated, disk.smart?.standby, disk.health?.level, settings.get_boolean('float-compact'),
                settings.get_boolean('float-expanded')].join('|')
            : `none|${store.status}`;
        if (force || sig !== this._signature) {
            this._signature = sig;
            this._build(disk);
        } else {
            for (const fn of this._live)
                fn(disk);
        }
    }

    _build(disk) {
        const {settings, store} = this._ctx;
        const compact = settings.get_boolean('float-compact');
        const expanded = settings.get_boolean('float-expanded');
        const unit = settings.get_string('temp-unit');
        this._live = [];
        this.actor.destroy_all_children();
        setLevelClass(this.actor, 'lh-float', compact ? 'compact' : null, ['compact']);

        // header
        const header = box(false, {style_class: 'lh-float-header'});
        const kindIcon = icon('drive-harddisk-symbolic', 'lh-float-icon');
        header.add_child(kindIcon);
        const titles = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = ellipsize(label(_('Disk Guardian'), 'lh-float-title'));
        const sub = ellipsize(label('', 'lh-float-sub'));
        titles.add_child(title);
        if (!compact)
            titles.add_child(sub);
        header.add_child(titles);
        const buttons = box(false, {style_class: 'lh-float-buttons'});
        if (store.disks.length > 1)
            buttons.add_child(iconButton('media-playlist-repeat-symbolic', _('Next disk'), () => this._nextDisk(), 'lh-float-button'));
        if (disk)
            buttons.add_child(iconButton('view-more-horizontal-symbolic', _('Details'), () => this._ctx.openDetails(disk.key), 'lh-float-button'));
        buttons.add_child(iconButton(compact ? 'pan-down-symbolic' : 'pan-up-symbolic', compact ? _('Expand') : _('Compact'),
            () => settings.set_boolean('float-compact', !compact), 'lh-float-button'));
        buttons.add_child(iconButton('window-close-symbolic', _('Close'),
            () => settings.set_boolean('float-enabled', false), 'lh-float-button'));
        header.add_child(buttons);
        this.actor.add_child(header);

        if (!disk) {
            const msg = store.status === 'missing' || store.status === 'error'
                ? _('Collector service is not running') : store.status === 'loading' ? _('Loading…') : _('No disks found');
            this.actor.add_child(wrap(label(msg, 'lh-float-empty')));
            return;
        }

        setIcon(kindIcon, fmt.kindIcon(disk));
        title.text = fmt.displayName(settings, disk);
        sub.text = [fmt.kindLabel(disk), fmt.bytes(disk.capacity), disk.name].join(' · ');
        const h = disk.health ?? {};

        if (compact) {
            const row = box(false, {style_class: 'lh-float-compact-row'});
            const temp = label('', 'lh-float-temp-small', {x_expand: true});
            const health = label(`${fmt.levelLabel(h.level)}${typeof h.score === 'number' ? ` ${fmt.percent(h.score)}` : ''}`, 'lh-float-health-small');
            setLevelClass(health, 'lh-text', h.level ?? 'unknown');
            const hours = label(fmt.hours(disk.power_on_hours), 'lh-float-hours-small');
            row.add_child(temp);
            row.add_child(health);
            row.add_child(hours);
            this.actor.add_child(row);
            const upd = d => {
                const t = d.temperature ?? {};
                temp.text = typeof t.current === 'number' ? fmt.temp(t.current, unit) : (t.standby ? '💤' : '—');
                setLevelClass(temp, 'lh-text', fmt.tempLevel(settings, d));
            };
            upd(disk);
            this._live.push(upd);
            return;
        }

        // hero: ring + temperature
        const hero = box(false, {style_class: 'lh-float-hero'});
        const ring = new HealthRing(68, 7, 'lh-ring');
        ring.set(h.score, h.level);
        const ringBox = box(true, {style_class: 'lh-float-ringbox'});
        ringBox.add_child(ring.actor);
        const lvl = label(fmt.levelLabel(h.level), 'lh-float-level', {x_align: Clutter.ActorAlign.CENTER});
        setLevelClass(lvl, 'lh-text', h.level ?? 'unknown');
        ringBox.add_child(lvl);
        hero.add_child(ringBox);

        const tempBox = box(true, {x_expand: true, style_class: 'lh-float-tempbox'});
        const tempCap = box(false);
        tempCap.add_child(icon('lh-thermometer-symbolic', 'lh-float-cap-icon'));
        tempCap.add_child(label(_('Temperature'), 'lh-float-cap'));
        tempBox.add_child(tempCap);
        const bigTemp = label('', 'lh-float-temp');
        tempBox.add_child(bigTemp);
        const mm = label('', 'lh-float-minmax');
        tempBox.add_child(mm);
        hero.add_child(tempBox);
        this.actor.add_child(hero);

        const spark = new Sparkline('lh-spark');
        this.actor.add_child(spark.actor);

        const updTemp = d => {
            const t = d.temperature ?? {};
            const level = fmt.tempLevel(settings, d);
            bigTemp.text = typeof t.current === 'number' ? fmt.temp(t.current, unit) : (t.standby ? '💤' : '—');
            setLevelClass(bigTemp, 'lh-text', level);
            mm.text = t.standby && typeof t.current !== 'number'
                ? _('Sleeping (not woken up)')
                : `${_('Min 24h')} ${fmt.temp(t.min_24h, unit)} · ${_('Max 24h')} ${fmt.temp(t.max_24h, unit)}`;
            spark.set(t.history ?? [], level === 'ok' ? 'good' : level);
        };
        updTemp(disk);
        this._live.push(updTemp);

        // key values
        const list = box(true, {style_class: 'lh-float-list'});
        const c = disk.counters ?? {};
        const add = (k, v, level = null) => {
            if (v === null || v === undefined || v === '—')
                return;
            const r = kvRow(k, v);
            if (level)
                setLevelClass(r.valueLabel, 'lh-text', level);
            list.add_child(r);
        };
        add(_('Power-on hours'), disk.power_on_hours !== null && disk.power_on_hours !== undefined
            ? `${fmt.hours(disk.power_on_hours)} · ${fmt.duration(disk.power_on_hours)}` : null);
        if (typeof disk.usage?.today_hours === 'number')
            add(_('Today'), fmt.hours(disk.usage.today_hours));
        add(_('Power cycles'), disk.power_cycles !== null && disk.power_cycles !== undefined ? fmt.num(disk.power_cycles) : null);
        if (typeof disk.life_remaining === 'number')
            add(_('Life remaining'), fmt.percent(disk.life_remaining),
                disk.life_remaining <= 10 ? 'critical' : disk.life_remaining <= 30 ? 'warning' : 'good');
        if (disk.data_written)
            add(_('Data written'), fmt.bytes(disk.data_written, disk.data_approx));
        if (disk.data_read)
            add(_('Data read'), fmt.bytes(disk.data_read, disk.data_approx));
        const [smText, , smLevel] = fmt.smartStatus(disk);
        add(_('SMART status'), smText, smLevel);
        const counter = (k, title) => {
            if (typeof c[k] === 'number')
                add(title, fmt.num(c[k]), c[k] > 0 ? 'warning' : 'good');
        };
        counter('reallocated', _('Reallocated sectors'));
        counter('pending', _('Pending sectors'));
        counter('offline_uncorrectable', _('Uncorrectable sectors'));
        counter('crc_errors', _('CRC errors (cable)'));
        counter('media_errors', _('Media errors'));
        counter('grown_defects', _('Grown defects'));
        if (typeof c.available_spare === 'number')
            add(_('Available spare'), fmt.percent(c.available_spare));
        if (typeof c.unsafe_shutdowns === 'number')
            add(_('Unsafe shutdowns'), fmt.num(c.unsafe_shutdowns));
        this.actor.add_child(list);

        // partitions
        const lay = disk.partitions;
        if (fmt.partitionSegments(disk).length) {
            const ph = box(false, {style_class: 'lh-float-parthead'});
            ph.add_child(label(_('Partitions'), 'lh-float-cap', {x_expand: true}));
            ph.add_child(label(`${_('{n} partitions', {n: fmt.num(lay.count)})} · ${fmt.partitionTableName(lay.table)}`, 'lh-float-cap'));
            this.actor.add_child(ph);
            const pbar = new PartitionBar('lh-partbar-small');
            pbar.set(disk);
            this.actor.add_child(pbar.actor);
            this.actor.add_child(partitionLegend(disk, false));
        }

        // problems
        const issues = (h.issues ?? []).filter(i => i.severity !== 'info');
        for (const i of issues.slice(0, 3)) {
            const r = box(false, {style_class: `lh-issue lh-issue-${i.severity} lh-float-issue`});
            r.add_child(wrap(label(fmt.issueText(i, unit), 'lh-issue-text', {x_expand: true})));
            this.actor.add_child(r);
        }

        // every value
        const toggle = new St.Button({
            style_class: 'lh-float-toggle',
            label: expanded ? _('Hide values') : _('Show all values'),
            can_focus: true,
            x_expand: true,
        });
        toggle.connect('clicked', () => settings.set_boolean('float-expanded', !expanded));
        this.actor.add_child(toggle);
        if (expanded)
            this.actor.add_child(this._allValues(disk, unit));
    }

    _allValues(disk, unit) {
        const scroll = new St.ScrollView({
            style_class: 'lh-float-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const list = box(true, {style_class: 'lh-float-all'});
        setScrollChild(scroll, list);
        const attrs = disk.attributes ?? [];
        for (const a of attrs) {
            const r = kvRow(`${a.id} · ${(a.name ?? '').replace(/_/g, ' ')}`, `${fmt.num(a.value)} | ${a.raw ?? ''}`);
            setLevelClass(r.valueLabel, 'lh-text', {ok: null, warn: 'warning', failing: 'critical', info: null}[a.status] ?? null);
            list.add_child(r);
        }
        const nv = disk.nvme;
        if (nv) {
            const skip = new Set(['temperature_sensors']);
            for (const [k, v] of Object.entries(nv)) {
                if (skip.has(k) || typeof v === 'object')
                    continue;
                let val = fmt.num(v);
                if (k.startsWith('data_units_'))
                    val = fmt.bytes(v * 512000);
                else if (k === 'temperature')
                    val = fmt.temp(v, unit);
                list.add_child(kvRow(k.replace(/_/g, ' '), val));
            }
        }
        for (const [k, v] of Object.entries(disk.scsi ?? {})) {
            if (v === null || v === undefined)
                continue;
            const val = typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a}: ${b ?? '—'}`).join(', ') : String(v);
            list.add_child(kvRow(k.replace(/_/g, ' '), val));
        }
        for (const b of disk.btrfs ?? []) {
            for (const dv of b.devices ?? []) {
                for (const [k, v] of Object.entries(dv)) {
                    if (k !== 'device')
                        list.add_child(kvRow(`btrfs ${k.replace(/_/g, ' ')}`, fmt.num(v)));
                }
            }
        }
        if (!list.get_n_children())
            list.add_child(label(_('No SMART attributes'), 'lh-muted'));
        return scroll;
    }

    _nextDisk() {
        const {store, settings} = this._ctx;
        if (!store.disks.length)
            return;
        const cur = store.getDefaultDisk();
        const i = store.disks.findIndex(d => d.key === cur?.key);
        settings.set_string('default-disk', store.disks[(i + 1) % store.disks.length].key);
    }

    destroy() {
        const {store, settings} = this._ctx;
        store.disconnect(this._storeId);
        settings.disconnect(this._settingsId);
        for (const id of this._overviewIds)
            Main.overview.disconnect(id);
        Main.layoutManager.disconnect(this._monitorsId);
        this._grab?.dismiss();
        this._grab = null;
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
    }
}

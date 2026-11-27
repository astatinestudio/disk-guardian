// Full details window for one disk.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {_, localizeDigits} from './i18n.js';
import * as fmt from './format.js';
import {
    box, label, ellipsize, wrap, icon, badge, textButton, setLevelClass, kvRow, tile, sectionTitle,
    setScrollChild, HealthRing, HealthBar, Sparkline, PartitionBar, partitionLegend, localize,
} from './widgets.js';

const TABS = [
    ['overview', 'Overview'],
    ['smart', 'SMART'],
    ['usage', 'Usage'],
    ['tests', 'Self-tests'],
    ['fs', 'Partitions'],
];

const SEVERITY_ICON = {
    critical: 'dialog-error-symbolic',
    warning: 'dialog-warning-symbolic',
    info: 'dialog-information-symbolic',
};

const ATTR_STATUS = {ok: 'OK', warn: 'Watch', failing: 'Failing', info: 'Info'};
const ATTR_LEVEL = {ok: 'good', warn: 'warning', failing: 'critical', info: 'unknown'};

export class DetailsDialog {
    constructor(ctx, key, onClosed) {
        this._ctx = ctx;
        this._key = key;
        this._tab = 'overview';
        this._signature = null;
        this._live = [];

        this._dialog = new ModalDialog.ModalDialog({styleClass: 'lh-dialog', destroyOnClose: true});
        const root = box(true, {style_class: 'lh-dialog-root'});
        this._dialog.contentLayout.add_child(root);

        // header
        const header = box(false, {style_class: 'lh-dlg-header'});
        this._icon = icon('drive-harddisk-symbolic', 'lh-dlg-icon');
        header.add_child(this._icon);
        const titles = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = ellipsize(label('', 'lh-dlg-title'));
        this._badges = box(false, {style_class: 'lh-badges'});
        titles.add_child(this._title);
        titles.add_child(this._badges);
        header.add_child(titles);
        const ringBox = box(true, {style_class: 'lh-dlg-ringbox'});
        this._ring = new HealthRing(76, 7, 'lh-ring-big');
        this._ringLevel = label('', 'lh-dlg-level', {x_align: Clutter.ActorAlign.CENTER});
        ringBox.add_child(this._ring.actor);
        ringBox.add_child(this._ringLevel);
        header.add_child(ringBox);
        root.add_child(header);

        // tabs
        const tabBar = box(false, {style_class: 'lh-tabs'});
        this._tabButtons = new Map();
        for (const [id, title] of TABS) {
            const b = textButton(_(title), () => this._setTab(id), 'lh-tab');
            b.x_expand = true;
            this._tabButtons.set(id, b);
            tabBar.add_child(b);
        }
        root.add_child(tabBar);

        // content
        this._scroll = new St.ScrollView({
            style_class: 'lh-dlg-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._content = box(true, {style_class: 'lh-dlg-content', x_expand: true});
        setScrollChild(this._scroll, this._content);
        root.add_child(this._scroll);

        this._dialog.setButtons([
            {label: _('Refresh now'), action: () => ctx.request({action: 'refresh'})},
            {label: _('Close'), action: () => this._dialog.close(), key: Clutter.KEY_Escape, default: true},
        ]);

        this._storeId = ctx.store.connect('changed', () => this._refresh(false));
        this._settingsId = ctx.settings.connect('changed', () => this._refresh(true));
        this._dialog.connect('destroy', () => {
            ctx.store.disconnect(this._storeId);
            ctx.settings.disconnect(this._settingsId);
            this._dialog = null;
            onClosed?.(this);
        });

        this._updateTabButtons();
        this._refresh(true);
        this._dialog.open();
    }

    close() {
        this._dialog?.close();
    }

    destroy() {
        this._dialog?.destroy();
    }

    _setTab(id) {
        this._tab = id;
        this._updateTabButtons();
        this._refresh(true);
        const adj = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        if (adj)
            adj.value = 0;
    }

    _updateTabButtons() {
        for (const [id, b] of this._tabButtons) {
            if (id === this._tab)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
    }

    get _unit() {
        return this._ctx.settings.get_string('temp-unit');
    }

    _refresh(force) {
        if (!this._dialog)
            return;
        if (force)
            localize(this._dialog); // whole dialog incl. its buttons; re-run when the language changes
        const disk = this._ctx.store.getDisk(this._key);
        if (!disk) {
            this._content.destroy_all_children();
            this._content.add_child(label(_('No disks found'), 'lh-empty'));
            this._signature = null;
            return;
        }
        this._disk = disk;
        this._updateHeader(disk);

        const sig = [this._tab, disk.smart_updated, disk.smart?.standby, disk.self_test?.running,
            disk.last_request?.at, (disk.usage?.days ?? []).length].join('|');
        if (force || sig !== this._signature) {
            this._signature = sig;
            this._render(disk);
        } else {
            for (const fn of this._live)
                fn(disk);
        }
    }

    _updateHeader(disk) {
        const {settings} = this._ctx;
        this._icon.icon_name = fmt.kindIcon(disk);
        this._title.text = fmt.displayName(settings, disk);
        this._badges.destroy_all_children();
        this._badges.add_child(badge(fmt.kindLabel(disk), 'kind'));
        this._badges.add_child(badge(fmt.bytes(disk.capacity), 'neutral'));
        this._badges.add_child(badge(disk.path ?? disk.name, 'neutral'));
        if (disk.bus === 'usb')
            this._badges.add_child(badge(_('USB'), 'neutral'));
        if ((disk.btrfs ?? []).length)
            this._badges.add_child(badge('btrfs', 'neutral'));
        if (disk.smart?.standby)
            this._badges.add_child(badge(_('Standby'), 'neutral'));
        const h = disk.health ?? {};
        this._ring.set(h.score, h.level);
        this._ringLevel.text = fmt.levelLabel(h.level);
        setLevelClass(this._ringLevel, 'lh-text', h.level ?? 'unknown');
    }

    _render(disk) {
        this._live = [];
        this._content.destroy_all_children();
        switch (this._tab) {
        case 'overview': this._renderOverview(disk); break;
        case 'smart': this._renderSmart(disk); break;
        case 'usage': this._renderUsage(disk); break;
        case 'tests': this._renderTests(disk); break;
        case 'fs': this._renderFs(disk); break;
        }
    }

    _section(title) {
        const s = box(true, {style_class: 'lh-section'});
        if (title)
            s.add_child(sectionTitle(title));
        this._content.add_child(s);
        return s;
    }

    // ------------------------------------------------------------------ overview
    _renderOverview(disk) {
        const {settings} = this._ctx;
        const unit = this._unit;

        // problems
        const issues = disk.health?.issues ?? [];
        const ps = this._section(null);
        if (issues.length === 0) {
            const row = box(false, {style_class: 'lh-issue lh-issue-good'});
            row.add_child(icon('emblem-ok-symbolic', 'lh-issue-icon'));
            row.add_child(wrap(label(_('No problems found'), 'lh-issue-text', {x_expand: true})));
            ps.add_child(row);
        }
        for (const i of issues) {
            const row = box(false, {style_class: `lh-issue lh-issue-${i.severity}`});
            row.add_child(icon(SEVERITY_ICON[i.severity] ?? SEVERITY_ICON.info, 'lh-issue-icon'));
            row.add_child(wrap(label(fmt.issueText(i, unit), 'lh-issue-text', {x_expand: true})));
            ps.add_child(row);
        }

        // tiles
        const t = disk.temperature ?? {};
        const grid = box(true, {style_class: 'lh-tiles'});
        const row1 = box(false, {style_class: 'lh-tiles-row'});
        const row2 = box(false, {style_class: 'lh-tiles-row'});
        grid.add_child(row1);
        grid.add_child(row2);
        this._content.add_child(grid);

        const tempTile = tile('lh-thermometer-symbolic', _('Temperature'), '', '');
        const updTemp = d => {
            const tt = d.temperature ?? {};
            tempTile.valueLabel.text = typeof tt.current === 'number' ? fmt.temp(tt.current, unit) : (tt.standby ? '💤' : '—');
            setLevelClass(tempTile.valueLabel, 'lh-text', fmt.tempLevel(settings, d));
            tempTile.subLabel.text = tt.standby ? _('Sleeping (not woken up)') : tt.source ? _('source: {s}', {s: tt.source}) : '';
        };
        updTemp(disk);
        this._live.push(updTemp);
        row1.add_child(tempTile);

        row1.add_child(tile('lh-clock-symbolic', _('Power-on time'), fmt.hours(disk.power_on_hours),
            fmt.duration(disk.power_on_hours)));
        const life = disk.life_remaining;
        row1.add_child(tile('lh-life-symbolic', _('Life remaining'), life === null || life === undefined ? '—' : fmt.percent(life),
            disk.kind === 'hdd' ? '' : disk.life_source ?? '',
            life === null || life === undefined ? null : life <= 10 ? 'critical' : life <= 30 ? 'warning' : 'good'));
        const [smText, smSub, smLevel] = fmt.smartStatus(disk);
        row1.add_child(tile('lh-heart-symbolic', _('SMART status'), smText, smSub, smLevel));

        row2.add_child(tile('lh-write-symbolic', _('Data written'), fmt.bytes(disk.data_written, disk.data_approx),
            disk.usage?.today_written ? `${_('Today')}: ${fmt.bytes(disk.usage.today_written)}` : ''));
        row2.add_child(tile('lh-read-symbolic', _('Data read'), fmt.bytes(disk.data_read, disk.data_approx), ''));
        row2.add_child(tile('lh-power-symbolic', _('Power cycles'), fmt.num(disk.power_cycles), ''));
        row2.add_child(tile('drive-harddisk-symbolic', _('Capacity'), fmt.bytes(disk.capacity), disk.name));

        // temperature chart
        const ts = this._section(`${_('Temperature')} — ${_('Last 24 hours')}`);
        const spark = new Sparkline('lh-spark-big');
        ts.add_child(spark.actor);
        const mm = box(false, {style_class: 'lh-temp-stats'});
        const mkStat = cap => {
            const b = box(true, {style_class: 'lh-temp-stat', x_expand: true});
            b.add_child(label(cap, 'lh-temp-stat-cap'));
            const v = label('', 'lh-temp-stat-val');
            b.add_child(v);
            mm.add_child(b);
            return v;
        };
        const sNow = mkStat(_('Now'));
        const sMin = mkStat(_('Min 24h'));
        const sMax = mkStat(_('Max 24h'));
        const sLife = mkStat(_('Lifetime max'));
        ts.add_child(mm);
        const updChart = d => {
            const tt = d.temperature ?? {};
            const lvl = fmt.tempLevel(settings, d);
            spark.set(tt.history ?? [], lvl === 'ok' ? 'good' : lvl);
            sNow.text = fmt.temp(tt.current, unit);
            sMin.text = fmt.temp(tt.min_24h, unit);
            sMax.text = fmt.temp(tt.max_24h, unit);
            sLife.text = fmt.temp(tt.lifetime_max, unit);
        };
        updChart(disk);
        this._live.push(updChart);
        if ((t.history ?? []).length < 2)
            ts.add_child(label(_('No history yet'), 'lh-muted'));

        // information
        const info = this._section(_('Information'));
        const rows = [
            [_('Model'), disk.model],
            [_('Family'), disk.model_family],
            [_('Serial'), disk.serial],
            [_('Firmware'), disk.firmware],
            [_('Capacity'), disk.capacity ? `${fmt.bytes(disk.capacity)} (${fmt.num(disk.capacity)} B)` : null],
            [_('Interface'), [disk.protocol, disk.bus?.toUpperCase(), disk.sata_version, disk.nvme_version && `NVMe ${disk.nvme_version}`, disk.transport]
                .filter(Boolean).join(' · ') || null],
            [_('Link speed'), disk.link_speed ? (disk.max_link_speed && disk.max_link_speed !== disk.link_speed
                ? `${disk.link_speed} / ${disk.max_link_speed}` : disk.link_speed) : null],
            [_('Form factor'), disk.form_factor],
            [_('Rotation'), typeof disk.rotation_rate === 'number'
                ? (disk.rotation_rate > 0 ? _('{n} rpm', {n: fmt.num(disk.rotation_rate)}) : _('Solid state')) : null],
            [_('Device'), disk.path],
        ];
        for (const [k, v] of rows)
            if (v)
                info.add_child(kvRow(k, String(v)));
    }

    // ------------------------------------------------------------------ smart
    _renderSmart(disk) {
        const attrs = disk.attributes ?? [];
        let any = false;
        if (attrs.length) {
            any = true;
            const s = this._section('SMART');
            const head = box(false, {style_class: 'lh-trow lh-thead'});
            const cols = [['ID', 'lh-c-id'], ['Attribute', 'lh-c-name'], ['Value', 'lh-c-num'], ['Worst', 'lh-c-num'],
                ['Threshold', 'lh-c-num'], ['Raw', 'lh-c-raw'], ['Status', 'lh-c-status']];
            for (const [t, c] of cols)
                head.add_child(ellipsize(label(_(t), `lh-cell ${c}`)));
            s.add_child(head);
            for (const a of attrs) {
                const r = box(false, {style_class: `lh-trow lh-trow-${a.status}`});
                r.add_child(label(fmt.num(a.id), 'lh-cell lh-c-id'));
                r.add_child(ellipsize(label((a.name ?? '').replace(/_/g, ' '), 'lh-cell lh-c-name')));
                r.add_child(label(fmt.num(a.value), 'lh-cell lh-c-num'));
                r.add_child(label(fmt.num(a.worst), 'lh-cell lh-c-num'));
                r.add_child(label(fmt.num(a.thresh), 'lh-cell lh-c-num'));
                r.add_child(ellipsize(label(String(a.raw ?? '—'), 'lh-cell lh-c-raw')));
                const st = badge(_(ATTR_STATUS[a.status] ?? 'OK'), ATTR_LEVEL[a.status] ?? 'good');
                st.add_style_class_name('lh-c-status');
                r.add_child(st);
                s.add_child(r);
            }
        }

        const nv = disk.nvme;
        if (nv) {
            any = true;
            const s = this._section(_('NVMe health log'));
            const unit = this._unit;
            const rows = [
                [_('Critical warning'), nv.critical_warning ? `0x${Number(nv.critical_warning).toString(16)}` : fmt.num(0), nv.critical_warning ? 'critical' : 'good'],
                [_('Temperature'), fmt.temp(nv.temperature, unit)],
                [_('Available spare'), fmt.percent(nv.available_spare), nv.available_spare <= nv.available_spare_threshold ? 'critical' : null],
                [_('Spare threshold'), fmt.percent(nv.available_spare_threshold)],
                [_('Percentage used'), fmt.percent(nv.percentage_used), nv.percentage_used >= 90 ? 'critical' : nv.percentage_used >= 70 ? 'warning' : null],
                [_('Data read'), fmt.bytes(nv.data_units_read * 512000)],
                [_('Data written'), fmt.bytes(nv.data_units_written * 512000)],
                [_('Host read commands'), fmt.num(nv.host_reads)],
                [_('Host write commands'), fmt.num(nv.host_writes)],
                [_('Controller busy time'), _('{n} min', {n: fmt.num(nv.controller_busy_time)})],
                [_('Power cycles'), fmt.num(nv.power_cycles)],
                [_('Power-on hours'), fmt.hours(nv.power_on_hours)],
                [_('Unsafe shutdowns'), fmt.num(nv.unsafe_shutdowns)],
                [_('Media errors'), fmt.num(nv.media_errors), nv.media_errors ? 'warning' : null],
                [_('Error log entries'), fmt.num(nv.num_err_log_entries)],
                [_('Warning temp time'), _('{n} min', {n: fmt.num(nv.warning_temp_time)})],
                [_('Critical temp time'), _('{n} min', {n: fmt.num(nv.critical_comp_time)})],
            ];
            (nv.temperature_sensors ?? []).forEach((v, i) => rows.push([`${_('Temperature')} ${fmt.num(i + 1)}`, fmt.temp(v, unit)]));
            for (const [k, v, lvl] of rows) {
                const r = kvRow(k, v);
                if (lvl)
                    setLevelClass(r.valueLabel, 'lh-text', lvl);
                s.add_child(r);
            }
        }

        const sc = disk.scsi;
        if (sc) {
            any = true;
            const s = this._section(_('SAS / SCSI counters'));
            const pair = e => e ? `${fmt.num(e.corrected)} / ${fmt.num(e.uncorrected)}` : '—';
            const rows = [
                [_('Grown defects'), fmt.num(sc.grown_defects), sc.grown_defects ? 'warning' : null],
                [_('Read: corrected / uncorrected'), pair(sc.read), sc.read?.uncorrected ? 'warning' : null],
                [_('Write: corrected / uncorrected'), pair(sc.write), sc.write?.uncorrected ? 'warning' : null],
                [_('Verify: corrected / uncorrected'), pair(sc.verify), sc.verify?.uncorrected ? 'warning' : null],
                [_('Start/stop cycles'), sc.specified_start_stop
                    ? `${fmt.num(sc.start_stop_cycles)} / ${fmt.num(sc.specified_start_stop)}` : fmt.num(sc.start_stop_cycles)],
                [_('Load/unload cycles'), fmt.num(sc.load_unload_cycles)],
            ];
            if (sc.informational_exception)
                rows.push([_('Status'), sc.informational_exception]);
            for (const [k, v, lvl] of rows) {
                const r = kvRow(k, v);
                if (lvl)
                    setLevelClass(r.valueLabel, 'lh-text', lvl);
                s.add_child(r);
            }
        }

        if (!any) {
            const s = this._section(null);
            s.add_child(label(_('No SMART attributes'), 'lh-empty'));
            if (disk.smart?.error === 'read_failed')
                s.add_child(wrap(label(fmt.issueText({code: 'smart_read_failed', params: {}}), 'lh-text-warning')));
            if (disk.smart?.error_detail)
                s.add_child(wrap(label(disk.smart.error_detail, 'lh-muted')));
        }
    }

    // ------------------------------------------------------------------ usage
    _renderUsage(disk) {
        const usage = disk.usage ?? {days: []};
        const days = usage.days ?? [];
        const withHours = days.filter(d => typeof d.hours === 'number');
        const avg = withHours.length ? withHours.reduce((a, d) => a + d.hours, 0) / withHours.length : null;

        const row = box(false, {style_class: 'lh-tiles-row'});
        this._content.add_child(row);
        row.add_child(tile('lh-clock-symbolic', _('Power-on hours'), fmt.hours(disk.power_on_hours), fmt.duration(disk.power_on_hours)));
        row.add_child(tile('lh-clock-symbolic', _('Today'), usage.today_hours === null || usage.today_hours === undefined
            ? '—' : fmt.hours(usage.today_hours), ''));
        row.add_child(tile('lh-clock-symbolic', _('Average per day'), avg === null ? '—' : _('{h} h', {h: fmt.num(avg, 1)}), ''));
        row.add_child(tile('lh-write-symbolic', _('Data written'), fmt.bytes(disk.data_written, disk.data_approx),
            usage.today_written ? `${_('Today')}: ${fmt.bytes(usage.today_written)}` : ''));

        const s1 = this._section(_('Hours per day'));
        s1.add_child(this._barChart(days.map(d => [d.date, d.hours]), v => fmt.num(v), 24));
        if (days.some(d => typeof d.written === 'number')) {
            const s2 = this._section(_('Written per day'));
            s2.add_child(this._barChart(days.map(d => [d.date, d.written]), v => fmt.bytes(v), 0));
        }
        this._content.add_child(wrap(label(_('Usage history fills in day by day.'), 'lh-muted')));
    }

    _barChart(series, fmtValue, minMax) {
        const chart = box(false, {style_class: 'lh-chart'});
        const values = series.map(s => s[1]).filter(v => typeof v === 'number');
        if (!values.length) {
            chart.add_child(label(_('No history yet'), 'lh-muted'));
            return chart;
        }
        const max = Math.max(minMax, ...values) || 1;
        const MAX_PX = 110;
        for (const [date, v] of series) {
            const col = box(true, {style_class: 'lh-chart-col', x_expand: true});
            const valLbl = label(typeof v === 'number' ? fmtValue(v) : '', 'lh-chart-val', {x_align: Clutter.ActorAlign.CENTER});
            const spacer = new St.Widget({y_expand: true});
            const h = typeof v === 'number' ? Math.max(2, Math.round(MAX_PX * v / max)) : 0;
            const bar = new St.Widget({style_class: 'lh-chart-bar', style: `height: ${h}px;`, x_align: Clutter.ActorAlign.CENTER});
            const d = date.slice(5).replace('-', '/');
            col.add_child(spacer);
            col.add_child(valLbl);
            col.add_child(bar);
            col.add_child(label(localizeDigits(d), 'lh-chart-date', {x_align: Clutter.ActorAlign.CENTER}));
            chart.add_child(col);
        }
        return chart;
    }

    // ------------------------------------------------------------------ self tests
    _renderTests(disk) {
        const {request} = this._ctx;
        const st = disk.self_test ?? {};
        const s = this._section(_('Self-tests'));
        s.add_child(wrap(label(_('Short test takes about 2 minutes, extended can take hours. The disk stays usable.'), 'lh-muted')));

        if (st.running) {
            const run = box(true, {style_class: 'lh-test-running'});
            run.add_child(label(`${_('Test in progress')}${typeof st.remaining === 'number' ? ` — ${_('{p}% remaining', {p: fmt.num(st.remaining)})}` : ''}`, 'lh-test-running-title'));
            const bar = new HealthBar();
            bar.set(typeof st.remaining === 'number' ? 100 - st.remaining : 5, 'good');
            run.add_child(bar.actor);
            s.add_child(run);
        }

        const btns = box(false, {style_class: 'lh-test-buttons'});
        const canTest = disk.smart?.available && !disk.smart?.standby;
        const mk = (text, req) => {
            const b = textButton(text, () => request({...req, disk: disk.key}), 'lh-button');
            b.reactive = !!canTest;
            if (!canTest)
                b.add_style_pseudo_class('insensitive');
            btns.add_child(b);
        };
        if (st.running) {
            mk(_('Abort test'), {action: 'abort'});
        } else {
            mk(_('Run short test'), {action: 'selftest', type: 'short'});
            mk(_('Run extended test'), {action: 'selftest', type: 'long'});
        }
        s.add_child(btns);

        const lr = disk.last_request;
        if (lr) {
            s.add_child(wrap(label(_('Last request: {r}', {r: `${lr.action}${lr.type ? ` (${lr.type})` : ''} — ${lr.ok ? _('accepted') : _('rejected')} · ${fmt.ago(lr.at)}`}),
                lr.ok ? 'lh-muted' : 'lh-text-warning')));
        }

        const log = this._section(null);
        const tests = disk.self_tests ?? [];
        if (!tests.length) {
            log.add_child(label(_('No self-tests recorded'), 'lh-empty'));
            return;
        }
        const head = box(false, {style_class: 'lh-trow lh-thead'});
        head.add_child(label(_('Type'), 'lh-cell lh-c-ttype'));
        head.add_child(label(_('Result'), 'lh-cell lh-c-tresult'));
        head.add_child(label(_('At hour'), 'lh-cell lh-c-num'));
        log.add_child(head);
        for (const t of tests) {
            const r = box(false, {style_class: 'lh-trow'});
            r.add_child(ellipsize(label(t.type ?? '—', 'lh-cell lh-c-ttype')));
            const res = ellipsize(label(t.status ?? '—', 'lh-cell lh-c-tresult'));
            setLevelClass(res, 'lh-text', t.passed === true ? 'good' : t.passed === false ? 'critical' : 'unknown');
            r.add_child(res);
            r.add_child(label(fmt.num(t.hours), 'lh-cell lh-c-num'));
            log.add_child(r);
        }
    }

    // ------------------------------------------------------------------ file systems
    _renderFs(disk) {
        const lay = disk.partitions;
        if (lay) {
            const ps = this._section(null);
            const head = box(false, {style_class: 'lh-badges'});
            head.add_child(sectionTitle(_('Partitions')));
            head.add_child(badge(_('{n} partitions', {n: fmt.num(lay.count)}), 'kind'));
            head.add_child(badge(`${_('Partition table')}: ${fmt.partitionTableName(lay.table)}`, 'neutral'));
            ps.add_child(head);
            const bar = new PartitionBar('lh-partbar');
            bar.set(disk);
            ps.add_child(bar.actor);
            if (fmt.partitionSegments(disk).length)
                ps.add_child(partitionLegend(disk, true));
            else
                ps.add_child(label(_('No partitions'), 'lh-empty'));
        }
        const fss = lay ? [] : disk.filesystems ?? [];
        const s = lay ? this._section(null) : this._section(_('File systems'));
        if (!lay && !fss.length)
            s.add_child(label(_('No file systems'), 'lh-empty'));
        for (const f of fss) {
            const card = box(true, {style_class: 'lh-fs'});
            const top = box(false, {style_class: 'lh-fs-top'});
            top.add_child(ellipsize(label(f.mounts?.length ? f.mounts.join(', ') : _('Not mounted'), 'lh-fs-mount', {x_expand: true})));
            top.add_child(badge(f.fstype ?? '?', 'neutral'));
            card.add_child(top);
            const sub = [f.name, f.label].filter(Boolean).join(' · ');
            if (sub)
                card.add_child(label(sub, 'lh-muted'));
            if (f.size && typeof f.used === 'number') {
                const pct = 100 * f.used / f.size;
                const bar = new HealthBar();
                bar.set(pct, pct >= 95 ? 'critical' : pct >= 85 ? 'warning' : 'good');
                card.add_child(bar.actor);
                card.add_child(label(_('used {u} of {s}', {u: fmt.bytes(f.used), s: fmt.bytes(f.size)}) + ` (${fmt.percent(Math.round(pct))})`, 'lh-muted'));
            }
            s.add_child(card);
        }

        for (const b of disk.btrfs ?? []) {
            const bs = this._section(`btrfs — ${b.mount}`);
            bs.add_child(sectionTitle(_('btrfs device errors')));
            for (const dv of b.devices ?? []) {
                bs.add_child(label(dv.device, 'lh-muted'));
                const names = [['write_io_errs', 'Write errors'], ['read_io_errs', 'Read errors'], ['flush_io_errs', 'Flush errors'],
                    ['corruption_errs', 'Corruption errors'], ['generation_errs', 'Generation errors']];
                for (const [k, t] of names) {
                    const r = kvRow(_(t), fmt.num(dv[k]));
                    setLevelClass(r.valueLabel, 'lh-text', dv[k] ? 'critical' : 'good');
                    bs.add_child(r);
                }
            }
            if (b.scrub) {
                bs.add_child(sectionTitle(_('Last scrub')));
                if (b.scrub.started)
                    bs.add_child(kvRow(_('Last scrub'), b.scrub.started));
                if (b.scrub.status)
                    bs.add_child(kvRow(_('Status'), b.scrub.status));
                if (b.scrub.errors) {
                    const r = kvRow(_('Result'), b.scrub.errors);
                    setLevelClass(r.valueLabel, 'lh-text', /no errors/i.test(b.scrub.errors) ? 'good' : 'warning');
                    bs.add_child(r);
                }
            }
        }
    }
}

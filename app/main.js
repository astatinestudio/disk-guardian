// Disk Guardian — desktop application (GTK 4 + libadwaita).
// Reads the collector snapshot (/run/diskguardian/state.json) like the panel extension.
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'cairo';
import System from 'system';

import {_, setLanguage, getLanguage, localizeDigits} from './lib/i18n.js';
import * as fmt from './lib/format.js';

const APP_ID = 'io.github.diskguardian.DiskGuardian';
const VERSION = '1.3.3';
const EXT_UUID = 'disk-guardian@diskguardian';
const SCHEMA = 'org.gnome.shell.extensions.diskguardian';
const STATE_PATH = '/run/diskguardian/state.json';
const REQ_DIR = '/run/diskguardian/requests';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const CSS = `
.lh-hero { padding: 18px 20px; }
.lh-tile { padding: 14px 16px; }
.lh-tile-value { font-size: 1.45em; font-weight: 800; }
.lh-issue { padding: 10px 14px; border-radius: 12px; }
.lh-issue.warning { background-color: alpha(@warning_color, 0.15); }
.lh-issue.critical { background-color: alpha(@error_color, 0.15); }
.lh-issue.info { background-color: alpha(@accent_color, 0.12); }
.lh-issue.good { background-color: alpha(@success_color, 0.13); }
.lh-badge { padding: 2px 10px; border-radius: 99px; font-size: 0.8em; font-weight: bold; background-color: alpha(currentColor, 0.1); }
.lh-badge.kind { background-color: alpha(@accent_color, 0.2); color: @accent_color; }
.lh-chart-bar { background-color: @accent_color; border-radius: 6px 6px 2px 2px; }
.lh-dot { min-width: 10px; min-height: 10px; border-radius: 99px; background-color: alpha(currentColor, 0.3); }
.lh-dot.good { background-color: @success_color; }
.lh-dot.warning { background-color: @warning_color; }
.lh-dot.critical { background-color: @error_color; }
.lh-card-pad { padding: 14px 16px; }
.lh-row-temp { font-weight: 800; }
.lh-footer { padding: 10px 14px; }
.lh-pb-read progress { background-color: #33d17a; }
.lh-pb-write progress { background-color: #f5a33b; }
.lh-pb-busy progress { background-color: @accent_color; }
.lh-proc-head { border-bottom: 1px solid alpha(currentColor, 0.12); padding-bottom: 4px; }
.lh-colhead { padding: 2px 10px; min-height: 0; }
.lh-proc-row { padding: 5px 0; border-radius: 8px; }
.lh-proc-row:hover { background-color: alpha(currentColor, 0.05); }
`;

const LEVEL_CSS = {good: 'success', ok: 'success', warning: 'warning', warn: 'warning', critical: 'error', crit: 'error'};

function setLevel(widget, level) {
    for (const c of ['success', 'warning', 'error'])
        widget.remove_css_class(c);
    if (LEVEL_CSS[level])
        widget.add_css_class(LEVEL_CSS[level]);
}

const vbox = (spacing = 0, css = []) => new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing, css_classes: css});
const hbox = (spacing = 0, css = []) => new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing, css_classes: css});
const lbl = (text, css = [], props = {}) => new Gtk.Label({label: text ?? '', css_classes: css, xalign: 0, ...props});

function clear(box) {
    let c;
    while ((c = box.get_first_child()))
        box.remove(c);
}

function badge(text, kind = '') {
    return lbl(text, kind ? ['lh-badge', kind] : ['lh-badge'], {valign: Gtk.Align.CENTER});
}

function propRow(title, value, level = null) {
    const row = new Adw.ActionRow({title});
    const v = lbl(String(value ?? '—'), ['numeric'], {selectable: true, xalign: 1, wrap: true, max_width_chars: 40});
    if (level)
        setLevel(v, level);
    row.add_suffix(v);
    return row;
}

function widgetColor(w) {
    try {
        if (w.get_color)
            return w.get_color();
        return w.get_style_context().get_color();
    } catch {
        const c = new Gdk.RGBA();
        c.parse('#888');
        return c;
    }
}

function drawText(cr, area, text, x, y, align = 'left', markup = false) {
    const layout = area.create_pango_layout(null);
    if (markup)
        layout.set_markup(text, -1);
    else
        layout.set_text(text, -1);
    const [, logical] = layout.get_pixel_extents();
    const tx = align === 'right' ? x - logical.width : align === 'center' ? x - logical.width / 2 : x;
    cr.moveTo(tx, y - logical.height / 2);
    PangoCairo.show_layout(cr, layout);
}

function rgb(level) {
    return fmt.COLORS[level] ?? fmt.COLORS.accent;
}

// ------------------------------------------------------------------ settings

const DEFAULTS = {
    'language': 'auto', 'temp-unit': 'C', 'default-disk': '',
    'temp-warn-hdd': 50, 'temp-crit-hdd': 58, 'temp-warn-ssd': 60, 'temp-crit-ssd': 70,
    'temp-warn-nvme': 65, 'temp-crit-nvme': 78,
};

function loadSettings() {
    const src = Gio.SettingsSchemaSource.get_default();
    if (src?.lookup(SCHEMA, true))
        return new Gio.Settings({schema_id: SCHEMA});
    return {
        get_string: k => DEFAULTS[k] ?? '',
        get_int: k => DEFAULTS[k] ?? 0,
        get_boolean: () => false,
        get_strv: () => [],
        get_value: () => ({deepUnpack: () => ({})}),
        set_string() {},
        connect: () => 0,
        disconnect() {},
    };
}

// ------------------------------------------------------------------ drawings

function makeRing(size) {
    const area = new Gtk.DrawingArea({content_width: size, content_height: size, valign: Gtk.Align.CENTER});
    area._score = null;
    area._level = 'unknown';
    area.set_draw_func((a, cr, w, h) => {
        const t = Math.max(6, size / 12);
        const r = Math.min(w, h) / 2 - t / 2 - 1;
        const fg = widgetColor(a);
        cr.setLineWidth(t);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.12);
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
        cr.stroke();
        if (typeof a._score === 'number' && a._score > 0) {
            const [R, G, B] = rgb(a._level);
            cr.setSourceRGBA(R, G, B, 1);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * a._score / 100);
            cr.stroke();
        }
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 1);
        const txt = typeof a._score === 'number' ? fmt.num(a._score) : '?';
        drawText(cr, a, `<span size="${size >= 100 ? 'xx-large' : 'x-large'}" weight="heavy">${txt}</span>`, w / 2, h / 2, 'center', true);
        cr.$dispose();
    });
    area.setValue = (score, level) => {
        area._score = typeof score === 'number' ? score : null;
        area._level = level ?? 'unknown';
        area.queue_draw();
    };
    return area;
}

function makeTempChart(unitFn) {
    const area = new Gtk.DrawingArea({content_height: 190, hexpand: true});
    area.add_css_class('caption');
    area._points = [];
    area._level = 'good';
    area.set_draw_func((a, cr, w, h) => {
        const fg = widgetColor(a);
        const unit = unitFn();
        const pts = a._points;
        const padL = 46, padR = 10, padT = 10, padB = 24;
        const now = Date.now() / 1000;
        const t0 = now - 24 * 3600;
        if (pts.length < 2) {
            cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.5);
            drawText(cr, a, _('No history yet'), w / 2, h / 2, 'center');
            cr.$dispose();
            return;
        }
        let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
        lo = Math.floor(lo - 2);
        hi = Math.ceil(hi + 2);
        if (hi - lo < 8) {
            const m = (hi + lo) / 2;
            lo = Math.floor(m - 4);
            hi = Math.ceil(m + 4);
        }
        const X = ts => padL + Math.max(0, (ts - t0) / (now - t0)) * (w - padL - padR);
        const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

        // grid + labels
        cr.setLineWidth(1);
        for (let i = 0; i <= 4; i++) {
            const v = lo + (hi - lo) * i / 4;
            const y = Math.round(Y(v)) + 0.5;
            cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.08);
            cr.moveTo(padL, y);
            cr.lineTo(w - padR, y);
            cr.stroke();
            cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.55);
            drawText(cr, a, fmt.temp(v, unit), padL - 8, y, 'right');
        }
        for (const hAgo of [24, 18, 12, 6, 0]) {
            const x = X(now - hAgo * 3600);
            cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.55);
            drawText(cr, a, hAgo === 0 ? _('Now') : localizeDigits(`-${hAgo}h`), x, h - padB / 2,
                hAgo === 24 ? 'left' : hAgo === 0 ? 'right' : 'center');
        }

        const [R, G, B] = rgb(a._level);
        const path = () => {
            cr.moveTo(X(pts[0][0]), Y(pts[0][1]));
            for (const p of pts.slice(1))
                cr.lineTo(X(p[0]), Y(p[1]));
        };
        path();
        cr.lineTo(X(pts[pts.length - 1][0]), h - padB);
        cr.lineTo(X(pts[0][0]), h - padB);
        cr.closePath();
        const grad = new Cairo.LinearGradient(0, padT, 0, h - padB);
        grad.addColorStopRGBA(0, R, G, B, 0.35);
        grad.addColorStopRGBA(1, R, G, B, 0.02);
        cr.setSource(grad);
        cr.fill();
        path();
        cr.setSourceRGBA(R, G, B, 1);
        cr.setLineWidth(2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.stroke();
        const last = pts[pts.length - 1];
        cr.arc(X(last[0]), Y(last[1]), 3.5, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    });
    area.setData = (points, level) => {
        area._points = (points ?? []).filter(p => typeof p[1] === 'number');
        area._level = level === 'unknown' || !level ? 'accent' : level;
        area.queue_draw();
    };
    return area;
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function hatch(cr, fg, x0, x1, h) {
    cr.save();
    cr.rectangle(x0, 0, x1 - x0, h);
    cr.clip();
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.07);
    cr.paint();
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.18);
    cr.setLineWidth(1);
    for (let t = x0 - h; t < x1; t += 7) {
        cr.moveTo(t, h);
        cr.lineTo(t + h, 0);
    }
    cr.stroke();
    cr.restore();
}

/** GNOME Disks-like bar: one block per partition (darker part = used space), hatched = unallocated. */
function makePartitionBar(height = 64) {
    const area = new Gtk.DrawingArea({content_height: height, hexpand: true});
    area.add_css_class('caption');
    area._segs = [];
    area.set_draw_func((a, cr, w, h) => {
        const fg = widgetColor(a);
        const segs = a._segs;
        if (!segs.length) {
            cr.$dispose();
            return;
        }
        roundedRect(cr, 0, 0, w, h, 12);
        cr.clip();
        const gap = 3;
        let x = 0;
        segs.forEach((sg, i) => {
            const sw = sg.width * w;
            const x0 = x + (i ? gap / 2 : 0);
            const x1 = x + sw - (i < segs.length - 1 ? gap / 2 : 0);
            x += sw;
            if (x1 <= x0)
                return;
            if (sg.color) {
                const [R, G, B] = sg.color;
                cr.setSourceRGBA(R, G, B, sg.usedFrac === null ? 0.85 : 0.38);
                cr.rectangle(x0, 0, x1 - x0, h);
                cr.fill();
                if (sg.usedFrac !== null) {
                    cr.setSourceRGBA(R, G, B, 0.95);
                    cr.rectangle(x0, 0, (x1 - x0) * Math.min(1, sg.usedFrac), h);
                    cr.fill();
                }
            } else {
                hatch(cr, fg, x0, x1, h);
            }
            if (x1 - x0 > 54) {
                cr.save();
                cr.rectangle(x0, 0, x1 - x0, h);
                cr.clip();
                if (sg.color)
                    cr.setSourceRGBA(1, 1, 1, 0.97);
                else
                    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.75);
                const title = sg.kind === 'free' ? _('free') : sg.name;
                drawText(cr, a, `<b>${GLib.markup_escape_text(title, -1)}</b>`, x0 + 9, h / 2 - 9, 'left', true);
                drawText(cr, a, `${fmt.bytes(sg.size)}${sg.kind === 'part' ? ` · ${fmt.partitionFs(sg)}` : ''}`, x0 + 9, h / 2 + 9, 'left');
                cr.restore();
            }
        });
        cr.$dispose();
    });
    area.setDisk = disk => {
        area._segs = fmt.partitionSegments(disk);
        area.queue_draw();
    };
    return area;
}

function colorSwatch(color, size = 14) {
    const a = new Gtk.DrawingArea({content_width: size, content_height: size, valign: Gtk.Align.CENTER});
    a.set_draw_func((area, cr, w, h) => {
        roundedRect(cr, 0, 0, w, h, 4);
        if (color) {
            cr.setSourceRGBA(color[0], color[1], color[2], 1);
            cr.fill();
        } else {
            cr.clip();
            hatch(cr, widgetColor(area), 0, w, h);
        }
        cr.$dispose();
    });
    return a;
}

function barChart(series, fmtValue, minMax) {
    const box = hbox(6);
    box.homogeneous = true;
    box.set_size_request(-1, 180);
    const values = series.map(s => s[1]).filter(v => typeof v === 'number');
    if (!values.length) {
        box.append(lbl(_('No history yet'), ['dim-label'], {xalign: 0.5, hexpand: true}));
        return box;
    }
    const max = Math.max(minMax, ...values) || 1;
    for (const [date, v] of series) {
        const col = vbox(4);
        col.valign = Gtk.Align.END;
        col.append(lbl(typeof v === 'number' ? fmtValue(v) : '', ['caption', 'numeric'], {xalign: 0.5}));
        const bar = new Gtk.Box({css_classes: ['lh-chart-bar'], halign: Gtk.Align.CENTER});
        bar.set_size_request(18, typeof v === 'number' ? Math.max(3, Math.round(120 * v / max)) : 0);
        col.append(bar);
        col.append(lbl(localizeDigits(date.slice(5).replace('-', '/')), ['caption', 'dim-label'], {xalign: 0.5}));
        box.append(col);
    }
    return box;
}

// ------------------------------------------------------------------ window

class DiskGuardianWindow {
    constructor(app) {
        this.app = app;
        this.settings = app.settings;
        this.disks = [];
        this.daemon = null;
        this.generated = 0;
        this.status = 'loading';
        this.selectedKey = null;
        this.rows = new Map();
        this.rowKeys = '';
        this.signature = null;
        this.live = [];
        this.mode = 'disk';           // 'disk' | 'activity'

        this.win = new Adw.ApplicationWindow({application: app, title: _('Disk Guardian'), default_width: 1120, default_height: 800});
        this.win.set_size_request(360, 420);
        this.toasts = new Adw.ToastOverlay();
        this.split = new Adw.NavigationSplitView({min_sidebar_width: 270, max_sidebar_width: 340});
        this.toasts.set_child(this.split);
        this.win.set_content(this.toasts);

        this._buildSidebar();
        this._buildContent();
        this.activityView = new ActivityView(this);
        this.main.add_named(this.activityView.widget, 'activity');

        const bp = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 760sp')});
        bp.add_setter(this.split, 'collapsed', true);
        bp.add_setter(this.switcherBar, 'reveal', true);
        bp.add_setter(this.switcher, 'visible', false);
        this.win.add_breakpoint(bp);

        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this.poll();
            return GLib.SOURCE_CONTINUE;
        });
        this._extId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            this.checkExtension();
            return GLib.SOURCE_CONTINUE;
        });
        this._settingsId = this.settings.connect('changed', () => {
            this.signature = null;
            this.render();
        });
        this.win.connect('close-request', () => {
            GLib.source_remove(this._pollId);
            GLib.source_remove(this._extId);
            this.activityView.stop();
            this.settings.disconnect(this._settingsId);
            return false;
        });

        this.poll();
        this.checkExtension();
    }

    present() {
        this.win.present();
    }

    get unit() {
        return this.settings.get_string('temp-unit');
    }

    // -------------------------------------------------------------- layout
    _buildSidebar() {
        const view = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const menu = new Gio.Menu();
        menu.append(_('Live activity'), 'app.show-activity');
        menu.append(_('Refresh now'), 'app.refresh');
        menu.append(_('Panel extension settings'), 'app.ext-prefs');
        menu.append(_('About Disk Guardian'), 'app.about');
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu, primary: true, tooltip_text: _('Settings')}));
        view.add_top_bar(header);

        this.navList = new Gtk.ListBox({css_classes: ['navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE});
        this.activityRow = new Gtk.ListBoxRow();
        const ar = hbox(12);
        ar.set_margin_top(8);
        ar.set_margin_bottom(8);
        ar.set_margin_start(6);
        ar.set_margin_end(6);
        ar.append(new Gtk.Image({icon_name: 'utilities-system-monitor-symbolic', pixel_size: 32}));
        const at = vbox(2);
        at.valign = Gtk.Align.CENTER;
        at.append(lbl(_('Live activity'), ['heading']));
        this.activityRowSub = lbl(_('Read/write speed and processes'), ['caption', 'dim-label', 'numeric'], {ellipsize: Pango.EllipsizeMode.END});
        at.append(this.activityRowSub);
        ar.append(at);
        this.activityRow.set_child(ar);
        this.navList.append(this.activityRow);
        this.navList.connect('row-activated', () => this.showActivity());

        this.list = new Gtk.ListBox({css_classes: ['navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE});
        this.list.connect('row-activated', (_lb, row) => {
            this.select(row._key);
            this.split.show_content = true;
        });
        const sideBox = vbox(0);
        sideBox.append(this.navList);
        sideBox.append(new Gtk.Separator({margin_start: 12, margin_end: 12}));
        sideBox.append(this.list);
        const scroll = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: sideBox});
        const box = vbox();
        box.append(scroll);
        this.footer = lbl('', ['caption', 'dim-label', 'lh-footer'], {wrap: true});
        box.append(this.footer);
        view.set_content(box);
        this.split.set_sidebar(new Adw.NavigationPage({title: _('Disk Guardian'), child: view}));
    }

    _buildContent() {
        const view = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        this.header = header;
        this.activityTitle = new Adw.WindowTitle({title: _('Live activity'), subtitle: ''});
        this.stack = new Adw.ViewStack({vexpand: true});
        this.switcher = new Adw.ViewSwitcher({stack: this.stack, policy: Adw.ViewSwitcherPolicy.WIDE});
        header.set_title_widget(this.switcher);
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: _('Refresh now')});
        refresh.connect('clicked', () => this.request({action: 'refresh'}));
        header.pack_end(refresh);
        view.add_top_bar(header);

        this.banner = new Adw.Banner({revealed: false});
        this.banner.connect('button-clicked', () => this.enableExtension());
        view.add_top_bar(this.banner);

        this.pages = {};
        const tabs = [
            ['overview', 'Overview', 'view-grid-symbolic'],
            ['smart', 'SMART', 'view-list-symbolic'],
            ['usage', 'Usage', 'document-open-recent-symbolic'],
            ['tests', 'Self-tests', 'emblem-ok-symbolic'],
            ['fs', 'Partitions', 'drive-multidisk-symbolic'],
        ];
        for (const [id, title, iconName] of tabs) {
            const box = vbox(18);
            box.set_margin_top(24);
            box.set_margin_bottom(24);
            box.set_margin_start(18);
            box.set_margin_end(18);
            const clamp = new Adw.Clamp({maximum_size: 1040, tightening_threshold: 700, child: box});
            const scroll = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, child: clamp});
            this.stack.add_titled_with_icon(scroll, id, _(title), iconName);
            this.pages[id] = box;
        }
        this.stack.connect('notify::visible-child-name', () => {
            this.signature = null;
            this.render();
        });

        this.switcherBar = new Adw.ViewSwitcherBar({stack: this.stack});
        view.add_bottom_bar(this.switcherBar);

        this.statusPage = new Adw.StatusPage({icon_name: APP_ID, vexpand: true});
        const retry = new Gtk.Button({label: _('Try again'), css_classes: ['pill', 'suggested-action'], halign: Gtk.Align.CENTER});
        retry.connect('clicked', () => this.poll());
        this.statusPage.set_child(retry);

        this.main = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE});
        this.main.add_named(this.statusPage, 'status');
        this.main.add_named(this.stack, 'disk');
        view.set_content(this.main);

        this.contentPage = new Adw.NavigationPage({title: _('Details'), child: view, tag: 'content'});
        this.split.set_content(this.contentPage);
    }

    // -------------------------------------------------------------- data
    async poll() {
        try {
            const [bytes] = await Gio.File.new_for_path(STATE_PATH).load_contents_async(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            const age = Date.now() / 1000 - (data.generated ?? 0);
            const status = age > 60 ? 'stale' : 'ok';
            if (data.generated === this.generated && status === this.status)
                return;
            this.generated = data.generated ?? 0;
            this.daemon = data.daemon ?? null;
            this.disks = Array.isArray(data.disks) ? data.disks : [];
            this.status = status;
        } catch (e) {
            const missing = e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
            if (!missing && e instanceof SyntaxError)
                return;
            if (this.status === 'missing')
                return;
            this.status = 'missing';
            this.disks = [];
        }
        this.render();
    }

    async request(req, silent = false) {
        let msg;
        try {
            const name = `${Date.now()}-${Math.floor(Math.random() * 1e9)}.json`;
            const file = Gio.File.new_for_path(`${REQ_DIR}/${name}`);
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(req)));
            await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
            if (silent)
                return true;
            this.toast(req.action === 'refresh' ? _('Refreshing…') : _('Request sent'));
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this.poll();
                return GLib.SOURCE_REMOVE;
            });
            return true;
        } catch (e) {
            if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
                msg = _('Permission denied. Your user must be in the “{g}” group.', {g: this.daemon?.request_group ?? 'sudo'});
            else if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                msg = _('Collector service is not running');
            else
                msg = String(e?.message ?? e);
        }
        if (!silent)
            this.toast(msg);
        return msg;
    }

    toast(text) {
        this.toasts.add_toast(new Adw.Toast({title: text, timeout: 4}));
    }

    // -------------------------------------------------------------- panel extension
    async checkExtension() {
        try {
            const res = await Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                'org.gnome.Shell.Extensions', 'GetExtensionInfo', new GLib.Variant('(s)', [EXT_UUID]),
                null, Gio.DBusCallFlags.NONE, 3000, null);
            const info = res.recursiveUnpack()[0];
            if (!info || Object.keys(info).length === 0) {
                this.banner.title = _('Log out and back in to show disk temperatures in the top panel.');
                this.banner.button_label = '';
                this.banner.revealed = true;
            } else if (info.state !== 1) {
                this.banner.title = _('The panel extension is turned off.');
                this.banner.button_label = _('Turn on');
                this.banner.revealed = true;
            } else {
                this.banner.revealed = false;
            }
        } catch {
            this.banner.revealed = false;   // not running under GNOME Shell
        }
    }

    async enableExtension() {
        try {
            await Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                'org.gnome.Shell.Extensions', 'EnableExtension', new GLib.Variant('(s)', [EXT_UUID]),
                null, Gio.DBusCallFlags.NONE, 5000, null);
        } catch (e) {
            this.toast(String(e?.message ?? e));
        }
        this.checkExtension();
    }

    async openExtensionPrefs() {
        try {
            await Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                'org.gnome.Shell.Extensions', 'OpenExtensionPrefs', new GLib.Variant('(ssa{sv})', [EXT_UUID, '', {}]),
                null, Gio.DBusCallFlags.NONE, 5000, null);
        } catch {
            this.toast(_('Log out and back in to show disk temperatures in the top panel.'));
        }
    }

    // -------------------------------------------------------------- render
    showActivity() {
        this.mode = 'activity';
        this.list.unselect_all();
        this.navList.select_row(this.activityRow);
        this.activityView.start();
        this.split.show_content = true;
        this.render();
    }

    activitySubtitle(text) {
        this.activityRowSub.label = text;
        this.activityTitle.subtitle = text;
    }

    select(key) {
        if (this.mode === 'activity') {
            this.mode = 'disk';
            this.activityView.stop();
            this.navList.unselect_all();
            this.activityRowSub.label = _('Read/write speed and processes');
        }
        this.selectedKey = key;
        this.signature = null;
        this.render();
    }

    render() {
        this._renderSidebar();
        if (this.mode === 'activity') {
            if (this.header.title_widget !== this.activityTitle)
                this.header.set_title_widget(this.activityTitle);
            this.switcherBar.visible = false;
            this.main.visible_child_name = 'activity';
            this.contentPage.title = _('Live activity');
            return;
        }
        if (this.header.title_widget !== this.switcher)
            this.header.set_title_widget(this.switcher);
        this.switcherBar.visible = true;
        if (this.status === 'missing' || (this.status !== 'loading' && !this.disks.length)) {
            this.statusPage.title = this.status === 'missing' ? _('Collector service is not running') : _('No disks found');
            this.statusPage.description = this.status === 'missing'
                ? `${_('Install the diskguardian package or run: sudo systemctl start linuxhealth-collector')}`
                : '';
            this.main.visible_child_name = 'status';
            this.contentPage.title = _('Disk Guardian');
            return;
        }
        const disk = this.disks.find(d => d.key === this.selectedKey) ?? this.disks.find(d => d.key === this.settings.get_string('default-disk')) ?? this.disks[0];
        if (!disk)
            return;
        this.selectedKey = disk.key;
        this.main.visible_child_name = 'disk';
        this.contentPage.title = fmt.displayName(this.settings, disk);
        const row = this.rows.get(disk.key);
        if (row && this.mode === 'disk' && this.list.get_selected_row() !== row.row)
            this.list.select_row(row.row);

        const tab = this.stack.visible_child_name ?? 'overview';
        const sig = [disk.key, tab, disk.smart_updated, disk.smart?.standby, disk.self_test?.running,
            disk.last_request?.at, (disk.usage?.days ?? []).length, getLanguage()].join('|');
        if (sig !== this.signature) {
            this.signature = sig;
            this.live = [];
            for (const box of Object.values(this.pages))
                clear(box);
            const fn = {overview: this._overview, smart: this._smart, usage: this._usage, tests: this._tests, fs: this._fs}[tab];
            fn?.call(this, this.pages[tab], disk);
        } else {
            for (const f of this.live)
                f(disk);
        }
    }

    _renderSidebar() {
        const keys = this.disks.map(d => d.key).join('|');
        if (keys !== this.rowKeys) {
            this.rowKeys = keys;
            clear(this.list);
            this.rows.clear();
            for (const d of this.disks) {
                const r = new DiskRow();
                this.rows.set(d.key, r);
                this.list.append(r.row);
            }
        }
        for (const d of this.disks)
            this.rows.get(d.key)?.update(d, this.settings);

        if (this.status === 'missing')
            this.footer.label = _('Collector service is not running');
        else if (this.status === 'stale')
            this.footer.label = _('Data is outdated — the collector may have stopped');
        else
            this.footer.label = `${_('{n} disks', {n: this.disks.length})} · ${_('updated {t}', {t: fmt.ago(this.generated)})}`;
    }

    // -------------------------------------------------------------- overview
    _overview(page, disk) {
        const settings = this.settings;
        const unit = this.unit;
        const h = disk.health ?? {};

        // hero
        const hero = hbox(18, ['card', 'lh-hero']);
        hero.append(new Gtk.Image({icon_name: fmt.kindIcon(disk), pixel_size: 64, valign: Gtk.Align.CENTER}));
        const titles = vbox(6);
        titles.hexpand = true;
        titles.valign = Gtk.Align.CENTER;
        titles.append(lbl(fmt.displayName(settings, disk), ['title-1'], {wrap: true}));
        const badges = hbox(6);
        badges.append(badge(fmt.kindLabel(disk), 'kind'));
        badges.append(badge(fmt.bytes(disk.capacity)));
        badges.append(badge(disk.path ?? disk.name));
        if (disk.bus === 'usb')
            badges.append(badge(_('USB')));
        if ((disk.btrfs ?? []).length)
            badges.append(badge('btrfs'));
        if (disk.smart?.standby)
            badges.append(badge(_('Standby')));
        titles.append(badges);
        hero.append(titles);
        const ringBox = vbox(4);
        ringBox.valign = Gtk.Align.CENTER;
        const ring = makeRing(104);
        ring.setValue(h.score, h.level);
        ringBox.append(ring);
        const lvl = lbl(fmt.levelLabel(h.level), ['heading'], {xalign: 0.5});
        setLevel(lvl, h.level);
        ringBox.append(lvl);
        hero.append(ringBox);
        page.append(hero);

        // issues
        const issues = h.issues ?? [];
        const issueBox = vbox(6);
        if (!issues.length)
            issueBox.append(this._issue('good', 'emblem-ok-symbolic', _('No problems found')));
        for (const i of issues) {
            const icon = {critical: 'dialog-error-symbolic', warning: 'dialog-warning-symbolic'}[i.severity] ?? 'dialog-information-symbolic';
            issueBox.append(this._issue(i.severity, icon, fmt.issueText(i, unit)));
        }
        page.append(issueBox);

        // tiles
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, max_children_per_line: 4, min_children_per_line: 2,
            column_spacing: 12, row_spacing: 12,
        });
        const tempTile = this._tile('lh-thermometer-symbolic', _('Temperature'), '', '');
        const updTemp = d => {
            const t = d.temperature ?? {};
            tempTile.value.label = typeof t.current === 'number' ? fmt.temp(t.current, unit) : (t.standby ? '💤' : '—');
            setLevel(tempTile.value, fmt.tempLevel(settings, d));
            tempTile.sub.label = t.standby ? _('Sleeping (not woken up)') : t.source ? _('source: {s}', {s: t.source}) : '';
        };
        updTemp(disk);
        this.live.push(updTemp);
        flow.append(tempTile.box);
        flow.append(this._tile('lh-clock-symbolic', _('Power-on time'), fmt.hours(disk.power_on_hours), fmt.duration(disk.power_on_hours)).box);
        const life = disk.life_remaining;
        flow.append(this._tile('lh-life-symbolic', _('Life remaining'), typeof life === 'number' ? fmt.percent(life) : '—', '',
            typeof life === 'number' ? (life <= 10 ? 'critical' : life <= 30 ? 'warning' : 'good') : null).box);
        const [smText, smSub, smLevel] = fmt.smartStatus(disk);
        flow.append(this._tile('lh-heart-symbolic', _('SMART status'), smText, smSub, smLevel).box);
        flow.append(this._tile('lh-write-symbolic', _('Data written'), fmt.bytes(disk.data_written, disk.data_approx),
            disk.usage?.today_written ? `${_('Today')}: ${fmt.bytes(disk.usage.today_written)}` : '').box);
        flow.append(this._tile('lh-read-symbolic', _('Data read'), fmt.bytes(disk.data_read, disk.data_approx), '').box);
        flow.append(this._tile('lh-power-symbolic', _('Power cycles'), fmt.num(disk.power_cycles), '').box);
        flow.append(this._tile('drive-harddisk-symbolic', _('Capacity'), fmt.bytes(disk.capacity), disk.name).box);
        page.append(flow);

        // partitions (compact)
        if (fmt.partitionSegments(disk).length) {
            const pc = vbox(10, ['card', 'lh-card-pad']);
            const ph = hbox(8);
            ph.append(lbl(_('Partitions'), ['heading'], {hexpand: true}));
            ph.append(badge(_('{n} partitions', {n: fmt.num(disk.partitions.count)})));
            ph.append(badge(fmt.partitionTableName(disk.partitions.table)));
            pc.append(ph);
            const bar = makePartitionBar(56);
            bar.setDisk(disk);
            pc.append(bar);
            pc.append(this._partitionList(disk, false));
            page.append(pc);
        }

        // temperature chart
        const chartCard = vbox(10, ['card', 'lh-card-pad']);
        chartCard.append(lbl(`${_('Temperature')} — ${_('Last 24 hours')}`, ['heading']));
        const chart = makeTempChart(() => this.unit);
        chartCard.append(chart);
        const stats = hbox(12);
        stats.homogeneous = true;
        const mk = cap => {
            const b = vbox(0);
            b.append(lbl(cap, ['caption', 'dim-label']));
            const v = lbl('', ['heading', 'numeric']);
            b.append(v);
            stats.append(b);
            return v;
        };
        const sNow = mk(_('Now')), sMin = mk(_('Min 24h')), sMax = mk(_('Max 24h')), sLife = mk(_('Lifetime max'));
        chartCard.append(stats);
        const updChart = d => {
            const t = d.temperature ?? {};
            const l = fmt.tempLevel(settings, d);
            chart.setData(t.history, l === 'ok' ? 'good' : l);
            sNow.label = fmt.temp(t.current, unit);
            sMin.label = fmt.temp(t.min_24h, unit);
            sMax.label = fmt.temp(t.max_24h, unit);
            sLife.label = fmt.temp(t.lifetime_max, unit);
        };
        updChart(disk);
        this.live.push(updChart);
        page.append(chartCard);

        // information
        const info = new Adw.PreferencesGroup({title: _('Information')});
        const rows = [
            [_('Model'), disk.model],
            [_('Family'), disk.model_family],
            [_('Serial'), disk.serial],
            [_('Firmware'), disk.firmware],
            [_('Capacity'), disk.capacity ? `${fmt.bytes(disk.capacity)} (${fmt.num(disk.capacity)} B)` : null],
            [_('Interface'), [disk.protocol, disk.bus?.toUpperCase(), disk.sata_version, disk.nvme_version && `NVMe ${disk.nvme_version}`, disk.transport]
                .filter(Boolean).join(' · ') || null],
            [_('Link speed'), disk.link_speed],
            [_('Form factor'), disk.form_factor],
            [_('Rotation'), typeof disk.rotation_rate === 'number'
                ? (disk.rotation_rate > 0 ? _('{n} rpm', {n: fmt.num(disk.rotation_rate)}) : _('Solid state')) : null],
            [_('Device'), disk.path],
        ];
        for (const [k, v] of rows)
            if (v)
                info.add(propRow(k, v));
        page.append(info);

        // set default disk
        const isDefault = this.settings.get_string('default-disk') === disk.key;
        const def = new Gtk.Button({
            label: isDefault ? `★ ${_('Default disk')}` : _('Set as default disk'),
            css_classes: ['pill'], halign: Gtk.Align.CENTER, sensitive: !isDefault,
        });
        def.connect('clicked', () => this.settings.set_string('default-disk', disk.key));
        page.append(def);
    }

    _issue(severity, iconName, text) {
        const b = hbox(10, ['lh-issue', severity]);
        const icon = new Gtk.Image({icon_name: iconName});
        setLevel(icon, severity === 'info' ? null : severity);
        b.append(icon);
        b.append(lbl(text, [], {wrap: true, hexpand: true}));
        return b;
    }

    _tile(iconName, caption, value, sub, level = null) {
        const box = vbox(4, ['card', 'lh-tile']);
        const head = hbox(6);
        head.append(new Gtk.Image({icon_name: iconName, css_classes: ['dim-label']}));
        head.append(lbl(caption, ['caption', 'dim-label'], {ellipsize: Pango.EllipsizeMode.END}));
        box.append(head);
        const v = lbl(value, ['lh-tile-value', 'numeric'], {ellipsize: Pango.EllipsizeMode.END});
        if (level)
            setLevel(v, level);
        box.append(v);
        const s = lbl(sub, ['caption', 'dim-label'], {ellipsize: Pango.EllipsizeMode.END});
        box.append(s);
        return {box, value: v, sub: s};
    }

    // -------------------------------------------------------------- smart
    _smart(page, disk) {
        const attrs = disk.attributes ?? [];
        let any = false;
        if (attrs.length) {
            any = true;
            const card = vbox(8, ['card', 'lh-card-pad']);
            card.append(lbl('SMART', ['heading']));
            const grid = new Gtk.Grid({column_spacing: 18, row_spacing: 6});
            const heads = ['ID', 'Attribute', 'Value', 'Worst', 'Threshold', 'Raw', 'Status'];
            heads.forEach((t, i) => grid.attach(lbl(_(t), ['caption', 'dim-label']), i, 0, 1, 1));
            const stName = {ok: 'OK', warn: 'Watch', failing: 'Failing', info: 'Info'};
            const stLevel = {ok: 'good', warn: 'warning', failing: 'critical', info: null};
            attrs.forEach((a, r) => {
                const y = r + 1;
                grid.attach(lbl(fmt.num(a.id), ['numeric']), 0, y, 1, 1);
                grid.attach(lbl((a.name ?? '').replace(/_/g, ' '), [], {hexpand: true, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 34}), 1, y, 1, 1);
                grid.attach(lbl(fmt.num(a.value), ['numeric']), 2, y, 1, 1);
                grid.attach(lbl(fmt.num(a.worst), ['numeric']), 3, y, 1, 1);
                grid.attach(lbl(fmt.num(a.thresh), ['numeric']), 4, y, 1, 1);
                grid.attach(lbl(String(a.raw ?? '—'), ['numeric'], {ellipsize: Pango.EllipsizeMode.END, max_width_chars: 22, selectable: true}), 5, y, 1, 1);
                const s = lbl(_(stName[a.status] ?? 'OK'), ['caption-heading']);
                setLevel(s, stLevel[a.status]);
                grid.attach(s, 6, y, 1, 1);
            });
            const scroll = new Gtk.ScrolledWindow({
                hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER,
                propagate_natural_height: true, child: grid,
            });
            card.append(scroll);
            page.append(card);
        }

        const nv = disk.nvme;
        if (nv) {
            any = true;
            const unit = this.unit;
            const g = new Adw.PreferencesGroup({title: _('NVMe health log')});
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
                [_('Media errors'), fmt.num(nv.media_errors), nv.media_errors ? 'warning' : 'good'],
                [_('Error log entries'), fmt.num(nv.num_err_log_entries)],
                [_('Warning temp time'), _('{n} min', {n: fmt.num(nv.warning_temp_time)})],
                [_('Critical temp time'), _('{n} min', {n: fmt.num(nv.critical_comp_time)})],
            ];
            (nv.temperature_sensors ?? []).forEach((v, i) => rows.push([`${_('Temperature')} ${fmt.num(i + 1)}`, fmt.temp(v, unit)]));
            for (const [k, v, l] of rows)
                g.add(propRow(k, v, l));
            page.append(g);
        }

        const sc = disk.scsi;
        if (sc) {
            any = true;
            const g = new Adw.PreferencesGroup({title: _('SAS / SCSI counters')});
            const pair = e => e ? `${fmt.num(e.corrected)} / ${fmt.num(e.uncorrected)}` : '—';
            g.add(propRow(_('Grown defects'), fmt.num(sc.grown_defects), sc.grown_defects ? 'warning' : 'good'));
            g.add(propRow(_('Read: corrected / uncorrected'), pair(sc.read), sc.read?.uncorrected ? 'warning' : null));
            g.add(propRow(_('Write: corrected / uncorrected'), pair(sc.write), sc.write?.uncorrected ? 'warning' : null));
            g.add(propRow(_('Verify: corrected / uncorrected'), pair(sc.verify), sc.verify?.uncorrected ? 'warning' : null));
            g.add(propRow(_('Start/stop cycles'), fmt.num(sc.start_stop_cycles)));
            g.add(propRow(_('Load/unload cycles'), fmt.num(sc.load_unload_cycles)));
            page.append(g);
        }

        if (!any) {
            const failed = disk.smart?.error === 'read_failed';
            page.append(new Adw.StatusPage({
                icon_name: failed ? 'dialog-warning-symbolic' : 'drive-harddisk-symbolic',
                title: failed ? _('SMART data cannot be read') : _('No SMART attributes'),
                description: failed
                    ? fmt.issueText({code: 'smart_read_failed', params: {}})
                    : disk.smart?.standby ? _('Disk is asleep — press “Refresh now”') : '',
            }));
            if (disk.smart?.error_detail) {
                const card = vbox(6, ['card', 'lh-card-pad']);
                card.append(lbl(_('Commands tried'), ['heading']));
                card.append(lbl(disk.smart.error_detail, ['monospace', 'caption'], {selectable: true, wrap: true, xalign: 0}));
                page.append(card);
            }
        }
    }

    // -------------------------------------------------------------- usage
    _usage(page, disk) {
        const usage = disk.usage ?? {days: []};
        const days = usage.days ?? [];
        const withHours = days.filter(d => typeof d.hours === 'number');
        const avg = withHours.length ? withHours.reduce((a, d) => a + d.hours, 0) / withHours.length : null;

        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, max_children_per_line: 4, min_children_per_line: 2,
            column_spacing: 12, row_spacing: 12,
        });
        flow.append(this._tile('lh-clock-symbolic', _('Power-on hours'), fmt.hours(disk.power_on_hours), fmt.duration(disk.power_on_hours)).box);
        flow.append(this._tile('x-office-calendar-symbolic', _('Today'), typeof usage.today_hours === 'number' ? fmt.hours(usage.today_hours) : '—', '').box);
        flow.append(this._tile('view-continuous-symbolic', _('Average per day'), avg === null ? '—' : _('{h} h', {h: fmt.num(avg, 1)}), '').box);
        flow.append(this._tile('lh-write-symbolic', _('Data written'), fmt.bytes(disk.data_written, disk.data_approx),
            usage.today_written ? `${_('Today')}: ${fmt.bytes(usage.today_written)}` : '').box);
        page.append(flow);

        const c1 = vbox(10, ['card', 'lh-card-pad']);
        c1.append(lbl(_('Hours per day'), ['heading']));
        c1.append(barChart(days.map(d => [d.date, d.hours]), v => fmt.num(v), 24));
        page.append(c1);
        if (days.some(d => typeof d.written === 'number')) {
            const c2 = vbox(10, ['card', 'lh-card-pad']);
            c2.append(lbl(_('Written per day'), ['heading']));
            c2.append(barChart(days.map(d => [d.date, d.written]), v => fmt.bytes(v), 0));
            page.append(c2);
        }
        page.append(lbl(_('Usage history fills in day by day.'), ['caption', 'dim-label'], {wrap: true}));
    }

    // -------------------------------------------------------------- tests
    _tests(page, disk) {
        const st = disk.self_test ?? {};
        page.append(lbl(_('Short test takes about 2 minutes, extended can take hours. The disk stays usable.'), ['dim-label'], {wrap: true}));

        if (st.running) {
            const card = vbox(8, ['card', 'lh-card-pad']);
            card.append(lbl(`${_('Test in progress')}${typeof st.remaining === 'number' ? ` — ${_('{p}% remaining', {p: fmt.num(st.remaining)})}` : ''}`, ['heading']));
            const bar = new Gtk.ProgressBar({fraction: typeof st.remaining === 'number' ? (100 - st.remaining) / 100 : 0.05});
            card.append(bar);
            page.append(card);
        }

        const btns = hbox(10);
        btns.halign = Gtk.Align.START;
        const can = !!disk.smart?.available && !disk.smart?.standby;
        const mk = (text, req, css) => {
            const b = new Gtk.Button({label: text, css_classes: ['pill', ...css], sensitive: can});
            b.connect('clicked', () => this.request({...req, disk: disk.key}));
            btns.append(b);
        };
        if (st.running) {
            mk(_('Abort test'), {action: 'abort'}, ['destructive-action']);
        } else {
            mk(_('Run short test'), {action: 'selftest', type: 'short'}, ['suggested-action']);
            mk(_('Run extended test'), {action: 'selftest', type: 'long'}, []);
        }
        page.append(btns);

        const lr = disk.last_request;
        if (lr) {
            const l = lbl(_('Last request: {r}', {r: `${lr.action}${lr.type ? ` (${lr.type})` : ''} — ${lr.ok ? _('accepted') : _('rejected')} · ${fmt.ago(lr.at)}`}),
                ['caption'], {wrap: true});
            setLevel(l, lr.ok ? null : 'warning');
            page.append(l);
        }

        const tests = disk.self_tests ?? [];
        const g = new Adw.PreferencesGroup({title: _('Self-tests')});
        if (!tests.length)
            g.add(new Adw.ActionRow({title: _('No self-tests recorded')}));
        for (const t of tests) {
            const row = new Adw.ActionRow({title: t.type ?? '—', subtitle: t.status ?? ''});
            const icon = new Gtk.Image({
                icon_name: t.passed === true ? 'emblem-ok-symbolic' : t.passed === false ? 'dialog-error-symbolic' : 'dialog-question-symbolic',
            });
            setLevel(icon, t.passed === true ? 'good' : t.passed === false ? 'critical' : null);
            row.add_prefix(icon);
            row.add_suffix(lbl(`${_('At hour')} ${fmt.num(t.hours)}`, ['dim-label', 'numeric']));
            g.add(row);
        }
        page.append(g);
    }

    // -------------------------------------------------------------- file systems
    _partitionList(disk, detailed) {
        const box = vbox(detailed ? 10 : 6);
        for (const sg of fmt.partitionSegments(disk)) {
            const row = hbox(12, detailed ? ['card', 'lh-card-pad'] : []);
            row.append(colorSwatch(sg.color, detailed ? 18 : 12));
            const texts = vbox(3);
            texts.hexpand = true;
            const title = lbl(fmt.partitionTitle(sg), detailed ? ['heading'] : [], {ellipsize: Pango.EllipsizeMode.END});
            texts.append(title);
            const sub = sg.kind === 'free'
                ? [fmt.bytes(sg.size)]
                : [sg.name, fmt.partitionFs(sg), fmt.bytes(sg.size), detailed ? sg.type_name : null].filter(Boolean);
            texts.append(lbl(sub.join(' · '), ['caption', 'dim-label'], {ellipsize: Pango.EllipsizeMode.END}));
            const u = sg.kind === 'part' ? fmt.partitionUsage(sg) : null;
            if (detailed) {
                if (sg.kind === 'part') {
                    if (sg.fstype === 'crypto_LUKS')
                        texts.append(lbl(`🔒 ${_('Encrypted')} (LUKS)${(sg.inner ?? []).length ? '' : ` — ${_('Not mounted')}`}`, ['caption']));
                    const mounts = [...(sg.mounts ?? []), ...(sg.inner ?? []).flatMap(i => i.mounts ?? [])];
                    texts.append(lbl(`${_('Mounted at')}: ${mounts.length ? mounts.join(', ') : _('Not mounted')}`, ['caption']));
                    const labels = [sg.label, sg.partlabel, ...(sg.inner ?? []).map(i => i.label)].filter(Boolean);
                    if (labels.length)
                        texts.append(lbl(`${_('Label')}: ${[...new Set(labels)].join(' · ')}`, ['caption', 'dim-label']));
                }
                if (u) {
                    const pct = u.used / u.size;
                    texts.append(new Gtk.ProgressBar({fraction: Math.min(1, pct), margin_top: 4}));
                    const l = lbl(`${_('used {u} of {s}', {u: fmt.bytes(u.used), s: fmt.bytes(u.size)})} (${fmt.percent(Math.round(pct * 100))})`, ['caption']);
                    setLevel(l, pct >= 0.95 ? 'critical' : pct >= 0.85 ? 'warning' : null);
                    texts.append(l);
                }
            }
            row.append(texts);
            if (!detailed && u) {
                const pct = Math.round(100 * u.used / u.size);
                const l = lbl(fmt.percent(pct), ['caption', 'numeric'], {valign: Gtk.Align.CENTER});
                setLevel(l, pct >= 95 ? 'critical' : pct >= 85 ? 'warning' : null);
                row.append(l);
            }
            box.append(row);
        }
        return box;
    }

    _fs(page, disk) {
        const lay = disk.partitions;
        if (lay) {
            const head = vbox(10, ['card', 'lh-card-pad']);
            const ph = hbox(8);
            ph.append(lbl(_('Partitions'), ['title-4'], {hexpand: true}));
            ph.append(badge(_('{n} partitions', {n: fmt.num(lay.count)})));
            ph.append(badge(`${_('Partition table')}: ${fmt.partitionTableName(lay.table)}`));
            ph.append(badge(fmt.bytes(lay.size)));
            head.append(ph);
            const bar = makePartitionBar(76);
            bar.setDisk(disk);
            head.append(bar);
            page.append(head);
            if (fmt.partitionSegments(disk).length)
                page.append(this._partitionList(disk, true));
            else
                page.append(new Adw.StatusPage({icon_name: 'drive-multidisk-symbolic', title: _('No partitions')}));
        }
        const fss = lay ? [] : disk.filesystems ?? [];
        if (!lay && !fss.length)
            page.append(new Adw.StatusPage({icon_name: 'folder-symbolic', title: _('No file systems')}));
        for (const f of fss) {
            const card = vbox(6, ['card', 'lh-card-pad']);
            const top = hbox(8);
            top.append(lbl(f.mounts?.length ? f.mounts.join(', ') : _('Not mounted'), ['heading'], {hexpand: true, ellipsize: Pango.EllipsizeMode.END}));
            top.append(badge(f.fstype ?? '?', 'kind'));
            card.append(top);
            const sub = [f.name, f.label].filter(Boolean).join(' · ');
            if (sub)
                card.append(lbl(sub, ['caption', 'dim-label']));
            if (f.size && typeof f.used === 'number') {
                const pct = f.used / f.size;
                card.append(new Gtk.ProgressBar({fraction: Math.min(1, pct)}));
                const l = lbl(`${_('used {u} of {s}', {u: fmt.bytes(f.used), s: fmt.bytes(f.size)})} (${fmt.percent(Math.round(pct * 100))})`, ['caption']);
                setLevel(l, pct >= 0.95 ? 'critical' : pct >= 0.85 ? 'warning' : null);
                card.append(l);
            }
            page.append(card);
        }

        for (const b of disk.btrfs ?? []) {
            const g = new Adw.PreferencesGroup({title: `btrfs — ${b.mount}`, description: _('btrfs device errors')});
            for (const dv of b.devices ?? []) {
                const names = [['write_io_errs', 'Write errors'], ['read_io_errs', 'Read errors'], ['flush_io_errs', 'Flush errors'],
                    ['corruption_errs', 'Corruption errors'], ['generation_errs', 'Generation errors']];
                for (const [k, t] of names)
                    g.add(propRow(`${_(t)} — ${dv.device}`, fmt.num(dv[k]), dv[k] ? 'critical' : 'good'));
            }
            if (b.scrub) {
                if (b.scrub.started)
                    g.add(propRow(_('Last scrub'), b.scrub.started));
                if (b.scrub.status)
                    g.add(propRow(_('Status'), b.scrub.status));
                if (b.scrub.errors)
                    g.add(propRow(_('Result'), b.scrub.errors, /no errors/i.test(b.scrub.errors) ? 'good' : 'warning'));
            }
            page.append(g);
        }
    }
}

// ------------------------------------------------------------------ live activity (htop for disks)

const ACTIVITY_PATH = '/run/diskguardian/activity.json';
const RW = {read: [0.20, 0.82, 0.48], write: [0.96, 0.60, 0.20]};

function rate(v) {
    return `${fmt.bytes(v ?? 0)}/s`;
}

function makeActivityChart() {
    const area = new Gtk.DrawingArea({content_height: 110, hexpand: true});
    area.add_css_class('caption');
    area._hist = [];
    area.set_draw_func((a, cr, w, h) => {
        const fg = widgetColor(a);
        const hist = a._hist;
        const padT = 16, padB = 4;
        const peak = Math.max(1e6, ...hist.map(p => Math.max(p[1], p[2])));
        const X = i => w - (hist.length - 1 - i) * w / 59;   // newest sample on the right edge
        const Y = v => padT + (1 - v / peak) * (h - padT - padB);
        // grid
        cr.setLineWidth(1);
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.08);
        for (let i = 0; i <= 2; i++) {
            const y = Math.round(padT + i * (h - padT - padB) / 2) + 0.5;
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }
        // busy % as soft background columns
        hist.forEach((p, i) => {
            if (p[3] > 0) {
                cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.06 + 0.12 * p[3] / 100);
                const x = X(i);
                const bw = w / 59;
                cr.rectangle(x - bw / 2, h - padB - (h - padT - padB) * p[3] / 100, bw, (h - padT - padB) * p[3] / 100);
                cr.fill();
            }
        });
        for (const [idx, key] of [[1, 'read'], [2, 'write']]) {
            if (hist.length < 2)
                continue;
            const [R, G, B] = RW[key];
            cr.moveTo(X(0), Y(hist[0][idx]));
            hist.forEach((p, i) => cr.lineTo(X(i), Y(p[idx])));
            cr.setSourceRGBA(R, G, B, 1);
            cr.setLineWidth(2);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.stroke();
        }
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.55);
        drawText(cr, a, rate(peak), 4, 8, 'left');
        drawText(cr, a, localizeDigits('60s'), w - 4, 8, 'right');
        cr.$dispose();
    });
    area.setData = hist => {
        area._hist = (hist ?? []).slice(-60);
        area.queue_draw();
    };
    return area;
}

class ActivityDiskCard {
    constructor() {
        this.box = vbox(10, ['card', 'lh-card-pad']);
        const top = hbox(10);
        this.icon = new Gtk.Image({pixel_size: 24});
        top.append(this.icon);
        const titles = vbox(0);
        titles.hexpand = true;
        this.title = lbl('', ['heading'], {ellipsize: Pango.EllipsizeMode.END});
        this.sub = lbl('', ['caption', 'dim-label']);
        titles.append(this.title);
        titles.append(this.sub);
        top.append(titles);
        this.temp = lbl('', ['heading', 'numeric']);
        top.append(this.temp);
        this.box.append(top);

        const grid = new Gtk.Grid({column_spacing: 12, row_spacing: 6});
        const meter = (row, caption, css) => {
            grid.attach(lbl(caption, ['caption', 'dim-label']), 0, row, 1, 1);
            const bar = new Gtk.ProgressBar({hexpand: true, valign: Gtk.Align.CENTER, css_classes: [css]});
            grid.attach(bar, 1, row, 1, 1);
            const val = lbl('', ['numeric', 'heading'], {xalign: 1, width_chars: 11});
            grid.attach(val, 2, row, 1, 1);
            return [bar, val];
        };
        [this.rBar, this.rVal] = meter(0, _('Read'), 'lh-pb-read');
        [this.wBar, this.wVal] = meter(1, _('Write'), 'lh-pb-write');
        [this.uBar, this.uVal] = meter(2, _('Busy'), 'lh-pb-busy');
        this.box.append(grid);

        this.stats = lbl('', ['caption', 'numeric', 'dim-label'], {wrap: true});
        this.box.append(this.stats);
        this.chart = makeActivityChart();
        this.box.append(this.chart);
    }

    update(a, disk, settings) {
        this.icon.icon_name = disk ? fmt.kindIcon(disk) : 'drive-harddisk-symbolic';
        this.title.label = disk ? fmt.displayName(settings, disk) : a.name;
        this.sub.label = [a.name, disk ? fmt.kindLabel(disk) : null, disk ? fmt.bytes(disk.capacity) : null].filter(Boolean).join(' · ');
        const t = disk?.temperature;
        this.temp.label = typeof t?.current === 'number' ? fmt.temp(t.current, settings.get_string('temp-unit')) : (t?.standby ? '💤' : '');
        if (disk)
            setLevel(this.temp, fmt.tempLevel(settings, disk));
        const peak = Math.max(1e6, ...(a.history ?? []).map(p => Math.max(p[1], p[2])));
        this.rBar.fraction = Math.min(1, (a.read_bps ?? 0) / peak);
        this.wBar.fraction = Math.min(1, (a.write_bps ?? 0) / peak);
        this.uBar.fraction = Math.min(1, (a.util ?? 0) / 100);
        this.rVal.label = rate(a.read_bps);
        this.wVal.label = rate(a.write_bps);
        this.uVal.label = fmt.percent(Math.round(a.util ?? 0));
        setLevel(this.uVal, a.util >= 90 ? 'critical' : a.util >= 60 ? 'warning' : null);
        this.stats.label = [
            `${_('IOPS')} ${fmt.num(a.read_iops)} / ${fmt.num(a.write_iops)}`,
            `${_('Latency')} ${fmt.num(a.await_read, 1)} / ${fmt.num(a.await_write, 1)} ${_('ms')}`,
            `${_('Queue')} ${fmt.num(a.queue, 2)}`,
            `${_('In flight')} ${fmt.num(a.in_flight)}`,
            `${_('Since boot')} ↓${fmt.bytes(a.read_total)} ↑${fmt.bytes(a.write_total)}`,
        ].join('   ·   ');
        this.chart.setData(a.history);
    }
}

const PROC_COLS = [
    // key, title, width_chars, align
    ['pid', 'PID', 7, 1],
    ['user', 'User', 10, 0],
    ['comm', 'Process', 0, 0],
    ['read_bps', 'Read/s', 10, 1],
    ['write_bps', 'Write/s', 10, 1],
    ['read_bytes', 'Total read', 10, 1],
    ['write_bytes', 'Total written', 10, 1],
];

class ActivityView {
    constructor(win) {
        this.win = win;
        this.sortKey = 'io';
        this.desc = true;
        this.activeOnly = true;
        this.filter = '';
        this.cards = new Map();
        this.rows = [];
        this.timers = [];
        this.reqError = null;
        this.data = null;

        const box = vbox(18);
        box.set_margin_top(24);
        box.set_margin_bottom(24);
        box.set_margin_start(18);
        box.set_margin_end(18);
        const clamp = new Adw.Clamp({maximum_size: 1100, tightening_threshold: 700, child: box});
        this.widget = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, child: clamp});

        // summary
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, max_children_per_line: 4, min_children_per_line: 2,
            column_spacing: 12, row_spacing: 12,
        });
        this.tRead = win._tile('lh-read-symbolic', _('Total read'), '—', _('all disks'));
        this.tWrite = win._tile('lh-write-symbolic', _('Total write'), '—', _('all disks'));
        this.tBusy = win._tile('drive-harddisk-symbolic', _('Busiest disk'), '—', '');
        this.tProcs = win._tile('system-run-symbolic', _('Active processes'), '—', '');
        for (const t of [this.tRead, this.tWrite, this.tBusy, this.tProcs])
            flow.append(t.box);
        box.append(flow);

        this.diskBox = vbox(12);
        box.append(this.diskBox);

        // processes
        const pcard = vbox(8, ['card', 'lh-card-pad']);
        const ptop = hbox(10);
        ptop.append(lbl(_('Processes using the disks'), ['heading'], {hexpand: true}));
        const search = new Gtk.SearchEntry({placeholder_text: _('Filter'), width_chars: 14});
        search.connect('search-changed', () => {
            this.filter = search.text.toLowerCase();
            this.renderProcs();
        });
        ptop.append(search);
        const activeSw = new Gtk.Switch({active: true, valign: Gtk.Align.CENTER});
        activeSw.connect('notify::active', () => {
            this.activeOnly = activeSw.active;
            this.renderProcs();
        });
        ptop.append(lbl(_('Only active'), ['caption']));
        ptop.append(activeSw);
        pcard.append(ptop);

        const head = hbox(8, ['lh-proc-head']);
        this.headButtons = new Map();
        for (const [key, title, chars, align] of PROC_COLS) {
            const b = new Gtk.Button({css_classes: ['flat', 'lh-colhead'], hexpand: chars === 0});
            const l = lbl(_(title), ['caption-heading'], {xalign: align, width_chars: chars || -1});
            b.set_child(l);
            b._label = l;
            b._title = _(title);
            b.connect('clicked', () => {
                if (this.sortKey === key) {
                    this.desc = !this.desc;
                } else {
                    this.sortKey = key;
                    this.desc = !(key === 'comm' || key === 'user' || key === 'pid');
                }
                this.renderProcs();
            });
            this.headButtons.set(key, b);
            head.append(b);
        }
        pcard.append(head);
        this.procBox = vbox(0);
        pcard.append(this.procBox);
        this.procMsg = lbl('', ['dim-label'], {wrap: true, xalign: 0.5});
        this.procMsg.set_margin_top(12);
        this.procMsg.set_margin_bottom(12);
        pcard.append(this.procMsg);
        box.append(pcard);

        box.append(lbl(_('Tip: run “sudo dg-top” in a terminal for the same view in htop style.'), ['caption', 'dim-label'], {wrap: true}));
    }

    start() {
        this.stop();
        this.heartbeat();
        this.poll();
        this.timers.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this.poll();
            return GLib.SOURCE_CONTINUE;
        }));
        this.timers.push(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this.heartbeat();
            return GLib.SOURCE_CONTINUE;
        }));
    }

    stop() {
        for (const id of this.timers)
            GLib.source_remove(id);
        this.timers = [];
    }

    async heartbeat() {
        const res = await this.win.request({action: 'activity'}, true);
        this.reqError = res === true ? null : res;
    }

    async poll() {
        try {
            const [bytes] = await Gio.File.new_for_path(ACTIVITY_PATH).load_contents_async(null);
            this.data = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            if (e instanceof SyntaxError)
                return;
            this.data = null;
        }
        this.render();
    }

    render() {
        const settings = this.win.settings;
        const data = this.data;
        if (!data || Date.now() / 1000 - (data.generated ?? 0) > 10) {
            this.tRead.value.label = '—';
            this.tWrite.value.label = '—';
            this.procMsg.label = _('Collector service is not running');
            this.procMsg.visible = true;
            return;
        }
        const disks = data.disks ?? [];
        this.tRead.value.label = rate(data.totals?.read_bps);
        this.tWrite.value.label = rate(data.totals?.write_bps);
        const busiest = [...disks].sort((a, b) => b.util - a.util)[0];
        this.tBusy.value.label = busiest && busiest.util > 0 ? fmt.percent(Math.round(busiest.util)) : '—';
        this.tBusy.sub.label = busiest && busiest.util > 0 ? busiest.name : _('idle');
        this.win.activitySubtitle(`↓${rate(data.totals?.read_bps)}  ↑${rate(data.totals?.write_bps)}`);

        // disk cards (in place, no flicker)
        const names = disks.map(d => d.name).join('|');
        if (names !== this._names) {
            this._names = names;
            clear(this.diskBox);
            this.cards.clear();
            for (const d of disks) {
                const c = new ActivityDiskCard();
                this.cards.set(d.name, c);
                this.diskBox.append(c.box);
            }
        }
        for (const d of disks)
            this.cards.get(d.name)?.update(d, this.win.disks.find(x => x.name === d.name), settings);

        const p = data.processes;
        this.tProcs.value.label = p ? fmt.num(p.active) : '—';
        this.tProcs.sub.label = p ? _('of {n} processes', {n: fmt.num(p.total)}) : '';
        this.renderProcs();
    }

    renderProcs() {
        for (const [key, b] of this.headButtons) {
            const on = key === this.sortKey || (this.sortKey === 'io' && key === 'read_bps');
            b._label.label = on ? `${b._title} ${this.desc ? '▼' : '▲'}` : b._title;
        }
        const p = this.data?.processes;
        if (!p) {
            this.rows.forEach(r => (r.box.visible = false));
            this.procMsg.label = this.reqError
                ? `${this.reqError}\n${_('The process list needs the collector and membership in the sudo group.')}`
                : _('Collecting… (the first values appear after two seconds)');
            this.procMsg.visible = true;
            return;
        }
        let list = p.list ?? [];
        if (this.activeOnly)
            list = list.filter(x => x.read_bps || x.write_bps);
        if (this.filter)
            list = list.filter(x => `${x.comm} ${x.cmd} ${x.user} ${x.pid}`.toLowerCase().includes(this.filter));
        const k = this.sortKey;
        const val = x => k === 'io' ? x.read_bps + x.write_bps : x[k];
        list.sort((a, b) => {
            const va = val(a), vb = val(b);
            const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
            return this.desc ? -c : c;
        });
        list = list.slice(0, 50);

        while (this.rows.length < list.length) {
            const row = hbox(8, ['lh-proc-row']);
            const cells = PROC_COLS.map(([, , chars, align]) => {
                const l = lbl('', ['numeric'], {xalign: align, width_chars: chars || -1, hexpand: chars === 0,
                    ellipsize: Pango.EllipsizeMode.END, max_width_chars: chars || 60});
                l.set_margin_start(10);
                l.set_margin_end(10);
                row.append(l);
                return l;
            });
            this.procBox.append(row);
            this.rows.push({box: row, cells});
        }
        this.rows.forEach((r, i) => {
            const x = list[i];
            r.box.visible = !!x;
            if (!x)
                return;
            const [cPid, cUser, cComm, cR, cW, cRT, cWT] = r.cells;
            cPid.label = fmt.num(x.pid);
            cUser.label = x.user;
            cComm.label = x.comm;
            r.box.tooltip_text = x.cmd;
            cR.label = x.read_bps ? rate(x.read_bps) : '—';
            cW.label = x.write_bps ? rate(x.write_bps) : '—';
            cRT.label = fmt.bytes(x.read_bytes);
            cWT.label = fmt.bytes(x.write_bytes);
            setLevel(cR, x.read_bps ? 'good' : null);
            setLevel(cW, x.write_bps ? 'warning' : null);
            for (const c of r.cells)
                c.opacity = x.read_bps || x.write_bps ? 1 : 0.55;
        });
        this.procMsg.visible = list.length === 0;
        this.procMsg.label = _('No process is reading or writing right now.');
    }
}

class DiskRow {
    constructor() {
        this.row = new Gtk.ListBoxRow();
        const box = hbox(12);
        box.set_margin_top(8);
        box.set_margin_bottom(8);
        box.set_margin_start(6);
        box.set_margin_end(6);
        this.icon = new Gtk.Image({pixel_size: 32});
        box.append(this.icon);
        const texts = vbox(2);
        texts.hexpand = true;
        texts.valign = Gtk.Align.CENTER;
        this.title = lbl('', ['heading'], {ellipsize: Pango.EllipsizeMode.END});
        this.sub = lbl('', ['caption', 'dim-label'], {ellipsize: Pango.EllipsizeMode.END});
        texts.append(this.title);
        texts.append(this.sub);
        box.append(texts);
        const right = vbox(4);
        right.valign = Gtk.Align.CENTER;
        this.temp = lbl('', ['numeric', 'lh-row-temp'], {xalign: 1});
        const hrow = hbox(6);
        hrow.halign = Gtk.Align.END;
        this.dot = new Gtk.Box({css_classes: ['lh-dot'], valign: Gtk.Align.CENTER});
        this.score = lbl('', ['caption', 'numeric']);
        hrow.append(this.dot);
        hrow.append(this.score);
        right.append(this.temp);
        right.append(hrow);
        box.append(right);
        this.row.set_child(box);
    }

    update(disk, settings) {
        this.row._key = disk.key;
        this.icon.icon_name = fmt.kindIcon(disk);
        this.title.label = fmt.displayName(settings, disk);
        this.sub.label = [fmt.kindLabel(disk), fmt.bytes(disk.capacity), disk.name].join(' · ');
        const t = disk.temperature ?? {};
        this.temp.label = typeof t.current === 'number' ? fmt.temp(t.current, settings.get_string('temp-unit')) : (t.standby ? '💤' : '—');
        setLevel(this.temp, fmt.tempLevel(settings, disk));
        const h = disk.health ?? {};
        for (const c of ['good', 'warning', 'critical'])
            this.dot.remove_css_class(c);
        if (['good', 'warning', 'critical'].includes(h.level))
            this.dot.add_css_class(h.level);
        this.score.label = typeof h.score === 'number' ? fmt.percent(h.score) : fmt.levelLabel(h.level);
    }
}

// ------------------------------------------------------------------ application

const DiskGuardianApp = class {
    constructor() {
        this.app = new Adw.Application({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS ?? Gio.ApplicationFlags.FLAGS_NONE,
        });
        this.app.connect('startup', () => this._startup());
        this.app.connect('activate', () => this._activate());
    }

    _startup() {
        this.app.settings = loadSettings();
        setLanguage(this.app.settings.get_string('language'), GLib.get_language_names());
        if (getLanguage() === 'fa')
            Gtk.Widget.set_default_direction(Gtk.TextDirection.RTL);
        GLib.set_application_name(_('Disk Guardian'));

        const provider = new Gtk.CssProvider();
        if (provider.load_from_string)
            provider.load_from_string(CSS);
        else
            provider.load_from_data(CSS, -1);
        const display = Gdk.Display.get_default();
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        // bundled lh-*-symbolic icons (thermometer, clock, ...) next to this file
        const appDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
        Gtk.IconTheme.get_for_display(display).add_search_path(`${appDir}/icons`);

        if (getLanguage() === 'fa')
            this._usePersianFont(appDir, display);

        const action = (name, fn, accels) => {
            const a = new Gio.SimpleAction({name});
            a.connect('activate', fn);
            this.app.add_action(a);
            if (accels)
                this.app.set_accels_for_action(`app.${name}`, accels);
        };
        action('refresh', () => this.window?.request({action: 'refresh'}), ['F5', '<Control>r']);
        action('show-activity', () => {
            if (this.window)
                this.window.showActivity();
            else
                this._pendingActivity = true;
        }, ['<Control>t']);
        action('ext-prefs', () => this.window?.openExtensionPrefs());
        action('about', () => this._about());
        action('quit', () => this.app.quit(), ['<Control>q']);
    }

    /**
     * Persian UI font: "Croissant". Fonts bundled next to the app (fonts/*.ttf, see
     * `build_deb.py --with-fonts`) are registered privately for this process; a
     * system-wide or ~/.local/share/fonts install is picked up by fontconfig as usual.
     */
    _usePersianFont(appDir, display) {
        const fontDir = Gio.File.new_for_path(`${appDir}/fonts`);
        const fontMap = PangoCairo.FontMap.get_default();
        if (fontDir.query_exists(null) && typeof fontMap.add_font_file === 'function') {
            try {
                const en = fontDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = en.next_file(null))) {
                    const name = info.get_name();
                    if (/\.(ttf|otf)$/i.test(name))
                        fontMap.add_font_file(`${fontDir.get_path()}/${name}`);
                }
            } catch (e) {
                logError(e, 'Disk Guardian: cannot load bundled fonts');
            }
        }
        const css = new Gtk.CssProvider();
        const rules = '* { font-family: "Croissant", "Vazirmatn", "Noto Sans Arabic", sans-serif; }';
        if (css.load_from_string)
            css.load_from_string(rules);
        else
            css.load_from_data(rules, -1);
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
    }

    _activate() {
        if (!this.window)
            this.window = new DiskGuardianWindow(this.app);
        if (this._pendingActivity) {
            this._pendingActivity = false;
            this.window.showActivity();
        }
        this.window.present();
    }

    _about() {
        const props = {
            application_name: _('Disk Guardian'),
            application_icon: APP_ID,
            version: VERSION,
            developer_name: 'Disk Guardian',
            comments: _('Health, SMART data, power-on hours and live temperature of every disk.'),
            license_type: Gtk.License.MIT_X11,
        };
        if (Adw.AboutDialog)
            new Adw.AboutDialog(props).present(this.window.win);
        else
            new Adw.AboutWindow({...props, transient_for: this.window.win}).present();
    }

    /** `disk-guardian --activity` opens the live activity page (also in an already running instance). */
    run(argv) {
        const wantActivity = argv.includes('--activity');
        argv = argv.filter(a => a !== '--activity');
        if (wantActivity) {
            this.app.register(null);
            this.app.activate_action('show-activity', null);
        }
        return this.app.run(argv);
    }
};

const exitCode = new DiskGuardianApp().run([System.programInvocationName, ...ARGV]);
System.exit(exitCode);

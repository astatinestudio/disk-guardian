// Small reusable St widgets: boxes, health ring, sparkline, health bar, tiles.
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Cairo from 'cairo';
import {COLORS, num, bytes, percent, partitionSegments, partitionTitle, partitionFs, partitionUsage} from './format.js';
import {isRtl} from './i18n.js';

let _iconDir = null;

/** Called once from enable(): folder holding the bundled lh-*-symbolic.svg icons. */
export function setIconDir(dir) {
    _iconDir = dir;
}

/** St.Icon for a theme icon name, or a bundled icon when the name starts with "lh-". */
export function icon(name, styleClass = '', params = {}) {
    const i = new St.Icon({style_class: styleClass, ...params});
    setIcon(i, name);
    return i;
}

export function setIcon(stIcon, name) {
    if (name.startsWith('lh-') && _iconDir)
        stIcon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(`${_iconDir}/${name}.svg`));
    else
        stIcon.icon_name = name;
}

// ------------------------------------------------------------ RTL + Persian font
//
// The Shell's text direction follows the *session* locale, not the extension's
// language setting, so a Persian UI on an English desktop would stay LTR. Clutter
// keeps a per-actor text direction (BoxLayout order, START/END alignment, scroll
// bar side and label base direction all read it), but new children do not inherit
// it from their parent. localize() sets it on a whole subtree and hooks every
// container so children added later (UI rebuilds) get it too.

const _hooked = new WeakSet();

function _textDirection() {
    return isRtl() ? Clutter.TextDirection.RTL : Clutter.TextDirection.LTR;
}

function _applyDirection(actor) {
    const dir = _textDirection();
    if (actor.get_text_direction() !== dir)
        actor.set_text_direction(dir);
    if (!_hooked.has(actor)) {
        _hooked.add(actor);
        // GNOME 46+: Clutter.Actor::child-added; GNOME 45: Clutter.Container::actor-added
        for (const sig of ['child-added', 'actor-added']) {
            try {
                actor.connect(sig, (_parent, child) => _applyDirection(child));
                break;
            } catch {}
        }
    }
    for (const child of actor.get_children())
        _applyDirection(child);
}

/**
 * Make a widget tree follow the extension language: RTL layout for Persian
 * (style class "lh-rtl") and the Persian font (style class "lh-fa", see
 * stylesheet.css). `direction: false` only applies the font (top panel).
 */
export function localize(root, {direction = true} = {}) {
    const fa = isRtl();
    for (const [cls, on] of [['lh-fa', fa], ['lh-rtl', fa && direction]]) {
        if (on)
            root.add_style_class_name(cls);
        else
            root.remove_style_class_name(cls);
    }
    if (direction)
        _applyDirection(root);
    return root;
}

/** Mirror custom Cairo drawings (charts, partition bar) in RTL. */
function _mirrorIfRtl(area, cr, w) {
    if (area.get_text_direction() === Clutter.TextDirection.RTL) {
        cr.translate(w, 0);
        cr.scale(-1, 1);
    }
}

/** St.BoxLayout that works on GNOME 45 (vertical) and 48+ (orientation). */
export function box(vertical, params = {}) {
    const b = new St.BoxLayout(params);
    if (vertical) {
        if ('orientation' in b)
            b.orientation = Clutter.Orientation.VERTICAL;
        else
            b.vertical = true;
    }
    return b;
}

export function label(text, styleClass = '', params = {}) {
    const l = new St.Label({text: text ?? '', style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
    return l;
}

export function ellipsize(lbl) {
    lbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return lbl;
}

export function wrap(lbl) {
    lbl.clutter_text.line_wrap = true;
    lbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    lbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return lbl;
}

export function iconButton(iconName, accessibleName, onClick, styleClass = 'lh-icon-button') {
    const btn = new St.Button({
        style_class: styleClass,
        child: icon(iconName, 'lh-icon-button-icon'),
        can_focus: true,
        accessible_name: accessibleName ?? '',
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (onClick)
        btn.connect('clicked', onClick);
    return btn;
}

export function textButton(text, onClick, styleClass = 'lh-button') {
    const btn = new St.Button({label: text, style_class: styleClass, can_focus: true});
    if (onClick)
        btn.connect('clicked', onClick);
    return btn;
}

export function badge(text, variant = 'neutral') {
    return label(text, `lh-badge lh-badge-${variant}`);
}

export function setLevelClass(actor, prefix, level, levels = ['good', 'ok', 'warning', 'warn', 'critical', 'crit', 'unknown', 'standby']) {
    for (const l of levels)
        actor.remove_style_class_name(`${prefix}-${l}`);
    if (level)
        actor.add_style_class_name(`${prefix}-${level}`);
}

function setColor(cr, level, alpha = 1) {
    const [r, g, b] = COLORS[level] ?? COLORS.unknown;
    cr.setSourceRGBA(r, g, b, alpha);
}

/** Circular health score indicator. */
export class HealthRing {
    constructor(size = 64, thickness = 6, styleClass = 'lh-ring') {
        this._thickness = thickness;
        this._value = null;
        this._level = 'unknown';
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: styleClass,
            style: `width: ${size}px; height: ${size}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._label = new St.Label({
            style_class: `${styleClass}-label`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._area);
        this.actor.add_child(this._label);
        this._area.connect('repaint', a => this._draw(a));
    }

    set(score, level) {
        this._value = typeof score === 'number' ? Math.max(0, Math.min(100, score)) : null;
        this._level = level ?? 'unknown';
        this._label.text = this._value === null ? '?' : num(this._value);
        this._area.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const t = this._thickness * scale;
        const r = Math.min(w, h) / 2 - t / 2 - 1;
        const cx = w / 2, cy = h / 2;
        cr.setLineWidth(t);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();
        if (this._value !== null && this._value > 0) {
            setColor(cr, this._level);
            cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this._value / 100);
            cr.stroke();
        }
        cr.$dispose();
    }
}

/** Temperature line chart with soft fill. points: [[ts, value], ...] */
export class Sparkline {
    constructor(styleClass = 'lh-spark') {
        this._points = [];
        this._level = 'accent';
        this.actor = new St.DrawingArea({style_class: styleClass, x_expand: true});
        this.actor.connect('repaint', a => this._draw(a));
        this.actor.connect('notify::text-direction', a => a.queue_repaint());
    }

    set(points, level) {
        this._points = Array.isArray(points) ? points.filter(p => typeof p[1] === 'number') : [];
        this._level = level === 'unknown' || !level ? 'accent' : level;
        this.actor.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const pts = this._points;
        _mirrorIfRtl(area, cr, w); // time runs right-to-left in RTL, like the bar charts
        if (pts.length < 2) {
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
            cr.setLineWidth(1);
            cr.moveTo(0, h - 1);
            cr.lineTo(w, h - 1);
            cr.stroke();
            cr.$dispose();
            return;
        }
        const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
        let lo = Math.min(...pts.map(p => p[1]));
        let hi = Math.max(...pts.map(p => p[1]));
        if (hi - lo < 6) {
            const mid = (hi + lo) / 2;
            lo = mid - 3;
            hi = mid + 3;
        }
        const pad = 3;
        const x = ts => (t1 === t0 ? 0 : (ts - t0) / (t1 - t0)) * (w - 2 * pad) + pad;
        const y = v => h - pad - (v - lo) / (hi - lo) * (h - 2 * pad);

        const path = () => {
            cr.moveTo(x(pts[0][0]), y(pts[0][1]));
            for (let i = 1; i < pts.length; i++)
                cr.lineTo(x(pts[i][0]), y(pts[i][1]));
        };
        // fill
        path();
        cr.lineTo(x(t1), h);
        cr.lineTo(x(t0), h);
        cr.closePath();
        const grad = new Cairo.LinearGradient(0, 0, 0, h);
        const [r, g, b] = COLORS[this._level] ?? COLORS.accent;
        grad.addColorStopRGBA(0, r, g, b, 0.35);
        grad.addColorStopRGBA(1, r, g, b, 0.02);
        cr.setSource(grad);
        cr.fill();
        // line
        path();
        cr.setLineWidth(2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        setColor(cr, this._level);
        cr.stroke();
        // last point
        const lx = x(pts[pts.length - 1][0]), ly = y(pts[pts.length - 1][1]);
        cr.arc(lx, ly, 3, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
}

/** Horizontal health / usage bar. */
export class HealthBar {
    constructor(styleClass = 'lh-bar') {
        this.actor = new St.Widget({
            style_class: styleClass,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({
            style_class: `${styleClass}-fill`,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        // the fill grows from the start edge: left in LTR, right in RTL
        const syncPivot = () => this._fill.set_pivot_point(
            this._fill.get_text_direction() === Clutter.TextDirection.RTL ? 1 : 0, 0.5);
        this._fill.connect('notify::text-direction', syncPivot);
        syncPivot();
        this._fill.scale_x = 0;
        this.actor.add_child(this._fill);
    }

    set(value, level) {
        const f = typeof value === 'number' ? Math.max(0, Math.min(100, value)) / 100 : 0;
        this._fill.scale_x = f;
        setLevelClass(this._fill, 'lh-fill', level ?? 'unknown');
    }
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

/** Partition bar: one block per partition (darker = used space), hatched = unallocated. */
export class PartitionBar {
    constructor(styleClass = 'lh-partbar') {
        this._segs = [];
        this.actor = new St.DrawingArea({style_class: styleClass, x_expand: true});
        this.actor.connect('repaint', a => this._draw(a));
        this.actor.connect('notify::text-direction', a => a.queue_repaint());
    }

    set(disk) {
        this._segs = partitionSegments(disk);
        this.actor.visible = this._segs.length > 0;
        this.actor.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const segs = this._segs;
        _mirrorIfRtl(area, cr, w);
        if (segs.length) {
            roundedRect(cr, 0, 0, w, h, Math.min(10, h / 3));
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
                    cr.save();
                    cr.rectangle(x0, 0, x1 - x0, h);
                    cr.clip();
                    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.18);
                    cr.paint();
                    cr.setSourceRGBA(0.6, 0.6, 0.6, 0.35);
                    cr.setLineWidth(1);
                    for (let t = x0 - h; t < x1; t += 7) {
                        cr.moveTo(t, h);
                        cr.lineTo(t + h, 0);
                    }
                    cr.stroke();
                    cr.restore();
                }
            });
        }
        cr.$dispose();
    }
}

/** One row per partition: color swatch, title, details and usage. */
export function partitionLegend(disk, detailed = false) {
    const list = box(true, {style_class: 'lh-partlegend'});
    for (const sg of partitionSegments(disk)) {
        const row = box(false, {style_class: detailed ? 'lh-partrow lh-partrow-detailed' : 'lh-partrow'});
        const sw = new St.Widget({
            style_class: 'lh-swatch',
            style: sg.color
                ? `background-color: rgb(${sg.color.map(c => Math.round(c * 255)).join(',')});`
                : 'background-color: rgba(128,128,128,0.35);',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(sw);
        const texts = box(true, {x_expand: true});
        texts.add_child(ellipsize(label(partitionTitle(sg), detailed ? 'lh-part-title' : 'lh-part-title-small')));
        const sub = sg.kind === 'free' ? [bytes(sg.size)] : [sg.name, partitionFs(sg), bytes(sg.size)];
        texts.add_child(ellipsize(label(sub.join(' · '), 'lh-part-sub')));
        const u = sg.kind === 'part' ? partitionUsage(sg) : null;
        if (detailed && u) {
            const bar = new HealthBar();
            const pct = 100 * u.used / u.size;
            bar.set(pct, pct >= 95 ? 'critical' : pct >= 85 ? 'warning' : 'good');
            texts.add_child(bar.actor);
            texts.add_child(label(`${bytes(u.used)} / ${bytes(u.size)}`, 'lh-part-sub'));
        }
        row.add_child(texts);
        if (u) {
            const pct = Math.round(100 * u.used / u.size);
            const pl = label(percent(pct), 'lh-part-pct');
            setLevelClass(pl, 'lh-text', pct >= 95 ? 'critical' : pct >= 85 ? 'warning' : null);
            row.add_child(pl);
        }
        list.add_child(row);
    }
    return list;
}

/** Key / value row. */
export function kvRow(key, value, valueClass = '') {
    const row = box(false, {style_class: 'lh-kv'});
    const k = ellipsize(label(key, 'lh-kv-key', {x_expand: true}));
    const v = label(value, `lh-kv-value ${valueClass}`);
    row.add_child(k);
    row.add_child(v);
    row.valueLabel = v;
    return row;
}

/** Stat tile: caption, big value, small sub text. */
export function tile(iconName, caption, value, sub = '', level = null) {
    const t = box(true, {style_class: 'lh-tile', x_expand: true});
    const head = box(false, {style_class: 'lh-tile-head'});
    head.add_child(icon(iconName, 'lh-tile-icon'));
    head.add_child(ellipsize(label(caption, 'lh-tile-caption', {x_expand: true})));
    t.add_child(head);
    const v = ellipsize(label(value, 'lh-tile-value'));
    if (level)
        setLevelClass(v, 'lh-text', level);
    t.add_child(v);
    const s = ellipsize(label(sub, 'lh-tile-sub'));
    t.add_child(s);
    t.valueLabel = v;
    t.subLabel = s;
    return t;
}

export function sectionTitle(text) {
    return label(text, 'lh-section-title', {x_expand: true});
}

export function setScrollChild(scroll, child) {
    if (scroll.set_child)
        scroll.set_child(child);
    else
        scroll.add_actor(child);
}

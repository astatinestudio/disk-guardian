// Shared by the main window (main.js) and the floating widget (widget.js).
import {_, setLanguage, isRtl, getLanguage, getLanguageTag, languageChoices} from '../lib/i18n.js';
import * as fmt from '../lib/format.js';
import {normalizeState} from '../lib/normalize.js';

const T = window.__TAURI__;
export const invoke = (cmd, args) => T.core.invoke(cmd, args);
export const listen = (event, cb) => T.event.listen(event, cb);
export const currentWindow = () => T.window.getCurrentWindow();
export const LogicalSize = (w, h) => new T.dpi.LogicalSize(w, h);

/** GSettings-like view of the settings object, so format.js works unchanged. */
export class Settings {
    constructor(obj) {
        this.o = obj ?? {};
    }

    get_string(k) {
        return String(this.o[k] ?? '');
    }

    get_int(k) {
        return Number(this.o[k] ?? 0);
    }

    get_boolean(k) {
        return Boolean(this.o[k]);
    }

    get_strv(k) {
        return Array.isArray(this.o[k]) ? this.o[k] : [];
    }

    get_value(k) {
        const v = this.o[k];
        return {deepUnpack: () => v ?? {}};
    }
}

export async function loadSettings() {
    return new Settings(await invoke('get_settings'));
}

export function saveSettings(patch) {
    return invoke('set_settings', {patch});
}

/** Language + direction of the page; also tells the tray menu. */
export function applyLanguage(settings) {
    setLanguage(settings.get_string('language'), navigator.languages ?? [navigator.language]);
    const html = document.documentElement;
    html.lang = getLanguageTag();
    html.dir = isRtl() ? 'rtl' : 'ltr';
    for (const el of document.querySelectorAll('[data-i18n]'))
        el.textContent = _(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
        el.title = _(el.dataset.i18nTitle);
        el.setAttribute('aria-label', el.title);
    }
    invoke('set_ui_language', {lang: getLanguage()}).catch(() => {});
}

/**
 * {status, state, platform, error}
 * status: ok | stale | missing | error | nosmartctl
 */
export async function loadState() {
    const r = await invoke('get_state');
    const out = {status: r.status, state: null, platform: r.platform, path: r.path, error: r.error ?? null};
    if (r.status !== 'ok')
        return out;
    try {
        out.state = normalizeState(JSON.parse(r.text));
    } catch (e) {
        return {...out, status: 'error', error: String(e)};
    }
    if (r.platform === 'windows')
        syncExplorer(out.state);
    const daemon = out.state.daemon ?? {};
    const age = Date.now() / 1000 - (out.state.generated || 0);
    if (daemon.smartctl === false)
        out.status = 'nosmartctl';
    else if (age > Math.max(60, (daemon.temp_interval ?? 3) * 10))
        out.status = 'stale';
    return out;
}

/** Windows: health badge (score circle + check / ! / x) on every drive letter in
 *  File Explorer. Every open window sends it; the app ignores repeats (and the setting being off). */
function syncExplorer(state) {
    const drives = [];
    for (const d of state?.disks ?? []) {
        const h = d.health ?? {};
        if (!['good', 'warning', 'critical'].includes(h.level))
            continue;
        const score = Number.isFinite(h.score) ? Math.round(h.score) : null;
        for (const v of d.volumes ?? []) {
            if (v.letter)
                drives.push({letter: v.letter, level: h.level, score});
        }
    }
    invoke('set_explorer_health', {drives}).catch(() => {});
}

// ------------------------------------------------------------------ html helpers

const ESC = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** Masked SVG icon (follows currentColor). */
export function icon(name, cls = '') {
    return `<span class="ico ${cls}" style="--i:url(/icons/${esc(name)}.svg)" aria-hidden="true"></span>`;
}

export function kindIcon(disk) {
    // own drive icons (ui/icons/{nvme,ssd,hdd,sas,flash}.svg, scripts/drive-icons.py)
    if (disk.kind === 'flash')
        return 'flash';
    if (disk.kind === 'nvme')
        return 'nvme';
    if (disk.kind === 'sas')
        return disk.media === 'ssd' ? 'ssd' : 'sas';
    if (disk.kind === 'hdd' || disk.media === 'hdd')
        return 'hdd';
    if (disk.kind === 'ssd' || disk.kind === 'virtual')
        return 'ssd';
    return disk.bus === 'usb' ? 'flash' : 'ssd';
}

/** format.js level names -> CSS class suffix */
export function lvl(level) {
    return {good: 'good', ok: 'good', warning: 'warn', warn: 'warn', critical: 'crit', crit: 'crit'}[level] ?? 'unknown';
}

/** Circular health score. */
export function ring(score, level, size = 68, stroke = 7) {
    const v = typeof score === 'number' ? Math.max(0, Math.min(100, score)) : null;
    const r = (size - stroke) / 2 - 1;
    const c = 2 * Math.PI * r;
    const mid = size / 2;
    const fg = v === null || v === 0 ? '' : `<circle class="ring-fg" cx="${mid}" cy="${mid}" r="${r}" stroke-width="${stroke}"
        stroke-dasharray="${(c * v / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>`;
    return `<div class="ring lvl-${lvl(level)}" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
          <circle class="ring-bg" cx="${mid}" cy="${mid}" r="${r}" stroke-width="${stroke}"/>${fg}
        </svg><span>${v === null ? '?' : fmt.num(v)}</span></div>`;
}

/** Temperature chart. points: [[ts, value], ...]; mirrored in RTL by CSS. */
export function sparkline(points, level, height = 46) {
    const pts = (points ?? []).filter(p => typeof p?.[1] === 'number');
    const W = 600, H = 100, pad = 4;
    if (pts.length < 2)
        return `<div class="spark lvl-${lvl(level)}" style="height:${height}px"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="spark-base" d="M0 ${H - 1}H${W}"/></svg></div>`;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
    if (hi - lo < 6) {
        const m = (hi + lo) / 2;
        lo = m - 3;
        hi = m + 3;
    }
    const x = t => (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - 2 * pad) + pad;
    const y = v => H - pad - (v - lo) / (hi - lo) * (H - 2 * pad);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
    const area = `${line}L${x(t1).toFixed(1)} ${H}L${x(t0).toFixed(1)} ${H}Z`;
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    const last = pts[pts.length - 1];
    return `<div class="spark lvl-${lvl(level)}" style="height:${height}px">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="currentColor" stop-opacity=".35"/><stop offset="1" stop-color="currentColor" stop-opacity=".02"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#${id})"/>
        <path class="spark-line" d="${line}"/>
      </svg>
      <i class="spark-dot" style="inset-inline-end:${((W - x(last[0])) / W * 100).toFixed(2)}%;top:${(y(last[1]) / H * 100).toFixed(2)}%"></i>
    </div>`;
}

export function kv(key, value, level = null) {
    if (value === null || value === undefined || value === '—')
        return '';
    return `<div class="kv"><span class="kv-key">${esc(key)}</span><span class="kv-val ${level ? `t-${lvl(level)}` : ''}">${esc(value)}</span></div>`;
}

/** Temperature text of a disk ("38°C", "💤", "—") and its level. */
export function tempText(settings, disk) {
    const t = disk.temperature ?? {};
    const unit = settings.get_string('temp-unit') || 'C';
    if (typeof t.current === 'number')
        return [fmt.temp(t.current, unit), fmt.tempLevel(settings, disk)];
    return [t.standby ? '💤' : '—', 'unknown'];
}

/** How the OS names the disk: "C: G:" / "Disk 1" on Windows, "sda" / "disk0" elsewhere. */
export function deviceName(disk) {
    if (disk.drive_letters?.length)
        return disk.drive_letters.join(' ');
    if (Number.isInteger(disk.disk_number))
        return _('Disk {n}', {n: disk.disk_number});
    return disk.name;
}

/** Device badge: "Disk 1" on Windows, the device path elsewhere. */
export function deviceId(disk) {
    return Number.isInteger(disk.disk_number) ? _('Disk {n}', {n: disk.disk_number}) : (disk.path ?? disk.name);
}

export function displayName(settings, disk) {
    return fmt.displayName(settings, disk);
}

export function toast(text, kind = 'info') {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        document.body.append(el);
    }
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.hidden = true), 4500);
}

/** Send a request to the collector; returns a user facing error or null. */
export async function sendRequest(req) {
    try {
        await invoke('send_request', {request: req});
        return null;
    } catch (e) {
        const msg = String(e);
        if (msg === 'permission')
            return _('Permission denied. Your user must be in the “{g}” group.', {g: 'sudo'});
        if (msg === 'not-running')
            return _('Collector service is not running');
        return msg;
    }
}

export {_, isRtl, getLanguage, languageChoices, fmt};

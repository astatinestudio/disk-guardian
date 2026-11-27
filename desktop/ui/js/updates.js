// Self-update UI: banner in the main window, Settings > Updates page and the
// announcements of updates.json (see src-tauri/src/updater.rs for the manifest).
import {_, invoke, listen, esc, icon, toast, saveSettings, getLanguage, fmt} from './common.js';

const EVERY = 6 * 3600 * 1000;
const upd = {info: null, checking: false, error: null, progress: null, installing: false};
const shown = new Set();      // announcements shown in this session (display.mode "once")
const dismissed = new Set();  // closed in this session
let ctx;                      // {settings, platform, openUpdates()}

const auto = () => ctx.settings.o['update-check'] !== false;

function parse(v) {
    const p = String(v ?? '').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
    while (p.length < 3)
        p.push(0);
    return p;
}

function newer(a, b) {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i])
            return x[i] > y[i];
    }
    return false;
}

/** {"en": "...", "fa": "..."} -> text in the UI language (English, then anything). */
const loc = o => typeof o === 'string' ? o : o?.[getLanguage()] ?? o?.en ?? Object.values(o ?? {})[0] ?? '';

export function initUpdates(c) {
    ctx = c;
    listen('update-progress', e => {
        upd.progress = e.payload;
        refresh();
    });
    listen('update-installing', () => {
        upd.installing = true;
        refresh();
    });
    if (auto())
        setTimeout(() => checkUpdates(false), 4000);
    setInterval(() => auto() && !upd.progress && checkUpdates(false), EVERY);
}

export async function checkUpdates(manual) {
    upd.checking = true;
    refresh();
    try {
        upd.info = await invoke('check_update');
        upd.error = null;
        if (manual && !upd.info.available)
            toast(_('You have the latest version.'), 'good');
    } catch (e) {
        upd.error = String(e);
        if (manual)
            toast(_('Could not check for updates.'), 'warn');
    } finally {
        upd.checking = false;
        refresh();
    }
}

async function install() {
    upd.progress = {done: 0, total: null};
    upd.error = null;
    refresh();
    try {
        await invoke('install_update');
    } catch (e) {
        upd.progress = null;
        upd.error = String(e);
        toast(_('Update failed: {e}', {e: String(e)}), 'warn');
    }
    refresh();
}

const openUrl = url => invoke('open_url', {url}).catch(e => toast(String(e), 'warn'));

// ------------------------------------------------------------------ announcements

const annKey = a => `${a.id}:${a.revision ?? 1}`;

function announcements() {
    const now = Date.now();
    const cur = upd.info?.current;
    const seen = ctx.settings.o['announcements-seen'] ?? [];
    return (upd.info?.announcements ?? []).filter(a => a?.id
        && a.enabled !== false
        && (!Array.isArray(a.platforms) || a.platforms.includes(ctx.platform.os))
        && (!a.starts_at || Date.parse(a.starts_at) <= now)
        && (!a.expires_at || Date.parse(a.expires_at) > now)
        && (!a.min_app_version || !newer(a.min_app_version, cur))
        && (!a.max_app_version || !newer(cur, a.max_app_version))
        && !dismissed.has(annKey(a))
        && (!seen.includes(annKey(a)) || shown.has(annKey(a))))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .slice(0, 2);
}

function markSeen(key) {
    const seen = ctx.settings.o['announcements-seen'] ?? [];
    if (!seen.includes(key))
        saveSettings({'announcements-seen': [...seen, key].slice(-100)});
}

function runAction(a) {
    const act = a.action ?? {};
    if (act.type === 'navigate' && act.target === 'updates')
        ctx.openUpdates();
    else if (act.type === 'url' && act.url)
        openUrl(act.url);
}

// ------------------------------------------------------------------ main window banners

function bannerHtml(kind, title, body, actions, closeId) {
    return `<div class="banner banner-${kind}">${icon(kind === 'update' ? 'download' : kind, 'banner-ico')}
        <div class="banner-text"><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>
        ${actions}
        ${closeId ? `<button class="icon-btn" data-close="${esc(closeId)}" title="${esc(_('Close'))}">${icon('close')}</button>` : ''}
      </div>`;
}

function renderNotices() {
    const el = document.getElementById('notices');
    if (!el || !ctx)
        return;
    const i = upd.info;
    let html = '';
    if (i?.available && (i.mandatory || ctx.settings.o['update-dismissed'] !== i.version)) {
        html += bannerHtml('update', _('Disk Guardian {v} is available', {v: i.version}),
            i.mandatory ? _('This update is required.') : loc(i.notes),
            `<button class="btn btn-accent" data-upd="open">${esc(_('Update'))}</button>`,
            i.mandatory ? null : 'update');
    }
    for (const a of announcements()) {
        const key = annKey(a);
        if ((a.display?.mode ?? 'once') === 'once' && !shown.has(key)) {
            shown.add(key);
            markSeen(key);
        }
        const kind = {warning: 'warning', error: 'error', critical: 'error'}[a.type] ?? 'info';
        const act = a.action?.label ? `<button class="btn" data-ann="${esc(key)}">${esc(loc(a.action.label))}</button>` : '';
        html += bannerHtml(kind, loc(a.title), loc(a.message), act, a.dismissible === false ? null : key);
    }
    el.innerHTML = html;
    el.hidden = !html;
    el.querySelector('[data-upd="open"]')?.addEventListener('click', () => ctx.openUpdates());
    for (const b of el.querySelectorAll('[data-ann]'))
        b.addEventListener('click', () => runAction(upd.info.announcements.find(a => annKey(a) === b.dataset.ann)));
    for (const b of el.querySelectorAll('[data-close]')) {
        b.addEventListener('click', () => {
            const k = b.dataset.close;
            if (k === 'update') {
                saveSettings({'update-dismissed': i.version});
                ctx.settings.o['update-dismissed'] = i.version;
            } else {
                dismissed.add(k);
                const a = upd.info.announcements.find(x => annKey(x) === k);
                if ((a?.display?.mode ?? 'once') !== 'always')
                    markSeen(k);
            }
            renderNotices();
        });
    }
}

// ------------------------------------------------------------------ Settings > Updates

function statusHtml() {
    const i = upd.info;
    let head, body = '', buttons = '';
    if (upd.installing) {
        head = [_('Installing… the app will restart.'), 'download'];
    } else if (upd.progress) {
        const {done, total} = upd.progress;
        const p = total ? Math.min(100, Math.round(done / total * 100)) : null;
        head = [_('Downloading… {p}', {p: p === null ? fmt.bytes(done) : `${fmt.num(p)}${getLanguage() === 'fa' ? '٪' : '%'}`}), 'download'];
        body = `<div class="upd-bar"><i style="inline-size:${p ?? 30}%" class="${p === null ? 'indet' : ''}"></i></div>`;
    } else if (upd.checking) {
        head = [_('Checking…'), 'refresh'];
    } else if (i?.available) {
        head = [_('Version {v} is available', {v: i.version}), 'download'];
        const notes = loc(i.notes);
        body = `${i.mandatory ? `<p class="upd-req">${esc(_('This update is required.'))}</p>` : ''}${notes ? `<p class="upd-notes">${esc(notes)}</p>` : ''}
            ${i.installable ? '' : `<p class="upd-hint">${esc(_('This installation cannot update itself. Download the new version from the release page.'))}</p>`}`;
        buttons = i.installable
            ? `<button type="button" class="btn btn-accent" data-upd="install">${esc(_('Download and install'))}</button>`
            : '';
        if (i.release_url)
            buttons += `<button type="button" class="btn" data-upd="notes">${esc(_('Release notes'))}</button>`;
    } else if (upd.error) {
        head = [_('Could not check for updates.'), 'warning'];
        body = `<p class="upd-hint mono sel" dir="ltr">${esc(upd.error)}</p>`;
    } else if (i) {
        head = [_('You have the latest version.'), 'ok'];
    } else {
        head = [_('Not checked yet'), 'info'];
    }
    const busy = upd.checking || upd.progress || upd.installing;
    return `<div class="upd-head">${icon(head[1], 'upd-ico')}<b>${esc(head[0])}</b></div>
        ${body}
        ${buttons ? `<div class="btn-row">${buttons}</div>` : ''}
        <div class="upd-foot">
          <small>${esc(_('Current version'))} <span class="mono">${esc(i?.current ?? ctx.platform.version ?? '')}</span>${i?.checked ? ` · ${esc(_('Last checked {t}', {t: fmt.ago(i.checked)}))}` : ''}</small>
          <button type="button" class="btn" data-upd="check" ${busy ? 'disabled' : ''}>${icon('refresh')}${esc(_('Check now'))}</button>
        </div>`;
}

/** Body of the Updates settings page; `row`/`sw` come from renderSettings. */
export function updatesPage(group, row, sw) {
    return `${group('', row('update-check', _('Check for updates automatically'), sw('update-check')))}
        <div class="set-group"><div class="set-card upd-card" id="upd-status">${statusHtml()}</div></div>`;
}

function bindPage() {
    const el = document.getElementById('upd-status');
    if (!el)
        return;
    el.querySelector('[data-upd="check"]')?.addEventListener('click', () => checkUpdates(true));
    el.querySelector('[data-upd="install"]')?.addEventListener('click', install);
    el.querySelector('[data-upd="notes"]')?.addEventListener('click', () => openUrl(upd.info.release_url));
}

export function refresh() {
    renderNotices();
    const el = document.getElementById('upd-status');
    if (el) {
        el.innerHTML = statusHtml();
        bindPage();
    }
}

/** Settings dialog was (re)built. */
export const bindUpdatesPage = bindPage;

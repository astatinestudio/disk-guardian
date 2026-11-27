// Floating widget: everything about the default disk, always on top, draggable.
// Same content as the GNOME Shell extension's widget (extension/lib/floatWidget.js).
import {
    _, fmt, invoke, listen, loadSettings, saveSettings, applyLanguage, loadState, esc, icon, kindIcon,
    lvl, ring, sparkline, kv, tempText, displayName, currentWindow, LogicalSize, deviceName,
} from './common.js';

const MARGIN = 10; // room for the panel shadow inside the transparent window
let settings;
let snap = {status: 'loading', state: null};
let shown = false;

const panel = document.getElementById('panel');

function defaultDisk() {
    const list = snap.state?.disks ?? [];
    const key = settings.get_string('default-disk');
    return list.find(d => d.key === key) ?? list[0] ?? null;
}

function header(d, compact) {
    const many = (snap.state?.disks ?? []).length > 1;
    const sub = d ? [fmt.kindLabel(d), fmt.bytes(d.capacity), deviceName(d)].join(' · ') : '';
    return `<header class="w-head">
      ${icon(d ? kindIcon(d) : 'hdd', 'w-icon')}
      <div class="w-titles"><b>${esc(d ? displayName(settings, d) : _('Disk Guardian'))}</b>${!compact && sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <div class="w-buttons">
        ${many ? `<button data-act="next" title="${esc(_('Next disk'))}">${icon('next')}</button>` : ''}
        ${d ? `<button data-act="details" title="${esc(_('Details'))}">${icon('open')}</button>` : ''}
        <button data-act="compact" title="${esc(compact ? _('Expand') : _('Compact'))}">${icon(compact ? 'chevron-down' : 'chevron-up')}</button>
        <button data-act="close" title="${esc(_('Close'))}">${icon('close')}</button>
      </div></header>`;
}

function allValues(d) {
    const u = settings.get_string('temp-unit') || 'C';
    const rows = [];
    for (const a of d.attributes ?? [])
        rows.push(kv(`${a.id} · ${(a.name ?? '').replace(/_/g, ' ')}`, `${fmt.num(a.value)} | ${a.raw ?? ''}`,
            {warn: 'warning', failing: 'critical'}[a.status] ?? null));
    for (const [k, v] of Object.entries(d.nvme ?? {})) {
        if (k === 'temperature_sensors' || typeof v === 'object')
            continue;
        const val = k.startsWith('data_units_') ? fmt.bytes(v * 512000) : k === 'temperature' ? fmt.temp(v, u) : fmt.num(v);
        rows.push(kv(k.replace(/_/g, ' '), val));
    }
    for (const [k, v] of Object.entries(d.scsi ?? {})) {
        if (v === null || v === undefined)
            continue;
        rows.push(kv(k.replace(/_/g, ' '), typeof v === 'object'
            ? Object.entries(v).map(([a, b]) => `${a}: ${b ?? '—'}`).join(', ') : String(v)));
    }
    return `<div class="w-all">${rows.join('') || `<p class="muted">${esc(_('No SMART attributes'))}</p>`}</div>`;
}

function render() {
    const d = defaultDisk();
    const compact = settings.get_boolean('float-compact');
    const expanded = settings.get_boolean('float-expanded');
    panel.classList.toggle('compact', compact);
    panel.style.setProperty('--w-opacity', String(settings.get_int('float-opacity') / 100));

    if (!d) {
        const msg = ['missing', 'error', 'stale'].includes(snap.status) ? _('Collector service is not running')
            : snap.status === 'loading' ? _('Loading…') : _('No disks found');
        panel.innerHTML = `${header(null, compact)}<p class="w-empty">${esc(msg)}</p>`;
        return fit();
    }
    const h = d.health ?? {};
    const t = d.temperature ?? {};
    const [tt, tl] = tempText(settings, d);
    const u = settings.get_string('temp-unit') || 'C';

    if (compact) {
        panel.innerHTML = `${header(d, true)}
          <div class="w-compact">
            <span class="w-temp-small t-${lvl(tl)}">${esc(tt)}</span>
            <span class="t-${lvl(h.level)} w-health-small">${esc(fmt.levelLabel(h.level))}${typeof h.score === 'number' ? ` ${esc(fmt.percent(h.score))}` : ''}</span>
            <span class="muted">${esc(fmt.hours(d.power_on_hours))}</span>
          </div>`;
        return fit();
    }

    const c = d.counters ?? {};
    const rows = [];
    const add = (k, v, level = null) => rows.push(kv(k, v, level));
    if (d.power_on_hours !== null && d.power_on_hours !== undefined)
        add(_('Power-on hours'), `${fmt.hours(d.power_on_hours)} · ${fmt.duration(d.power_on_hours)}`);
    if (typeof d.usage?.today_hours === 'number')
        add(_('Today'), fmt.hours(d.usage.today_hours));
    if (d.power_cycles !== null && d.power_cycles !== undefined)
        add(_('Power cycles'), fmt.num(d.power_cycles));
    if (typeof d.life_remaining === 'number')
        add(_('Life remaining'), fmt.percent(d.life_remaining), d.life_remaining <= 10 ? 'critical' : d.life_remaining <= 30 ? 'warning' : 'good');
    if (d.data_written)
        add(_('Data written'), fmt.bytes(d.data_written, d.data_approx));
    if (d.data_read)
        add(_('Data read'), fmt.bytes(d.data_read, d.data_approx));
    const [smText, , smLevel] = fmt.smartStatus(d);
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

    const issues = (h.issues ?? []).filter(i => i.severity !== 'info').slice(0, 3)
        .map(i => `<div class="issue issue-${lvl(i.severity)}">${icon(i.severity === 'critical' ? 'error' : 'warning')}<span>${esc(fmt.issueText(i, u))}</span></div>`).join('');
    const minmax = t.standby && typeof t.current !== 'number'
        ? _('Sleeping (not woken up)')
        : `${_('Min 24h')} ${fmt.temp(t.min_24h, u)} · ${_('Max 24h')} ${fmt.temp(t.max_24h, u)}`;

    panel.innerHTML = `${header(d, false)}
      <div class="w-hero">
        <div class="w-ringbox">${ring(h.score, h.level, 68, 7)}<span class="t-${lvl(h.level)}">${esc(fmt.levelLabel(h.level))}</span></div>
        <div class="w-tempbox">
          <span class="w-cap">${icon('lh-thermometer-symbolic')}${esc(_('Temperature'))}</span>
          <span class="w-temp t-${lvl(tl)}">${esc(tt)}</span>
          <span class="w-minmax">${esc(minmax)}</span>
        </div>
      </div>
      ${sparkline(t.history, tl === 'ok' ? 'good' : tl, 46)}
      <div class="w-list">${rows.join('')}</div>
      ${issues}
      <button class="w-toggle" data-act="expand">${esc(expanded ? _('Hide values') : _('Show all values'))}</button>
      ${expanded ? allValues(d) : ''}`;
    return fit();
}

/** Resize the transparent window to the panel, then show it (first time). */
async function fit() {
    await new Promise(r => requestAnimationFrame(r));
    const r = panel.getBoundingClientRect();
    const win = currentWindow();
    try {
        await win.setSize(LogicalSize(Math.ceil(r.width) + 2 * MARGIN, Math.ceil(r.height) + 2 * MARGIN));
        if (!shown) {
            shown = true;
            await win.show();
        }
    } catch (e) {
        console.error(e);
    }
}

function nextDisk() {
    const list = snap.state?.disks ?? [];
    if (!list.length)
        return;
    const cur = defaultDisk();
    const i = list.findIndex(d => d.key === cur?.key);
    saveSettings({'default-disk': list[(i + 1) % list.length].key});
}

panel.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b)
        return;
    const act = b.dataset.act;
    if (act === 'close')
        saveSettings({'float-enabled': false});
    else if (act === 'compact')
        saveSettings({'float-compact': !settings.get_boolean('float-compact')});
    else if (act === 'expand')
        saveSettings({'float-expanded': !settings.get_boolean('float-expanded')});
    else if (act === 'next')
        nextDisk();
    else if (act === 'details')
        invoke('show_main_window', {disk: defaultDisk()?.key ?? null});
});

// drag anywhere except buttons and the scrolling value list
panel.addEventListener('mousedown', e => {
    if (e.button !== 0 || settings.get_boolean('float-locked') || e.target.closest('button, .w-all'))
        return;
    currentWindow().startDragging();
});

async function refresh() {
    try {
        snap = await loadState();
    } catch {
        snap = {status: 'error', state: null};
    }
    render();
}

async function init() {
    settings = await loadSettings();
    applyLanguage(settings);
    await refresh();
    listen('state-changed', refresh);
    listen('settings-changed', e => {
        settings.o = e.payload;
        applyLanguage(settings);
        render();
    });
}

init();

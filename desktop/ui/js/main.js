// Main window: disk list + details (overview, SMART, self-tests) + settings.
import {
    _, getLanguage, languageChoices, fmt, invoke, listen, currentWindow, loadSettings, saveSettings, applyLanguage, loadState, esc, icon, kindIcon,
    lvl, ring, sparkline, kv, tempText, displayName, toast, sendRequest, deviceName, deviceId,
} from './common.js';
import {featureGroups, specSections, powerStates} from './specs.js';
import {getLanguageTag} from '../lib/i18n.js';
import {ABOUT, ABOUT_DESCRIPTION, aboutDate} from '../lib/about.js';
import {initUpdates, updatesPage, bindUpdatesPage, refresh as refreshUpdates} from './updates.js';

const SEVERITY_ICON = {critical: 'error', warning: 'warning', info: 'info'};
const ATTR_STATUS = {ok: 'OK', warn: 'Watch', failing: 'Failing', info: 'Info'};
const ATTR_LEVEL = {ok: 'good', warn: 'warning', failing: 'critical', info: 'unknown'};

let settings;
let snap = {status: 'loading', state: null};
let platform = {os: ''};
let selected = null;
let tab = 'overview';
let featFilter = 'all';
let serviceBusy = false;

const $ = sel => document.querySelector(sel);
const disks = () => snap.state?.disks ?? [];
const hidden = () => settings.get_strv('hidden-disks');
const unit = () => settings.get_string('temp-unit') || 'C';

// ------------------------------------------------------------------ top bar + banner

function renderStatus() {
    const el = $('#status-line');
    if (snap.status === 'ok' || snap.status === 'stale')
        el.textContent = `${_('{n} disks', {n: disks().length})} · ${_('updated {t}', {t: fmt.ago(snap.state?.generated)})}`;
    else
        el.textContent = snap.status === 'loading' ? _('Loading…') : '';
}

function renderBanner() {
    const el = $('#banner');
    const linux = platform.os === 'linux';
    let title = null, body = '', action = null;
    if (snap.status === 'missing' || snap.status === 'error') {
        title = linux ? _('Collector service is not running') : _('The collector service is not installed or not running');
        body = linux
            ? _('Install the disk-guardian package or run: sudo systemctl enable --now disk-guardian')
            : _('Disk Guardian reads SMART data with a small background service that needs administrator rights once to install.');
        action = linux ? _('Start service') : _('Install service');
        if (snap.status === 'error' && snap.error)
            body += ` (${snap.error})`;
    } else if (snap.status === 'stale') {
        title = _('Data is outdated — the collector may have stopped');
        action = linux ? _('Start service') : _('Install service');
    } else if (snap.status === 'nosmartctl') {
        title = _('smartctl was not found');
        body = platform.os === 'macos'
            ? _('Install smartmontools, for example: brew install smartmontools')
            : _('Install smartmontools from smartmontools.org, then restart the service.');
    } else if (snap.status === 'ok' && !disks().length) {
        title = _('No disks found');
    }
    el.hidden = !title;
    if (!title)
        return;
    el.innerHTML = `${icon('warning', 'banner-ico')}
        <div class="banner-text"><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>
        ${action ? `<button class="btn btn-accent" id="btn-service" ${serviceBusy ? 'disabled' : ''}>${esc(serviceBusy ? _('Waiting…') : action)}</button>` : ''}`;
    $('#btn-service')?.addEventListener('click', installService);
}

async function installService() {
    serviceBusy = true;
    renderBanner();
    try {
        await invoke('install_service');
        toast(_('The collector service is running.'), 'good');
    } catch (e) {
        toast(`${_('Could not start the service')}: ${e}`, 'warn');
    }
    serviceBusy = false;
    await refreshState();
}

// ------------------------------------------------------------------ disk list

function renderList() {
    const list = $('#disk-list');
    const shown = disks().filter(d => !hidden().includes(d.key));
    if (!shown.length) {
        list.innerHTML = `<div class="empty">${esc(snap.status === 'loading' ? _('Loading…') : _('No disks found'))}</div>`;
        return;
    }
    const def = settings.get_string('default-disk');
    list.innerHTML = shown.map(d => {
        const h = d.health ?? {};
        const [tt, tl] = tempText(settings, d);
        const L = lvl(h.level);
        const meta = [`<span class="badge badge-kind">${esc(fmt.kindLabel(d))}</span>`,
            `<bdi class="meta-dev">${esc(deviceName(d))}</bdi>`,
            d.capacity ? `<bdi>${esc(fmt.bytes(d.capacity))}</bdi>` : ''].filter(Boolean);
        const stats = [`<span class="cstat lvl-text t-${L}"><i class="dot dot-${L}"></i>${esc(fmt.levelLabel(h.level))}</span>`];
        if (tt !== '—')
            stats.push(`<span class="cstat t-${lvl(tl)}">${icon('lh-thermometer-symbolic')}<bdi>${esc(tt)}</bdi></span>`);
        if (typeof d.power_on_hours === 'number')
            stats.push(`<span class="cstat muted">${icon('lh-clock-symbolic')}<bdi>${esc(fmt.hours(d.power_on_hours))}</bdi></span>`);
        return `<button class="card lvl-${L} ${d.key === selected ? 'selected' : ''}" data-key="${esc(d.key)}">
          <span class="card-ring">${ring(typeof h.score === 'number' ? h.score : null, h.level, 46, 5)}</span>
          <span class="card-main">
            <span class="card-top"><span class="card-title">${esc(displayName(settings, d))}</span>
              <span class="star ${d.key === def ? 'on' : ''}" role="button" tabindex="0" data-star="${esc(d.key)}"
                title="${esc(_('Set as default disk'))}">${icon(d.key === def ? 'star-fill' : 'star')}</span></span>
            <span class="card-meta">${meta.join('<i class="sep"></i>')}</span>
            <span class="card-stats">${stats.join('')}</span>
          </span>
        </button>`;
    }).join('');
}

// ------------------------------------------------------------------ details

function renderDetail() {
    const el = $('#detail');
    const d = disks().find(x => x.key === selected);
    if (!d) {
        el.innerHTML = `<div class="empty big">${icon('hdd', 'empty-ico')}<p>${esc(snap.status === 'loading' ? _('Loading…') : _('No disks found'))}</p></div>`;
        return;
    }
    const h = d.health ?? {};
    const badges = [
        `<span class="badge badge-kind">${esc(fmt.kindLabel(d))}</span>`,
        `<span class="badge">${esc(fmt.bytes(d.capacity))}</span>`,
        `<span class="badge mono">${esc(deviceId(d))}</span>`,
        d.drive_letters?.length ? `<span class="badge">${esc(d.drive_letters.join(' '))}</span>` : '',
        d.bus === 'usb' ? `<span class="badge">${esc(_('USB'))}</span>` : '',
        d.smart?.standby ? `<span class="badge">${esc(_('Standby'))}</span>` : '',
    ].join('');
    const tabs = [['overview', 'Overview'], ['smart', 'SMART'], ['tests', 'Self-tests'], ['info', 'Information']];
    el.innerHTML = `
      <header class="detail-head">
        <span class="detail-icon">${icon(kindIcon(d))}</span>
        <div class="detail-titles"><h2>${esc(displayName(settings, d))}</h2><div class="badges">${badges}</div></div>
        <div class="ringbox">${ring(h.score, h.level, 78, 7)}<span class="t-${lvl(h.level)} ring-level">${esc(fmt.levelLabel(h.level))}</span></div>
      </header>
      <nav class="tabs" role="tablist">${tabs.map(([id, t]) =>
        `<button role="tab" class="tab ${id === tab ? 'on' : ''}" data-tab="${id}" aria-selected="${id === tab}">${esc(_(t))}</button>`).join('')}</nav>
      <div class="tab-body">${tab === 'smart' ? smartTab(d) : tab === 'tests' ? testsTab(d) : tab === 'info' ? infoTab(d) : overviewTab(d)}</div>`;
}

function issueRow(i) {
    return `<div class="issue issue-${lvl(i.severity === 'info' ? 'info' : i.severity)} sev-${esc(i.severity)}">
      ${icon(SEVERITY_ICON[i.severity] ?? 'info')}<span>${esc(fmt.issueText(i, unit()))}</span></div>`;
}

function tile(iconName, caption, value, sub = '', level = null) {
    return `<div class="tile"><div class="tile-head">${icon(iconName)}<span>${esc(caption)}</span></div>
      <div class="tile-value ${level ? `t-${lvl(level)}` : ''}">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div></div>`;
}

/** Read test summary: [text, sub, level] */
function readTestSummary(d) {
    const rt = d.read_test;
    if (!rt)
        return [_('Not run yet'), '', null];
    if (rt.running)
        return [pct(rt.progress ?? 0, 1), _('Reading…'), null];
    if (rt.error)
        return ['—', rt.error, 'warning'];
    if (rt.errors > 0)
        return [_('{n} unreadable areas', {n: fmt.num(rt.errors)}), fmt.ago(rt.finished), 'critical'];
    if (rt.aborted)
        return [_('Stopped at {p}%', {p: fmt.num(rt.progress ?? 0, 1)}), fmt.ago(rt.finished), null];
    return [_('No errors'), fmt.ago(rt.finished), 'good'];
}

function volumesPanel(d) {
    if (!d.volumes?.length)
        return '';
    const rows = d.volumes.map(v => {
        const used = v.size ? (v.size - (v.free ?? 0)) / v.size * 100 : 0;
        const lv = used >= 95 ? 'crit' : used >= 85 ? 'warn' : 'good';
        return `<div class="vol">
          <div class="vol-top"><b>${esc(v.letter)}</b><span class="muted">${esc([v.label, v.fs].filter(Boolean).join(' · '))}</span>
            ${v.health && v.health !== 'Healthy' ? `<span class="badge badge-warn">${esc(v.health)}</span>` : ''}
            <span class="vol-free"><bdi>${esc(fmt.bytes(v.free))}</bdi> ${esc(_('free'))} / <bdi>${esc(fmt.bytes(v.size))}</bdi></span></div>
          <span class="bar"><i class="fill-${lv}" style="inline-size:${used.toFixed(1)}%"></i></span></div>`;
    }).join('');
    return `<section class="panel"><h3>${esc(_('Volumes'))}</h3>${rows}</section>`;
}

function flashTiles(d) {
    const ev = d.windows?.events ?? {};
    const errs = (ev.bad_blocks || 0) + (ev.controller || 0) + (ev.paging || 0) + (ev.retried || 0);
    const [rtText, rtSub, rtLevel] = readTestSummary(d);
    const winHealth = {Healthy: _('Good'), Warning: _('Warning'), Unhealthy: _('Critical')}[d.windows?.health] ?? (d.windows?.health || '—');
    const winLevel = {Healthy: 'good', Warning: 'warning', Unhealthy: 'critical'}[d.windows?.health] ?? null;
    return `<div class="tiles">
        ${tile('play', _('Read test'), rtText, rtSub, rtLevel)}
        ${tile('warning', _('Disk errors (30 days)'), fmt.num(errs), '', errs > 0 ? (ev.bad_blocks ? 'critical' : 'warning') : 'good')}
        ${tile('shield', _('Windows status'), winHealth, d.windows?.status ?? '', winLevel)}
        ${tile('lh-read-symbolic', _('Average speed'), d.read_test?.avg_mbps ? _('{v} MB/s', {v: fmt.num(d.read_test.avg_mbps, 1)}) : '—',
            d.read_test?.min_mbps ? `${_('Slowest')}: ${_('{v} MB/s', {v: fmt.num(d.read_test.min_mbps, 1)})}` : '')}
        ${tile('flash', _('Capacity'), fmt.bytes(d.capacity || d.windows?.size), deviceName(d))}
      </div>`;
}

function overviewTab(d) {
    const t = d.temperature ?? {};
    const issues = d.health?.issues ?? [];
    const [tt, tl] = tempText(settings, d);
    const life = d.life_remaining;
    const [smText, smSub, smLevel] = fmt.smartStatus(d);
    const lifeLevel = life === null || life === undefined ? null : life <= 10 ? 'critical' : life <= 30 ? 'warning' : 'good';
    const tSub = t.standby ? _('Sleeping (not woken up)') : t.source ? _('source: {s}', {s: t.source}) : '';

    const lvlTemp = fmt.tempLevel(settings, d);
    const issuesHtml = `<section class="panel issues">${issues.length ? issues.map(issueRow).join('')
        : `<div class="issue issue-good">${icon('ok')}<span>${esc(_('No problems found'))}</span></div>`}</section>`;
    if (d.kind === 'flash')
        return `${issuesHtml}${flashTiles(d)}${volumesPanel(d)}`;
    return `
      ${issuesHtml}
      <div class="tiles">
        ${tile('lh-thermometer-symbolic', _('Temperature'), tt, tSub, tl)}
        ${tile('lh-clock-symbolic', _('Power-on time'), fmt.hours(d.power_on_hours), fmt.duration(d.power_on_hours))}
        ${tile('lh-life-symbolic', _('Life remaining'), life === null || life === undefined ? '—' : fmt.percent(life), d.kind === 'hdd' ? '' : d.life_source ?? '', lifeLevel)}
        ${tile('lh-heart-symbolic', _('SMART status'), smText, smSub, smLevel)}
        ${tile('lh-write-symbolic', _('Data written'), fmt.bytes(d.data_written, d.data_approx))}
        ${tile('lh-read-symbolic', _('Data read'), fmt.bytes(d.data_read, d.data_approx))}
        ${tile('lh-power-symbolic', _('Power cycles'), fmt.num(d.power_cycles))}
        ${tile('hdd', _('Capacity'), fmt.bytes(d.capacity), deviceName(d))}
      </div>
      <section class="panel">
        <h3>${esc(_('Temperature'))} — ${esc(_('Last 24 hours'))}</h3>
        ${sparkline(t.history, lvlTemp === 'ok' ? 'good' : lvlTemp, 110)}
        <div class="temp-stats">
          <div><span>${esc(_('Now'))}</span><b>${esc(fmt.temp(t.current, unit()))}</b></div>
          <div><span>${esc(_('Min 24h'))}</span><b>${esc(fmt.temp(t.min_24h, unit()))}</b></div>
          <div><span>${esc(_('Max 24h'))}</span><b>${esc(fmt.temp(t.max_24h, unit()))}</b></div>
          <div><span>${esc(_('Lifetime max'))}</span><b>${esc(fmt.temp(t.lifetime_max, unit()))}</b></div>
        </div>
        ${(t.history ?? []).length < 2 ? `<p class="muted">${esc(_('No history yet'))}</p>` : ''}
      </section>
      ${volumesPanel(d)}`;
}

function infoTab(d) {
    const groups = featureGroups(d);
    const sections = specSections(d, unit());
    const ps = powerStates(d);
    const all = groups.flatMap(([, items]) => items);
    const yes = all.filter(f => f.supported).length;
    const show = f => featFilter === 'all' || (featFilter === 'yes') === f.supported;
    const panel = sec => `<section class="panel spec"><h3>${esc(sec.title)}</h3>
        ${sec.rows.map(([k, v]) => kv(k, String(v))).join('')}</section>`;
    const bySec = id => sections.find(x => x.id === id);
    const vols = (d.volumes ?? []).filter(v => v.letter);
    const volPanel = vols.length ? `<section class="panel spec"><h3>${esc(_('Logical drives'))}</h3>
        ${vols.map(v => kv(`⁦${v.letter}⁩`, [v.label, v.fs, fmt.bytes(v.size)].filter(Boolean).join(' · '))).join('')}</section>` : '';

    const filterBtn = (id, label, n) => `<button class="${featFilter === id ? 'on' : ''}" data-ffilter="${id}">${esc(label)} <b>${esc(fmt.num(n))}</b></button>`;
    const featHtml = all.length ? `
      <section class="panel">
        <div class="panel-head"><h3>${esc(_('Features'))}</h3>
          <div class="chips">${filterBtn('all', _('All'), all.length)}${filterBtn('yes', _('Supported'), yes)}${filterBtn('no', _('Not supported'), all.length - yes)}</div></div>
        ${groups.map(([title, items]) => {
            const rows = items.filter(show);
            return rows.length ? `<div class="feat-group">${groups.length > 1 ? `<h4>${esc(title)}</h4>` : ''}<div class="feat-list">${rows.map(f => `
              <div class="frow ${f.supported ? 'on' : 'off'}" title="${esc(f.supported ? _('Supported') : _('Not supported'))}">
                <span class="fi">${icon(f.supported ? 'check' : 'close')}</span>
                <span class="fname"><b>${esc(f.label)}</b>${f.desc ? `<small>${esc(f.desc)}</small>` : ''}</span>
                ${f.supported && f.detail ? `<span class="fstate">${esc(f.detail)}</span>` : ''}
              </div>`).join('')}</div></div>` : '';
        }).join('')}
      </section>` : `<p class="empty">${esc(_('This disk did not report its features.'))}</p>`;

    const psHtml = ps.length ? `
      <section class="panel"><h3>${esc(_('Power states'))}</h3>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>#</th><th>${esc(_('Max power'))}</th><th>${esc(_('Type'))}</th><th>${esc(_('Entry latency'))}</th><th>${esc(_('Exit latency'))}</th></tr></thead>
          <tbody>${ps.map(p => {
              const lat = us => (!us ? '—' : us >= 1000 ? _('{v} ms', {v: fmt.num(us / 1000, 1)}) : _('{v} µs', {v: fmt.num(us)}));
              return `<tr><td>PS${esc(p.id)}</td>
                <td>${p.watts === null ? '—' : esc(_('{v} W', {v: fmt.num(p.watts, 2)}))}</td>
                <td><span class="badge ${p.idle ? '' : 'badge-good'}">${esc(p.idle ? _('Sleep') : _('Active'))}</span></td>
                <td>${esc(lat(p.entry))}</td><td>${esc(lat(p.exit))}</td></tr>`;
          }).join('')}</tbody>
        </table></div></section>` : '';

    const top = [bySec('summary'), bySec('link')].filter(Boolean).map(panel).join('') + volPanel;
    const rest = sections.filter(x => !['summary', 'link'].includes(x.id)).map(panel).join('');
    return `<div class="spec-grid">${top}</div>${featHtml}<div class="spec-grid">${rest}</div>${psHtml}`;
}

function smartTab(d) {
    const out = [];
    const attrs = d.attributes ?? [];
    if (attrs.length) {
        const cols = ['ID', 'Attribute', 'Value', 'Worst', 'Threshold', 'Raw', 'Status'];
        out.push(`<section class="panel"><h3>SMART</h3><div class="table-wrap"><table class="table">
          <thead><tr>${cols.map(c => `<th>${esc(_(c))}</th>`).join('')}</tr></thead><tbody>
          ${attrs.map(a => `<tr class="row-${esc(a.status)}"><td>${esc(fmt.num(a.id))}</td>
            <td class="name">${esc((a.name ?? '').replace(/_/g, ' '))}</td><td>${esc(fmt.num(a.value))}</td>
            <td>${esc(fmt.num(a.worst))}</td><td>${esc(fmt.num(a.thresh))}</td><td class="mono">${esc(a.raw ?? '—')}</td>
            <td><span class="badge badge-${lvl(ATTR_LEVEL[a.status] ?? 'good')}">${esc(_(ATTR_STATUS[a.status] ?? 'OK'))}</span></td></tr>`).join('')}
          </tbody></table></div></section>`);
    }
    const nv = d.nvme;
    if (nv) {
        const u = unit();
        const rows = [
            [_('Critical warning'), nv.critical_warning ? `0x${Number(nv.critical_warning).toString(16)}` : fmt.num(0), nv.critical_warning ? 'critical' : 'good'],
            [_('Temperature'), fmt.temp(nv.temperature, u)],
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
            ...(nv.temperature_sensors ?? []).map((v, i) => [`${_('Temperature')} ${fmt.num(i + 1)}`, fmt.temp(v, u)]),
        ];
        out.push(`<section class="panel"><h3>${esc(_('NVMe health log'))}</h3><div class="kv-grid">${rows.map(([k, v, l]) => kv(k, v, l)).join('')}</div></section>`);
    }
    const sc = d.scsi;
    if (sc) {
        const pair = e => (e ? `${fmt.num(e.corrected)} / ${fmt.num(e.uncorrected)}` : '—');
        const rows = [
            [_('Grown defects'), fmt.num(sc.grown_defects), sc.grown_defects ? 'warning' : null],
            [_('Read: corrected / uncorrected'), pair(sc.read), sc.read?.uncorrected ? 'warning' : null],
            [_('Write: corrected / uncorrected'), pair(sc.write), sc.write?.uncorrected ? 'warning' : null],
            [_('Verify: corrected / uncorrected'), pair(sc.verify), sc.verify?.uncorrected ? 'warning' : null],
            [_('Start/stop cycles'), sc.specified_start_stop ? `${fmt.num(sc.start_stop_cycles)} / ${fmt.num(sc.specified_start_stop)}` : fmt.num(sc.start_stop_cycles)],
            [_('Load/unload cycles'), fmt.num(sc.load_unload_cycles)],
        ];
        if (sc.informational_exception)
            rows.push([_('Status'), sc.informational_exception]);
        out.push(`<section class="panel"><h3>${esc(_('SAS / SCSI counters'))}</h3><div class="kv-grid">${rows.map(([k, v, l]) => kv(k, v, l)).join('')}</div></section>`);
    }
    if (!out.length) {
        out.push(`<section class="panel"><p class="empty">${esc(_('No SMART attributes'))}</p>
          ${d.smart?.error === 'read_failed' ? `<p class="t-warn">${esc(fmt.issueText({code: 'smart_read_failed', params: {}}))}</p>` : ''}
          ${d.smart?.error_detail ? `<pre class="detail-log">${esc(d.smart.error_detail)}</pre>` : ''}</section>`);
    }
    return out.join('');
}

function testsTab(d) {
    const st = d.self_test ?? {};
    const canTest = d.smart?.available && !d.smart?.standby;
    const btn = (label, req, iconName) =>
        `<button class="btn" data-req='${esc(JSON.stringify({...req, disk: d.key}))}' ${canTest ? '' : 'disabled'}>${icon(iconName)}${esc(label)}</button>`;
    const lr = d.last_request;
    const tests = d.self_tests ?? [];
    const rt = d.read_test;
    const readTest = d.read_test_supported ? `
      <section class="panel">
        <h3>${esc(_('Read test'))}</h3>
        <p class="muted">${esc(_('Reads the whole drive and finds unreadable areas. Read only: your files are not changed. Takes a few minutes per 10 GB.'))}</p>
        ${rt?.running ? `<div class="running"><b>${esc(_('Reading… {p}%', {p: fmt.num(rt.progress ?? 0, 1)}))}${rt.errors ? ` — ${esc(_('{n} unreadable areas', {n: fmt.num(rt.errors)}))}` : ''}</b>
          <span class="bar"><i class="fill-${rt.errors ? 'crit' : 'good'}" style="inline-size:${Number(rt.progress) || 0}%"></i></span>
          <span class="muted bidi-auto">${esc(fmt.bytes(rt.done))} / ${esc(fmt.bytes(rt.total))}${rt.avg_mbps ? ` · ${esc(_('{v} MB/s', {v: fmt.num(rt.avg_mbps, 1)}))}` : ''}</span></div>` : ''}
        <div class="btn-row">${rt?.running
            ? `<button class="btn" data-req='${esc(JSON.stringify({action: 'readtest_abort', disk: d.key}))}'>${icon('stop')}${esc(_('Stop'))}</button>`
            : `<button class="btn btn-accent" data-req='${esc(JSON.stringify({action: 'readtest', disk: d.key}))}'>${icon('play')}${esc(_('Start read test'))}</button>`}</div>
        ${rt && !rt.running ? `<div class="kv-grid">
            ${kv(_('Last run'), readTestSummary(d)[0], readTestSummary(d)[2])}
            ${kv(_('Average speed'), rt.avg_mbps ? _('{v} MB/s', {v: fmt.num(rt.avg_mbps, 1)}) : null)}
            ${kv(_('Slowest'), rt.min_mbps ? _('{v} MB/s', {v: fmt.num(rt.min_mbps, 1)}) : null)}
            ${kv(_('Last update'), fmt.ago(rt.finished))}</div>` : ''}
      </section>` : '';
    if (d.kind === 'flash')
        return readTest;
    return `${readTest}
      <section class="panel">
        <h3>${esc(_('Self-tests'))}</h3>
        <p class="muted">${esc(_('Short test takes about 2 minutes, extended can take hours. The disk stays usable.'))}</p>
        ${st.running ? `<div class="running"><b>${esc(_('Test in progress'))}${typeof st.remaining === 'number' ? ` — ${esc(_('{p}% remaining', {p: fmt.num(st.remaining)}))}` : ''}</b>
          <span class="bar"><i class="fill-good" style="inline-size:${typeof st.remaining === 'number' ? 100 - st.remaining : 5}%"></i></span></div>` : ''}
        <div class="btn-row">${st.running ? btn(_('Abort test'), {action: 'abort'}, 'stop')
            : btn(_('Run short test'), {action: 'selftest', type: 'short'}, 'play') + btn(_('Run extended test'), {action: 'selftest', type: 'long'}, 'play')}</div>
        ${lr ? `<p class="${lr.ok ? 'muted' : 't-warn'}">${esc(_('Last request: {r}', {r: `${lr.action}${lr.type ? ` (${lr.type})` : ''} — ${lr.ok ? _('accepted') : _('rejected')} · ${fmt.ago(lr.at)}`}))}</p>` : ''}
      </section>
      <section class="panel">${tests.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>${esc(_('Type'))}</th><th>${esc(_('Result'))}</th><th>${esc(_('At hour'))}</th></tr></thead><tbody>
          ${tests.map(t => `<tr><td>${esc(t.type ?? '—')}</td>
            <td class="t-${t.passed === true ? 'good' : t.passed === false ? 'crit' : 'unknown'}">${esc(t.status ?? '—')}</td>
            <td>${esc(fmt.num(t.hours))}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="empty">${esc(_('No self-tests recorded'))}</p>`}</section>`;
}

// ------------------------------------------------------------------ settings dialog

let settingsPage = 'general';
const pct = (v, digits = 0) => `${fmt.num(v, digits)}${getLanguage() === 'fa' ? '٪' : '%'}`;

/** Rows that only make sense when another switch is on: [row key, required key]. */
const DEPENDS = [['tray-mode', 'tray-enabled'], ['float-opacity', 'float-enabled'], ['float-locked', 'float-enabled']];

function syncSettingsDeps(dlg) {
    for (const [key, need] of DEPENDS)
        dlg.querySelector(`[data-row="${key}"]`)?.classList.toggle('off', !settings.o[need]);
}

function renderSettings() {
    const dlg = $('#settings-dlg');
    const s = settings.o;
    const linux = platform.os === 'linux';
    const os = platform.os;
    const sel = (key, options) => `<span class="select"><select data-key="${key}">${options.map(([v, t]) =>
        `<option value="${esc(v)}" ${String(s[key]) === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></span>`;
    const seg = (key, options) => `<div class="seg" role="radiogroup">${options.map(([v, t]) =>
        `<label><input type="radio" name="${key}" value="${esc(v)}" data-key="${key}" ${String(s[key]) === v ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}</div>`;
    const sw = key => `<label class="switch"><input type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}><i></i></label>`;
    const row = (key, title, control, sub = '') => `<div class="set-row" data-row="${key}"><div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>${control}</div>`;
    const group = (title, rows) => `<div class="set-group">${title ? `<h4>${esc(title)}</h4>` : ''}<div class="set-card">${rows}</div></div>`;
    const num = key => `<span class="num-in"><input type="number" min="20" max="100" data-key="${key}" value="${esc(s[key])}"><i>°C</i></span>`;
    const opacity = Number(s['float-opacity'] ?? 94);
    const aliases = s['disk-aliases'] ?? {};

    const pages = [
        ['general', 'settings', _('General'), `
          ${group('', `
            ${row('language', _('Language'), sel('language', languageChoices(_('Automatic'))))}
            ${row('temp-unit', _('Temperature unit'), seg('temp-unit', [['C', '°C'], ['F', '°F']]))}
            ${row('autostart', _('Start at login'), sw('autostart'))}`)}`],
        ['tray', 'tray', os === 'macos' ? _('Menu bar') : _('Tray icon'), `
          ${group('', `
            ${row('tray-enabled', _('Show temperature in the tray'), sw('tray-enabled'), linux ? _('GNOME shows temperatures in the top panel through the Disk Guardian extension.') : '')}
            ${row('tray-mode', _('Show'), seg('tray-mode', [['max', _('Hottest disk')], ['default', _('Default disk')]]))}`)}`],
        ...(os === 'windows' ? [['taskbar', 'taskbar', _('Taskbar'), `
          ${group('', row('taskbar-enabled', _('Show in the taskbar'), sw('taskbar-enabled'), _('Temperatures next to the clock, inside the Windows taskbar.')))}`],
          ['explorer', 'shield', _('File Explorer'), `
          ${group('', row('explorer-health', _('Show health on drives'), sw('explorer-health'), _('Health score and a colored badge on every drive in This PC.')))}`]] : []),
        ['widget', 'widget', _('Floating widget'), `
          ${group('', `
            ${row('float-enabled', _('Show floating widget'), sw('float-enabled'))}
            ${row('float-opacity', _('Opacity'), `<div class="range"><input type="range" min="40" max="100" data-key="float-opacity" value="${esc(opacity)}" style="--p:${(opacity - 40) / 60 * 100}%"><output>${esc(pct(opacity))}</output></div>`)}
            ${row('float-locked', _('Lock position'), sw('float-locked'))}`)}`],
        ['alerts', 'lh-thermometer-symbolic', _('Temperature alerts'), `
          <div class="set-group"><div class="set-card"><div class="thresholds">
            <span></span><span class="th th-warn">${esc(_('Warning'))}</span><span class="th th-crit">${esc(_('Critical'))}</span>
            ${['hdd', 'ssd', 'nvme'].map(k => `<span class="kind">${icon(k)}${esc(fmt.kindLabel({kind: k}))}</span>${num(`temp-warn-${k}`)}${num(`temp-crit-${k}`)}`).join('')}
          </div></div></div>`],
        ['disks', 'hdd', _('Disks'), disks().length ? group('', disks().map(d => `<div class="set-row disk-row">
              ${icon(kindIcon(d), 'disk-ico')}
              <div><b>${esc(d.model || d.name)}</b><small>${esc([deviceName(d), fmt.bytes(d.capacity), d.serial].filter(Boolean).join(' · '))}</small></div>
              <input type="text" class="text-in" data-alias="${esc(d.key)}" placeholder="${esc(_('Display name'))}" value="${esc(aliases[d.key] ?? '')}">
              <label class="switch" title="${esc(_('Show in panel'))}"><input type="checkbox" data-show="${esc(d.key)}" ${hidden().includes(d.key) ? '' : 'checked'}><i></i></label>
            </div>`).join('')) : `<p class="set-note">${esc(_('Start the collector to see your disks here.'))}</p>`],
        ['updates', 'download', _('Updates'), updatesPage(group, row, sw)],
        ['about', 'info', _('About'), `
          <div class="set-card about-box">
            <span class="brand-mark">${icon('hdd')}</span>
            <h4>${esc(ABOUT.name)}</h4>
            <p>${esc(_('Version'))} <span class="mono">${esc(platform.version ?? '')}</span> · ${esc(platform.os ?? '')}</p>
            <p class="about-desc">${esc(_(ABOUT_DESCRIPTION))}</p>
          </div>
          ${group('', [
              [_('Created by'), esc(ABOUT.author)],
              [_('Created'), esc(aboutDate(ABOUT.created, getLanguageTag()))],
              [_('Last updated'), esc(aboutDate(ABOUT.updated, getLanguageTag()))],
              [_('Source code'), `<span class="mono sel" dir="ltr">${esc(ABOUT.repo.replace(/^https:\/\//, ''))}</span>`],
          ].map(([k, v]) => `<div class="set-row about-row"><div><b>${esc(k)}</b></div><span>${v}</span></div>`).join(''))}
          ${snap.path ? `<p class="set-note"><span class="mono sel" dir="ltr">${esc(snap.path)}</span></p>` : ''}`],
    ];
    if (!pages.some(p => p[0] === settingsPage))
        settingsPage = 'general';
    const title = pages.find(p => p[0] === settingsPage)[2];

    dlg.innerHTML = `<form method="dialog" class="settings">
      <nav class="set-nav">
        <h2>${esc(_('Settings'))}</h2>
        ${pages.map(([id, ico, t]) => `<button type="button" data-page="${id}" class="${id === settingsPage ? 'on' : ''}">${icon(ico)}<span>${esc(t)}</span></button>`).join('')}
      </nav>
      <div class="set-main">
        <header class="set-head"><h3>${esc(title)}</h3><button class="icon-btn" value="close" title="${esc(_('Close'))}">${icon('close')}</button></header>
        <div class="set-pages">${pages.map(([id, , , body]) => `<section class="set-page" data-page-body="${id}" ${id === settingsPage ? '' : 'hidden'}>${body}</section>`).join('')}</div>
      </div></form>`;

    for (const b of dlg.querySelectorAll('[data-page]')) {
        b.addEventListener('click', () => {
            settingsPage = b.dataset.page;
            for (const x of dlg.querySelectorAll('[data-page]'))
                x.classList.toggle('on', x === b);
            for (const x of dlg.querySelectorAll('[data-page-body]'))
                x.hidden = x.dataset.pageBody !== settingsPage;
            dlg.querySelector('.set-head h3').textContent = b.textContent.trim();
            dlg.querySelector('.set-pages').scrollTop = 0;
        });
    }
    for (const el of dlg.querySelectorAll('[data-key]')) {
        el.addEventListener('change', () => {
            const k = el.dataset.key;
            const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
            settings.o[k] = v;
            syncSettingsDeps(dlg);
            saveSettings({[k]: v});
        });
    }
    const range = dlg.querySelector('input[type="range"]');
    range?.addEventListener('input', () => {
        range.style.setProperty('--p', `${(range.value - 40) / 60 * 100}%`);
        range.nextElementSibling.textContent = pct(Number(range.value));
    });
    for (const el of dlg.querySelectorAll('[data-alias]')) {
        el.addEventListener('change', () => {
            const a = {...(settings.o['disk-aliases'] ?? {})};
            if (el.value.trim())
                a[el.dataset.alias] = el.value.trim();
            else
                delete a[el.dataset.alias];
            saveSettings({'disk-aliases': a});
        });
    }
    for (const el of dlg.querySelectorAll('[data-show]')) {
        el.addEventListener('change', () => {
            const set = new Set(hidden());
            if (el.checked)
                set.delete(el.dataset.show);
            else
                set.add(el.dataset.show);
            saveSettings({'hidden-disks': [...set]});
        });
    }
    bindUpdatesPage();
    syncSettingsDeps(dlg);
}

function openUpdates() {
    settingsPage = 'updates';
    renderSettings();
    const dlg = $('#settings-dlg');
    if (!dlg.open)
        dlg.showModal();
}

// ------------------------------------------------------------------ window frame (custom title bar)

function bindWindowFrame() {
    const win = currentWindow();
    const bar = $('.topbar');
    const NO_DRAG = 'button, input, select, a, .win-ctl';
    bar.addEventListener('mousedown', e => {
        if (e.button !== 0 || e.target.closest(NO_DRAG))
            return;
        if (e.detail === 2)
            win.toggleMaximize();
        else
            win.startDragging();
    });
    $('#win-min').addEventListener('click', () => win.minimize());
    $('#win-max').addEventListener('click', () => win.toggleMaximize());
    $('#win-close').addEventListener('click', () => win.close());
    const syncMax = async () => {
        const max = await win.isMaximized().catch(() => false);
        const b = $('#win-max');
        b.querySelector('.ico').style.setProperty('--i', `url(/icons/${max ? 'win-restore' : 'win-max'}.svg)`);
        b.title = _(max ? 'Restore' : 'Maximize');
        document.documentElement.classList.toggle('maximized', max);
    };
    win.onResized(syncMax);
    syncMax();
}

// ------------------------------------------------------------------ wiring

function renderAll() {
    const list = disks();
    if (!list.some(d => d.key === selected))
        selected = (list.find(d => d.key === settings.get_string('default-disk')) ?? list[0])?.key ?? null;
    renderStatus();
    renderBanner();
    renderList();
    renderDetail();
}

async function refreshState() {
    try {
        snap = await loadState();
    } catch (e) {
        snap = {status: 'error', state: null, error: String(e)};
    }
    renderAll();
}

function bind() {
    $('#disk-list').addEventListener('click', e => {
        const star = e.target.closest('[data-star]');
        if (star) {
            e.stopPropagation();
            saveSettings({'default-disk': star.dataset.star, 'float-enabled': true});
            return;
        }
        const card = e.target.closest('.card');
        if (card) {
            selected = card.dataset.key;
            renderList();
            renderDetail();
        }
    });
    $('#detail').addEventListener('click', async e => {
        const ff = e.target.closest('[data-ffilter]');
        if (ff) {
            featFilter = ff.dataset.ffilter;
            renderDetail();
            return;
        }
        const t = e.target.closest('[data-tab]');
        if (t) {
            tab = t.dataset.tab;
            renderDetail();
            return;
        }
        const r = e.target.closest('[data-req]');
        if (r) {
            const err = await sendRequest(JSON.parse(r.dataset.req));
            toast(err ?? _('Request sent'), err ? 'warn' : 'good');
        }
    });
    $('#btn-refresh').addEventListener('click', async () => {
        const err = await sendRequest({action: 'refresh'});
        toast(err ?? _('Refreshing…'), err ? 'warn' : 'info');
        refreshState();
    });
    $('#btn-settings').addEventListener('click', () => {
        renderSettings();
        $('#settings-dlg').showModal();
    });
    // click on the dimmed backdrop closes the dialog
    $('#settings-dlg').addEventListener('mousedown', e => {
        if (e.target === e.currentTarget)
            e.currentTarget.close();
    });
    window.addEventListener('keydown', e => {
        if (e.key === 'F5' || (e.key === 'r' && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            $('#btn-refresh').click();
        }
    });
}

async function init() {
    settings = await loadSettings();
    platform = await invoke('platform_info');
    document.documentElement.dataset.os = platform.os;
    applyLanguage(settings);
    bindWindowFrame();
    const m = location.hash.match(/disk=([^&]+)/);
    if (m)
        selected = decodeURIComponent(m[1]);
    bind();
    initUpdates({settings, platform, openUpdates});
    await refreshState();
    listen('state-changed', refreshState);
    listen('settings-changed', e => {
        const langBefore = getLanguage();
        settings.o = e.payload;
        applyLanguage(settings);
        renderAll();
        refreshUpdates();
        const dlg = $('#settings-dlg');
        if (dlg.open && langBefore !== getLanguage())
            renderSettings();
        else if (dlg.open)
            syncSettingsDeps(dlg);
    });
    listen('select-disk', e => {
        selected = e.payload;
        tab = 'overview';
        renderAll();
    });
    setInterval(renderStatus, 5000);
}

init().catch(e => {
    document.body.innerHTML = `<pre class="fatal">${esc(e?.stack ?? e)}</pre>`;
});

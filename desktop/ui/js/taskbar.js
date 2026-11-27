// Windows taskbar widget (docked into the taskbar by src-tauri/src/taskbar.rs):
// one or two disks, "C:  38°", colored by temperature level. Click opens the app.
import {_, fmt, invoke, listen, loadSettings, applyLanguage, loadState, esc, lvl, displayName, deviceName} from './common.js';

let settings;
let snap = {status: 'loading', state: null};
let lastWidth = 0;
const el = document.getElementById('tb');

/** Default disk first, then the hottest of the others; at most two. */
function pick() {
    const hidden = settings.get_strv('hidden-disks');
    const list = (snap.state?.disks ?? []).filter(d => !hidden.includes(d.key));
    const def = list.find(d => d.key === settings.get_string('default-disk'));
    const t = d => (typeof d.temperature?.current === 'number' ? d.temperature.current : -1);
    const rest = list.filter(d => d !== def).sort((a, b) => t(b) - t(a));
    return [def, ...rest].filter(Boolean).slice(0, 2);
}

function shortName(d) {
    const aliases = settings.get_value('disk-aliases').deepUnpack();
    if (aliases[d.key])
        return aliases[d.key];
    return d.drive_letters?.[0] ?? deviceName(d);
}

async function render() {
    const disks = pick();
    const unit = settings.get_string('temp-unit') || 'C';
    el.classList.toggle('one', disks.length < 2);
    if (!disks.length) {
        el.innerHTML = `<div class="tb-row"><span class="tb-name">${esc(_('Disk Guardian'))}</span><b>—</b></div>`;
    } else {
        el.innerHTML = disks.map(d => {
            const t = d.temperature ?? {};
            const text = typeof t.current === 'number' ? fmt.temp(t.current, unit, true) : (t.standby ? '💤' : '—');
            return `<div class="tb-row"><span class="tb-name">${esc(shortName(d))}</span>
                <b class="t-${lvl(fmt.tempLevel(settings, d))}">${esc(text)}</b></div>`;
        }).join('');
    }
    el.title = disks.map(d => `${displayName(settings, d)}: ${fmt.temp(d.temperature?.current, unit)}`).join('\n') || _('Disk Guardian');
    await new Promise(r => requestAnimationFrame(r));
    const width = Math.ceil(el.getBoundingClientRect().width) + 4;
    if (width !== lastWidth) {
        lastWidth = width;
        invoke('taskbar_resize', {width}).catch(() => {});
    }
}

async function theme() {
    const light = await invoke('taskbar_light').catch(() => false);
    document.documentElement.classList.toggle('tb-light', light);
}

async function refresh() {
    try {
        snap = await loadState();
    } catch {
        snap = {status: 'error', state: null};
    }
    render();
}

el.addEventListener('click', () => invoke('show_main_window', {disk: pick()[0]?.key ?? null}));

async function init() {
    settings = await loadSettings();
    applyLanguage(settings);
    await theme();
    await refresh();
    listen('state-changed', refresh);
    listen('settings-changed', e => {
        settings.o = e.payload;
        applyLanguage(settings);
        render();
    });
    setInterval(theme, 30000);
}

init();

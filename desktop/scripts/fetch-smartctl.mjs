// Puts smartctl into src-tauri/binaries/ so the installer ships it next to
// disk-guardian (bundle.externalBin, see tauri.smartctl.conf.json).
//
//   Windows: downloads the official smartmontools installer from GitHub,
//            checks its .md5, extracts smartctl.exe with 7-Zip: the 64-bit build for
//            x64, the 32-bit build for x86 and ARM64 (Windows on ARM runs x86 code)
//   macOS:   copies smartctl from Homebrew (brew install smartmontools)
//
// smartmontools is GPL-2.0; it is shipped unmodified as a separate program.
// Source: https://github.com/smartmontools/smartmontools
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION = '7.5';
const TAG = `RELEASE_${VERSION.replace('.', '_')}`;
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(desktop, 'src-tauri', 'binaries');

/** Target of this build: tauri build --target … sets TAURI_ENV_TARGET_TRIPLE, else the host. */
function triple() {
    if (process.env.TAURI_ENV_TARGET_TRIPLE)
        return process.env.TAURI_ENV_TARGET_TRIPLE;
    const out = execFileSync('rustc', ['-vV'], {encoding: 'utf8'});
    return out.match(/^host: (.+)$/m)[1].trim();
}

async function download(url) {
    const r = await fetch(url, {redirect: 'follow'});
    if (!r.ok)
        throw new Error(`${url}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}

function find(dir, name) {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const f = find(p, name);
            if (f)
                return f;
        } else if (e.name.toLowerCase() === name) {
            return p;
        }
    }
    return null;
}

async function windows(target, bits) {
    const sevenZip = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe', '7z'].find(p => p === '7z' || existsSync(p));
    const base = `https://github.com/smartmontools/smartmontools/releases/download/${TAG}/smartmontools-${VERSION}.win32-setup.exe`;
    const setup = await download(base);
    const md5 = (await download(`${base}.md5`)).toString('utf8').trim().split(/\s+/)[0].toLowerCase();
    const got = createHash('md5').update(setup).digest('hex');
    if (got !== md5)
        throw new Error(`checksum mismatch: expected ${md5}, got ${got}`);
    const work = mkdtempSync(path.join(tmpdir(), 'smartctl-'));
    try {
        const exe = path.join(work, 'setup.exe');
        writeFileSync(exe, setup);
        execFileSync(sevenZip, ['x', '-y', `-o${path.join(work, 'x')}`, exe], {stdio: 'ignore'});
        // the installer carries bin/ (64-bit) and bin32/ (32-bit)
        const bin = path.join(work, 'x', bits === 32 ? 'bin32' : 'bin', 'smartctl.exe');
        const src = existsSync(bin) ? bin : bits === 64 && find(path.join(work, 'x'), 'smartctl.exe');
        if (!src)
            throw new Error('smartctl.exe not found in the installer');
        copyFileSync(src, target);
    } finally {
        rmSync(work, {recursive: true, force: true});
    }
}

function macos(target) {
    const prefix = execFileSync('brew', ['--prefix'], {encoding: 'utf8'}).trim();
    const src = path.join(prefix, 'sbin', 'smartctl');
    if (!existsSync(src))
        throw new Error('smartctl not found: brew install smartmontools');
    copyFileSync(src, target);
    chmodSync(target, 0o755);
}

const t = triple();
const target = path.join(outDir, `smartctl-${t}${t.includes('windows') ? '.exe' : ''}`);
if (existsSync(target) && !process.argv.includes('--force')) {
    console.log(`fetch-smartctl: ${path.relative(desktop, target)} already there`);
    process.exit(0);
}
mkdirSync(outDir, {recursive: true});
if (t.includes('windows'))
    await windows(target, t.startsWith('x86_64') ? 64 : 32);
else if (process.platform === 'darwin')
    macos(target);
else {
    console.log('fetch-smartctl: on Linux smartctl comes from the smartmontools package');
    process.exit(0);
}
const version = execFileSync(target, ['--version'], {encoding: 'utf8'}).split('\n')[0];
console.log(`fetch-smartctl: ${path.relative(desktop, target)} (${(statSync(target).size / 1024).toFixed(0)} KiB) — ${version}`);

#!/usr/bin/env node
// Release helper for the self-updater (src-tauri/src/updater.rs).
//
//   node scripts/release.mjs keygen
//       Creates the Ed25519 release key (once). The private key goes to
//       ~/.disk-guardian/update-signing-key.pem (keep it safe, never commit it);
//       the public key is written into src-tauri/src/updater.rs.
//
//   node scripts/release.mjs pack <artifacts-dir> [--mandatory] [--notes-en "..."] [--notes-fa "..."]
//       <artifacts-dir>: the build outputs of every platform (e.g. the unzipped CI artifacts;
//       searched recursively): "*-setup.exe", "*-portable.zip", "*.deb", "*.rpm", "*.AppImage",
//       "*.app.tar.gz", "*.dmg". Options: --notes-file <json> ({"en", "fa", ..., "mandatory"}).
//       Writes release/v<version>/ with stable file names + SHA256SUMS.txt + SHA256SUMS.txt.sig
//       and adds the release to updates.json (repo root). Then:
//         gh release create v<version> release/v<version>/*     (upload the files)
//         git commit updates.json && git push                  (users get the update)
//
// Environment: DISKGUARDIAN_SIGNING_KEY = path of the private key (default above),
//              DISKGUARDIAN_REPO = owner/repo on GitHub (default from updater.rs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const UPDATER_RS = path.join(desktop, 'src-tauri', 'src', 'updater.rs');
const MANIFEST = path.join(root, 'updates.json');
const KEY = process.env.DISKGUARDIAN_SIGNING_KEY || path.join(os.homedir(), '.disk-guardian', 'update-signing-key.pem');

const die = msg => {
    console.error(`release: ${msg}`);
    process.exit(1);
};

function keygen() {
    if (fs.existsSync(KEY))
        die(`${KEY} already exists. Delete it only if you really want a new key: installed apps then no longer accept updates.`);
    const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(KEY), {recursive: true});
    fs.writeFileSync(KEY, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
    const raw = publicKey.export({type: 'spki', format: 'der'}).subarray(-32).toString('hex');
    const rs = fs.readFileSync(UPDATER_RS, 'utf8').replace(/const PUBLIC_KEY_HEX: &str = "[0-9a-f]*";/, `const PUBLIC_KEY_HEX: &str = "${raw}";`);
    fs.writeFileSync(UPDATER_RS, rs);
    console.log(`private key: ${KEY}  (back it up, never commit it)`);
    console.log(`public key:  ${raw}  (written to src-tauri/src/updater.rs)`);
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory())
            walk(p, out);
        else
            out.push(p);
    }
    return out;
}

/** x64 | x86 | arm from a Tauri bundle name (x64 / amd64 / x86_64, x86 / i686, aarch64 / arm64). */
function arch(name) {
    if (/aarch64|arm64/i.test(name))
        return 'arm';
    if (/x86_64|amd64|x64/i.test(name))
        return 'x64';
    if (/i686|x86/i.test(name))
        return 'x86';
    return null;
}

const WIN = {x64: 'x64', x86: 'x86', arm: 'arm64'};
const MAC = {x64: 'x64', arm: 'aarch64'};
const DEB = {x64: 'amd64', arm: 'arm64'};
const RPM = {x64: 'x86_64', arm: 'aarch64'};

/** build output -> [platform, download key, stable file name] (keys: see src-tauri/src/updater.rs) */
function classify(file) {
    const n = path.basename(file);
    const a = arch(n);
    const one = (map, plat, key, name) => map[a] ? [plat, `${key}-${map[a]}`, name.replace('*', map[a])] : null;
    if (/-setup\.exe$/i.test(n))
        return one(WIN, 'windows', 'installer', 'Disk-Guardian-Windows-Setup-*.exe');
    if (/-portable\.zip$/i.test(n))
        return one(WIN, 'windows', 'portable', 'Disk-Guardian-Windows-Portable-*.zip');
    if (/\.deb$/i.test(n))
        return one(DEB, 'linux', 'deb', 'Disk-Guardian-Linux-*.deb');
    if (/\.rpm$/i.test(n))
        return one(RPM, 'linux', 'rpm', 'Disk-Guardian-Linux-*.rpm');
    if (/\.AppImage$/i.test(n))
        return one(RPM, 'linux', 'appimage', 'Disk-Guardian-Linux-*.AppImage');
    if (/\.app\.tar\.gz$/i.test(n))
        return one(MAC, 'macos', 'app', 'Disk-Guardian-macOS-*.app.tar.gz');
    if (/\.dmg$/i.test(n))
        return one(MAC, 'macos', 'dmg', 'Disk-Guardian-macOS-*.dmg');
    return null;
}

function arg(args, name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}

function pack(args) {
    const src = args[0];
    if (!src || !fs.existsSync(src))
        die('usage: node scripts/release.mjs pack <artifacts-dir> [--mandatory] [--notes-en ".."] [--notes-fa ".."]');
    if (!fs.existsSync(KEY))
        die(`no signing key at ${KEY} (run: node scripts/release.mjs keygen)`);
    const version = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
    const repo = process.env.DISKGUARDIAN_REPO
        || fs.readFileSync(UPDATER_RS, 'utf8').match(/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\//)?.[1];
    const tag = `v${version}`;
    const out = path.join(root, 'release', tag);
    fs.rmSync(out, {recursive: true, force: true});
    fs.mkdirSync(out, {recursive: true});

    const platforms = {};
    for (const f of walk(src)) {
        const c = classify(f);
        if (!c)
            continue;
        const [plat, key, name] = c;
        if (!path.basename(f).includes(version))
            die(`${f} is not version ${version} (tauri.conf.json)`);
        fs.copyFileSync(f, path.join(out, name));
        (platforms[plat] ??= {})[key] = {file: name};
        console.log(`  ${name}  <-  ${path.relative(src, f)}`);
    }
    if (!Object.keys(platforms).length)
        die(`no installers found in ${src}`);

    const sums = fs.readdirSync(out).sort().map(n =>
        `${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, n))).digest('hex')}  ${n}`).join('\n') + '\n';
    fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums);
    const key = crypto.createPrivateKey(fs.readFileSync(KEY));
    fs.writeFileSync(path.join(out, 'SHA256SUMS.txt.sig'), crypto.sign(null, Buffer.from(sums), key).toString('hex') + '\n');

    const m = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
    m.releases ??= {};
    m.platforms ??= {};
    m.announcements ??= [];
    // --notes-file release-notes/v1.6.0.json: {"en": "...", "fa": "...", "mandatory": false}
    const file = arg(args, '--notes-file');
    const extra = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const mandatory = args.includes('--mandatory') || extra.mandatory === true;
    const notes = {};
    for (const [k, v] of Object.entries(extra))
        if (typeof v === 'string')
            notes[k] = v;
    if (arg(args, '--notes-en'))
        notes.en = arg(args, '--notes-en');
    if (arg(args, '--notes-fa'))
        notes.fa = arg(args, '--notes-fa');
    m.releases[version] = {
        release_url: `https://github.com/${repo}/releases/tag/${tag}`,
        base_url: `https://github.com/${repo}/releases/download/${tag}/`,
        checksums_file: 'SHA256SUMS.txt',
        signature_file: 'SHA256SUMS.txt.sig',
        ...(Object.keys(notes).length ? {notes} : {}),
    };
    for (const [plat, downloads] of Object.entries(platforms))
        m.platforms[plat] = {version, mandatory, downloads};
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');

    console.log(`\n${out}\n  SHA256SUMS.txt + SHA256SUMS.txt.sig (signed)\nupdates.json: ${version} for ${Object.keys(platforms).join(', ')}`);
    console.log(`\nNext:\n  gh release create ${tag} release/${tag}/* --title "Disk Guardian ${version}"\n  git add updates.json && git commit -m "Release ${version}" && git push`);
    console.log('Publish the GitHub release first, then push updates.json.');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'keygen')
    keygen();
else if (cmd === 'pack')
    pack(rest);
else
    die('commands: keygen | pack <artifacts-dir>');

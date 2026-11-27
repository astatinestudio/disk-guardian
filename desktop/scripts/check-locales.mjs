// Checks extension/lib/locales/*.js against the Persian table (the reference key set):
// every key translated, no unknown keys, same {placeholders}. Run: node desktop/scripts/check-locales.mjs
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension/lib/locales');
const load = async f => (await import(pathToFileURL(path.join(dir, f)).href)).default;
const ref = await load('fa.js');
const keys = Object.keys(ref);
const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
let bad = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    const t = await load(f);
    const missing = keys.filter(k => !(k in t));
    const extra = Object.keys(t).filter(k => !(k in ref));
    const phErr = Object.entries(t).filter(([k, v]) => typeof v !== 'string' || ph(k) !== ph(v)).map(([k]) => k);
    const ok = !missing.length && !extra.length && !phErr.length;
    bad += ok ? 0 : 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}: ${Object.keys(t).length}/${keys.length}`);
    for (const [label, list] of [['missing', missing], ['unknown', extra], ['placeholders', phErr]])
        if (list.length) console.log(`     ${label}: ${list.map(k => JSON.stringify(k)).join(', ')}`);
}
process.exit(bad ? 1 : 0);

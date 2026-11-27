// Copies the code and icons shared with the GNOME Shell extension into ui/:
//   extension/lib/{i18n,format,normalize,about}.js, locales/ -> ui/lib/  (translations, formatting, SMART analysis:
//                                                     one source of truth for the app and the extension)
//   fonts/Vazirmatn-*.ttf          -> ui/fonts/    (Persian / Arabic UI font, OFL, see css/style.css)
// Set BUNDLE_FONTS=0 to build without the font (an installed Vazirmatn is used then).
import {copyFileSync, mkdirSync, readdirSync, existsSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const ui = path.join(desktop, 'ui');

function copyDir(from, to, filter) {
    mkdirSync(to, {recursive: true});
    let n = 0;
    for (const f of readdirSync(from).filter(filter)) {
        copyFileSync(path.join(from, f), path.join(to, f));
        n++;
    }
    return n;
}

const lib = path.join(ui, 'lib');
mkdirSync(lib, {recursive: true});
for (const f of ['i18n.js', 'format.js', 'normalize.js', 'about.js'])
    copyFileSync(path.join(root, 'extension', 'lib', f), path.join(lib, f));
const locales = copyDir(path.join(root, 'extension', 'lib', 'locales'), path.join(lib, 'locales'), f => f.endsWith('.js'));
// ui/icons has its own filled icon set (Material Symbols Rounded, Apache 2.0); the
// extension's GNOME symbolic icons are no longer copied over it.

const fontsOut = path.join(ui, 'fonts');
const FONT_WEIGHTS = ['Light', 'Regular', 'SemiBold', 'Bold', 'ExtraBold', 'Black'];
let fonts = 0;
if (existsSync(fontsOut))
    rmSync(fontsOut, {recursive: true});
if (process.env.BUNDLE_FONTS !== '0' && existsSync(path.join(root, 'fonts')))
    fonts = copyDir(path.join(root, 'fonts'), fontsOut, f => f === 'OFL.txt' || FONT_WEIGHTS.some(w => f === `Vazirmatn-${w}.ttf`));

console.log(`sync-shared: lib (i18n.js, format.js, normalize.js, about.js, ${locales} locales)${fonts ? `, ${fonts} fonts` : ''}`);

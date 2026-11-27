// Tiny built-in translation layer: English strings are the keys.
// Shared by the shell extension, its preferences window and the desktop app
// (desktop/ui, copied by desktop/scripts/sync-shared.mjs): no GJS / browser
// specific imports here. One file per language in ./locales/.

import ar from './locales/ar.js';
import de from './locales/de.js';
import es from './locales/es.js';
import fa from './locales/fa.js';
import fr from './locales/fr.js';
import hi from './locales/hi.js';
import id from './locales/id.js';
import it from './locales/it.js';
import ja from './locales/ja.js';
import ko from './locales/ko.js';
import nl from './locales/nl.js';
import pl from './locales/pl.js';
import pt from './locales/pt.js';
import ru from './locales/ru.js';
import tr from './locales/tr.js';
import uk from './locales/uk.js';
import vi from './locales/vi.js';
import zh from './locales/zh.js';

/**
 * Supported UI languages: [code, native name, {rtl, tag}] (tag = BCP 47 tag for
 * html[lang], picks the right CJK glyphs). Order = order in the language menus.
 */
export const LANGUAGES = [
    ['ar', 'العربية', {rtl: true}],
    ['de', 'Deutsch'],
    ['en', 'English'],
    ['es', 'Español'],
    ['fr', 'Français'],
    ['id', 'Bahasa Indonesia'],
    ['it', 'Italiano'],
    ['nl', 'Nederlands'],
    ['pl', 'Polski'],
    ['pt', 'Português'],
    ['tr', 'Türkçe'],
    ['vi', 'Tiếng Việt'],
    ['ru', 'Русский'],
    ['uk', 'Українська'],
    ['fa', 'فارسی', {rtl: true}],
    ['hi', 'हिन्दी'],
    ['zh', '简体中文', {tag: 'zh-CN'}],
    ['ja', '日本語'],
    ['ko', '한국어'],
];

const TABLES = {ar, de, es, fa, fr, hi, id, it, ja, ko, nl, pl, pt, ru, tr, uk, vi, zh};
const INFO = Object.fromEntries(LANGUAGES.map(([code, name, opts = {}]) => [code, {name, ...opts}]));

let _lang = 'en';
let _table = null;

/** "pt_BR.UTF-8" / "zh-Hans-CN" / "fa_IR@latin" -> "pt" / "zh" / "fa"; null if unsupported. */
function _match(name) {
    const base = String(name ?? '').toLowerCase().split(/[_.@-]/)[0];
    return INFO[base] ? base : null;
}

/**
 * @param pref language code from LANGUAGES, or 'auto'
 * @param systemLanguages preferred system languages, first is the UI language
 *        (GJS: GLib.get_language_names(), browser: navigator.languages)
 */
export function setLanguage(pref, systemLanguages = []) {
    _lang = INFO[pref] ? pref : _match(systemLanguages[0]) ?? 'en';
    _table = TABLES[_lang] ?? null;
}

export function getLanguage() {
    return _lang;
}

/** BCP 47 tag for the current language (html[lang]). */
export function getLanguageTag() {
    return INFO[_lang]?.tag ?? _lang;
}

export function isRtl() {
    return INFO[_lang]?.rtl === true;
}

/** Choices for a language menu: [['auto', automaticLabel], [code, native name], ...]. */
export function languageChoices(automaticLabel) {
    return [['auto', automaticLabel], ...LANGUAGES.map(([code, name]) => [code, name])];
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Persian digits / separators; other languages keep ASCII digits. */
export function localizeDigits(s) {
    s = String(s);
    if (_lang !== 'fa')
        return s;
    // decimal point as "/" (common Persian usage; the Arabic separator ٫ is easily
    // misread as a comma at small UI sizes)
    return s.replace(/[0-9]/g, d => FA_DIGITS[d]).replace(/(\d|[۰-۹]),(?=[۰-۹])/g, '$1٬')
        .replace(/([۰-۹])\.([۰-۹])/g, '$1/$2').replace(/([۰-۹])%/g, '$1٪');
}

/** Translate `key` and substitute {params}. Numbers in params are localized. */
export function _(key, params) {
    let s = _table?.[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params))
            s = s.split(`{${k}}`).join(typeof v === 'number' ? localizeDigits(v) : String(v ?? ''));
    }
    return s;
}

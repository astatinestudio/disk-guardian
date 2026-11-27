// Disk Guardian — preferences window.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {_, setLanguage, isRtl, languageChoices} from './lib/i18n.js';
import * as fmt from './lib/format.js';
import {normalizeState} from './lib/normalize.js';

const STATE_PATH = '/run/diskguardian/state.json';

function readState() {
    try {
        const [, bytes] = GLib.file_get_contents(STATE_PATH);
        return normalizeState(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return null;
    }
}

function comboRow(settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({title, subtitle: subtitle ?? '', model: Gtk.StringList.new(options.map(o => o[1]))});
    const cur = options.findIndex(o => o[0] === settings.get_string(key));
    row.selected = Math.max(0, cur);
    row.connect('notify::selected', () => {
        const opt = options[row.selected];
        if (opt)
            settings.set_string(key, opt[0]);
    });
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, min, max, step = 1, subtitle = '') {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = title;
    row.subtitle = subtitle;
    row.value = settings.get_int(key);
    row.connect('notify::value', () => settings.set_int(key, Math.round(row.value)));
    return row;
}

/**
 * Persian: RTL + Persian font for this window only. Prefs run inside the shared
 * Extensions process, so Gtk.Widget.set_default_direction() would flip other
 * windows too; set the direction on this window's widgets instead.
 */
function localizeWindow(window) {
    if (!isRtl())
        return;
    window.add_css_class('lh-fa');
    const css = new Gtk.CssProvider();
    const rules = '.lh-fa, .lh-fa * { font-family: "Vazirmatn", "Vazir", "Noto Sans Arabic", sans-serif; }';
    if (css.load_from_string)
        css.load_from_string(rules);
    else
        css.load_from_data(rules, -1);
    Gtk.StyleContext.add_provider_for_display(window.get_display(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    const walk = w => {
        w.set_direction(Gtk.TextDirection.RTL);
        for (let c = w.get_first_child(); c; c = c.get_next_sibling())
            walk(c);
    };
    walk(window);
    window.connect('map', () => walk(window));
}

function group(page, title, description) {
    const g = new Adw.PreferencesGroup({title: title ?? '', description: description ?? ''});
    page.add(g);
    return g;
}

export default class DiskGuardianPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        setLanguage(settings.get_string('language'), GLib.get_language_names());
        window._settings = settings;
        window.set_default_size(720, 780);
        window.search_enabled = true;
        const state = readState();
        const disks = state?.disks ?? [];

        window.add(this._generalPage(settings));
        window.add(this._floatPage(settings, disks));
        window.add(this._alertsPage(settings));
        window.add(this._disksPage(settings, state, disks));
        localizeWindow(window);
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        const g = group(page, _('General'), _('Changes apply immediately.'));
        g.add(comboRow(settings, 'language', _('Language'), null,
            languageChoices(_('Automatic'))));
        g.add(comboRow(settings, 'temp-unit', _('Temperature unit'), null, [['C', '°C'], ['F', '°F']]));
        g.add(spinRow(settings, 'poll-interval', _('Read interval'), 1, 60, 1, _('Seconds between UI updates')));

        const p = group(page, _('Panel'));
        p.add(comboRow(settings, 'panel-mode', _('Panel display'), null, [
            ['all', _('All disks')], ['max', _('Hottest disk only')], ['default', _('Default disk only')], ['icon', _('Icon only')],
        ]));
        p.add(switchRow(settings, 'panel-show-names', _('Show disk names')));
        p.add(switchRow(settings, 'panel-colorize', _('Color by temperature')));
        p.add(comboRow(settings, 'panel-position', _('Position'), null,
            [['right', _('Right')], ['center', _('Center')], ['left', _('Left')]]));
        return page;
    }

    _floatPage(settings, disks) {
        const page = new Adw.PreferencesPage({title: _('Floating widget'), icon_name: 'view-pin-symbolic'});
        const g = group(page, _('Floating widget'));
        g.add(switchRow(settings, 'float-enabled', _('Show floating widget')));

        const options = [['', _('First disk')], ...disks.map(d => [d.key, `${d.model ?? d.name} (${d.name})`])];
        const cur = settings.get_string('default-disk');
        if (cur && !options.some(o => o[0] === cur))
            options.push([cur, cur]);
        g.add(comboRow(settings, 'default-disk', _('Default disk'), _('Used by the floating widget and the panel'), options));

        g.add(switchRow(settings, 'float-compact', _('Compact')));
        g.add(switchRow(settings, 'float-expanded', _('Show all values')));
        g.add(spinRow(settings, 'float-opacity', `${_('Opacity')} (%)`, 30, 100, 1));
        g.add(switchRow(settings, 'float-locked', _('Lock position')));
        g.add(switchRow(settings, 'float-hide-overview', _('Hide in overview')));

        const reset = new Adw.ActionRow({title: _('Reset position')});
        const btn = new Gtk.Button({label: _('Reset'), valign: Gtk.Align.CENTER});
        btn.connect('clicked', () => {
            settings.set_int('float-x', -1);
            settings.set_int('float-y', -1);
        });
        reset.add_suffix(btn);
        g.add(reset);
        return page;
    }

    _alertsPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Alerts'), icon_name: 'preferences-system-notifications-symbolic'});
        const g = group(page, _('Notifications'));
        g.add(switchRow(settings, 'notify-enabled', _('Notifications')));
        g.add(switchRow(settings, 'notify-temp', _('Temperature alerts')));
        g.add(switchRow(settings, 'notify-health', _('Health alerts')));

        const t = group(page, _('Temperature thresholds (°C)'));
        const rows = [
            ['temp-warn-hdd', _('HDD warning')], ['temp-crit-hdd', _('HDD critical')],
            ['temp-warn-ssd', _('SATA SSD warning')], ['temp-crit-ssd', _('SATA SSD critical')],
            ['temp-warn-nvme', _('NVMe warning')], ['temp-crit-nvme', _('NVMe critical')],
        ];
        for (const [key, title] of rows)
            t.add(spinRow(settings, key, title, 20, 110, 1));
        return page;
    }

    _disksPage(settings, state, disks) {
        const page = new Adw.PreferencesPage({title: _('Disks'), icon_name: 'drive-harddisk-symbolic'});

        // service status
        const s = group(page, _('Collector service'));
        const age = state ? Date.now() / 1000 - (state.generated ?? 0) : Infinity;
        const running = age < 120;
        const status = new Adw.ActionRow({
            title: _('Collector service'),
            subtitle: running ? _('Running') : _('Not running'),
        });
        status.add_prefix(new Gtk.Image({
            icon_name: running ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            css_classes: [running ? 'success' : 'warning'],
        }));
        s.add(status);
        if (state?.daemon) {
            s.add(new Adw.ActionRow({title: _('Version'), subtitle: String(state.daemon.version ?? '?')}));
            s.add(new Adw.ActionRow({title: _('Last update'), subtitle: fmt.ago(state.generated)}));
            s.add(new Adw.ActionRow({
                title: _('SATA temperature sensor (drivetemp)'),
                subtitle: state.daemon.drivetemp ? _('Loaded') : _('Not loaded'),
            }));
        } else {
            s.add(new Adw.ActionRow({
                title: _('Install the disk-guardian package or run: sudo systemctl enable --now disk-guardian'),
                title_lines: 3,
            }));
        }

        if (!disks.length) {
            const e = group(page, _('Disks'));
            e.add(new Adw.ActionRow({title: _('Start the collector to see your disks here.')}));
            return page;
        }

        for (const d of disks) {
            const g = group(page, `${d.model ?? d.name}`,
                [fmt.kindLabel(d), fmt.bytes(d.capacity), d.name, d.serial].filter(Boolean).join(' · '));

            const aliasRow = new Adw.EntryRow({title: _('Display name'), show_apply_button: true});
            aliasRow.text = settings.get_value('disk-aliases').deepUnpack()[d.key] ?? '';
            aliasRow.connect('apply', () => {
                const aliases = settings.get_value('disk-aliases').deepUnpack();
                const v = aliasRow.text.trim();
                if (v)
                    aliases[d.key] = v;
                else
                    delete aliases[d.key];
                settings.set_value('disk-aliases', new GLib.Variant('a{ss}', aliases));
            });
            g.add(aliasRow);

            const show = new Adw.SwitchRow({title: _('Show in panel')});
            show.active = !settings.get_strv('hidden-disks').includes(d.key);
            show.connect('notify::active', () => {
                const hidden = new Set(settings.get_strv('hidden-disks'));
                if (show.active)
                    hidden.delete(d.key);
                else
                    hidden.add(d.key);
                settings.set_strv('hidden-disks', [...hidden]);
            });
            g.add(show);

            const h = d.health ?? {};
            const healthRow = new Adw.ActionRow({
                title: _('Health'),
                subtitle: `${fmt.levelLabel(h.level)}${typeof h.score === 'number' ? ` · ${fmt.percent(h.score)}` : ''}`,
            });
            g.add(healthRow);
        }
        return page;
    }
}

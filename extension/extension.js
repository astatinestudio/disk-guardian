// Disk Guardian — GNOME Shell extension entry point.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {_, setLanguage} from './lib/i18n.js';
import {setIconDir} from './lib/widgets.js';
import {DiskStore} from './lib/store.js';
import {DiskGuardianIndicator} from './lib/indicator.js';
import {FloatingWidget} from './lib/floatWidget.js';
import {DetailsDialog} from './lib/detailsDialog.js';
import {Notifier} from './lib/notifier.js';

export default class DiskGuardianExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        setLanguage(this._settings.get_string('language'), GLib.get_language_names());
        setIconDir(`${this.path}/icons`);

        this._store = new DiskStore(this._settings);
        this._ctx = {
            settings: this._settings,
            store: this._store,
            openDetails: key => this._openDetails(key),
            openPrefs: () => this.openPreferences(),
            request: req => this._request(req),
        };

        this._indicator = null;
        this._float = null;
        this._dialog = null;
        this._createIndicator();
        this._syncFloat();
        this._notifier = new Notifier(this._ctx);

        this._settingsIds = [
            this._settings.connect('changed::float-enabled', () => this._syncFloat()),
            this._settings.connect('changed::panel-position', () => this._createIndicator()),
            this._settings.connect('changed::language', () => {
                setLanguage(this._settings.get_string('language'), GLib.get_language_names());
                this._createIndicator();
                this._float?.destroy();
                this._float = null;
                this._syncFloat();
            }),
        ];

        this._store.start();
    }

    disable() {
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        this._dialog?.destroy();
        this._dialog = null;
        this._notifier?.destroy();
        this._notifier = null;
        this._float?.destroy();
        this._float = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._store?.destroy();
        this._store = null;
        this._ctx = null;
        this._settings = null;
    }

    _createIndicator() {
        this._indicator?.destroy();
        this._indicator = new DiskGuardianIndicator(this._ctx);
        const pos = this._settings.get_string('panel-position');
        const boxName = ['left', 'center', 'right'].includes(pos) ? pos : 'right';
        Main.panel.addToStatusArea(this.uuid, this._indicator, boxName === 'right' ? 0 : -1, boxName);
    }

    _syncFloat() {
        const want = this._settings.get_boolean('float-enabled');
        if (want && !this._float) {
            try {
                this._float = new FloatingWidget(this._ctx);
            } catch (e) {
                logError(e, 'Disk Guardian: cannot create the floating widget');
                this._float = null;
            }
        } else if (!want && this._float) {
            this._float.destroy();
            this._float = null;
        }
    }

    _openDetails(key) {
        this._dialog?.destroy();
        this._dialog = new DetailsDialog(this._ctx, key, d => {
            if (this._dialog === d)
                this._dialog = null;
        });
    }

    async _request(req) {
        const store = this._store;
        if (!store)
            return;
        try {
            await store.sendRequest(req);
            if (req.action !== 'refresh')
                Main.notify(_('Disk Guardian'), _('Request sent'));
        } catch (e) {
            const group = store.daemon?.request_group ?? 'sudo';
            if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
                Main.notify(_('Could not send request'), _('Permission denied. Your user must be in the “{g}” group.', {g: group}));
            else if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                Main.notify(_('Could not send request'), _('Collector service is not running'));
            else
                Main.notify(_('Could not send request'), String(e?.message ?? e));
        }
    }
}

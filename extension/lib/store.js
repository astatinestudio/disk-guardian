// Reads the collector snapshot (/run/diskguardian/state.json) and sends requests.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {normalizeState} from './normalize.js';

export const STATE_PATH = '/run/diskguardian/state.json';
export const REQ_DIR = '/run/diskguardian/requests';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

export class DiskStore extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.disks = [];
        this.daemon = null;
        this.generated = 0;
        this.status = 'loading';   // loading | ok | stale | missing | error
        this._timer = 0;
        this._busy = false;
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._decoder = new TextDecoder();
        this._intervalId = settings.connect('changed::poll-interval', () => this._schedule());
    }

    start() {
        this._poll();
        this._schedule();
    }

    _schedule() {
        if (this._timer)
            GLib.source_remove(this._timer);
        const secs = Math.max(1, this._settings.get_int('poll-interval'));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _poll() {
        if (this._busy || this._destroyed)
            return;
        this._busy = true;
        try {
            const file = Gio.File.new_for_path(STATE_PATH);
            const [contents] = await file.load_contents_async(this._cancellable);
            if (this._destroyed)
                return;
            // the collector writes raw smartctl JSON; analysis happens here (normalize.js)
            const data = normalizeState(JSON.parse(this._decoder.decode(contents)));
            this._apply(data);
        } catch (e) {
            if (this._destroyed)
                return;
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                this._setStatus('missing');
            else if (!(e instanceof SyntaxError))
                this._setStatus('error');
        } finally {
            this._busy = false;
        }
    }

    _apply(data) {
        const generated = data.generated || 0;
        const age = Date.now() / 1000 - generated;
        const tempInterval = data.daemon?.temp_interval ?? 3;
        const status = age > Math.max(60, tempInterval * 10) ? 'stale' : 'ok';
        if (generated === this.generated && status === this.status)
            return;
        this.generated = generated;
        this.daemon = data.daemon ?? null;
        this.disks = Array.isArray(data.disks) ? data.disks : [];
        this.status = status;
        this.emit('changed');
    }

    _setStatus(status) {
        if (this.status === status)
            return;
        this.status = status;
        if (status === 'missing') {
            this.disks = [];
            this.daemon = null;
        }
        this.emit('changed');
    }

    refresh() {
        this._poll();
    }

    getDisk(key) {
        return this.disks.find(d => d.key === key) ?? null;
    }

    getDefaultDisk() {
        return this.getDisk(this._settings.get_string('default-disk')) ?? this.disks[0] ?? null;
    }

    /** Write a request for the collector. Throws a GLib.Error on failure. */
    async sendRequest(request) {
        const name = `${Date.now()}-${Math.floor(Math.random() * 1e9)}.json`;
        const file = Gio.File.new_for_path(`${REQ_DIR}/${name}`);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(request)));
        await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
        // the collector picks requests up every second; re-read soon after
        if (this._reqTimer)
            GLib.source_remove(this._reqTimer);
        this._reqTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._reqTimer = 0;
            this._poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._reqTimer)
            GLib.source_remove(this._reqTimer);
        this._reqTimer = 0;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._settings.disconnect(this._intervalId);
    }
}

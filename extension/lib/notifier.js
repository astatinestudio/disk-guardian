// Desktop notifications for high temperature and worsening health.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_} from './i18n.js';
import * as fmt from './format.js';

const TEMP_RANK = {unknown: 0, ok: 0, warn: 1, crit: 2};
const HEALTH_RANK = {unknown: 0, good: 0, warning: 1, critical: 2};
const HYSTERESIS = 3;

export class Notifier {
    constructor(ctx) {
        this._ctx = ctx;
        this._temp = new Map();
        this._health = new Map();
        this._storeId = ctx.store.connect('changed', () => this._check());
    }

    _check() {
        const {store, settings} = this._ctx;
        if (store.status !== 'ok')
            return;
        const enabled = settings.get_boolean('notify-enabled');
        const unit = settings.get_string('temp-unit');

        for (const d of store.disks) {
            const name = fmt.displayName(settings, d);

            // temperature with hysteresis
            const t = d.temperature?.current;
            if (typeof t === 'number') {
                const lvl = fmt.tempLevel(settings, d);
                const prev = this._temp.get(d.key) ?? 'ok';
                if (TEMP_RANK[lvl] > TEMP_RANK[prev]) {
                    this._temp.set(d.key, lvl);
                    if (enabled && settings.get_boolean('notify-temp')) {
                        const title = lvl === 'crit'
                            ? _('{disk} is very hot: {temp}', {disk: name, temp: fmt.temp(t, unit)})
                            : _('{disk} is hot: {temp}', {disk: name, temp: fmt.temp(t, unit)});
                        Main.notify(title, _('Consider improving airflow or reducing load.'));
                    }
                } else if (TEMP_RANK[lvl] < TEMP_RANK[prev]) {
                    const [w, c] = fmt.tempThresholds(settings, d);
                    if (prev === 'crit' && t <= c - HYSTERESIS)
                        this._temp.set(d.key, t >= w ? 'warn' : 'ok');
                    else if (prev === 'warn' && t <= w - HYSTERESIS)
                        this._temp.set(d.key, 'ok');
                }
            }

            // health: notify when it gets worse (and once for critical disks at startup)
            const h = d.health?.level ?? 'unknown';
            const prevH = this._health.get(d.key);
            this._health.set(d.key, h);
            const worse = prevH === undefined ? h === 'critical' : HEALTH_RANK[h] > HEALTH_RANK[prevH];
            if (worse && enabled && settings.get_boolean('notify-health')) {
                const top = (d.health?.issues ?? []).find(i => i.severity !== 'info');
                Main.notify(_('{disk}: health is now {level}', {disk: name, level: fmt.levelLabel(h)}),
                    top ? fmt.issueText(top, unit) : '');
            }
        }
    }

    destroy() {
        this._ctx.store.disconnect(this._storeId);
    }
}

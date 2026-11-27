// SMART analysis shared by the desktop app (desktop/ui) and the GNOME Shell extension.
// The collector (Rust, desktop/src-tauri/src/collector.rs) publishes raw `smartctl -j -x`
// output per disk plus OS details (lsblk / Windows disk info); this file turns it into the
// disk schema the UIs show: parsed attributes, counters, kind, health score and issues.
// Must stay free of GJS / browser imports. Tests: desktop/tests/normalize.test.mjs.

const ATA_COUNTERS = {
    5: 'reallocated',
    196: 'reallocated_events',
    197: 'pending',
    198: 'offline_uncorrectable',
    187: 'reported_uncorrect',
    10: 'spin_retry',
    199: 'crc_errors',
    188: 'command_timeout',
    184: 'end_to_end_errors',
    12: 'power_cycles_attr',
    192: 'unsafe_shutdowns',
    193: 'load_cycles',
    4: 'start_stop',
};
const ATA_PACKED = new Set([188, 193, 4, 12, 192]);
const ATA_WATCH = new Set([5, 10, 184, 187, 196, 197, 198]);
const ATA_LIFE_ATTRS = [231, 233, 202, 177, 169, 173, 232];
const VIRTUAL_RE = /VMware|QEMU|VBOX|VirtualBox|Virtual disk|Msft Virtual|Red Hat|VirtIO|BHYVE|Xen/i;
export const DEFAULT_TEMP_LIMIT = {hdd: 55, ssd: 70, nvme: 80, sas: 60};

/** Python int(): bool -> 0/1, number -> truncated, numeric string -> number, else null. */
export function toInt(v) {
    if (typeof v === 'boolean')
        return v ? 1 : 0;
    if (typeof v === 'number')
        return Number.isFinite(v) ? Math.trunc(v) : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v.trim());
        return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    return null;
}

function dig(d, ...keys) {
    for (const k of keys) {
        if (d === null || d === undefined || typeof d !== 'object')
            return null;
        d = d[k];
    }
    return d ?? null;
}

const or = (...vals) => {
    // Python `a or b or c`: first truthy value, else the last one
    for (const v of vals)
        if (v)
            return v;
    return vals[vals.length - 1] ?? null;
};

function ataDevstat(js, name) {
    for (const page of dig(js, 'ata_device_statistics', 'pages') ?? []) {
        for (const row of page?.table ?? []) {
            if (row?.name === name && dig(row, 'flags', 'valid') !== false)
                return toInt(row.value);
        }
    }
    return null;
}

function parseSelftests(js) {
    const tests = [];
    const log = dig(js, 'ata_smart_self_test_log', 'extended') || dig(js, 'ata_smart_self_test_log', 'standard') || {};
    for (const t of (log.table ?? []).slice(0, 15)) {
        const val = toInt(dig(t, 'status', 'value')) || 0;
        const nib = val >> 4;
        tests.push({
            type: dig(t, 'type', 'string'),
            status: dig(t, 'status', 'string'),
            passed: nib === 0 ? true : (nib >= 3 && nib <= 8 ? false : null),
            hours: toInt(t.lifetime_hours),
        });
    }
    for (const t of (dig(js, 'nvme_self_test_log', 'table') ?? []).slice(0, 15)) {
        const val = toInt(dig(t, 'self_test_result', 'value'));
        tests.push({
            type: dig(t, 'self_test_code', 'string'),
            status: dig(t, 'self_test_result', 'string'),
            passed: val === 0 ? true : ([5, 6, 7].includes(val) ? false : null),
            hours: toInt(t.power_on_hours),
        });
    }
    const scsiKeys = Object.keys(js).filter(k => k.startsWith('scsi_self_test_') && /^\d+$/.test(k.slice(15))).sort();
    for (const k of scsiKeys) {
        const t = js[k];
        const val = toInt(dig(t, 'result', 'value'));
        tests.push({
            type: dig(t, 'code', 'string'),
            status: dig(t, 'result', 'string'),
            passed: val === 0 ? true : ([3, 4, 5, 6, 7].includes(val) ? false : null),
            hours: toInt(dig(t, 'power_on_time', 'hours')),
        });
    }
    return tests;
}

function parseSelftestRunning(js) {
    const st = dig(js, 'ata_smart_data', 'self_test', 'status') ?? {};
    const val = toInt(st.value);
    if (val !== null && (val >> 4) === 15)
        return {running: true, text: st.string ?? null, remaining: toInt(st.remaining_percent)};
    const op = dig(js, 'nvme_self_test_log', 'current_self_test_operation') ?? {};
    if (toInt(op.value)) {
        const done = toInt(dig(js, 'nvme_self_test_log', 'current_self_test_completion_percent'));
        return {running: true, text: op.string ?? null, remaining: done !== null ? 100 - done : null};
    }
    return {running: false, text: null, remaining: null};
}

/** Normalize `smartctl -j -x` output (port of parse_smart). */
export function parseSmart(js) {
    const r = {};
    const dev = js.device ?? {};
    r.protocol = dev.protocol ?? null;
    r.dev_type = dev.type ?? null;
    let model = js.model_name;
    if (!model)
        model = [js.scsi_vendor, js.scsi_product].filter(Boolean).join(' ') || null;
    r.model = model ?? null;
    r.model_family = js.model_family ?? null;
    r.vendor = js.scsi_vendor ?? null;
    r.serial = js.serial_number ?? null;
    r.firmware = js.firmware_version || js.scsi_revision || null;
    r.capacity = or(toInt(dig(js, 'user_capacity', 'bytes')), toInt(js.nvme_total_capacity));
    r.rotation_rate = Number.isInteger(js.rotation_rate) ? js.rotation_rate : null;
    r.form_factor = dig(js, 'form_factor', 'name');
    r.sata_version = dig(js, 'sata_version', 'string');
    r.link_speed = dig(js, 'interface_speed', 'current', 'string');
    r.max_link_speed = dig(js, 'interface_speed', 'max', 'string');
    r.nvme_version = dig(js, 'nvme_version', 'string');
    r.transport = dig(js, 'scsi_transport_protocol', 'name');

    const isNvme = r.protocol === 'NVMe';
    let avail = dig(js, 'smart_support', 'available');
    let enabled = dig(js, 'smart_support', 'enabled');
    if (isNvme) {
        avail = avail === null ? true : avail;
        enabled = enabled === null ? true : enabled;
    }
    if (avail === null && (js.smart_status || (js.scsi_grown_defect_list !== undefined && js.scsi_grown_defect_list !== null)))
        avail = true;
    r.smart = {
        available: Boolean(avail),
        enabled: enabled !== null ? Boolean(enabled) : Boolean(avail),
        passed: dig(js, 'smart_status', 'passed'),
        error: null,
        standby: false,
    };

    r.power_on_hours = toInt(dig(js, 'power_on_time', 'hours'));
    r.power_cycles = toInt(js.power_cycle_count);

    const t = js.temperature ?? {};
    const sct = dig(js, 'ata_sct_status', 'temperature') ?? {};
    const cur = toInt(t.current);
    const temp = {
        current: cur && cur > 0 ? cur : null,
        lifetime_max: or(toInt(t.lifetime_max), toInt(sct.lifetime_max)),
        lifetime_min: or(toInt(t.lifetime_min), toInt(sct.lifetime_min)),
        warn_limit: or(toInt(t.op_limit_max), toInt(sct.op_limit_max)),
        crit_limit: or(toInt(t.critical_limit_max), toInt(t.drive_trip), toInt(sct.limit_max)),
    };
    r.temperature_smart = temp;

    const counters = {};
    const lbs = toInt(js.logical_block_size) || 512;

    // ---- ATA
    let life = null, lifeSrc = null, written = null, read = null, approx = false;
    const table = dig(js, 'ata_smart_attributes', 'table') ?? [];
    const byId = new Map();
    const attrs = [];
    for (const a of table) {
        const aid = toInt(a.id);
        const rawV = toInt(dig(a, 'raw', 'value'));
        const val = toInt(a.value);
        const worst = toInt(a.worst);
        const thresh = toInt(a.thresh);
        const wf = a.when_failed || '';
        let status = 'ok';
        if (wf === 'now' || (thresh && val !== null && val <= thresh))
            status = 'failing';
        else if (wf === 'past')
            status = 'warn';
        else if (ATA_WATCH.has(aid) && rawV)
            status = 'warn';
        else if (aid === 199 && rawV)
            status = 'info';
        const rawStr = dig(a, 'raw', 'string');
        attrs.push({
            id: aid, name: a.name ?? null, value: val, worst, thresh,
            raw: rawStr !== null ? rawStr : rawV,
            raw_value: rawV, when_failed: wf || null,
            prefail: Boolean(dig(a, 'flags', 'prefailure')), status,
        });
        byId.set(aid, [val, rawV]);
        if (aid in ATA_COUNTERS && rawV !== null)
            counters[ATA_COUNTERS[aid]] = ATA_PACKED.has(aid) ? rawV % 2 ** 32 : rawV;
    }
    r.attributes = attrs;

    let errlog = dig(js, 'ata_smart_error_log', 'extended', 'count');
    if (errlog === null)
        errlog = dig(js, 'ata_smart_error_log', 'summary', 'count');
    if (errlog !== null)
        counters.error_log_entries = toInt(errlog);

    if (table.length) {
        const used = ataDevstat(js, 'Percentage Used Endurance Indicator');
        const isSsd = r.rotation_rate === 0;
        if (used !== null && isSsd) {
            life = Math.max(0, 100 - used);
            lifeSrc = 'devstat';
        } else if (isSsd) {
            for (const aid of ATA_LIFE_ATTRS) {
                const v = byId.get(aid)?.[0];
                if (v !== undefined && v !== null && v >= 0 && v <= 100) {
                    life = v;
                    lifeSrc = `attr${aid}`;
                    break;
                }
            }
        }
        const sw = ataDevstat(js, 'Logical Sectors Written');
        const sr = ataDevstat(js, 'Logical Sectors Read');
        if (sw !== null) {
            written = sw * lbs;
        } else if (byId.get(241)?.[1]) {
            written = byId.get(241)[1] * lbs;
            approx = true;
        }
        if (sr !== null) {
            read = sr * lbs;
        } else if (byId.get(242)?.[1]) {
            read = byId.get(242)[1] * lbs;
            approx = true;
        }
    }

    // ---- NVMe
    const nvLog = js.nvme_smart_health_information_log;
    r.nvme = nvLog && typeof nvLog === 'object' && !Array.isArray(nvLog) ? nvLog : null;
    if (r.nvme) {
        const nv = r.nvme;
        const pu = toInt(nv.percentage_used);
        if (pu !== null) {
            life = Math.max(0, 100 - pu);
            lifeSrc = 'nvme';
        }
        const dw = toInt(nv.data_units_written);
        const dr = toInt(nv.data_units_read);
        written = dw !== null ? dw * 512000 : written;
        read = dr !== null ? dr * 512000 : read;
        for (const k of ['critical_warning', 'media_errors', 'num_err_log_entries', 'unsafe_shutdowns',
            'available_spare', 'available_spare_threshold']) {
            if (nv[k] !== undefined && nv[k] !== null)
                counters[k] = toInt(nv[k]);
        }
        if (r.power_on_hours === null)
            r.power_on_hours = toInt(nv.power_on_hours);
        if (r.power_cycles === null)
            r.power_cycles = toInt(nv.power_cycles);
        if (temp.current === null)
            temp.current = toInt(nv.temperature);
        const wct = js.nvme_warning_composite_temperature ? toInt(js.nvme_warning_composite_temperature) : null;
        const cct = js.nvme_critical_composite_temperature ? toInt(js.nvme_critical_composite_temperature) : null;
        temp.warn_limit = temp.warn_limit || wct;
        temp.crit_limit = temp.crit_limit || cct;
    }

    // ---- SCSI / SAS
    const scsi = {};
    if (r.protocol === 'SCSI') {
        const gd = js.scsi_grown_defect_list;
        if (gd !== undefined && gd !== null) {
            counters.grown_defects = toInt(gd);
            scsi.grown_defects = toInt(gd);
        }
        let unc = 0;
        let haveUnc = false;
        for (const kind of ['read', 'write', 'verify']) {
            const ec = dig(js, 'scsi_error_counter_log', kind);
            if (!ec || typeof ec !== 'object')
                continue;
            scsi[kind] = {
                corrected: toInt(ec.total_errors_corrected),
                uncorrected: toInt(ec.total_uncorrected_errors),
                gigabytes: ec.gigabytes_processed ?? null,
            };
            if (ec.total_uncorrected_errors !== undefined && ec.total_uncorrected_errors !== null) {
                haveUnc = true;
                unc += toInt(ec.total_uncorrected_errors) || 0;
            }
            const gb = Number(ec.gigabytes_processed);
            if (ec.gigabytes_processed !== undefined && ec.gigabytes_processed !== null && Number.isFinite(gb)) {
                if (kind === 'write')
                    written = Math.trunc(gb * 1e9);
                else if (kind === 'read')
                    read = Math.trunc(gb * 1e9);
            }
        }
        if (haveUnc)
            counters.scsi_uncorrected = unc;
        const ss = js.scsi_start_stop_cycle_counter ?? {};
        scsi.start_stop_cycles = toInt(ss.accumulated_start_stop_cycles);
        scsi.load_unload_cycles = toInt(ss.accumulated_load_unload_cycles);
        scsi.specified_start_stop = toInt(ss.specified_cycle_count_over_device_lifetime);
        if (r.power_cycles === null && scsi.start_stop_cycles !== null)
            r.power_cycles = scsi.start_stop_cycles;
        const pu = toInt(js.scsi_percentage_used_endurance_indicator);
        if (pu !== null) {
            life = Math.max(0, 100 - pu);
            lifeSrc = 'scsi';
        }
        if (r.smart.passed === null) {
            const ie = dig(js, 'smart_status', 'scsi', 'ie_string');
            if (ie)
                scsi.informational_exception = ie;
        }
    }
    r.scsi = Object.keys(scsi).length ? scsi : null;

    r.counters = counters;
    r.life_remaining = life;
    r.life_source = lifeSrc;
    r.data_written = written;
    r.data_read = read;
    r.data_approx = approx;
    r.self_tests = parseSelftests(js);
    r.self_test = parseSelftestRunning(js);
    return r;
}

/** kind / media like Collector._classify (no lsblk: bus comes from the smartctl -d type). */
export function classify(d) {
    const name = d.name ?? '';
    const proto = d.protocol;
    const rr = d.rotation_rate;
    let media = Number.isInteger(rr) ? (rr > 0 ? 'hdd' : 'ssd') : (d._rota ? 'hdd' : 'ssd');
    let kind;
    if (/^nvme/.test(name) || d.bus === 'nvme' || proto === 'NVMe') {
        kind = 'nvme';
        media = 'ssd';
    } else if (d.bus === 'virtio' || VIRTUAL_RE.test(`${d.vendor ?? ''} ${d.model ?? ''}`)) {
        kind = 'virtual';
    } else if (d.bus === 'usb' && proto !== 'ATA' && !(rr > 0)) {
        // USB stick / card reader: SCSI pass-through only, no real SMART
        kind = 'flash';
        media = 'ssd';
    } else if (d.bus === 'sas' || (proto === 'SCSI' && !['usb', 'virtio'].includes(d.bus))) {
        kind = 'sas';
    } else {
        kind = media;
    }
    return {kind, media};
}

/** Health score / level / issues (port of evaluate). */
export function evaluate(d) {
    const issues = [];
    let ded = 0;
    const add = (severity, code, params = {}) => issues.push({severity, code, params});
    const sm = d.smart ?? {};
    const c = d.counters ?? {};

    if (!d.smart_updated && sm.error === 'read_failed') {
        add('info', 'smart_read_failed', {usb: d.bus === 'usb'});
        return {score: null, level: 'unknown', issues};
    }
    if (!d.smart_updated && sm.standby) {
        add('info', 'not_read_standby');
        return {score: null, level: 'unknown', issues};
    }
    if (!d.smart_updated && sm.pending) {
        add('info', 'smart_pending');
        return {score: null, level: 'unknown', issues};
    }
    const cnt = k => (Number.isInteger(c[k]) && c[k] > 0 ? c[k] : 0);

    if (!sm.available)
        add('info', 'smart_unavailable');
    else if (!sm.enabled)
        add('warning', 'smart_disabled');

    if (sm.passed === false) {
        add('critical', 'smart_failed');
        ded += 100;
    }
    for (const a of d.attributes ?? []) {
        if (a.when_failed === 'now') {
            add('critical', 'attr_failing_now', {name: a.name, id: a.id});
            ded += 40;
        } else if (a.when_failed === 'past') {
            add('warning', 'attr_failed_past', {name: a.name, id: a.id});
            ded += 10;
        }
    }
    const fl = (a, b) => Math.floor(a / b);
    let n = cnt('reallocated');
    if (n) {
        add(n >= 100 ? 'critical' : 'warning', 'reallocated', {count: n});
        ded += 10 + Math.min(30, fl(n, 5));
    }
    n = cnt('pending');
    if (n) {
        add(n >= 10 ? 'critical' : 'warning', 'pending', {count: n});
        ded += 15 + Math.min(30, n);
    }
    n = cnt('offline_uncorrectable');
    if (n) {
        add(n >= 10 ? 'critical' : 'warning', 'uncorrectable', {count: n});
        ded += 15 + Math.min(30, n);
    }
    n = cnt('reported_uncorrect');
    if (n) {
        add('warning', 'reported_uncorrect', {count: n});
        ded += 10 + Math.min(20, n);
    }
    n = cnt('spin_retry');
    if (n) {
        add('warning', 'spin_retry', {count: n});
        ded += 10;
    }
    n = cnt('end_to_end_errors');
    if (n) {
        add('warning', 'end_to_end', {count: n});
        ded += 10;
    }
    n = cnt('crc_errors');
    if (n) {
        add(n >= 50 ? 'warning' : 'info', 'crc_errors', {count: n});
        ded += n >= 50 ? 5 : 2;
    }
    n = cnt('error_log_entries');
    if (n && d.kind !== 'nvme') {
        add('info', 'error_log', {count: n});
        ded += Math.min(5, n);
    }
    if (d.nvme) {
        const cw = cnt('critical_warning');
        if (cw) {
            add('critical', 'nvme_critical_warning', {value: cw});
            ded += 50;
        }
        const spare = c.available_spare;
        const thr = c.available_spare_threshold;
        if (Number.isInteger(spare) && Number.isInteger(thr) && thr > 0 && spare <= thr) {
            add('critical', 'spare_low', {value: spare, threshold: thr});
            ded += 40;
        }
        n = cnt('media_errors');
        if (n) {
            add('warning', 'media_errors', {count: n});
            ded += 10 + Math.min(30, n);
        }
    }
    n = cnt('grown_defects');
    if (n) {
        add(n >= 100 ? 'critical' : 'warning', 'grown_defects', {count: n});
        ded += 10 + Math.min(30, fl(n, 5));
    }
    n = cnt('scsi_uncorrected');
    if (n) {
        add('warning', 'scsi_uncorrected', {count: n});
        ded += 10 + Math.min(20, n);
    }
    const tests = d.self_tests ?? [];
    if (tests.length && tests[0].passed === false) {
        add('critical', 'selftest_failed', {type: tests[0].type, hours: tests[0].hours});
        ded += 40;
    }
    const life = d.life_remaining;
    if (Number.isInteger(life)) {
        if (life <= 10)
            add('critical', 'wear_out', {life});
        else if (life <= 30)
            add('warning', 'wear_high', {life});
    }
    const temp = d.temperature ?? {};
    const cur = temp.current;
    const limit = temp.warn_limit || DEFAULT_TEMP_LIMIT[d.kind] || DEFAULT_TEMP_LIMIT[d.media] || 60;
    if (typeof cur === 'number' && cur >= limit) {
        add('warning', 'temp_high', {temp: cur, limit});
        ded += 5;
    }

    for (const b of d.btrfs ?? []) {
        if (b.errors_total) {
            add('warning', 'btrfs_errors', {count: b.errors_total, mount: b.mount});
            ded += 15;
        }
        const scrubErr = b.scrub?.errors;
        if (scrubErr && String(scrubErr).toLowerCase() !== 'no errors found') {
            add('warning', 'btrfs_scrub_errors', {mount: b.mount, text: scrubErr});
            ded += 10;
        }
    }

    const sev = new Set(issues.map(i => i.severity));
    if (!sm.available && !sev.has('warning') && !sev.has('critical'))
        return {score: null, level: 'unknown', issues};

    let score = 100 - ded;
    if (Number.isInteger(life))
        score = Math.min(score, life);
    score = Math.max(0, Math.min(100, score));
    let level;
    if (sev.has('critical')) {
        level = 'critical';
        score = Math.min(score, 30);
    } else if (sev.has('warning')) {
        level = 'warning';
    } else {
        level = 'good';
    }
    const order = {critical: 0, warning: 1, info: 2};
    issues.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    return {score, level, issues};
}

/**
 * One disk of the raw (Windows / macOS) state -> Linux schema.
 * raw disk: {name, path, dev_type, key, smart: {error, error_detail, standby}, smart_updated,
 *            smart_checked, temperature: {current, source, updated, standby, history, min_24h, max_24h},
 *            last_request, raw: <smartctl -j -x> | null}
 */
export function normalizeDisk(rd) {
    const name = String(rd.name ?? rd.path ?? '?').replace(/^\/dev\//, '');
    const WIN_BUS = {USB: 'usb', NVMe: 'nvme', SATA: 'sata', SAS: 'sas', SCSI: 'scsi', RAID: 'raid'};
    const blk = rd.block ?? {};
    const tran = String(blk.tran ?? '').toLowerCase() || null;
    const bus = WIN_BUS[rd.windows?.bus_type] ?? (/^(usb|snt)/.test(rd.dev_type ?? '') ? 'usb' : null)
        ?? tran ?? (/^x?vd/.test(name) ? 'virtio' : /^nvme/.test(name) ? 'nvme' : (rd.bus ?? null));
    let d = {
        name, path: rd.path ?? null, key: rd.key ?? name, bus, removable: Boolean(blk.removable) || bus === 'usb',
        smart: {available: false, enabled: false, passed: null, error: null, standby: false},
        smart_updated: rd.smart_updated ?? null, smart_checked: rd.smart_checked ?? null,
        attributes: [], counters: {}, self_tests: [], self_test: {running: false},
        model: rd.model ?? blk.model ?? null, serial: blk.serial ?? null, capacity: blk.size ?? null,
        vendor: blk.vendor ?? null, _rota: Boolean(blk.rota),
        filesystems: Array.isArray(rd.filesystems) ? rd.filesystems : [], partitions: rd.partitions ?? null,
        btrfs: Array.isArray(rd.btrfs) ? rd.btrfs : [], usage: rd.usage ?? null,
        last_request: rd.last_request ?? null,
    };
    let tsmart = {};
    if (rd.raw && typeof rd.raw === 'object') {
        const p = parseSmart(rd.raw);
        tsmart = p.temperature_smart;
        delete p.temperature_smart;
        for (const [k, v] of Object.entries(p)) {
            if (['model', 'serial', 'capacity', 'vendor'].includes(k) && !v)
                continue;
            d[k] = v;
        }
    }
    d.smart = {...d.smart, ...(rd.smart ?? {})};
    // first read not finished yet (running now, or queued after the other disks)
    d.smart.pending = !d.smart.error && !d.smart.standby && (Boolean(rd.smart?.scanning) || !rd.smart_checked);
    if (rd.smart?.error === 'read_failed')
        d.smart.available = Boolean(d.smart_updated);
    const {current: _cur, ...limits} = tsmart;
    d.temperature = {current: null, source: null, updated: null, ...limits, ...(rd.temperature ?? {})};
    d = {...d, ...classify(d)};
    delete d._rota;
    // Windows: "Disk 1" with drive letters instead of smartctl's /dev/sdX
    if (rd.windows && Number.isInteger(rd.windows.number)) {
        d.disk_number = rd.windows.number;
        d.volumes = Array.isArray(rd.windows.volumes) ? rd.windows.volumes : [];
        d.drive_letters = d.volumes.map(v => v.letter).filter(Boolean).sort();
        d.windows = rd.windows;
    }
    d.read_test = rd.read_test ?? null;
    d.read_test_supported = Boolean(rd.read_test_supported ?? Number.isInteger(d.disk_number));
    d.raw = rd.raw && typeof rd.raw === 'object' ? rd.raw : null;
    d.identify = rd.identify ?? null;
    if (!rd.key)
        d.key = d.serial || name;
    if (d.kind === 'flash') {
        // the SCSI "OK" of a USB stick says nothing about its flash memory
        d.smart = {...d.smart, available: false, passed: null};
        d.health = flashHealth(d);
    } else {
        d.health = withWindowsChecks(evaluate(d), d);
    }
    return d;
}

// ------------------------------------------------------------------ Windows checks

/** Issues from Windows itself: disk health status, System log disk errors (30 days),
 *  file system health, and the surface read test. Returns {issues, ded}. */
export function windowsChecks(d) {
    const issues = [];
    let ded = 0;
    const add = (severity, code, params = {}) => issues.push({severity, code, params});
    const w = d.windows ?? {};
    if (w.health === 'Unhealthy') {
        add('critical', 'win_unhealthy');
        ded += 60;
    } else if (w.health === 'Warning') {
        add('warning', 'win_warning');
        ded += 20;
    }
    const ev = w.events ?? {};
    if (ev.bad_blocks > 0) {
        add('critical', 'disk_bad_blocks', {count: ev.bad_blocks});
        ded += 40;
    }
    const io = (ev.controller || 0) + (ev.paging || 0) + (ev.retried || 0);
    if (io > 0) {
        add('warning', 'disk_io_errors', {count: io});
        ded += Math.min(30, 10 + io);
    }
    for (const v of d.volumes ?? []) {
        if (v.health && v.health !== 'Healthy') {
            add('warning', 'fs_repair', {letter: v.letter});
            ded += 10;
        }
    }
    const rt = d.read_test;
    if (rt && !rt.running && !rt.error && rt.errors > 0) {
        add('critical', 'readtest_errors', {count: rt.errors});
        ded += 50;
    }
    return {issues, ded};
}

function level(issues, score) {
    const sev = new Set(issues.map(i => i.severity));
    if (sev.has('critical'))
        return ['critical', Math.min(score, 30)];
    if (sev.has('warning'))
        return ['warning', score];
    return ['good', score];
}

const ORDER = {critical: 0, warning: 1, info: 2};
const bySeverity = (a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3);

/** SMART health plus the Windows checks. */
export function withWindowsChecks(h, d) {
    if (!d.windows)
        return h;
    const extra = windowsChecks(d);
    if (!extra.issues.length)
        return h;
    const issues = [...h.issues, ...extra.issues].sort(bySeverity);
    if (h.score === null)
        return {...h, issues};
    const [lvl, score] = level(issues, Math.max(0, h.score - extra.ded));
    return {score, level: lvl, issues};
}

/** Health of a flash drive (no SMART): Windows checks + read test only. */
export function flashHealth(d) {
    const {issues, ded} = windowsChecks(d);
    const rt = d.read_test;
    if (!rt || rt.aborted || rt.error || (rt.running && !(rt.errors > 0)))
        issues.push({severity: 'info', code: 'readtest_none', params: {}});
    const [lvl, score] = level(issues, Math.max(0, 100 - ded));
    return {score, level: lvl, issues: issues.sort(bySeverity)};
}

/** Normalize a whole state object. States from the old Python collector (no
 *  `format: "raw"`) are already normalized and returned unchanged. */
export function normalizeState(state) {
    if (!state || state.format !== 'raw')
        return state;
    return {...state, disks: (state.disks ?? []).map(normalizeDisk)};
}

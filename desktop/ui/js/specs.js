// "Information" tab: complete specifications and the features a disk does / does not support.
// Sources, best first:
//   identify  NVMe Identify Controller / Namespace (4 KiB each, hex) read by the collector
//   windows   controller, PCIe link, SCSI location (Windows only)
//   raw       smartctl -x JSON
// Values a source did not report are left out: unknown is never shown as "not supported".
import {_, fmt, getLanguage} from './common.js';

const has = v => v !== undefined && v !== null && v !== '';
const pick = (o, ...path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
const LIST_SEP = {fa: '، ', ar: '، ', zh: '、', ja: '、'};
const list = items => items.filter(Boolean).join(LIST_SEP[getLanguage()] ?? ', ');
const yesNo = v => (v ? _('Yes') : _('No'));
const hex = (n, len = 4) => (typeof n === 'number' ? n.toString(16).toUpperCase().padStart(len, '0') : null);

const PCI_VENDORS = {
    0x144D: 'Samsung', 0x1E4B: 'MAXIO', 0x15B7: 'SanDisk / WD', 0x1C5C: 'SK hynix', 0x8086: 'Intel',
    0x1987: 'Phison', 0x126F: 'Silicon Motion', 0x1344: 'Micron', 0x1179: 'Toshiba', 0x1E0F: 'KIOXIA',
    0x1CC1: 'ADATA', 0x1D97: 'Longsys (Lexar)', 0x1B4B: 'Marvell', 0x2646: 'Kingston', 0x1E49: 'YMTC',
    0x1BB1: 'Seagate', 0x10EC: 'Realtek', 0x1CC4: 'Union Memory', 0x1D79: 'Transcend', 0x1F40: 'Netac',
    0x1E95: 'SSSTC', 0x1C58: 'HGST', 0x1DBE: 'INNOGRIT', 0x1E3B: 'DapuStor', 0x106B: 'Apple',
    0x1B96: 'Western Digital', 0x1D0F: 'Amazon', 0x1414: 'Microsoft', 0x1AF4: 'Red Hat (virtio)', 0x80EE: 'VirtualBox',
};
const vendor = id => (has(id) ? `0x${hex(id)}${PCI_VENDORS[id] ? ` (${PCI_VENDORS[id]})` : ''}` : null);
const PCIE_GEN = {1: '1.0', 2: '2.0', 3: '3.0', 4: '4.0', 5: '5.0', 6: '6.0'};
const pcie = (speed, width) => (PCIE_GEN[speed] ? `PCIe ${PCIE_GEN[speed]}${width ? ` x${width}` : ''}` : null);

// ------------------------------------------------------------------ identify decoding

class Buf {
    constructor(hexStr) {
        this.b = new Uint8Array((hexStr ?? '').length / 2);
        for (let i = 0; i < this.b.length; i++)
            this.b[i] = parseInt(hexStr.substr(i * 2, 2), 16);
    }

    u8(o) {
        return this.b[o] ?? 0;
    }

    u16(o) {
        return this.u8(o) | (this.u8(o + 1) << 8);
    }

    u32(o) {
        return (this.u16(o) + this.u16(o + 2) * 65536);
    }

    /** low 53 bits of a little-endian 64/128-bit number */
    u64(o) {
        return this.u32(o) + this.u32(o + 4) * 2 ** 32;
    }

    str(o, n) {
        return String.fromCharCode(...this.b.slice(o, o + n)).replace(/\0/g, '').trim();
    }

    bit(o, n) {
        return Boolean(this.u32(o) & (1 << n));
    }
}

/** Decoded NVMe Identify Controller (only what the tab shows). */
export function nvmeController(hexStr) {
    if (!hexStr || hexStr.length < 8192)
        return null;
    const c = new Buf(hexStr);
    const ver = c.u32(0x50);
    const psd = [];
    for (let i = 0; i <= c.u8(0x107) && i < 32; i++) {
        const o = 0x800 + i * 32;
        const flags = c.u8(o + 3);
        const mp = c.u16(o);
        psd.push({
            id: i, watts: flags & 1 ? mp / 10000 : mp / 100, idle: Boolean(flags & 2),
            entry: c.u32(o + 4), exit: c.u32(o + 8),
        });
    }
    return {
        vid: c.u16(0), ssvid: c.u16(2), sn: c.str(4, 20), mn: c.str(0x18, 40), fr: c.str(0x40, 8),
        rab: c.u8(0x48), oui: [c.u8(0x4b), c.u8(0x4a), c.u8(0x49)], cmic: c.u8(0x4c), mdts: c.u8(0x4d), cntlid: c.u16(0x4e),
        ver: ver ? `${ver >>> 16}.${(ver >> 8) & 0xff}${ver & 0xff ? `.${ver & 0xff}` : ''}` : null,
        rtd3r: c.u32(0x54), rtd3e: c.u32(0x58),
        oacs: c.u16(0x100), acl: c.u8(0x102) + 1, aerl: c.u8(0x103) + 1,
        frmw: c.u8(0x104), lpa: c.u8(0x105), elpe: c.u8(0x106) + 1, npss: c.u8(0x107) + 1,
        avscc: c.u8(0x108) & 1, apsta: c.u8(0x109) & 1,
        wctemp: c.u16(0x10a), cctemp: c.u16(0x10c),
        hmpre: c.u32(0x110), hmmin: c.u32(0x114),
        tnvmcap: c.u64(0x118), unvmcap: c.u64(0x128), rpmbs: c.u32(0x138),
        edstt: c.u16(0x13c), dsto: c.u8(0x13e) & 1, kas: c.u16(0x140),
        hctma: c.u16(0x142) & 1, mntmt: c.u16(0x144), mxtmt: c.u16(0x146), sanicap: c.u32(0x148),
        sqes: c.u8(0x200), cqes: c.u8(0x201), maxcmd: c.u16(0x202), nn: c.u32(0x204),
        oncs: c.u16(0x208), fuses: c.u16(0x20a), fna: c.u8(0x20c), vwc: c.u8(0x20d) & 1,
        awun: c.u16(0x20e), awupf: c.u16(0x210), acwu: c.u16(0x214), sgls: c.u32(0x218),
        subnqn: c.str(0x300, 256), psd,
    };
}

/** Decoded NVMe Identify Namespace. */
export function nvmeNamespace(hexStr) {
    if (!hexStr || hexStr.length < 8192)
        return null;
    const n = new Buf(hexStr);
    const count = n.u8(25) + 1;
    const active = n.u8(26) & 0x0f;
    const formats = [];
    for (let i = 0; i < count && i < 64; i++) {
        const o = 128 + i * 4;
        formats.push({id: i, ms: n.u16(o), size: 2 ** n.u8(o + 2), rp: n.u8(o + 3) & 3, active: i === active});
    }
    return {
        nsze: n.u64(0), ncap: n.u64(8), nuse: n.u64(16), thin: Boolean(n.u8(24) & 1),
        active, formats, eui64: [...n.b.slice(120, 128)].map(x => x.toString(16).padStart(2, '0')).join(''),
    };
}

const kToC = k => (k ? k - 273 : null);
/** binary sizes as the firmware states them: 64 MB, not 67.1 MB */
const mib = b => (b >= 1048576 ? `${fmt.num(b / 1048576, b % 1048576 ? 1 : 0)} MB` : `${fmt.num(b / 1024)} KB`);

// ------------------------------------------------------------------ features

/** Short explanations, shown under the important features. */
const DESC = {
    smart: 'Reports the health counters this app reads.',
    selftest: 'The disk can check itself (short and extended test).',
    trim: 'Windows can tell the SSD which blocks are free, keeping it fast and reducing wear.',
    security: 'Supports locking with a password and self-encrypting (Opal / BitLocker hardware) commands.',
    format: 'Can wipe all data quickly with a format / crypto erase.',
    firmware: 'The firmware can be updated with the maker’s tool.',
    apst: 'Goes into deep sleep when idle, saving power (battery).',
    vwc: 'Speeds up writes by buffering them in the disk.',
    hmb: 'DRAM-less SSD: borrows a little system RAM for its mapping table.',
    hctm: 'The system can ask the SSD to slow down before it gets too hot.',
    sanitize: 'Erases all user data, including caches and spare areas, beyond recovery.',
    ns: 'The disk can be split into several logical drives.',
    wcache: 'Speeds up writes by buffering them in the disk.',
    errlog: 'Keeps a record of the errors the disk ran into.',
};

function row(id, label, supported, detail = '') {
    return {id, label, supported: Boolean(supported), detail, desc: DESC[id] ? _(DESC[id]) : ''};
}

/** NVMe feature list from Identify Controller, grouped like the specification. */
function nvmeFeatures(c) {
    const oacs = n => Boolean(c.oacs & (1 << n));
    const oncs = n => Boolean(c.oncs & (1 << n));
    const lpa = n => Boolean(c.lpa & (1 << n));
    const slots = (c.frmw >> 1) & 7;
    return [
        [_('Commands'), [
            row('selftest', _('Device self-test'), oacs(4), oacs(4) && c.edstt ? _('Extended: {n} min', {n: c.edstt}) : ''),
            row('security', _('Security send / receive'), oacs(0)),
            row('format', _('Format NVM'), oacs(1)),
            row('firmware', _('Firmware download'), oacs(2), slots ? _('{n} slots', {n: slots}) : ''),
            row('fwreset', _('Firmware activation without reset'), c.frmw & 0x10),
            row('ns', _('Namespace management'), oacs(3)),
            row('directives', _('Directives'), oacs(5)),
            row('mi', _('NVMe-MI send / receive'), oacs(6)),
            row('virt', _('Virtualization management'), oacs(7)),
            row('doorbell', _('Doorbell buffer config'), oacs(8)),
            row('lbastatus', _('Get LBA status'), oacs(9)),
            row('lockdown', _('Command and feature lockdown'), oacs(10)),
        ]],
        [_('Data commands'), [
            row('trim', _('Dataset management (TRIM)'), oncs(2)),
            row('zeroes', _('Write zeroes'), oncs(3)),
            row('compare', _('Compare'), oncs(0)),
            row('uncorrectable', _('Write uncorrectable'), oncs(1)),
            row('savesel', _('Save / select fields'), oncs(4)),
            row('reservations', _('Reservations'), oncs(5)),
            row('timestamp', _('Timestamp'), oncs(6)),
            row('verify', _('Verify'), oncs(7)),
            row('copy', _('Copy'), oncs(8)),
            row('fused', _('Compare and write (fused)'), c.fuses & 1),
            row('sgl', _('Scatter gather list (SGL)'), c.sgls & 3),
        ]],
        [_('Erase'), [
            row('crypto', _('Cryptographic erase'), c.fna & 4),
            row('fmtall', _('Format applies to all namespaces'), c.fna & 1),
            row('secall', _('Secure erase applies to all namespaces'), c.fna & 2),
            row('sanitize', _('Sanitize: crypto erase'), c.sanicap & 1),
            row('sanblock', _('Sanitize: block erase'), c.sanicap & 2),
            row('sanover', _('Sanitize: overwrite'), c.sanicap & 4),
        ]],
        [_('Power and temperature'), [
            row('apst', _('Autonomous power state transitions (APST)'), c.apsta, _('{n} power states', {n: c.npss})),
            row('vwc', _('Volatile write cache'), c.vwc),
            row('hmb', _('Host memory buffer (HMB)'), c.hmpre > 0, c.hmpre ? mib(c.hmpre * 4096) : ''),
            row('hctm', _('Host controlled thermal management'), c.hctma),
            row('rpmb', _('Replay protected memory block (RPMB)'), c.rpmbs & 7),
        ]],
        [_('Logs'), [
            row('smartns', _('SMART information per namespace'), lpa(0)),
            row('effects', _('Command effects log'), lpa(1)),
            row('extlog', _('Extended get log page'), lpa(2)),
            row('telemetry', _('Telemetry log'), lpa(3)),
            row('events', _('Persistent event log'), lpa(4)),
        ]],
    ];
}

/** Feature list from smartctl's JSON (ATA disks, or NVMe without identify data). */
function smartctlFeatures(d) {
    const r = d.raw ?? {};
    const nvme = d.protocol === 'NVMe';
    const ata = d.protocol === 'ATA';
    const admin = r.nvme_optional_admin_commands ?? {};
    const nvm = r.nvme_optional_nvm_commands ?? {};
    const logs = r.nvme_log_page_attributes ?? {};
    const caps = pick(r, 'ata_smart_data', 'capabilities') ?? {};
    const polling = pick(r, 'ata_smart_data', 'self_test', 'polling_minutes') ?? {};
    const on = v => (v ? _('Enabled') : _('Disabled'));
    const out = [];
    const add = (id, label, supported, detail = '') => {
        if (has(supported))
            out.push(row(id, label, supported, detail));
    };
    const smartAvail = pick(r, 'smart_support', 'available');
    add('smart', _('SMART'), d.kind === 'flash' ? false : has(smartAvail) ? smartAvail : (nvme || null),
        smartAvail && has(pick(r, 'smart_support', 'enabled')) ? on(r.smart_support.enabled) : '');
    if (nvme) {
        add('selftest', _('Device self-test'), admin.self_test);
        add('trim', _('Dataset management (TRIM)'), nvm.dataset_management);
        add('zeroes', _('Write zeroes'), nvm.write_zeroes);
        add('security', _('Security send / receive'), admin.security_send_receive);
        add('format', _('Format NVM'), admin.format_nvm);
        add('firmware', _('Firmware download'), admin.firmware_download);
        add('ns', _('Namespace management'), admin.namespace_management);
        add('telemetry', _('Telemetry log'), logs.telemetry_log);
        add('events', _('Persistent event log'), logs.persistent_event_log);
    } else if (ata) {
        const types = [];
        if (caps.self_tests_supported) {
            types.push(_('Short') + (polling.short ? ` (${_('{n} min', {n: polling.short})})` : ''));
            types.push(_('Extended') + (polling.extended ? ` (${_('{n} min', {n: polling.extended})})` : ''));
        }
        if (caps.conveyance_self_test_supported)
            types.push(_('Conveyance'));
        if (caps.selective_self_test_supported)
            types.push(_('Selective'));
        add('selftest', _('Device self-test'), caps.self_tests_supported, list(types));
        add('errlog', _('Error log'), caps.error_logging_supported);
        if (d.media !== 'hdd' || pick(r, 'trim', 'supported'))
            add('trim', _('TRIM'), pick(r, 'trim', 'supported'), pick(r, 'trim', 'deterministic') ? _('Deterministic') : '');
        if (r.write_cache)
            add('wcache', _('Write cache'), r.write_cache.supported ?? true, has(r.write_cache.enabled) ? on(r.write_cache.enabled) : '');
        if (r.read_lookahead)
            add('lookahead', _('Read look-ahead'), r.read_lookahead.supported ?? true, has(r.read_lookahead.enabled) ? on(r.read_lookahead.enabled) : '');
        if (r.ata_security)
            add('security', _('ATA security (password, secure erase)'), true,
                list([r.ata_security.enabled ? _('Enabled') : _('Disabled'), r.ata_security.frozen ? _('Frozen') : '']));
        if (r.ata_apm)
            add('apm', _('Power management (APM)'), true, r.ata_apm.enabled ? `${_('Enabled')} (${fmt.num(r.ata_apm.level)})` : _('Disabled'));
        if (r.ata_aam)
            add('aam', _('Acoustic management (AAM)'), true, r.ata_aam.enabled ? _('Enabled') : _('Disabled'));
        if (r.ata_sct_capabilities)
            add('sct', _('SCT commands'), true, r.ata_sct_capabilities.error_recovery_control_supported ? 'ERC' : '');
        add('stats', _('Device statistics'), has(r.ata_device_statistics) || null);
        add('db', _('Known to smartctl'), r.in_smartctl_database);
    } else if (d.kind === 'flash') {
        add('selftest', _('Device self-test'), false);
    }
    add('temp', _('Temperature sensor'), has(pick(r, 'temperature', 'current')) ? true : d.kind === 'flash' ? false : null);
    if (d.read_test_supported)
        add('readtest', _('Read test (this app)'), true);
    return out.length ? [[_('Features'), out]] : [];
}

/** [[group title, [{id, label, desc, supported, detail}]]] */
export function featureGroups(d) {
    const c = nvmeController(d.identify?.ctrl);
    if (!c)
        return smartctlFeatures(d);
    const smart = row('smart', _('SMART'), true);
    const groups = nvmeFeatures(c);
    groups[0][1].unshift(smart);
    if (d.read_test_supported)
        groups[0][1].push(row('readtest', _('Read test (this app)'), true));
    return groups;
}

// ------------------------------------------------------------------ specification sections

/** [{id, title, rows: [[key, value]]}] — empty values dropped. */
export function specSections(d, unit = 'C') {
    const r = d.raw ?? {};
    const c = nvmeController(d.identify?.ctrl);
    const ns = nvmeNamespace(d.identify?.ns);
    const hw = d.windows?.hw ?? {};
    const T = cel => (has(cel) ? fmt.temp(cel, unit) : null);
    const vidDid = (hw.hwid ?? '').match(/VEN_([0-9A-F]{4}).*DEV_([0-9A-F]{4})/i);
    const speed = pick(r, 'interface_speed');
    const firstPs = c?.psd?.[0];

    const sections = [
        {id: 'summary', title: _('Summary'), rows: [
            [_('Windows disk'), Number.isInteger(d.disk_number) ? _('Disk {n}', {n: d.disk_number}) : null],
            [_('Interface'), d.protocol === 'NVMe' ? 'NVMe' : list([d.windows?.bus_type, d.protocol !== d.windows?.bus_type ? d.protocol : null])],
            [_('Disk controller'), hw.controller ? `${hw.controller}${vidDid ? ` [VEN: ${vidDid[1]}, DEV: ${vidDid[2]}]` : ''}` : null],
            [_('Disk location'), has(hw.scsi_bus) ? _('Bus {b}, target {t}, LUN {l}', {b: hw.scsi_bus, t: hw.scsi_target ?? 0, l: hw.scsi_lun ?? 0}) : null],
            [_('PCI location'), hw.location ?? null],
            [_('Model'), d.model],
            [_('Family'), d.model_family],
            [_('Vendor'), r.scsi_vendor ?? d.vendor],
            [_('Firmware'), d.firmware ?? r.scsi_revision],
            [_('Serial'), d.serial],
            [_('Total size'), d.capacity ? `${fmt.bytes(d.capacity)} (${fmt.num(Math.round(d.capacity / 1048576))} MB)` : null],
            [_('Device type'), hw.media ? (/removable|external/i.test(hw.media) || d.bus === 'usb' ? _('Removable disk') : _('Fixed disk')) : null],
            [_('Form factor'), d.form_factor],
            [_('Rotation'), typeof d.rotation_rate === 'number' ? (d.rotation_rate > 0 ? _('{n} rpm', {n: fmt.num(d.rotation_rate)}) : _('Solid state')) : null],
        ]},
        {id: 'link', title: _('Connection'), rows: [
            [_('Highest possible transfer rate'), pcie(hw.max_link_speed, hw.max_link_width) ?? speed?.max?.string ?? null],
            [_('Negotiated transfer rate'), pcie(hw.link_speed, hw.link_width) ?? speed?.current?.string ?? d.link_speed ?? null],
            [_('ATA version'), pick(r, 'ata_version', 'string')],
            [_('SATA version'), pick(r, 'sata_version', 'string')],
            [_('Transport'), d.transport],
        ]},
    ];

    if (c) {
        const sq = v => _('Max: {max}, min: {min}', {max: 2 ** (v >> 4), min: 2 ** (v & 15)});
        sections.push({id: 'props', title: _('NVMe properties'), rows: [
            [_('NVMe version'), c.ver],
            [_('PCI vendor ID (VID)'), vendor(c.vid)],
            [_('PCI subsystem vendor ID (SSVID)'), vendor(c.ssvid)],
            [_('IEEE OUI identifier'), c.oui.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('-')],
            [_('Controller ID'), fmt.num(c.cntlid)],
            [_('Recommended arbitration burst (RAB)'), fmt.num(2 ** c.rab)],
            [_('Multi-interface capabilities'), fmt.num(c.cmic)],
            [_('Maximum data transfer size'), c.mdts ? `${fmt.num(2 ** c.mdts * 4)} KB (${fmt.num(2 ** c.mdts)} × 4 KB)` : _('No limit')],
            [_('Abort command limit'), fmt.num(c.acl)],
            [_('Asynchronous event request limit'), fmt.num(c.aerl)],
            [_('Firmware slots'), fmt.num((c.frmw >> 1) & 7)],
            [_('First firmware slot read only'), yesNo(c.frmw & 1)],
            [_('Maximum error log entries'), fmt.num(c.elpe)],
            [_('Power states'), fmt.num(c.npss)],
            [_('Admin vendor specific command format'), fmt.num(c.avscc)],
            [_('Submission queue entry size'), sq(c.sqes)],
            [_('Completion queue entry size'), sq(c.cqes)],
            [_('Maximum outstanding commands'), c.maxcmd ? fmt.num(c.maxcmd) : null],
            [_('Number of namespaces'), fmt.num(c.nn)],
            [_('Total NVM capacity'), c.tnvmcap ? fmt.bytes(c.tnvmcap) : null],
            [_('Unallocated capacity'), c.tnvmcap ? fmt.bytes(c.unvmcap) : null],
            [_('Extended self-test time'), c.edstt ? _('{n} min', {n: c.edstt}) : null],
            [_('Only one device self-test at a time'), yesNo(c.dsto)],
            [_('Host memory buffer'), c.hmpre ? _('Preferred {p}, minimum {m}', {p: mib(c.hmpre * 4096), m: mib(c.hmmin * 4096)}) : null],
            [_('Atomic write unit'), _('Normal {n}, power fail {p}', {n: fmt.num(c.awun + 1), p: fmt.num(c.awupf + 1)})],
            [_('Resume latency (RTD3)'), c.rtd3r ? `${fmt.num(c.rtd3r / 1e6, 2)} s` : null],
            [_('Entry latency (RTD3)'), c.rtd3e ? `${fmt.num(c.rtd3e / 1e6, 2)} s` : null],
            [_('Keep alive'), c.kas ? `${fmt.num(c.kas * 100)} ms` : null],
            [_('Maximum power'), firstPs ? `${fmt.num(Math.round(firstPs.watts * 1000))} mW` : null],
            ['NQN', c.subnqn || null],
        ]});
    } else if (d.protocol === 'NVMe') {
        sections.push({id: 'props', title: _('NVMe properties'), rows: [
            [_('NVMe version'), pick(r, 'nvme_version', 'string')],
            [_('PCI vendor ID (VID)'), vendor(pick(r, 'nvme_pci_vendor', 'id'))],
            [_('PCI subsystem vendor ID (SSVID)'), vendor(pick(r, 'nvme_pci_vendor', 'subsystem_id'))],
            [_('Controller ID'), has(r.nvme_controller_id) ? fmt.num(r.nvme_controller_id) : null],
            [_('Number of namespaces'), has(r.nvme_number_of_namespaces) ? fmt.num(r.nvme_number_of_namespaces) : null],
            [_('Maximum data transfer size'), r.nvme_maximum_data_transfer_pages ? `${fmt.num(r.nvme_maximum_data_transfer_pages * 4)} KB` : null],
            [_('Firmware slots'), has(pick(r, 'nvme_firmware_update_capabilities', 'slots')) ? fmt.num(r.nvme_firmware_update_capabilities.slots) : null],
        ]});
    }

    const tl = d.temperature ?? {};
    sections.push({id: 'thermal', title: _('Temperature limits'), rows: [
        [_('Warning temperature'), T(c ? kToC(c.wctemp) : tl.warn_limit ?? pick(r, 'nvme_composite_temperature_threshold', 'warning'))],
        [_('Critical temperature'), T(c ? kToC(c.cctemp) : tl.crit_limit ?? pick(r, 'nvme_composite_temperature_threshold', 'critical'))],
        [_('Thermal management range'), c?.hctma && c.mntmt && c.mxtmt ? `${T(kToC(c.mntmt))} – ${T(kToC(c.mxtmt))}` : null],
        [_('Lowest ever'), T(tl.lifetime_min)],
        [_('Highest ever'), T(tl.lifetime_max)],
    ]});

    if (ns) {
        const RP = [_('Best'), _('Better'), _('Good'), _('Degraded')];
        const act = ns.formats[ns.active];
        sections.push({id: 'ns', title: _('Namespace 1'), rows: [
            [_('Total sectors'), fmt.num(ns.nsze)],
            [_('Bytes per sector'), act ? fmt.num(act.size) : null],
            [_('Active LBA format'), fmt.num(ns.active)],
            [_('LBA formats supported'), fmt.num(ns.formats.length)],
            [_('LBA formats'), list(ns.formats.map(f => `${f.size}${f.ms ? `+${f.ms}` : ''} (${RP[f.rp]})${f.active ? ' ✓' : ''}`))],
            [_('Thin provisioning'), yesNo(ns.thin)],
            ['EUI-64', /[1-9a-f]/.test(ns.eui64) ? ns.eui64.toUpperCase() : null],
        ]});
    } else {
        sections.push({id: 'ns', title: _('Format'), rows: [
            [_('Sector size'), r.logical_block_size ? (r.physical_block_size && r.physical_block_size !== r.logical_block_size
                ? _('{l} B logical, {p} B physical', {l: r.logical_block_size, p: r.physical_block_size})
                : `${fmt.num(r.logical_block_size)} B`) : null],
            [_('Total sectors'), pick(r, 'user_capacity', 'blocks') ? fmt.num(r.user_capacity.blocks) : null],
            ['WWN', r.wwn ? `${hex(r.wwn.naa, 1)} ${hex(r.wwn.oui, 6)} ${hex(r.wwn.id, 9)}` : null],
        ]});
    }

    return sections
        .map(s => ({...s, rows: s.rows.filter(([, v]) => has(v))}))
        .filter(s => s.rows.length);
}

/** NVMe power states: [{id, watts, idle, entry, exit}] */
export function powerStates(d) {
    const c = nvmeController(d.identify?.ctrl);
    if (c)
        return c.psd;
    const ps = d.raw?.nvme_power_states;
    if (!Array.isArray(ps))
        return [];
    return ps.map((p, id) => ({
        id, watts: p.max_power?.units_per_watt ? p.max_power.value / p.max_power.units_per_watt : null,
        idle: Boolean(p.non_operational_state), entry: p.entry_latency_us ?? null, exit: p.exit_latency_us ?? null,
    }));
}

// Formatting helpers shared by the shell UI and the preferences window.
import {_, localizeDigits} from './i18n.js';

export const COLORS = {
    good: [0.20, 0.82, 0.48],
    ok: [0.20, 0.82, 0.48],
    warning: [0.96, 0.73, 0.18],
    warn: [0.96, 0.73, 0.18],
    critical: [1.0, 0.36, 0.36],
    crit: [1.0, 0.36, 0.36],
    unknown: [0.6, 0.6, 0.6],
    accent: [0.38, 0.63, 0.92],
};

export function num(n, digits = 0) {
    if (n === null || n === undefined || Number.isNaN(n))
        return '—';
    const fixed = Number(n).toFixed(digits);
    const [int, frac] = fixed.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return localizeDigits(frac ? `${grouped}.${frac}` : grouped);
}

export function percent(n) {
    if (n === null || n === undefined)
        return '—';
    return localizeDigits(`${num(n)}%`);
}

export function temp(c, unit = 'C', short = false) {
    if (c === null || c === undefined)
        return '—';
    const v = unit === 'F' ? c * 9 / 5 + 32 : c;
    return short ? `${num(Math.round(v))}°` : `${num(Math.round(v))}°${unit}`;
}

export function bytes(b, approx = false) {
    if (b === null || b === undefined)
        return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    let i = 0;
    let v = Number(b);
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
    return `${approx ? '≈ ' : ''}${num(v, digits)} ${units[i]}`;
}

export function hours(h) {
    if (h === null || h === undefined)
        return '—';
    return _('{h} h', {h: num(h)});
}

/** 17500 h -> "1y 11m 29d" */
export function duration(h) {
    if (h === null || h === undefined)
        return '—';
    const y = Math.floor(h / 8760);
    const m = Math.floor((h % 8760) / 730);
    const d = Math.floor((h % 730) / 24);
    if (y > 0)
        return _('{y}y {m}m {d}d', {y, m, d});
    if (m > 0)
        return _('{m}m {d}d', {m, d});
    if (h >= 24)
        return _('{d}d {h}h', {d: Math.floor(h / 24), h: h % 24});
    return _('{h}h', {h});
}

export function ago(ts) {
    if (!ts)
        return _('never');
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 5)
        return _('just now');
    if (s < 60)
        return _('{n}s ago', {n: s});
    if (s < 3600)
        return _('{n}m ago', {n: Math.round(s / 60)});
    return _('{n}h ago', {n: Math.round(s / 3600)});
}

export function kindLabel(disk) {
    return {nvme: _('NVMe'), ssd: _('SSD'), hdd: _('HDD'), sas: _('SAS'), virtual: _('Virtual'), flash: _('Flash drive')}[disk.kind] ?? _('Unknown');
}

export function kindIcon(disk) {
    if (disk.bus === 'usb' || disk.removable)
        return 'drive-removable-media-symbolic';
    if (disk.kind === 'hdd' || (disk.kind === 'sas' && disk.media === 'hdd'))
        return 'drive-harddisk-symbolic';
    return 'drive-harddisk-solidstate-symbolic';
}

export function levelLabel(level) {
    return {good: _('Good'), warning: _('Warning'), critical: _('Critical')}[level] ?? _('Unknown');
}

export function displayName(settings, disk) {
    const aliases = settings.get_value('disk-aliases').deepUnpack();
    if (aliases[disk.key])
        return aliases[disk.key];
    return disk.model || disk.name;
}

export function shortName(settings, disk) {
    const aliases = settings.get_value('disk-aliases').deepUnpack();
    if (aliases[disk.key])
        return aliases[disk.key];
    return disk.name.replace(/^(nvme\d+)n\d+$/, '$1');
}

function tempClass(disk) {
    if (disk.kind === 'nvme')
        return 'nvme';
    return disk.media === 'hdd' ? 'hdd' : 'ssd';
}

export function tempThresholds(settings, disk) {
    const k = tempClass(disk);
    return [settings.get_int(`temp-warn-${k}`), settings.get_int(`temp-crit-${k}`)];
}

/** 'ok' | 'warn' | 'crit' | 'unknown' */
export function tempLevel(settings, disk) {
    const t = disk.temperature?.current;
    if (t === null || t === undefined)
        return 'unknown';
    const [w, c] = tempThresholds(settings, disk);
    if (t >= c)
        return 'crit';
    if (t >= w)
        return 'warn';
    return 'ok';
}

const ISSUE_TEXT = {
    smart_failed: 'The disk reports SMART FAILED — back up your data now',
    attr_failing_now: 'Attribute {name} is failing now',
    attr_failed_past: 'Attribute {name} failed in the past',
    reallocated: '{count} reallocated sectors',
    pending: '{count} sectors pending reallocation',
    uncorrectable: '{count} uncorrectable sectors',
    reported_uncorrect: '{count} uncorrectable errors reported',
    spin_retry: '{count} spin-up retries',
    end_to_end: '{count} end-to-end errors',
    crc_errors: '{count} CRC errors — check the SATA cable',
    error_log: '{count} entries in the error log',
    nvme_critical_warning: 'NVMe critical warning flag is set ({value})',
    spare_low: 'Spare capacity is low ({value}%)',
    media_errors: '{count} media / integrity errors',
    grown_defects: '{count} grown defects',
    scsi_uncorrected: '{count} uncorrected read/write errors',
    selftest_failed: 'Last self-test failed',
    wear_out: 'Worn out: {life}% life left — replace soon',
    wear_high: 'High wear: {life}% life left',
    temp_high: 'Temperature {temp} is above the drive limit',
    btrfs_errors: '{count} btrfs device errors on {mount}',
    btrfs_scrub_errors: 'btrfs scrub found errors on {mount}',
    smart_unavailable: 'SMART is not available for this device',
    smart_pending: 'Reading SMART data… the first read of each disk can take up to a minute.',
    smart_disabled: 'SMART is disabled on this device',
    smart_read_failed: 'smartctl could not read SMART data from this disk. Some USB enclosures and virtual machines (for example VMware USB pass-through) block SMART commands — see the SMART tab for details.',
    win_unhealthy: 'Windows reports this disk as unhealthy',
    win_warning: 'Windows reports a warning for this disk',
    disk_bad_blocks: '{count} bad block errors in the Windows log (last 30 days)',
    disk_io_errors: '{count} read/write errors in the Windows log (last 30 days)',
    fs_repair: 'The file system on {letter} needs repair (chkdsk)',
    readtest_errors: 'The read test found {count} unreadable areas — copy your data off this drive',
    readtest_none: 'SMART is not available on this drive. Run a read test (Self-tests tab) for a full check.',
    not_read_standby:'The disk was asleep, so its data has not been read yet. Press “Refresh now” to wake it once.',
};

// ------------------------------------------------------------------ partitions

export const PART_COLORS = [
    [0.21, 0.52, 0.89], [0.57, 0.38, 0.85], [0.15, 0.64, 0.62], [0.90, 0.45, 0.15],
    [0.85, 0.30, 0.55], [0.30, 0.70, 0.30], [0.80, 0.65, 0.10], [0.45, 0.55, 0.65],
];

/**
 * Segments of the disk's partition bar in on-disk order, each with `color`
 * ([r,g,b] or null for unallocated), `usedFrac` (0..1 or null) and `width`
 * (0..1, sums to 1). Tiny partitions get a minimum width so they stay visible.
 */
export function partitionSegments(disk, minFrac = 0.05) {
    const lay = disk?.partitions;
    if (!lay || !lay.segments?.length)
        return [];
    const total = lay.size || lay.segments.reduce((a, s) => a + (s.size || 0), 0) || 1;
    let ci = 0;
    const segs = lay.segments.map(s => {
        const u = partitionUsage(s);
        return {
            ...s,
            color: s.kind === 'part' ? PART_COLORS[ci++ % PART_COLORS.length] : null,
            frac: (s.size || 0) / total,
            usedFrac: u ? u.used / u.size : null,
        };
    });
    if (segs.length * minFrac >= 1) {
        segs.forEach(s => (s.width = 1 / segs.length));
        return segs;
    }
    const small = segs.filter(s => s.frac < minFrac);
    const bigTotal = segs.filter(s => s.frac >= minFrac).reduce((a, s) => a + s.frac, 0) || 1;
    const rest = 1 - small.length * minFrac;
    segs.forEach(s => (s.width = s.frac < minFrac ? minFrac : s.frac / bigTotal * rest));
    return segs;
}

/** {used, size} of the file system that lives in this partition (directly or inside LUKS / LVM). */
export function partitionUsage(seg) {
    if (seg.fs_size && typeof seg.used === 'number')
        return {used: seg.used, size: seg.fs_size};
    const inner = (seg.inner ?? []).find(i => i.size && typeof i.used === 'number');
    return inner ? {used: inner.used, size: inner.size} : null;
}

/** Short title: mount point, else label, else device name. */
export function partitionTitle(seg) {
    if (seg.kind === 'free')
        return _('Unallocated space');
    const mounts = [...(seg.mounts ?? []), ...(seg.inner ?? []).flatMap(i => i.mounts ?? [])];
    return mounts[0] || seg.label || (seg.inner ?? []).find(i => i.label)?.label || seg.partlabel || seg.name;
}

const FS_NAMES = {
    crypto_LUKS: 'LUKS', LVM2_member: 'LVM', vfat: 'FAT32', ntfs: 'NTFS', exfat: 'exFAT',
    ext4: 'ext4', ext3: 'ext3', ext2: 'ext2', btrfs: 'btrfs', xfs: 'XFS', swap: 'swap', f2fs: 'F2FS', zfs_member: 'ZFS',
};

export function fsName(fstype) {
    return fstype ? FS_NAMES[fstype] ?? fstype : _('Unknown');
}

/** "LUKS → ext4", "NTFS", ... */
export function partitionFs(seg) {
    if (seg.kind === 'free')
        return '';
    const chain = [seg.fstype, ...(seg.inner ?? []).map(i => i.fstype)].filter(Boolean).map(fsName);
    return chain.length ? chain.join(' → ') : _('No file system');
}

export function partitionTableName(table) {
    return {gpt: 'GPT', dos: 'MBR'}[table] ?? (table ? table.toUpperCase() : _('No partition table'));
}

/** [text, subtext, level] for the "SMART status" tile. */
export function smartStatus(disk) {
    const sm = disk.smart ?? {};
    if (!disk.smart_updated && sm.error === 'read_failed')
        return [_('Cannot be read'), disk.bus === 'usb' ? _('USB enclosure / VM blocks SMART') : '', 'warning'];
    if (!disk.smart_updated && sm.pending)
        return [_('Reading…'), '', null];
    if (!disk.smart_updated)
        return [_('Not read yet'), sm.standby ? _('Disk is asleep — press “Refresh now”') : '', null];
    if (!sm.available)
        return [_('Not available'), '', null];
    if (sm.passed === true)
        return [_('Passed'), sm.enabled === false ? _('Disabled') : '', 'good'];
    if (sm.passed === false)
        return [_('Failed'), '', 'critical'];
    return ['—', sm.enabled === false ? _('Disabled') : '', null];
}

export function issueText(issue, unit = 'C') {
    const tpl = ISSUE_TEXT[issue.code] ?? issue.code;
    const p = {...issue.params};
    for (const k of ['count', 'value', 'life'])
        if (typeof p[k] === 'number')
            p[k] = num(p[k]);
    if (typeof p.temp === 'number')
        p.temp = temp(p.temp, unit);
    return _(tpl, p);
}

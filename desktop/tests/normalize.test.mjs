// Tests the SMART analysis (extension/lib/normalize.js) on saved smartctl samples:
//   node --test tests/
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {parseSmart, evaluate, normalizeDisk} from '../../extension/lib/normalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const files = readdirSync(fixtures).filter(f => f.endsWith('.json') && !f.endsWith('.expected.json'));

/** Same steps as the former collector's --parse mode. */
function jsParse(js) {
    const d = parseSmart(js);
    d.temperature = d.temperature_smart;
    delete d.temperature_smart;
    d.kind = d.protocol === 'NVMe' ? 'nvme' : d.protocol === 'SCSI' ? 'sas' : (d.rotation_rate ?? 0) > 0 ? 'hdd' : 'ssd';
    d.health = evaluate(d);
    return d;
}

// Reference results (*.expected.json) were produced by the former Python collector
// (`linuxhealth-collector.py --parse`) and pin the analysis down.
for (const f of files) {
    const exp = path.join(fixtures, f.replace(/\.json$/, '.expected.json'));
    test(`analysis matches reference: ${f}`, {skip: !existsSync(exp) && 'no reference'}, () => {
        const js = JSON.parse(readFileSync(path.join(fixtures, f), 'utf8'));
        const expected = JSON.parse(readFileSync(exp, 'utf8'));
        assert.deepEqual(JSON.parse(JSON.stringify(jsParse(js))), expected);
    });
}

test('raw disk from the Windows / macOS collector', () => {
    const raw = JSON.parse(readFileSync(path.join(fixtures, 'nvme.json'), 'utf8'));
    const d = normalizeDisk({
        name: '/dev/nvme0', path: '/dev/nvme0', dev_type: 'nvme', key: 'CY0AN123456789',
        smart: {error: null, standby: false}, smart_updated: 1700000000,
        temperature: {current: 31, source: 'smart', updated: 1700000000, history: [[1, 30], [2, 31]], min_24h: 30, max_24h: 31},
        raw,
    });
    assert.equal(d.name, 'nvme0');
    assert.equal(d.kind, 'nvme');
    assert.equal(d.temperature.current, 31);
    assert.equal(d.temperature.warn_limit, 84);
    assert.equal(d.life_remaining, 99);
    assert.equal(d.health.level, 'good');
    assert.equal(d.health.score, 99);
});

test('sleeping disk that was never read', () => {
    const d = normalizeDisk({name: '/dev/sdb', path: '/dev/sdb', dev_type: 'sat', smart: {standby: true}, temperature: {current: null, standby: true}, raw: null});
    assert.equal(d.bus, null);
    assert.equal(d.health.level, 'unknown');
    assert.equal(d.health.issues[0].code, 'not_read_standby');
});

test('failing HDD is critical', () => {
    const js = JSON.parse(readFileSync(path.join(fixtures, 'hdd_bad.json'), 'utf8'));
    const d = jsParse(js);
    assert.equal(d.health.level, 'critical');
    assert.equal(d.self_test.running, true);
    assert.equal(d.self_test.remaining, 90);
});

test('USB flash drive: no SMART, health from Windows checks + read test', () => {
    const raw = JSON.parse(readFileSync(path.join(fixtures, 'usb_flash.json'), 'utf8'));
    const win = {number: 2, size: 61530439680, bus_type: 'USB', health: 'Healthy', status: 'Online',
        events: {bad_blocks: 0, controller: 0, paging: 11, retried: 0},
        volumes: [{letter: 'E:', label: '', fs: 'FAT32', size: 61513662464, free: 60000000000, health: 'Healthy'}]};
    const base = {name: '/dev/sdc', path: '/dev/sdc', dev_type: 'scsi', key: '/dev/sdc', smart: {}, smart_updated: 1, temperature: {}, raw, windows: win};
    const d = normalizeDisk(base);
    assert.equal(d.kind, 'flash');
    assert.equal(d.bus, 'usb');
    assert.deepEqual(d.drive_letters, ['E:']);
    assert.equal(d.smart.available, false);
    assert.equal(d.health.level, 'warning');
    assert.equal(d.health.score, 79);
    assert.deepEqual(d.health.issues.map(i => i.code), ['disk_io_errors', 'readtest_none']);

    const tested = normalizeDisk({...base, windows: {...win, events: {}}, read_test: {running: false, errors: 3, finished: 2}});
    assert.equal(tested.health.level, 'critical');
    assert.equal(tested.health.issues[0].code, 'readtest_errors');

    const clean = normalizeDisk({...base, windows: {...win, events: {}}, read_test: {running: false, errors: 0, finished: 2}});
    assert.equal(clean.health.level, 'good');
    assert.equal(clean.health.score, 100);
    assert.equal(clean.health.issues.length, 0);
});

test('SMART disk on Windows also gets the Windows log errors', () => {
    const raw = JSON.parse(readFileSync(path.join(fixtures, 'nvme.json'), 'utf8'));
    const d = normalizeDisk({name: '/dev/sdb', path: '/dev/sdb', key: 'k', smart: {}, smart_updated: 1, temperature: {}, raw,
        windows: {number: 1, bus_type: 'NVMe', health: 'Healthy', events: {bad_blocks: 2}, volumes: []}});
    assert.equal(d.kind, 'nvme');
    assert.equal(d.health.level, 'critical');
    assert.ok(d.health.issues.some(i => i.code === 'disk_bad_blocks'));
});

test('Linux disk: lsblk info, partitions and btrfs errors', () => {
    const raw = JSON.parse(readFileSync(path.join(fixtures, 'ata_ssd.json'), 'utf8'));
    const d = normalizeDisk({
        name: 'sda', path: '/dev/sda', key: 'S1', smart: {}, smart_updated: 1, temperature: {}, raw,
        block: {model: 'Disk', serial: 'S1', size: 500107862016, rota: false, tran: 'sata', removable: false},
        filesystems: [{name: 'sda2', fstype: 'btrfs', mounts: ['/']}],
        partitions: {table: 'gpt', count: 2, segments: []},
        btrfs: [{mount: '/', errors_total: 3, devices: [], scrub: {errors: 'no errors found'}}],
        usage: {today_hours: 2, days: []},
    });
    assert.equal(d.bus, 'sata');
    assert.equal(d.removable, false);
    assert.equal(d.partitions.count, 2);
    assert.equal(d.usage.today_hours, 2);
    assert.ok(d.health.issues.some(i => i.code === 'btrfs_errors' && i.params.count === 3));
    assert.ok(!d.health.issues.some(i => i.code === 'btrfs_scrub_errors'));
    assert.equal('_rota' in d, false);
});

test('Linux USB stick (lsblk tran usb) is a flash drive', () => {
    const raw = JSON.parse(readFileSync(path.join(fixtures, 'usb_flash.json'), 'utf8'));
    const d = normalizeDisk({name: 'sdc', path: '/dev/sdc', key: 'k', smart: {}, smart_updated: 1, temperature: {}, raw,
        block: {tran: 'usb', removable: true, size: 61530439680}});
    assert.equal(d.kind, 'flash');
    assert.equal(d.removable, true);
});

test('disk whose first SMART read is still running', () => {
    const d = normalizeDisk({name: '/dev/sdb', path: '/dev/sdb', key: 'k', smart: {scanning: true}, temperature: {current: 46}, raw: null});
    assert.equal(d.smart.pending, true);
    assert.equal(d.health.level, 'unknown');
    assert.equal(d.health.issues[0].code, 'smart_pending');
    const failed = normalizeDisk({name: '/dev/sdb', path: '/dev/sdb', key: 'k', smart_checked: 5, smart: {error: 'read_failed'}, temperature: {}, raw: null});
    assert.equal(failed.smart.pending, false);
    assert.equal(failed.health.issues[0].code, 'smart_read_failed');
});

//! Linux specifics of the collector: block devices and partitions (lsblk + sysfs),
//! kernel hwmon temperatures (nvme / drivetemp), btrfs error counters, the config
//! file /etc/diskguardian/collector.conf and the request directory permissions.
//! Port of the former Python collector (linuxhealth-collector.py).

use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::collector::{log, run_capture, Config};

pub const CONF_FILE: &str = "/etc/diskguardian/collector.conf";
/// unallocated regions smaller than this are alignment padding
const MIN_GAP: u64 = 32 * 1024 * 1024;
const IGNORE_PREFIX: &[&str] = &["loop", "ram", "zram", "fd", "sr", "nbd", "md", "dm-"];

// ------------------------------------------------------------------ config

/// `[collector]` section of collector.conf (simple INI: key = value, # comments).
pub fn load_config(cfg: &mut Config) {
    let Ok(text) = fs::read_to_string(CONF_FILE) else { return };
    let mut in_section = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            in_section = line.eq_ignore_ascii_case("[collector]");
            continue;
        }
        let (Some((k, v)), true) = (line.split_once('='), in_section) else { continue };
        let (k, v) = (k.trim(), v.trim());
        let num = || v.parse::<u64>().ok().map(|n| n.max(1));
        let flag = || matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
        match k {
            "smart_interval" => cfg.smart_interval = num().unwrap_or(cfg.smart_interval),
            "temp_interval" => cfg.temp_interval = num().unwrap_or(cfg.temp_interval),
            "hdd_temp_interval" => cfg.hdd_temp_interval = num().unwrap_or(cfg.hdd_temp_interval),
            "hdd_use_hwmon" => cfg.hdd_use_hwmon = flag(),
            "wake_for_first_scan" => cfg.wake_for_first_scan = flag(),
            "request_group" => cfg.request_group = v.to_string(),
            "ignore_devices" => cfg.ignore = v.split_whitespace().map(str::to_string).collect(),
            _ => log(&format!("{CONF_FILE}: unknown setting {k}")),
        }
    }
}

// ------------------------------------------------------------------ requests directory

fn group_gid(name: &str) -> Option<u32> {
    let text = fs::read_to_string("/etc/group").ok()?;
    text.lines().find_map(|l| {
        let mut f = l.split(':');
        (f.next()? == name).then(|| f.nth(1)?.parse().ok()).flatten()
    })
}

/// requests/ is root:<request_group> 1770: group members may ask for a refresh or a
/// self-test, other users cannot (sticky: nobody deletes other users' requests).
pub fn secure_requests_dir(dir: &Path, group: &str) {
    use std::os::unix::fs::PermissionsExt;
    // administrators are "sudo" on Debian / Ubuntu and "wheel" on Fedora, openSUSE, Arch
    let gid = group_gid(group)
        .or_else(|| (group == "sudo").then(|| group_gid("wheel")).flatten())
        .unwrap_or_else(|| {
            log(&format!("group {group} not found, requests limited to root"));
            0
        });
    if let Err(e) = std::os::unix::fs::chown(dir, Some(0), Some(gid)) {
        log(&format!("cannot set the owner of {}: {e}", dir.display()));
    }
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o1770));
}

pub fn drivetemp_loaded() -> bool {
    Path::new("/sys/module/drivetemp").is_dir()
}

// ------------------------------------------------------------------ lsblk

/// Whole-disk nodes of `lsblk -J -b` (with their partition / LVM / LUKS children).
pub fn lsblk_disks(ignore: &HashSet<String>) -> Vec<Value> {
    const COLS: &str = "NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,ROTA,TRAN,VENDOR,FSTYPE,{mp},FSSIZE,FSUSED,LABEL,UUID,RM,HOTPLUG";
    // newest util-linux first; older versions reject unknown columns
    let attempts = [
        format!("{},PTTYPE,PARTLABEL,PARTTYPENAME", COLS.replace("{mp}", "MOUNTPOINTS")),
        format!("{},PTTYPE,PARTLABEL", COLS.replace("{mp}", "MOUNTPOINTS")),
        format!("{},PTTYPE", COLS.replace("{mp}", "MOUNTPOINT")),
        COLS.replace("{mp}", "MOUNTPOINT"),
    ];
    for cols in attempts {
        let mut cmd = Command::new("lsblk");
        cmd.args(["-J", "-b", "-o", &cols]);
        let (rc, out) = run_capture(cmd, Duration::from_secs(20));
        if rc != 0 {
            continue;
        }
        let Ok(js) = serde_json::from_str::<Value>(&out) else { continue };
        let Some(list) = js.get("blockdevices").and_then(Value::as_array) else { continue };
        return list.iter()
            .filter(|n| n["type"] == "disk")
            .filter(|n| {
                let name = n["name"].as_str().unwrap_or("");
                !name.is_empty() && !IGNORE_PREFIX.iter().any(|p| name.starts_with(p)) && !ignore.contains(name)
            })
            .cloned()
            .collect();
    }
    Vec::new()
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// lsblk sizes are numbers with -b, but some versions print strings
fn num(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

fn flag(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_u64() == Some(1),
        Value::String(s) => matches!(s.as_str(), "1" | "true"),
        _ => false,
    }
}

/// Summary of the disk node: what the UI needs when SMART did not answer.
pub fn block_info(n: &Value) -> Value {
    json!({
        "model": text(&n["model"]), "serial": text(&n["serial"]), "vendor": text(&n["vendor"]),
        "size": num(&n["size"]), "rota": flag(&n["rota"]), "tran": text(&n["tran"]),
        "removable": flag(&n["rm"]) || flag(&n["hotplug"]),
    })
}

fn walk<'a>(n: &'a Value, out: &mut Vec<&'a Value>) {
    out.push(n);
    for c in n["children"].as_array().into_iter().flatten() {
        walk(c, out);
    }
}

fn mounts(n: &Value) -> Vec<String> {
    match n.get("mountpoints").and_then(Value::as_array) {
        Some(a) => a.iter().filter_map(text).collect(),
        None => text(&n["mountpoint"]).into_iter().collect(),
    }
}

fn sysfs_u64(path: &str) -> Option<u64> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// (file systems, kernel names, mounted btrfs file systems) of one disk
pub fn filesystems(n: &Value) -> (Value, HashSet<String>, Vec<String>) {
    let mut nodes = Vec::new();
    walk(n, &mut nodes);
    let (mut fs_list, mut knames, mut btrfs) = (Vec::new(), HashSet::new(), Vec::new());
    for c in nodes {
        if let Some(k) = text(&c["kname"]).or_else(|| text(&c["name"])) {
            knames.insert(k);
        }
        let Some(fstype) = text(&c["fstype"]) else { continue };
        let m = mounts(c);
        if fstype == "btrfs" {
            if let Some(first) = m.first() {
                btrfs.push(first.clone());
            }
        }
        fs_list.push(json!({
            "name": text(&c["name"]), "fstype": fstype, "label": text(&c["label"]), "mounts": m,
            "size": num(&c["fssize"]), "used": num(&c["fsused"]),
        }));
    }
    (Value::Array(fs_list), knames, btrfs)
}

/// Partition table in on-disk order (with nested LUKS / LVM file systems) plus
/// unallocated gaps; offsets come from sysfs.
pub fn partition_layout(n: &Value) -> Value {
    let name = n["name"].as_str().unwrap_or("");
    let disk_size = num(&n["size"]).unwrap_or(0);
    let mut parts: Vec<Value> = Vec::new();
    for c in n["children"].as_array().into_iter().flatten().filter(|c| c["type"] == "part") {
        let pname = text(&c["kname"]).or_else(|| text(&c["name"])).unwrap_or_default();
        let base = format!("/sys/block/{name}/{pname}");
        let start = sysfs_u64(&format!("{base}/start")).map(|s| s * 512);
        let size = sysfs_u64(&format!("{base}/size")).map(|s| s * 512).or_else(|| num(&c["size"]));
        if size.is_some_and(|s| s <= 1024 * 1024) && text(&c["fstype"]).is_none() {
            continue; // DOS extended-partition container (its logical partitions are listed separately)
        }
        let mut sub = Vec::new();
        walk(c, &mut sub);
        let inner: Vec<Value> = sub.into_iter().skip(1)
            .filter(|s| text(&s["fstype"]).is_some() || !mounts(s).is_empty())
            .map(|s| json!({
                "name": text(&s["name"]), "type": text(&s["type"]), "fstype": text(&s["fstype"]),
                "label": text(&s["label"]), "mounts": mounts(s),
                "size": num(&s["fssize"]).or_else(|| num(&s["size"])), "used": num(&s["fsused"]),
            }))
            .collect();
        parts.push(json!({
            "name": pname, "number": sysfs_u64(&format!("{base}/partition")), "start": start, "size": size,
            "fstype": text(&c["fstype"]), "label": text(&c["label"]), "partlabel": text(&c["partlabel"]),
            "type_name": text(&c["parttypename"]), "mounts": mounts(c),
            "fs_size": num(&c["fssize"]), "used": num(&c["fsused"]), "inner": inner,
        }));
    }
    // on-disk order; partitions without a known offset keep lsblk order at the end
    parts.sort_by_key(|p| (p["start"].is_null(), p["start"].as_u64().unwrap_or(0)));
    let mut segments = Vec::new();
    let mut pos = 0u64;
    for p in &parts {
        let start = p["start"].as_u64();
        if let Some(s) = start.filter(|s| s.saturating_sub(pos) >= MIN_GAP) {
            segments.push(json!({"kind": "free", "start": pos, "size": s - pos}));
        }
        let mut seg = p.clone();
        seg["kind"] = json!("part");
        segments.push(seg);
        if let (Some(s), Some(sz)) = (start, p["size"].as_u64().filter(|&z| z > 0)) {
            pos = pos.max(s + sz);
        }
    }
    let disk_fs = text(&n["fstype"]);
    if disk_size.saturating_sub(pos) >= MIN_GAP && disk_size > 0 && (!parts.is_empty() || disk_fs.is_none()) {
        segments.push(json!({"kind": "free", "start": pos, "size": disk_size - pos}));
    }
    let mut count = parts.len();
    if parts.is_empty() && disk_fs.is_some() {
        // file system written directly on the disk (no partition table)
        segments = vec![json!({
            "kind": "part", "name": name, "number": null, "start": 0, "size": disk_size,
            "fstype": disk_fs, "label": text(&n["label"]), "partlabel": null, "type_name": null,
            "mounts": mounts(n), "fs_size": num(&n["fssize"]), "used": num(&n["fsused"]), "inner": [],
        })];
        count = 1;
    }
    json!({"table": text(&n["pttype"]), "size": disk_size, "count": count, "segments": segments})
}

// ------------------------------------------------------------------ hwmon

/// Kernel temperature input of a block device (nvme controller or drivetemp).
pub fn find_hwmon(name: &str) -> Option<PathBuf> {
    let dirs = [
        format!("/sys/block/{name}/device"),            // nvme controller: hwmonN
        format!("/sys/block/{name}/device/device"),     // nvme (pci)
        format!("/sys/block/{name}/device/hwmon"),      // drivetemp (sata)
    ];
    for d in dirs {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        let mut hits: Vec<PathBuf> = rd.flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("hwmon"))
            .map(|e| e.path().join("temp1_input"))
            .filter(|p| p.is_file())
            .collect();
        hits.sort();
        if let Some(p) = hits.into_iter().next() {
            return Some(p);
        }
    }
    None
}

pub fn read_hwmon(path: &Path) -> Option<i64> {
    let v: i64 = fs::read_to_string(path).ok()?.trim().parse().ok()?;
    let t = (v as f64 / 1000.0).round() as i64;
    (0 < t && t < 150).then_some(t) // 0 = "no sensor" on many virtual / USB devices
}

// ------------------------------------------------------------------ btrfs

pub fn has_btrfs() -> bool {
    ["/usr/bin/btrfs", "/usr/sbin/btrfs", "/bin/btrfs", "/sbin/btrfs"].iter().any(|p| Path::new(p).is_file())
}

/// `btrfs device stats` (errors of this disk's devices) and the last scrub of one mount.
pub fn btrfs_info(mount: &str, knames: &HashSet<String>) -> Value {
    let mut cmd = Command::new("btrfs");
    cmd.args(["device", "stats", mount]);
    let (_, out) = run_capture(cmd, Duration::from_secs(30));
    let mut devs: Vec<(String, serde_json::Map<String, Value>)> = Vec::new();
    for line in out.lines() {
        // "[/dev/sda2].write_io_errs    0"
        let Some(rest) = line.trim().strip_prefix('[') else { continue };
        let Some((dev, rest)) = rest.split_once("].") else { continue };
        let mut it = rest.split_whitespace();
        let (Some(key), Some(val)) = (it.next(), it.next().and_then(|v| v.parse::<i64>().ok())) else { continue };
        let base = fs::canonicalize(dev).ok()
            .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
            .unwrap_or_default();
        let short = Path::new(dev).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        if !knames.is_empty() && !knames.contains(&base) && !knames.contains(&short) {
            continue;
        }
        let entry = match devs.iter_mut().position(|d| d.0 == dev) {
            Some(i) => &mut devs[i].1,
            None => {
                let mut m = serde_json::Map::new();
                m.insert("device".into(), json!(dev));
                devs.push((dev.to_string(), m));
                &mut devs.last_mut().unwrap().1
            }
        };
        entry.insert(key.to_string(), json!(val));
    }
    let total: i64 = devs.iter()
        .flat_map(|d| d.1.iter().filter(|(k, _)| *k != "device").filter_map(|(_, v)| v.as_i64()))
        .filter(|v| *v > 0)
        .sum();
    let mut info = json!({
        "mount": mount, "devices": devs.into_iter().map(|d| Value::Object(d.1)).collect::<Vec<_>>(),
        "errors_total": total, "scrub": null,
    });
    let mut cmd = Command::new("btrfs");
    cmd.args(["scrub", "status", mount]);
    let (rc, out) = run_capture(cmd, Duration::from_secs(30));
    if rc == 0 && !out.is_empty() {
        let mut scrub = serde_json::Map::new();
        for line in out.lines() {
            let Some((k, v)) = line.split_once(':') else { continue };
            let (k, v) = (k.trim().to_lowercase(), v.trim());
            match k.as_str() {
                "status" => { scrub.insert("status".into(), json!(v)); }
                "scrub started" => { scrub.insert("started".into(), json!(v)); }
                "duration" => { scrub.insert("duration".into(), json!(v)); }
                "error summary" => { scrub.insert("errors".into(), json!(v)); }
                "uuid" => info["uuid"] = json!(v),
                _ => {}
            }
        }
        if !scrub.is_empty() {
            info["scrub"] = Value::Object(scrub);
        }
    }
    info
}

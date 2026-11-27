//! Disk collector for Windows, macOS and Linux (Windows service / launchd daemon /
//! systemd service, because smartctl needs administrator / root rights).
//!
//! It only gathers data: `smartctl -j -x` output per disk, NVMe identify data, live
//! temperature, a 24 h temperature history and daily usage, plus OS details (Windows
//! disk numbers and drive letters; Linux lsblk partitions, hwmon temperatures, btrfs).
//! Parsing and health scoring happen in extension/lib/normalize.js, shared by the
//! desktop app and the GNOME Shell extension.
//!
//! Output: paths::state_file(), {"format": "raw", "disks": [...]}; requests
//! (refresh / self-test) are JSON files dropped into paths::requests_dir().

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::paths;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SMART_INTERVAL_TESTING: u64 = 45;
/// smartctl temperature reads of SSD / NVMe without a kernel sensor
const SMART_TEMP_INTERVAL: u64 = if cfg!(target_os = "linux") { 30 } else { 15 };
/// daily power-on hours / bytes written kept for the usage chart
const DAILY_KEEP_DAYS: usize = 31;
const DISCOVER_INTERVAL: u64 = 60;
const HISTORY_SAMPLE: u64 = 60;
const HISTORY_KEEP: u64 = 24 * 3600;
const STATE_MAX_AGE: u64 = 5;
const WAKE_RETRY: u64 = 6 * 3600;
/// -d types tried when a disk (usually a USB enclosure) does not answer with the scanned type
const USB_TYPES: &[&str] = &["sat", "sat,12", "usbjmicron", "usbcypress", "usbsunplus", "usbprolific", "sntjmicron", "sntasmedia", "sntrealtek"];
const VIRTUAL_HINTS: &[&str] = &["vmware", "qemu", "vbox", "virtualbox", "virtual disk", "msft virtual", "red hat", "virtio", "bhyve", "xen"];

/// Collector settings (on Linux from /etc/diskguardian/collector.conf).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct Config {
    pub smart_interval: u64,
    /// kernel hwmon temperature reads (Linux) / smartctl temperature reads
    pub temp_interval: u64,
    pub hdd_temp_interval: u64,
    /// read HDD temperature through drivetemp (may keep drives from spinning down)
    pub hdd_use_hwmon: bool,
    pub wake_for_first_scan: bool,
    /// Linux: members may send refresh / self-test requests
    pub request_group: String,
    pub ignore: HashSet<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            smart_interval: 300,
            temp_interval: if cfg!(target_os = "linux") { 3 } else { 15 },
            hdd_temp_interval: 60,
            hdd_use_hwmon: false,
            wake_for_first_scan: true,
            request_group: "sudo".into(),
            ignore: HashSet::new(),
        }
    }
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Append a line to the collector log (the service has no console).
pub fn log(msg: &str) {
    let path = paths::log_file();
    if fs::metadata(&path).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", now(), msg);
    }
    eprintln!("{msg}");
}

// ------------------------------------------------------------------ smartctl

/// smartctl next to our executable (bundled), then the usual install locations, then PATH.
pub fn find_smartctl() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SMARTCTL").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let exe_name = if cfg!(windows) { "smartctl.exe" } else { "smartctl" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let p = dir.join(exe_name);
        if p.is_file() {
            return Some(p);
        }
    }
    let known: Vec<&str> = if cfg!(windows) {
        vec![r"C:\Program Files\smartmontools\bin\smartctl.exe", r"C:\Program Files (x86)\smartmontools\bin\smartctl.exe"]
    } else {
        vec!["/opt/homebrew/sbin/smartctl", "/usr/local/sbin/smartctl", "/opt/local/sbin/smartctl", "/usr/sbin/smartctl", "/usr/bin/smartctl"]
    };
    for k in known {
        if Path::new(k).is_file() {
            return Some(PathBuf::from(k));
        }
    }
    std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join(exe_name)).find(|p| p.is_file()))
}

pub fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Run a command with a timeout; returns (exit code or -1, stdout).
pub(crate) fn run_capture(mut cmd: Command, timeout: Duration) -> (i32, String) {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let Ok(mut child) = cmd.spawn() else { return (-1, String::new()) };
    let Some(mut out) = child.stdout.take() else { return (-1, String::new()) };
    let reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break -1;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => break -1,
        }
    };
    let bytes = reader.join().unwrap_or_default();
    (code, String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Clone)]
struct Smartctl {
    exe: PathBuf,
}

impl Smartctl {
    fn run(&self, args: &[&str], dev_type: Option<&str>, path: &str, timeout: u64) -> (i32, Value) {
        let mut cmd = Command::new(&self.exe);
        cmd.arg("-j").args(args);
        if let Some(t) = dev_type {
            cmd.arg("-d").arg(t);
        }
        cmd.arg(path);
        let (code, out) = run_capture(cmd, Duration::from_secs(timeout));
        (code, serde_json::from_str(&out).unwrap_or(Value::Null))
    }

    /// NVMe Identify Controller + Identify Namespace 1 (4 KiB each) as hex strings.
    /// smartctl has no option to print them, but its NVMe ioctl debug output
    /// (`-r nvmeioctl,2`) hex-dumps every buffer: " 1f0    00 11 22 ... 16 bytes   ascii".
    /// Lines after the last non-zero one are left out, so the buffers start zeroed.
    fn nvme_identify(&self, path: &str, dev_type: Option<&str>) -> Option<Value> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(["-i", "-r", "nvmeioctl,2"]);
        if let Some(t) = dev_type {
            cmd.arg("-d").arg(t);
        }
        cmd.arg(path);
        let (_, out) = run_capture(cmd, Duration::from_secs(30));
        let mut ctrl: Option<Vec<u8>> = None;
        let mut ns: Option<Vec<u8>> = None;
        // 0 = none, 1 = controller, 2 = namespace
        let mut cur = 0;
        for line in out.lines() {
            let t = line.trim();
            if t.starts_with("[NVMe call:") {
                cur = if !t.contains("opcode=0x06,") {
                    0
                } else if t.contains("cdw10=0x00000001") {
                    ctrl.get_or_insert_with(|| vec![0u8; 4096]);
                    1
                } else if t.contains("cdw10=0x00000000") && t.contains("nsid=0x00000001") {
                    ns.get_or_insert_with(|| vec![0u8; 4096]);
                    2
                } else {
                    0
                };
                continue;
            }
            if cur == 0 || t.starts_with('[') {
                continue;
            }
            let mut it = t.split_whitespace();
            let Some(off) = it.next().and_then(|o| usize::from_str_radix(o, 16).ok()) else { continue };
            let bytes: Vec<u8> = it.take(16).map_while(|b| (b.len() == 2).then(|| u8::from_str_radix(b, 16).ok()).flatten()).collect();
            if bytes.len() != 16 || off + 16 > 4096 {
                continue;
            }
            let buf = if cur == 1 { ctrl.as_mut() } else { ns.as_mut() };
            if let Some(buf) = buf {
                buf[off..off + 16].copy_from_slice(&bytes);
            }
        }
        let hex = |b: &Vec<u8>| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let ctrl = ctrl.filter(|b| b.iter().any(|&x| x != 0))?;
        Some(json!({"ctrl": hex(&ctrl), "ns": ns.filter(|b| b.iter().any(|&x| x != 0)).as_ref().map(hex)}))
    }

    /// Try `-x`, then `-a`, then `-i -H -A` (USB bridges and VMs often refuse the big logs).
    fn chain(&self, path: &str, dev_type: Option<&str>, wake: bool, tried: &mut Vec<String>) -> (bool, i32, Value) {
        let mut last = (-1, Value::Null);
        let attempts: [(&[&str], u64); 3] = [(&["-x"], 60), (&["-a"], 45), (&["-i", "-H", "-A"], 30)];
        for (args, timeout) in attempts {
            let mut a: Vec<&str> = args.to_vec();
            if !wake {
                a.extend(["-n", "standby"]);
            }
            let (rc, js) = self.run(&a, dev_type, path, timeout);
            let msgs = messages(&js);
            tried.push(format!("smartctl {}{}: {}{}", a.join(" "),
                dev_type.map(|t| format!(" -d {t}")).unwrap_or_default(),
                if rc == -1 && js.is_null() { "timeout / no output".to_string() } else { format!("exit {rc}") },
                if msgs.is_empty() { String::new() } else { format!(" — {}", short(&msgs, 200)) }));
            if is_standby(&msgs) || usable(rc, &js) {
                return (true, rc, js);
            }
            last = (rc, js);
        }
        (false, last.0, last.1)
    }

    /// Returns (rc, json, tried commands, -d type that worked when it had to be probed).
    fn read_smart(&self, path: &str, dev_type: Option<&str>, wake: bool, usb: bool) -> (i32, Value, Vec<String>, Option<String>) {
        let mut tried = Vec::new();
        let (ok, rc, js) = self.chain(path, dev_type, wake, &mut tried);
        if ok {
            return (rc, js, tried, None);
        }
        let maybe_usb = if cfg!(target_os = "linux") {
            usb
        } else {
            usb || dev_type.map(|t| t.starts_with("sat") || t.starts_with("usb") || t.starts_with("scsi")).unwrap_or(true)
        };
        if needs_type(&messages(&js)) || maybe_usb {
            for t in USB_TYPES.iter().copied().filter(|t| Some(*t) != dev_type) {
                let mut a = vec!["-i"];
                if !wake {
                    a.extend(["-n", "standby"]);
                }
                let (prc, pjs) = self.run(&a, Some(t), path, 20);
                let msgs = messages(&pjs);
                tried.push(format!("smartctl {} -d {t}: exit {prc}", a.join(" ")));
                if is_standby(&msgs) {
                    return (prc, pjs, tried, None);
                }
                let ata = pjs.pointer("/device/protocol").and_then(Value::as_str) == Some("ATA");
                if ata && (truthy(pjs.get("model_name")) || truthy(pjs.get("serial_number"))) {
                    let (ok2, rc2, js2) = self.chain(path, Some(t), wake, &mut tried);
                    if ok2 {
                        return (rc2, js2, tried, Some(t.to_string()));
                    }
                }
            }
        }
        (rc, js, tried, None)
    }

    fn scan(&self) -> Vec<(String, Option<String>)> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(["--scan", "-j"]);
        let (_, out) = run_capture(cmd, Duration::from_secs(60));
        let js: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
        js.get("devices")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|d| {
                        let name = d.get("name")?.as_str()?.to_string();
                        let t = d.get("type").and_then(Value::as_str).map(str::to_string);
                        Some((name, t))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Input of one SMART read on a worker thread.
struct ScanReq {
    path: String,
    dev_type: Option<String>,
    wake: bool,
    usb: bool,
    hdd: bool,
    never_read: bool,
    wake_failed: u64,
    wake_first: bool,
    /// also read NVMe identify data (once per disk)
    identify: bool,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    btrfs_mounts: Vec<String>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    knames: HashSet<String>,
}

struct ScanResult {
    path: String,
    rc: i32,
    js: Value,
    tried: Vec<String>,
    /// -d type that worked when it had to be probed
    found: Option<String>,
    woke: bool,
    /// Some(..) when identify was attempted
    identify: Option<Option<Value>>,
    btrfs: Option<Value>,
    secs: u64,
}

/// The slow part of a SMART read (smartctl calls, each with a timeout). Runs on a worker
/// thread so one slow disk never blocks temperatures, requests or the state file.
/// A sleeping disk is not woken up, except on an explicit refresh or when it has never
/// been read (at most every 6 h while that keeps failing).
fn scan_io(sc: &Smartctl, r: ScanReq) -> ScanResult {
    let started = Instant::now();
    let path = r.path.as_str();
    let dt = r.dev_type.as_deref();
    let (mut rc, mut js, mut tried, mut found) = sc.read_smart(path, dt, r.wake, r.usb);
    let mut woke = r.wake;
    if !r.wake && is_standby(&messages(&js)) && r.never_read && r.wake_first
        && now().saturating_sub(r.wake_failed) > WAKE_RETRY {
        log(&format!("{path} is asleep and has never been read: waking it once"));
        (rc, js, tried, found) = sc.read_smart(path, dt, true, r.usb);
        woke = true;
    }
    // Linux: some USB bridges reject SMART pass-through while the drive is spun down;
    // a small direct read wakes it up, then try again.
    if cfg!(target_os = "linux") && woke && (r.usb || r.hdd) && !usable(rc, &js) && !is_standby(&messages(&js)) {
        log(&format!("{path} did not answer SMART commands: spinning it up with a direct read and retrying"));
        let mut cmd = Command::new("dd");
        cmd.args([&format!("if={path}"), "of=/dev/null", "bs=1M", "count=8", "iflag=direct", "status=none"]);
        let (drc, _) = run_capture(cmd, Duration::from_secs(60));
        thread::sleep(Duration::from_secs(3));
        let (rc2, js2, tried2, found2) = sc.read_smart(path, None, true, r.usb);
        tried.push(format!("spin-up read (dd 8 MiB): exit {drc}"));
        tried.extend(tried2);
        (rc, js, found) = (rc2, js2, found2);
    }
    let ok = usable(rc, &js) && !is_standby(&messages(&js));
    let nvme = js.pointer("/device/protocol").and_then(Value::as_str) == Some("NVMe");
    let identify = (ok && r.identify && nvme).then(|| sc.nvme_identify(path, found.as_deref().or(dt)));
    #[cfg(target_os = "linux")]
    let btrfs = ok.then(|| {
        Value::Array(if crate::linux::has_btrfs() {
            r.btrfs_mounts.iter().map(|m| crate::linux::btrfs_info(m, &r.knames)).collect()
        } else {
            Vec::new()
        })
    });
    #[cfg(not(target_os = "linux"))]
    let btrfs = None;
    ScanResult { path: r.path.clone(), rc, js, tried, found, woke, identify, btrfs, secs: started.elapsed().as_secs() }
}

fn messages(js: &Value) -> String {
    js.pointer("/smartctl/messages")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|m| m.get("string").and_then(Value::as_str)).collect::<Vec<_>>().join(" | "))
        .unwrap_or_default()
}

fn is_standby(msgs: &str) -> bool {
    let l = msgs.to_lowercase();
    l.contains("is in standby mode") || l.contains("is in sleep mode")
}

fn needs_type(msgs: &str) -> bool {
    let l = msgs.to_lowercase();
    l.contains("unknown usb bridge") || l.contains("specify device type") || l.contains("please specify")
}

/// Python truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// Did smartctl return real data (same rule as the Linux collector)?
fn usable(rc: i32, js: &Value) -> bool {
    if !truthy(js.get("device")) {
        return false;
    }
    const KEYS: [&str; 6] = ["model_name", "serial_number", "smart_status", "ata_smart_attributes",
        "nvme_smart_health_information_log", "scsi_grown_defect_list"];
    if KEYS.iter().any(|k| truthy(js.get(*k))) {
        return true;
    }
    !(rc >= 0 && rc & 2 != 0)
}

fn temp_from(js: &Value) -> Option<i64> {
    let t = js.pointer("/temperature/current").and_then(Value::as_i64)
        .or_else(|| js.pointer("/nvme_smart_health_information_log/temperature").and_then(Value::as_i64))?;
    (t > 0).then_some(t)
}

fn self_test_running(js: &Value) -> bool {
    let ata = js.pointer("/ata_smart_data/self_test/status/value").and_then(Value::as_i64).map(|v| v >> 4 == 15).unwrap_or(false);
    let nvme = js.pointer("/nvme_self_test_log/current_self_test_operation/value").and_then(Value::as_i64).map(|v| v != 0).unwrap_or(false);
    ata || nvme
}

fn short(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// "YYYY-MM-DD" (UTC) of a unix time
fn day_of(ts: u64) -> String {
    let z = (ts / 86400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Power-on hours and bytes written from raw smartctl JSON (same sources as normalize.js).
fn poh_written(js: &Value) -> (Option<u64>, Option<u64>) {
    let poh = js.pointer("/power_on_time/hours").and_then(Value::as_u64)
        .or_else(|| js.pointer("/nvme_smart_health_information_log/power_on_hours").and_then(Value::as_u64));
    let lbs = js.get("logical_block_size").and_then(Value::as_u64).unwrap_or(512);
    let devstat = |name: &str| -> Option<u64> {
        js.pointer("/ata_device_statistics/pages")?.as_array()?.iter()
            .flat_map(|p| p["table"].as_array().into_iter().flatten())
            .find(|r| r["name"] == name && r.pointer("/flags/valid") != Some(&Value::Bool(false)))?
            ["value"].as_u64()
    };
    let attr241 = || -> Option<u64> {
        js.pointer("/ata_smart_attributes/table")?.as_array()?.iter()
            .find(|a| a["id"] == 241)?.pointer("/raw/value")?.as_u64().filter(|v| *v > 0)
    };
    let gb = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()));
    let written = js.pointer("/nvme_smart_health_information_log/data_units_written").and_then(Value::as_u64).map(|u| u * 512_000)
        .or_else(|| devstat("Logical Sectors Written").map(|s| s * lbs))
        .or_else(|| attr241().map(|s| s * lbs))
        .or_else(|| js.pointer("/scsi_error_counter_log/write/gigabytes_processed").and_then(gb).map(|g| (g * 1e9) as u64));
    (poh, written)
}

// ------------------------------------------------------------------ history

struct History {
    temps: HashMap<String, VecDeque<(u64, i64)>>,
    /// last finished read test per disk key
    read_tests: serde_json::Map<String, Value>,
    /// per disk key: {"poh_daily": {day: hours}, "written_daily": {day: bytes}} (first value of each day)
    daily: serde_json::Map<String, Value>,
    dirty: bool,
}

impl History {
    fn load() -> Self {
        let mut h = History { temps: HashMap::new(), read_tests: serde_json::Map::new(), daily: serde_json::Map::new(), dirty: false };
        let Ok(Value::Object(top)) = fs::read_to_string(paths::history_file())
            .map_err(|_| ()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| ()))
        else {
            return h;
        };
        let series = |v: &Value| -> VecDeque<(u64, i64)> {
            v.as_array().map(|a| {
                a.iter().filter_map(|p| Some((p.get(0)?.as_u64()?, p.get(1)?.as_f64()?.round() as i64))).collect()
            }).unwrap_or_default()
        };
        if top.contains_key("temps") || top.contains_key("read_tests") || top.contains_key("daily") {
            for (k, v) in top.get("temps").and_then(Value::as_object).into_iter().flatten() {
                h.temps.insert(k.clone(), series(v));
            }
            if let Some(Value::Object(m)) = top.get("read_tests") {
                h.read_tests = m.clone();
            }
            if let Some(Value::Object(m)) = top.get("daily") {
                h.daily = m.clone();
            }
        } else {
            // history.json of the former Python collector: {key: {temps, poh_daily, written_daily}}
            for (k, v) in &top {
                if v.get("temps").is_some() {
                    h.temps.insert(k.clone(), series(&v["temps"]));
                    h.daily.insert(k.clone(), json!({
                        "poh_daily": v.get("poh_daily").cloned().unwrap_or(json!({})),
                        "written_daily": v.get("written_daily").cloned().unwrap_or(json!({})),
                    }));
                }
            }
            h.dirty = true;
        }
        h
    }

    /// Remember the first power-on hours / bytes written value of each day.
    fn note_daily(&mut self, key: &str, poh: Option<u64>, written: Option<u64>) {
        let today = day_of(now());
        let e = self.daily.entry(key.to_string()).or_insert_with(|| json!({"poh_daily": {}, "written_daily": {}}));
        for (field, val) in [("poh_daily", poh), ("written_daily", written)] {
            let Some(val) = val else { continue };
            if !e[field].is_object() {
                e[field] = json!({});
            }
            let m = e[field].as_object_mut().expect("object");
            if !m.contains_key(&today) {
                m.insert(today.clone(), json!(val));
                let mut days: Vec<String> = m.keys().cloned().collect();
                days.sort();
                for old in days.iter().take(days.len().saturating_sub(DAILY_KEEP_DAYS)) {
                    m.remove(old);
                }
                self.dirty = true;
            }
        }
    }

    /// Hours on and bytes written per day (last 14 days) and today.
    fn usage(&self, key: &str, poh: Option<u64>, written: Option<u64>) -> Value {
        let e = self.daily.get(key);
        let series = |field: &str, current: Option<u64>| -> std::collections::BTreeMap<String, u64> {
            let mut out = std::collections::BTreeMap::new();
            let Some(m) = e.and_then(|e| e[field].as_object()) else { return out };
            let mut days: Vec<(&String, u64)> = m.iter().filter_map(|(k, v)| Some((k, v.as_u64()?))).collect();
            days.sort();
            for (i, (day, v)) in days.iter().enumerate() {
                let next = days.get(i + 1).map(|x| x.1).or(current);
                if let Some(n) = next {
                    out.insert((*day).clone(), n.saturating_sub(*v));
                }
            }
            out
        };
        let hours = series("poh_daily", poh);
        let wr = series("written_daily", written);
        let today = day_of(now());
        let mut all: Vec<&String> = hours.keys().chain(wr.keys()).collect();
        all.sort();
        all.dedup();
        let days: Vec<Value> = all.iter().rev().take(14).rev()
            .map(|d| json!({"date": d, "hours": hours.get(*d), "written": wr.get(*d)}))
            .collect();
        json!({"today_hours": hours.get(&today), "today_written": wr.get(&today), "days": days})
    }

    fn add(&mut self, key: &str, ts: u64, v: i64) {
        let q = self.temps.entry(key.to_string()).or_default();
        q.push_back((ts, v));
        while q.front().map(|p| p.0 + HISTORY_KEEP < ts).unwrap_or(false) {
            q.pop_front();
        }
        self.dirty = true;
    }

    fn series(&self, key: &str) -> Vec<Value> {
        self.temps.get(key).map(|q| q.iter().map(|(t, v)| json!([t, v])).collect()).unwrap_or_default()
    }

    fn minmax(&self, key: &str) -> (Option<i64>, Option<i64>) {
        let cutoff = now().saturating_sub(HISTORY_KEEP);
        let vals = self.temps.get(key).map(|q| q.iter().filter(|p| p.0 >= cutoff).map(|p| p.1).collect::<Vec<_>>()).unwrap_or_default();
        (vals.iter().min().copied(), vals.iter().max().copied())
    }

    fn save(&mut self) {
        if !self.dirty {
            return;
        }
        let cutoff = now().saturating_sub(HISTORY_KEEP);
        self.temps.retain(|_, q| q.back().map(|p| p.0 >= cutoff).unwrap_or(false));
        let map: serde_json::Map<String, Value> = self.temps.iter()
            .map(|(k, q)| (k.clone(), Value::Array(q.iter().map(|(t, v)| json!([t, v])).collect())))
            .collect();
        let doc = json!({"temps": map, "read_tests": self.read_tests, "daily": self.daily}).to_string();
        if atomic_write(&paths::history_file(), &doc).is_ok() {
            self.dirty = false;
        }
    }
}

fn atomic_write(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

// ------------------------------------------------------------------ disks

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Disk {
    path: String,
    dev_type: Option<String>,
    key: String,
    kind: &'static str,
    media: &'static str,
    raw: Option<Value>,
    smart_updated: Option<u64>,
    smart_checked: Option<u64>,
    next_scan: u64,
    error: Option<String>,
    error_detail: Option<String>,
    standby: bool,
    temp: Option<i64>,
    temp_source: Option<&'static str>,
    temp_updated: Option<u64>,
    last_temp_read: u64,
    last_request: Option<Value>,
    last_test_request: u64,
    wake_failed: u64,
    /// NVMe identify data (static, read once)
    identify: Option<Value>,
    identify_tried: bool,
    // Linux (lsblk / sysfs): block info, file systems, partition layout, btrfs
    block: Value,
    filesystems: Value,
    partitions: Value,
    btrfs: Value,
    knames: HashSet<String>,
    btrfs_mounts: Vec<String>,
    hwmon: Option<PathBuf>,
    last_hwmon: u64,
    /// a SMART read is running on the worker thread
    scanning: bool,
}

impl Disk {
    fn new(path: String, dev_type: Option<String>) -> Self {
        let kind = if path.contains("nvme") || dev_type.as_deref() == Some("nvme") { "nvme" } else { "ssd" };
        Disk {
            key: path.clone(), path, dev_type, kind, media: "ssd", raw: None,
            smart_updated: None, smart_checked: None, next_scan: 0, error: None, error_detail: None,
            standby: false, temp: None, temp_source: None, temp_updated: None, last_temp_read: 0,
            last_request: None, last_test_request: 0, wake_failed: 0,
            identify: None, identify_tried: false,
            block: Value::Null, filesystems: json!([]), partitions: Value::Null, btrfs: json!([]),
            knames: HashSet::new(), btrfs_mounts: Vec::new(), hwmon: None, last_hwmon: 0,
            scanning: false,
        }
    }

    /// Same rules as the UI (normalize.js classify); used for the tray thresholds.
    fn classify(&mut self) {
        let Some(js) = self.raw.as_ref() else { return };
        let proto = js.pointer("/device/protocol").and_then(Value::as_str).unwrap_or("");
        let model = format!("{} {} {}",
            js.get("model_name").and_then(Value::as_str).unwrap_or(""),
            js.get("scsi_vendor").and_then(Value::as_str).unwrap_or(""),
            js.get("scsi_product").and_then(Value::as_str).unwrap_or("")).to_lowercase();
        let usb = self.dev_type.as_deref().map(|t| t.starts_with("usb") || t.starts_with("snt")).unwrap_or(false)
            || self.block["tran"] == "usb";
        let media = match js.get("rotation_rate").and_then(Value::as_i64) {
            Some(r) if r > 0 => "hdd",
            Some(_) => "ssd",
            None if self.block["rota"] == true => "hdd",
            None => "ssd",
        };
        let (kind, media) = if proto == "NVMe" || self.path.contains("nvme") {
            ("nvme", "ssd")
        } else if VIRTUAL_HINTS.iter().any(|h| model.contains(h)) {
            ("virtual", media)
        } else if proto == "SCSI" && !usb {
            ("sas", media)
        } else {
            (media, media)
        };
        self.kind = kind;
        self.media = media;
        if let Some(serial) = js.get("serial_number").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            self.key = serial.to_string();
        }
    }

    /// Linux: refresh lsblk details (partitions change, USB disks come and go).
    #[cfg(target_os = "linux")]
    fn update_block(&mut self, n: &Value) {
        self.block = crate::linux::block_info(n);
        let (fs_list, knames, bmounts) = crate::linux::filesystems(n);
        self.filesystems = fs_list;
        self.knames = knames;
        self.btrfs_mounts = bmounts;
        self.partitions = crate::linux::partition_layout(n);
        if self.hwmon.is_none() {
            self.hwmon = crate::linux::find_hwmon(self.path.trim_start_matches("/dev/"));
        }
        if self.raw.is_none() {
            if let Some(serial) = self.block["serial"].as_str() {
                self.key = serial.to_string();
            }
            if self.block["rota"] == true {
                self.media = "hdd";
                self.kind = "hdd";
            }
            if self.path.starts_with("/dev/nvme") {
                self.kind = "nvme";
            }
        }
    }
}

// ------------------------------------------------------------------ Windows disk map

/// Windows names disks "Disk 0, 1, ..." with drive letters; smartctl uses /dev/sdX
/// (= PhysicalDriveN) or /dev/nvmeN. Ask Windows for the disks with their volumes.
#[cfg(windows)]
fn windows_disks() -> Vec<Value> {
    // Disk errors from the System log of the last 30 days, per disk number and event id:
    // 7 = bad block, 11 = controller error, 51 = error during paging, 153 = retried I/O.
    // The device path (\Device\HarddiskN\DRn) is an event property, so this works on any UI language.
    const PS: &str = "$ErrorActionPreference='SilentlyContinue'; $ev=@{}; \
        Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='disk';Id=7,11,51,153;StartTime=(Get-Date).AddDays(-30)} -MaxEvents 5000 \
        | ForEach-Object { $t=($_.Properties | ForEach-Object { [string]$_.Value }) -join ' '; \
          if ($t -match 'Harddisk(\\d+)') { $k=\"$($Matches[1])-$($_.Id)\"; $ev[$k] = 1 + [int]$ev[$k] } }; \
        @(Get-Disk | ForEach-Object { $n=$_.Number; \
        [pscustomobject]@{number=$n; serial=([string]$_.SerialNumber).Trim(); model=$_.FriendlyName; size=$_.Size; \
        bus_type=[string]$_.BusType; health=[string]$_.HealthStatus; status=($_.OperationalStatus -join ', '); \
        events=[pscustomobject]@{bad_blocks=[int]$ev[\"$n-7\"]; controller=[int]$ev[\"$n-11\"]; paging=[int]$ev[\"$n-51\"]; retried=[int]$ev[\"$n-153\"]}; \
        volumes=@(Get-Partition -DiskNumber $n | Where-Object DriveLetter | ForEach-Object { $v = $_ | Get-Volume; \
        [pscustomobject]@{letter=\"$($_.DriveLetter):\"; label=$v.FileSystemLabel; fs=$v.FileSystem; size=$v.Size; free=$v.SizeRemaining; health=[string]$v.HealthStatus} }) } }) \
        | ConvertTo-Json -Depth 5 -Compress";
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", PS]);
    let (_, out) = run_capture(cmd, Duration::from_secs(60));
    match serde_json::from_str::<Value>(out.trim()) {
        Ok(Value::Array(a)) => a,
        Ok(v @ Value::Object(_)) => vec![v],
        _ => Vec::new(),
    }
}

#[cfg(not(windows))]
fn windows_disks() -> Vec<Value> {
    Vec::new()
}

/// Static hardware details per Windows disk number: SCSI location, media type and the
/// parent controller (name, PCI ids, PCIe link speed / width). Takes a few seconds,
/// so it only runs again when the set of disks changes.
#[cfg(windows)]
fn windows_hw() -> Vec<Value> {
    const PS: &str = "$ErrorActionPreference='SilentlyContinue'; \
        @(Get-CimInstance Win32_DiskDrive | ForEach-Object { $d=$_; \
        $par=(Get-PnpDeviceProperty -InstanceId $d.PNPDeviceID -KeyName DEVPKEY_Device_Parent).Data; $p=@{}; \
        if ($par) { foreach ($k in 'DEVPKEY_Device_FriendlyName','DEVPKEY_Device_DeviceDesc','DEVPKEY_Device_HardwareIds','DEVPKEY_PciDevice_CurrentLinkSpeed','DEVPKEY_PciDevice_CurrentLinkWidth','DEVPKEY_PciDevice_MaxLinkSpeed','DEVPKEY_PciDevice_MaxLinkWidth','DEVPKEY_Device_LocationInfo') { \
        $p[$k]=(Get-PnpDeviceProperty -InstanceId $par -KeyName $k).Data } }; \
        [pscustomobject]@{number=[int]$d.Index; scsi_bus=$d.SCSIBus; scsi_target=$d.SCSITargetId; scsi_lun=$d.SCSILogicalUnit; \
        media=[string]$d.MediaType; interface=[string]$d.InterfaceType; \
        controller=$(if ($p.DEVPKEY_Device_FriendlyName) { $p.DEVPKEY_Device_FriendlyName } else { $p.DEVPKEY_Device_DeviceDesc }); \
        hwid=[string](@($p.DEVPKEY_Device_HardwareIds)[0]); location=$p.DEVPKEY_Device_LocationInfo; \
        link_speed=$p.DEVPKEY_PciDevice_CurrentLinkSpeed; link_width=$p.DEVPKEY_PciDevice_CurrentLinkWidth; \
        max_link_speed=$p.DEVPKEY_PciDevice_MaxLinkSpeed; max_link_width=$p.DEVPKEY_PciDevice_MaxLinkWidth } }) \
        | ConvertTo-Json -Depth 3 -Compress";
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", PS]);
    let (_, out) = run_capture(cmd, Duration::from_secs(60));
    match serde_json::from_str::<Value>(out.trim()) {
        Ok(Value::Array(a)) => a,
        Ok(v @ Value::Object(_)) => vec![v],
        _ => Vec::new(),
    }
}

#[cfg(not(windows))]
fn windows_hw() -> Vec<Value> {
    Vec::new()
}

fn norm_serial(s: &str) -> String {
    s.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_uppercase()
}

/// "/dev/sdb" -> 1, "/dev/sdaa" -> 26
fn sd_index(path: &str) -> Option<i64> {
    let letters = path.strip_prefix("/dev/sd")?;
    if letters.is_empty() || !letters.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    Some(letters.bytes().fold(0i64, |acc, b| acc * 26 + i64::from(b - b'a' + 1)) - 1)
}

pub struct Collector {
    cfg: Config,
    smartctl: Smartctl,
    win_disks: Vec<Value>,
    win_hw: Vec<Value>,
    /// running Windows disk query: (disks, hardware details when re-read)
    win_job: Option<thread::JoinHandle<(Vec<Value>, Option<Vec<Value>>)>>,
    /// running / just finished read tests: disk key -> (live state, stop flag)
    read_tests: HashMap<String, (Arc<Mutex<Value>>, Arc<AtomicBool>)>,
    disks: HashMap<String, Disk>,
    history: History,
    wake: HashSet<String>,
    last_refresh: u64,
    started: u64,
    dirty: bool,
}

impl Collector {
    fn new(exe: PathBuf) -> Self {
        #[allow(unused_mut)]
        let mut cfg = Config::default();
        #[cfg(target_os = "linux")]
        crate::linux::load_config(&mut cfg);
        Collector {
            cfg,
            smartctl: Smartctl { exe },
            win_disks: Vec::new(),
            win_hw: Vec::new(),
            win_job: None,
            read_tests: HashMap::new(),
            disks: HashMap::new(),
            history: History::load(),
            wake: HashSet::new(),
            last_refresh: 0,
            started: now(),
            dirty: true,
        }
    }

    fn discover(&mut self) {
        #[cfg(target_os = "linux")]
        {
            let nodes = crate::linux::lsblk_disks(&self.cfg.ignore);
            if nodes.is_empty() && !self.disks.is_empty() {
                return; // a failed lsblk must not drop every disk
            }
            let path_of = |n: &Value| n["path"].as_str().map(str::to_string)
                .unwrap_or_else(|| format!("/dev/{}", n["name"].as_str().unwrap_or("")));
            let paths: HashSet<String> = nodes.iter().map(path_of).collect();
            let before = self.disks.len();
            self.disks.retain(|p, _| paths.contains(p));
            if self.disks.len() != before {
                self.dirty = true;
            }
            for n in &nodes {
                let path = path_of(n);
                let d = self.disks.entry(path.clone()).or_insert_with(|| {
                    log(&format!("disk found: {path}"));
                    Disk::new(path.clone(), None)
                });
                d.update_block(n);
            }
            self.dirty = true;
            return;
        }
        #[allow(unreachable_code)]
        self.poll_windows(false);
        let found = self.smartctl.scan();
        if found.is_empty() && !self.disks.is_empty() {
            return; // a failed scan must not drop every disk
        }
        let names: HashSet<&String> = found.iter().map(|f| &f.0).collect();
        let before = self.disks.len();
        self.disks.retain(|p, _| names.contains(p));
        if self.disks.len() != before {
            self.dirty = true;
        }
        for (path, t) in found {
            if !self.disks.contains_key(&path) {
                log(&format!("disk found: {path} ({})", t.as_deref().unwrap_or("auto")));
                self.disks.insert(path.clone(), Disk::new(path, t));
                self.dirty = true;
            }
        }
    }

    /// Windows disk numbers / drive letters / event log come from PowerShell, which can
    /// take a long time on some systems: it runs on its own thread and the result is
    /// picked up later. `wait`: block until it is done (`--once`).
    fn poll_windows(&mut self, wait: bool) {
        if !cfg!(windows) {
            return;
        }
        if self.win_job.as_ref().is_some_and(|h| wait || h.is_finished()) {
            if let Some(Ok((win, hw))) = self.win_job.take().map(|h| h.join()) {
                if !win.is_empty() {
                    self.win_disks = win;
                    self.dirty = true;
                }
                if let Some(hw) = hw.filter(|h| !h.is_empty()) {
                    self.win_hw = hw;
                }
            }
            return;
        }
        if self.win_job.is_some() {
            return;
        }
        let known: std::collections::BTreeSet<i64> = self.win_hw.iter().filter_map(|x| x["number"].as_i64()).collect();
        self.win_job = Some(thread::spawn(move || {
            let started = Instant::now();
            let win = windows_disks();
            let numbers: std::collections::BTreeSet<i64> = win.iter().filter_map(|x| x["number"].as_i64()).collect();
            let hw = (!win.is_empty() && (known.is_empty() || numbers != known)).then(windows_hw);
            if started.elapsed().as_secs() >= 20 {
                log(&format!("Windows disk query took {} s", started.elapsed().as_secs()));
            }
            (win, hw)
        }));
        if wait {
            self.poll_windows(true);
        }
    }

    /// What a SMART read of `path` needs; None when the disk is gone.
    fn scan_req(&self, path: &str, wake: bool) -> Option<ScanReq> {
        let d = self.disks.get(path)?;
        Some(ScanReq {
            path: path.to_string(),
            dev_type: d.dev_type.clone(),
            wake,
            usb: d.block["tran"] == "usb",
            hdd: d.media == "hdd",
            never_read: d.smart_updated.is_none(),
            wake_failed: d.wake_failed,
            wake_first: self.cfg.wake_for_first_scan,
            identify: !d.identify_tried,
            btrfs_mounts: d.btrfs_mounts.clone(),
            knames: d.knames.clone(),
        })
    }

    /// Full SMART read in the calling thread (`--once`).
    fn scan_disk(&mut self, path: &str, wake: bool) {
        if let Some(req) = self.scan_req(path, wake) {
            let r = scan_io(&self.smartctl, req);
            self.apply_scan(r);
        }
    }

    /// Store the result of a SMART read (worker thread -> main loop).
    fn apply_scan(&mut self, r: ScanResult) {
        let ScanResult { path, rc, js, tried, found, woke, identify, btrfs, secs } = r;
        let path = path.as_str();
        if secs >= 20 {
            log(&format!("{path}: SMART read took {secs} s"));
        }
        let t = now();
        let msgs = messages(&js);
        let Some(d) = self.disks.get_mut(path) else { return };
        self.dirty = true;
        d.scanning = false;
        d.next_scan = t + self.cfg.smart_interval;
        d.smart_checked = Some(t);
        if !usable(rc, &js) && !is_standby(&msgs) {
            log(&format!("cannot read SMART data from {path}:\n  {}", tried.join("\n  ")));
            if woke {
                d.wake_failed = t;
            }
            d.error = Some("read_failed".into());
            d.error_detail = Some(tried.join("\n"));
            return;
        }
        if let Some(found) = found {
            d.dev_type = Some(found);
        }
        if is_standby(&msgs) {
            d.standby = true;
            d.temp = None;
            return;
        }
        d.error = None;
        d.error_detail = None;
        d.standby = false;
        d.smart_updated = Some(t);
        // a live kernel sensor (Linux hwmon) wins over the SMART snapshot
        if let Some(temp) = temp_from(&js).filter(|_| d.temp_source != Some("hwmon") || d.temp.is_none()) {
            d.temp = Some(temp);
            d.temp_source = Some("smart");
            d.temp_updated = Some(t);
        }
        if self_test_running(&js) {
            d.next_scan = t + SMART_INTERVAL_TESTING;
        }
        let (poh, written) = poh_written(&js);
        d.raw = Some(js);
        d.classify();
        if let Some(b) = btrfs {
            d.btrfs = b;
        }
        if let Some(id) = identify {
            d.identify_tried = true;
            if id.is_none() && d.kind == "nvme" {
                log(&format!("{path}: NVMe identify data not available"));
            }
            d.identify = id.or(d.identify.take());
        }
        let key = d.key.clone();
        self.history.note_daily(&key, poh, written);
    }

    fn temp_tick(&mut self, force: bool) {
        let t = now();
        // Linux: kernel hwmon sensors are cheap and never wake a disk
        #[cfg(target_os = "linux")]
        for d in self.disks.values_mut() {
            let Some(hw) = d.hwmon.clone() else { continue };
            if (d.media == "hdd" && !self.cfg.hdd_use_hwmon) || (!force && t.saturating_sub(d.last_hwmon) < self.cfg.temp_interval) {
                continue;
            }
            d.last_hwmon = t;
            if let Some(v) = crate::linux::read_hwmon(&hw) {
                if d.temp != Some(v) || d.standby {
                    self.dirty = true;
                }
                d.temp = Some(v);
                d.temp_source = Some("hwmon");
                d.temp_updated = Some(t);
                d.standby = false;
            }
        }
        let (hdd_interval, temp_interval) = (self.cfg.hdd_temp_interval, SMART_TEMP_INTERVAL);
        let due: Vec<(String, Option<String>)> = self.disks.values()
            .filter(|d| !(d.temp_source == Some("hwmon") && d.temp_updated.is_some_and(|u| t.saturating_sub(u) < 60)))
            .filter(|d| {
                let interval = if d.media == "hdd" { hdd_interval } else { temp_interval };
                force || t.saturating_sub(d.last_temp_read) >= interval
            })
            .map(|d| (d.path.clone(), d.dev_type.clone()))
            .collect();
        for (path, dev_type) in due {
            let (_, js) = self.smartctl.run(&["-A", "-n", "standby"], dev_type.as_deref(), &path, 30);
            let standby = is_standby(&messages(&js));
            let temp = temp_from(&js);
            let Some(d) = self.disks.get_mut(&path) else { continue };
            d.last_temp_read = now();
            if standby {
                if !d.standby || d.temp.is_some() {
                    self.dirty = true;
                }
                d.standby = true;
                d.temp = None;
            } else if let Some(v) = temp {
                if d.temp != Some(v) || d.standby {
                    self.dirty = true;
                }
                d.temp = Some(v);
                d.temp_source = Some("smart");
                d.temp_updated = Some(d.last_temp_read);
                d.standby = false;
            }
        }
    }

    fn sample_history(&mut self) {
        let t = now();
        for d in self.disks.values() {
            if let (Some(v), Some(up)) = (d.temp, d.temp_updated) {
                if t.saturating_sub(up) < 180 {
                    self.history.add(&d.key, t, v);
                }
            }
        }
    }

    // ---------------------------------------------------------- requests

    fn process_requests(&mut self) {
        let Ok(rd) = fs::read_dir(paths::requests_dir()) else { return };
        let files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).take(32).collect();
        for p in files {
            let req = fs::symlink_metadata(&p).ok()
                .filter(|m| m.is_file() && m.len() <= 4096)
                .and_then(|_| fs::read_to_string(&p).ok())
                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
            let _ = fs::remove_file(&p);
            if let Some(req) = req {
                self.handle_request(&req);
            }
        }
    }

    fn handle_request(&mut self, req: &Value) {
        let action = req.get("action").and_then(Value::as_str).unwrap_or("");
        let t = now();
        match action {
            "refresh" => {
                if t.saturating_sub(self.last_refresh) < 15 {
                    return;
                }
                self.last_refresh = t;
                for d in self.disks.values_mut() {
                    d.next_scan = 0;
                    self.wake.insert(d.path.clone());
                }
                self.temp_tick(true);
            }
            "readtest" => self.start_read_test(req.get("disk").and_then(Value::as_str).unwrap_or("")),
            "readtest_abort" => {
                if let Some((_, stop)) = self.read_tests.get(req.get("disk").and_then(Value::as_str).unwrap_or("")) {
                    stop.store(true, Ordering::SeqCst);
                }
            }
            "selftest" | "abort" => {
                let key = req.get("disk").and_then(Value::as_str).unwrap_or("");
                let ttype = req.get("type").and_then(Value::as_str).unwrap_or("");
                if action == "selftest" && ttype != "short" && ttype != "long" {
                    return;
                }
                let Some(d) = self.disks.values().find(|d| d.key == key) else { return };
                if t.saturating_sub(d.last_test_request) < 20 {
                    return;
                }
                let (path, dev_type) = (d.path.clone(), d.dev_type.clone());
                let args: Vec<&str> = if action == "abort" { vec!["-X"] } else { vec!["-t", ttype] };
                let (rc, js) = self.smartctl.run(&args, dev_type.as_deref(), &path, 60);
                let ok = rc >= 0 && rc & 0x6 == 0;
                let msg = short(&messages(&js), 300);
                log(&format!("self-test {action} {ttype} on {path} -> rc={rc}"));
                if let Some(d) = self.disks.get_mut(&path) {
                    d.last_test_request = t;
                    d.last_request = Some(json!({
                        "action": action, "type": if ttype.is_empty() { Value::Null } else { json!(ttype) },
                        "ok": ok, "message": if msg.is_empty() { Value::Null } else { json!(msg) }, "at": t,
                    }));
                    d.next_scan = t + 5;
                }
                self.dirty = true;
            }
            _ => {}
        }
    }

    // ---------------------------------------------------------- read test

    /// Surface read test: reads the whole disk (read only) and counts unreadable
    /// regions. The health check for disks without SMART (USB flash drives).
    fn start_read_test(&mut self, key: &str) {
        if let Some((st, _)) = self.read_tests.get(key) {
            if st.lock().unwrap()["running"] == true {
                return;
            }
        }
        let Some(d) = self.disks.values().find(|d| d.key == key) else { return };
        let Some((dev, total)) = self.read_test_target(d) else {
            log(&format!("read test: no readable device for {key}"));
            return;
        };
        let st = Arc::new(Mutex::new(json!({
            "running": true, "started": now(), "total": total, "done": 0, "progress": 0.0,
            "errors": 0, "bad_bytes": 0, "avg_mbps": null, "min_mbps": null,
        })));
        let stop = Arc::new(AtomicBool::new(false));
        log(&format!("read test started on {dev} ({key})"));
        {
            let (st, stop) = (st.clone(), stop.clone());
            thread::spawn(move || read_test_worker(&dev, total, &st, &stop));
        }
        self.read_tests.insert(key.to_string(), (st, stop));
        self.dirty = true;
    }

    /// Progress goes out with every state write; finished results go to the history.
    fn sync_read_tests(&mut self) {
        for (key, (st, _)) in &self.read_tests {
            let mut v = st.lock().unwrap();
            if v["running"] == true {
                self.dirty = true;
            } else if v["saved"] != true {
                v["saved"] = json!(true);
                let mut result = v.clone();
                if let Some(o) = result.as_object_mut() {
                    o.remove("saved");
                }
                self.history.read_tests.insert(key.clone(), result);
                self.history.dirty = true;
                self.dirty = true;
            }
        }
    }

    /// Device to read and its size: \\.\PhysicalDriveN on Windows, /dev/sdX on Linux.
    fn read_test_target(&self, d: &Disk) -> Option<(String, u64)> {
        if cfg!(windows) {
            let info = self.windows_info(d);
            return Some((format!(r"\\.\PhysicalDrive{}", info["number"].as_i64()?), info["size"].as_u64()?));
        }
        if cfg!(target_os = "linux") {
            let size = d.block["size"].as_u64()
                .or_else(|| d.raw.as_ref()?.pointer("/user_capacity/bytes")?.as_u64())?;
            return Some((d.path.clone(), size));
        }
        None
    }

    fn read_test_state(&self, key: &str) -> Value {
        if let Some((st, _)) = self.read_tests.get(key) {
            let mut v = st.lock().unwrap().clone();
            if let Some(o) = v.as_object_mut() {
                o.remove("saved");
            }
            return v;
        }
        self.history.read_tests.get(key).cloned().unwrap_or(Value::Null)
    }

    // ---------------------------------------------------------- state

    /// The Windows disk (number, drive letters) behind a smartctl device: serial first
    /// (SATA), then /dev/sdX = PhysicalDriveN, then capacity (NVMe serials differ).
    fn windows_info(&self, d: &Disk) -> Value {
        let raw = d.raw.as_ref();
        let serial = raw.and_then(|j| j.get("serial_number")).and_then(Value::as_str).map(norm_serial).unwrap_or_default();
        let cap = raw.and_then(|j| j.pointer("/user_capacity/bytes").or_else(|| j.get("nvme_total_capacity"))).and_then(Value::as_u64);
        let w = &self.win_disks;
        let found = (!serial.is_empty())
            .then(|| w.iter().find(|x| x["serial"].as_str().map(norm_serial).as_deref() == Some(serial.as_str())))
            .flatten()
            .or_else(|| sd_index(&d.path).and_then(|i| w.iter().find(|x| x["number"].as_i64() == Some(i))))
            .or_else(|| cap.and_then(|c| {
                let same: Vec<&Value> = w.iter().filter(|x| x["size"].as_u64() == Some(c)).collect();
                (same.len() == 1).then(|| same[0])
            }));
        match found {
            Some(x) => json!({
                "number": x["number"], "model": x["model"], "size": x["size"], "bus_type": x["bus_type"],
                "health": x["health"], "status": x["status"], "events": x["events"], "volumes": x["volumes"],
                "hw": self.win_hw.iter().find(|h| h["number"] == x["number"]).cloned().unwrap_or(Value::Null),
            }),
            None => Value::Null,
        }
    }

    pub fn build_state(&self) -> Value {
        let mut list: Vec<&Disk> = self.disks.values().collect();
        list.sort_by_key(|d| (d.kind != "nvme", d.path.clone()));
        let mut seen = HashSet::new();
        let disks: Vec<Value> = list.into_iter()
            .filter(|d| seen.insert(d.key.clone())) // the same disk can be listed twice (e.g. /dev/sda and /dev/csmi0,0)
            .map(|d| {
                let (min, max) = self.history.minmax(&d.key);
                let (poh, written) = d.raw.as_ref().map(poh_written).unwrap_or((None, None));
                let mut disk = json!({
                    "name": d.path.trim_start_matches("/dev/"),
                    "path": d.path,
                    "dev_type": d.dev_type,
                    "key": d.key,
                    "kind": d.kind,
                    "media": d.media,
                    "smart_updated": d.smart_updated,
                    "smart_checked": d.smart_checked,
                    "smart": {"error": d.error, "error_detail": d.error_detail, "standby": d.standby, "scanning": d.scanning},
                    "temperature": {
                        "current": d.temp, "source": d.temp_source, "updated": d.temp_updated, "standby": d.standby,
                        "history": self.history.series(&d.key), "min_24h": min, "max_24h": max,
                    },
                    "last_request": d.last_request,
                    "windows": self.windows_info(d),
                    "read_test": self.read_test_state(&d.key),
                    "raw": d.raw,
                    "identify": d.identify,
                    "read_test_supported": self.read_test_target(d).is_some(),
                    "usage": self.history.usage(&d.key, poh, written),
                });
                if cfg!(target_os = "linux") {
                    disk["block"] = d.block.clone();
                    disk["filesystems"] = d.filesystems.clone();
                    disk["partitions"] = d.partitions.clone();
                    disk["btrfs"] = d.btrfs.clone();
                }
                disk
            })
            .collect();
        json!({
            "version": 1,
            "format": "raw",
            "generated": now(),
            "daemon": {
                "version": VERSION, "os": std::env::consts::OS, "pid": std::process::id(), "started": self.started,
                "smart_interval": self.cfg.smart_interval, "temp_interval": self.cfg.temp_interval,
                "smartctl": true, "smartctl_path": self.smartctl.exe,
                "request_group": if cfg!(target_os = "linux") { json!(self.cfg.request_group) } else { Value::Null },
                "btrfs": linux_flag(LinuxFlag::Btrfs), "drivetemp": linux_flag(LinuxFlag::Drivetemp),
            },
            "disks": disks,
        })
    }

    fn write_state(&mut self) {
        match atomic_write(&paths::state_file(), &self.build_state().to_string()) {
            Ok(()) => self.dirty = false,
            Err(e) => log(&format!("cannot write state: {e}")),
        }
    }
}

/// Reads the whole device (\\.\PhysicalDriveN / /dev/sdX) in 4 MiB blocks, bypassing
/// the cache; a failing block is retried in 64 KiB pieces so the unreadable size is
/// known. Never writes.
fn read_test_worker(dev: &str, total: u64, st: &Mutex<Value>, stop: &AtomicBool) {
    let started = Instant::now();
    let finish = |extra: Value| {
        let mut v = st.lock().unwrap();
        v["running"] = json!(false);
        v["finished"] = json!(now());
        if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
            o.extend(e);
        }
    };
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (dev, total, stop, started);
        finish(json!({"error": "not supported on this system"}));
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        use std::alloc::{alloc, dealloc, Layout};
        use std::io::{Seek, SeekFrom};
        const CHUNK: usize = 4 << 20;
        const SUB: usize = 64 << 10;
        #[cfg(windows)]
        let opened = fs::File::open(dev);
        #[cfg(target_os = "linux")]
        let opened = {
            use std::os::unix::fs::OpenOptionsExt;
            // O_DIRECT: read the disk itself, not the page cache
            const O_DIRECT: i32 = if cfg!(any(target_arch = "aarch64", target_arch = "arm")) { 0o200000 } else { 0o40000 };
            fs::OpenOptions::new().read(true).custom_flags(O_DIRECT).open(dev)
        };
        let mut f = match opened {
            Ok(f) => f,
            Err(e) => return finish(json!({"error": e.to_string()})),
        };
        // raw disk reads need sector aligned buffers
        let layout = Layout::from_size_align(CHUNK, 4096).expect("layout");
        // SAFETY: non-zero size; freed with the same layout below
        let ptr = unsafe { alloc(layout) };
        if ptr.is_null() {
            return finish(json!({"error": "out of memory"}));
        }
        // SAFETY: ptr points to CHUNK bytes owned by this function
        let buf = unsafe { std::slice::from_raw_parts_mut(ptr, CHUNK) };
        let total = total - total % 4096;
        let (mut pos, mut errors, mut bad) = (0u64, 0u64, 0u64);
        let mut min_mbps: Option<f64> = None;
        let mut read_at = |f: &mut fs::File, at: u64, len: usize| -> bool {
            f.seek(SeekFrom::Start(at)).is_ok() && std::io::Read::read_exact(f, &mut buf[..len]).is_ok()
        };
        while pos < total && !stop.load(Ordering::SeqCst) {
            let n = (total - pos).min(CHUNK as u64) as usize;
            let t0 = Instant::now();
            if read_at(&mut f, pos, n) {
                let secs = t0.elapsed().as_secs_f64();
                if n == CHUNK && secs > 0.0 {
                    let mbps = n as f64 / 1e6 / secs;
                    min_mbps = Some(min_mbps.map_or(mbps, |m| m.min(mbps)));
                }
            } else {
                let mut off = 0;
                while off < n && !stop.load(Ordering::SeqCst) {
                    let m = SUB.min(n - off);
                    if !read_at(&mut f, pos + off as u64, m) {
                        errors += 1;
                        bad += m as u64;
                    }
                    off += m;
                }
            }
            pos += n as u64;
            let secs = started.elapsed().as_secs_f64().max(0.001);
            let mut v = st.lock().unwrap();
            v["done"] = json!(pos);
            v["progress"] = json!((pos as f64 / total as f64 * 1000.0).round() / 10.0);
            v["errors"] = json!(errors);
            v["bad_bytes"] = json!(bad);
            v["avg_mbps"] = json!((pos as f64 / 1e6 / secs * 10.0).round() / 10.0);
            v["min_mbps"] = json!(min_mbps.map(|m| (m * 10.0).round() / 10.0));
        }
        // SAFETY: allocated above with the same layout; buf is not used after this
        unsafe { dealloc(ptr, layout) };
        let aborted = stop.load(Ordering::SeqCst);
        log(&format!("read test {dev}: {errors} errors, aborted={aborted}"));
        finish(json!({"aborted": aborted, "seconds": started.elapsed().as_secs()}));
    }
}

enum LinuxFlag {
    Btrfs,
    Drivetemp,
}

fn linux_flag(f: LinuxFlag) -> Value {
    #[cfg(target_os = "linux")]
    {
        json!(match f {
            LinuxFlag::Btrfs => crate::linux::has_btrfs(),
            LinuxFlag::Drivetemp => crate::linux::drivetemp_loaded(),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = f;
        Value::Null
    }
}

fn write_no_smartctl_state() {
    let st = json!({
        "version": 1, "format": "raw", "generated": now(),
        "daemon": {"version": VERSION, "os": std::env::consts::OS, "pid": std::process::id(), "smartctl": false},
        "disks": [],
    });
    let _ = atomic_write(&paths::state_file(), &st.to_string());
}

/// Collector main loop; returns when `stop` is set.
pub fn run(stop: Arc<AtomicBool>) {
    paths::ensure_dirs();
    log(&format!("Disk Guardian collector {VERSION} starting"));
    let exe = loop {
        if let Some(exe) = find_smartctl() {
            break exe;
        }
        log("smartctl not found");
        write_no_smartctl_state();
        for _ in 0..60 {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            thread::sleep(Duration::from_secs(1));
        }
    };
    log(&format!("using {}", exe.display()));
    let mut c = Collector::new(exe);
    #[cfg(target_os = "linux")]
    crate::linux::secure_requests_dir(&paths::requests_dir(), &c.cfg.request_group);
    c.discover();
    c.temp_tick(true);
    c.write_state();
    let (mut last_disc, mut last_hist, mut last_save, mut last_write) = (now(), 0u64, now(), now());
    let mut job: Option<thread::JoinHandle<ScanResult>> = None;
    while !stop.load(Ordering::SeqCst) {
        let tick = Instant::now();
        c.process_requests();
        let t = now();
        if t.saturating_sub(last_disc) >= DISCOVER_INTERVAL {
            last_disc = t;
            c.discover();
        }
        c.poll_windows(false);
        // one SMART read at a time, on a worker thread: a slow or hanging disk never
        // blocks temperatures, requests or the state file
        if job.as_ref().is_some_and(|h| h.is_finished()) {
            if let Some(Ok(r)) = job.take().map(|h| h.join()) {
                c.apply_scan(r);
            }
        }
        if job.is_none() {
            let due = c.disks.values().filter(|d| d.next_scan <= t).map(|d| d.path.clone()).min();
            if let Some(path) = due {
                let wake = c.wake.remove(&path);
                if let Some(req) = c.scan_req(&path, wake) {
                    if let Some(d) = c.disks.get_mut(&path) {
                        d.scanning = true;
                        c.dirty = true;
                    }
                    let sc = c.smartctl.clone();
                    job = Some(thread::spawn(move || scan_io(&sc, req)));
                }
            }
        }
        c.temp_tick(false);
        c.sync_read_tests();
        if t.saturating_sub(last_hist) >= HISTORY_SAMPLE {
            last_hist = t;
            c.sample_history();
            c.dirty = true;
        }
        if t.saturating_sub(last_save) >= 600 {
            last_save = t;
            c.history.save();
        }
        if c.dirty || t.saturating_sub(last_write) >= STATE_MAX_AGE {
            last_write = t;
            c.write_state();
        }
        if let Some(rest) = Duration::from_secs(1).checked_sub(tick.elapsed()) {
            thread::sleep(rest);
        }
    }
    c.history.dirty = true;
    c.history.save();
    log("collector stopped");
}

/// `disk-guardian --once`: read every disk once and print the raw state.
pub fn once() {
    let Some(exe) = find_smartctl() else {
        eprintln!("smartctl not found");
        std::process::exit(1);
    };
    let mut c = Collector::new(exe);
    c.discover();
    c.poll_windows(true);
    let paths: Vec<String> = c.disks.keys().cloned().collect();
    for p in paths {
        c.scan_disk(&p, false);
    }
    println!("{}", serde_json::to_string_pretty(&c.build_state()).unwrap_or_default());
}

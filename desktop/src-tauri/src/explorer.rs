//! Windows: disk health on the drives in File Explorer ("This PC").
//!
//! Per-user shell overrides, no admin rights needed:
//!   HKCU\Software\Classes\Applications\Explorer.exe\Drives\<L>\DefaultIcon   .ico path
//! The icon is our own drive drawing (the system drive carries the Windows logo,
//! removable drives are a USB stick) with the health score in a green / yellow /
//! red circle (bottom right) and a check / ! / x mark (top left). Every letter we touch gets a `DiskGuardian` marker
//! value, so `clear_all` only ever removes our own overrides.

use serde::Deserialize;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::sync::Mutex;

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
    RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_ALL_ACCESS, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM, SHCNF_IDLIST, SHCNF_PATHW};

const DRIVES_KEY: &str = r"Software\Classes\Applications\Explorer.exe\Drives";
const MARKER: &str = "DiskGuardian";
/// bump when the badge drawing changes: Explorer caches icons by path
const ICON_VERSION: u32 = 5;
const SIZES: [usize; 10] = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const DRIVE_REMOVABLE: u32 = 2;

#[derive(Deserialize, Clone, PartialEq, Debug)]
pub struct Drive {
    /// "C" (a trailing ':' is accepted)
    pub letter: String,
    /// good | warning | critical
    pub level: String,
    /// health score 0-100 (None: only a level is known)
    pub score: Option<u32>,
}

/// What is currently written, so the three windows sending the same list cost nothing.
static APPLIED: Mutex<Option<Vec<Drive>>> = Mutex::new(None);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn letter_of(s: &str) -> Option<char> {
    let c = s.trim().chars().next()?.to_ascii_uppercase();
    c.is_ascii_uppercase().then_some(c)
}

// ------------------------------------------------------------------ registry

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn create_key(path: &str) -> Option<Key> {
    let mut h: HKEY = null_mut();
    let p = wide(path);
    let rc = unsafe {
        RegCreateKeyExW(HKEY_CURRENT_USER, p.as_ptr(), 0, null_mut(), REG_OPTION_NON_VOLATILE, KEY_ALL_ACCESS,
            null_mut(), &mut h, null_mut())
    };
    (rc == ERROR_SUCCESS).then_some(Key(h))
}

fn open_key(path: &str) -> Option<Key> {
    let mut h: HKEY = null_mut();
    let p = wide(path);
    let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, p.as_ptr(), 0, KEY_ALL_ACCESS, &mut h) };
    (rc == ERROR_SUCCESS).then_some(Key(h))
}

fn set_default_sz(path: &str, value: &str) -> bool {
    let Some(k) = create_key(path) else { return false };
    let v = wide(value);
    unsafe { RegSetValueExW(k.0, null_mut(), 0, REG_SZ, v.as_ptr().cast(), (v.len() * 2) as u32) == ERROR_SUCCESS }
}

fn letter_key(l: char) -> String {
    format!(r"{DRIVES_KEY}\{l}")
}

fn is_ours(l: char) -> bool {
    let Some(k) = open_key(&letter_key(l)) else { return false };
    let name = wide(MARKER);
    unsafe { RegQueryValueExW(k.0, name.as_ptr(), null_mut(), null_mut(), null_mut(), null_mut()) == ERROR_SUCCESS }
}

fn write_letter(l: char, icon: Option<&PathBuf>) {
    let base = letter_key(l);
    let Some(k) = create_key(&base) else { return };
    let one: u32 = 1;
    let name = wide(MARKER);
    unsafe { RegSetValueExW(k.0, name.as_ptr(), 0, REG_DWORD, (&one as *const u32).cast(), 4) };
    // the drive keeps its own name (the first version wrote the score into it)
    delete_subkey(&k, "DefaultLabel");
    match icon {
        Some(p) => {
            set_default_sz(&format!(r"{base}\DefaultIcon"), &p.to_string_lossy());
        }
        None => delete_subkey(&k, "DefaultIcon"),
    }
}

fn delete_subkey(k: &Key, name: &str) {
    let n = wide(name);
    unsafe { RegDeleteTreeW(k.0, n.as_ptr()) };
    unsafe { RegDeleteKeyW(k.0, n.as_ptr()) };
}

fn remove_letter(l: char) {
    if !is_ours(l) {
        return;
    }
    {
        let Some(k) = open_key(&letter_key(l)) else { return };
        delete_subkey(&k, "DefaultLabel");
        delete_subkey(&k, "DefaultIcon");
        let name = wide(MARKER);
        unsafe { RegDeleteValueW(k.0, name.as_ptr()) };
    }
    // the letter key itself only if nothing else (user's own overrides) is left in it
    if let Some(parent) = open_key(DRIVES_KEY) {
        let n = wide(&l.to_string());
        unsafe { RegDeleteKeyW(parent.0, n.as_ptr()) }; // fails when not empty: fine
    }
}

fn notify(letters: &[char]) {
    unsafe {
        for l in letters {
            let root = wide(&format!("{l}:\\"));
            SHChangeNotify(SHCNE_UPDATEITEM as i32, SHCNF_PATHW, root.as_ptr().cast(), null_mut());
        }
        SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, null_mut(), null_mut());
    }
}

// ------------------------------------------------------------------ public

/// Write the labels / icons of `drives`, remove ours from letters no longer listed.
pub fn apply(drives: Vec<Drive>) {
    let mut drives: Vec<Drive> = drives.into_iter().filter(|d| letter_of(&d.letter).is_some()).collect();
    drives.sort_by(|a, b| a.letter.cmp(&b.letter));
    drives.dedup_by(|a, b| letter_of(&a.letter) == letter_of(&b.letter));
    let mut applied = APPLIED.lock().unwrap();
    if applied.as_ref() == Some(&drives) {
        return;
    }
    let mut changed = Vec::new();
    let wanted: Vec<char> = drives.iter().filter_map(|d| letter_of(&d.letter)).collect();
    for l in 'A'..='Z' {
        if !wanted.contains(&l) && is_ours(l) {
            remove_letter(l);
            changed.push(l);
        }
    }
    for d in &drives {
        let l = letter_of(&d.letter).unwrap();
        let old = applied.as_ref().and_then(|a| a.iter().find(|x| letter_of(&x.letter) == Some(l)));
        if old == Some(d) {
            continue;
        }
        let icon = icon_for(l, &d.level, d.score);
        write_letter(l, icon.as_ref());
        changed.push(l);
    }
    *applied = Some(drives);
    if !changed.is_empty() {
        notify(&changed);
    }
}

/// Remove every override we wrote (setting turned off, app quitting, uninstall).
pub fn clear_all() {
    let mut changed = Vec::new();
    for l in 'A'..='Z' {
        if is_ours(l) {
            remove_letter(l);
            changed.push(l);
        }
    }
    *APPLIED.lock().unwrap() = None;
    if !changed.is_empty() {
        notify(&changed);
    }
}

// ------------------------------------------------------------------ icons

fn icon_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("DiskGuardian").join("explorer")
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// the drive Windows runs from: drive with the Windows logo
    System,
    Fixed,
    /// USB stick
    Removable,
}

fn drive_kind(l: char) -> Kind {
    if std::env::var("SystemDrive").ok().and_then(|s| letter_of(&s)) == Some(l) {
        return Kind::System;
    }
    let root = wide(&format!("{l}:\\"));
    if unsafe { GetDriveTypeW(root.as_ptr()) } == DRIVE_REMOVABLE {
        Kind::Removable
    } else {
        Kind::Fixed
    }
}

fn icon_for(l: char, level: &str, score: Option<u32>) -> Option<PathBuf> {
    let color = match level {
        "good" => [0x1f, 0x9d, 0x55],
        "warning" => [0xd9, 0x8c, 0x00],
        "critical" => [0xd6, 0x3c, 0x3c],
        _ => return None,
    };
    let kind = drive_kind(l);
    let base = match kind {
        Kind::System => "system",
        Kind::Fixed => "fixed",
        Kind::Removable => "removable",
    };
    let path = icon_dir().join(format!("v{ICON_VERSION}-{base}-{level}-{}.ico", score.map(|n| n.min(100).to_string()).unwrap_or_else(|| "x".into())));
    if path.exists() {
        return Some(path);
    }
    let images: Vec<(usize, Vec<u8>)> = SIZES.iter().map(|&s| {
        let mut px = vec![0u8; s * s * 4];
        draw_drive(&mut px, s, kind);
        draw_badges(&mut px, s, color, level, score);
        (s, px)
    }).collect();
    std::fs::create_dir_all(icon_dir()).ok()?;
    // icons of older drawing versions are no longer referenced
    let prefix = format!("v{ICON_VERSION}-");
    for e in std::fs::read_dir(icon_dir()).into_iter().flatten().flatten() {
        if !e.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(e.path());
        }
    }
    std::fs::write(&path, ico_bytes(&images)).ok()?;
    Some(path)
}

// ------------------------------------------------------------------ drive drawing
// Coordinates are fractions of the icon size; the top left corner stays free for
// the status mark and the bottom right for the score circle.

/// Signed distance to a rounded rectangle (pixels).
fn rrect_dist(fx: f32, fy: f32, (x0, y0, x1, y1): (f32, f32, f32, f32), r: f32) -> f32 {
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let qx = (fx - cx).abs() - ((x1 - x0) / 2.0 - r);
    let qy = (fy - cy).abs() - ((y1 - y0) / 2.0 - r);
    (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r
}

fn mix(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    [0, 1, 2].map(|i| (a[i] as f32 + (b[i] as f32 - a[i] as f32) * t).round() as u8)
}

/// Rounded rectangle (fractions of `size`) with a vertical gradient `top` -> `bottom`.
/// `blur` > 0 gives a soft edge (shadows).
#[allow(clippy::too_many_arguments)]
fn rrect(px: &mut [u8], size: usize, rect: (f32, f32, f32, f32), r: f32, top: [u8; 3], bottom: [u8; 3], alpha: f32, blur: f32) {
    let s = size as f32;
    let rect = (rect.0 * s, rect.1 * s, rect.2 * s, rect.3 * s);
    let r = (r * s).min((rect.2 - rect.0) / 2.0).min((rect.3 - rect.1) / 2.0);
    let blur = blur * s;
    let reach = blur + 1.0;
    let x0 = (rect.0 - reach).floor().max(0.0) as usize;
    let y0 = (rect.1 - reach).floor().max(0.0) as usize;
    let x1 = ((rect.2 + reach).ceil() as usize).min(size);
    let y1 = ((rect.3 + reach).ceil() as usize).min(size);
    for y in y0..y1 {
        for x in x0..x1 {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let d = rrect_dist(fx, fy, rect, r);
            let cov = if blur > 0.0 { ((blur - d) / (2.0 * blur)).clamp(0.0, 1.0) } else { (0.5 - d).clamp(0.0, 1.0) };
            let c = mix(top, bottom, (fy - rect.1) / (rect.3 - rect.1));
            blend(px, (y * size + x) * 4, c, cov * alpha);
        }
    }
}

fn dot(px: &mut [u8], size: usize, (cx, cy): Pt, r: f32, color: [u8; 3], alpha: f32) {
    let s = size as f32;
    let r = r * s;
    rrect(px, size, (cx - r / s, cy - r / s, cx + r / s, cy + r / s), r / s, color, color, alpha, 0.0);
}

fn draw_drive(px: &mut [u8], size: usize, kind: Kind) {
    let small = size <= 20;
    let led = [0x34, 0xd3, 0x69];
    match kind {
        Kind::Removable => {
            // USB stick lying on its side, connector to the right
            rrect(px, size, (0.09, 0.40, 0.92, 0.74), 0.06, [0, 0, 0], [0, 0, 0], 0.30, 0.025);
            rrect(px, size, (0.64, 0.40, 0.94, 0.64), 0.025, [0xe8, 0xea, 0xee], [0xb4, 0xb9, 0xc1], 1.0, 0.0);
            if !small {
                rrect(px, size, (0.73, 0.465, 0.80, 0.51), 0.008, [0x5c, 0x61, 0x69], [0x5c, 0x61, 0x69], 1.0, 0.0);
                rrect(px, size, (0.84, 0.465, 0.91, 0.51), 0.008, [0x5c, 0x61, 0x69], [0x5c, 0x61, 0x69], 1.0, 0.0);
            }
            rrect(px, size, (0.06, 0.34, 0.68, 0.70), 0.08, [0x5d, 0x66, 0x75], [0x33, 0x38, 0x41], 1.0, 0.0);
            if !small {
                rrect(px, size, (0.09, 0.355, 0.65, 0.375), 0.01, [255, 255, 255], [255, 255, 255], 0.18, 0.0);
            }
            dot(px, size, (0.16, 0.52), 0.028, led, 1.0);
        }
        Kind::System | Kind::Fixed => {
            // shadow, metal body, dark front panel with the activity light
            rrect(px, size, (0.07, 0.34, 0.93, 0.80), 0.08, [0, 0, 0], [0, 0, 0], 0.32, 0.03);
            rrect(px, size, (0.06, 0.27, 0.94, 0.75), 0.085, [0xf4, 0xf5, 0xf7], [0xc2, 0xc7, 0xce], 1.0, 0.0);
            if !small {
                // thin top edge highlight
                rrect(px, size, (0.10, 0.285, 0.90, 0.30), 0.01, [255, 255, 255], [255, 255, 255], 0.9, 0.0);
            }
            rrect(px, size, (0.12, 0.54, 0.88, 0.68), 0.035, [0x4a, 0x50, 0x5a], [0x2b, 0x2f, 0x36], 1.0, 0.0);
            dot(px, size, (0.20, 0.61), if small { 0.035 } else { 0.026 }, led, 1.0);
            if !small {
                dot(px, size, (0.20, 0.61), 0.05, led, 0.18); // glow
            }
            if kind == Kind::System {
                // the Windows logo, whole and in clear space on the body
                let (x, y, w, gap) = (0.13, 0.315, 0.19, if small { 0.025 } else { 0.014 });
                let h = (w - gap) / 2.0;
                let blue_top = [0x2b, 0xa8, 0xf5];
                let blue_bottom = [0x00, 0x6c, 0xd4];
                for (i, j) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
                    let x0 = x + i * (h + gap);
                    let y0 = y + j * (h + gap);
                    rrect(px, size, (x0, y0, x0 + h, y0 + h), 0.008, blue_top, blue_bottom, 1.0, 0.0);
                }
            }
        }
    }
}

fn seg_dist(px: f32, py: f32, (ax, ay): (f32, f32), (bx, by): (f32, f32)) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    ((px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt()
}

/// Paint `src` (straight alpha, coverage `a`) over pixel `i`.
fn blend(px: &mut [u8], i: usize, src: [u8; 3], a: f32) {
    if a <= 0.0 {
        return;
    }
    let a = a.min(1.0);
    let da = px[i + 3] as f32 / 255.0;
    let oa = a + da * (1.0 - a);
    for c in 0..3 {
        let v = (src[c] as f32 * a + px[i + c] as f32 * da * (1.0 - a)) / oa;
        px[i + c] = v.round() as u8;
    }
    px[i + 3] = (oa * 255.0).round() as u8;
}

type Pt = (f32, f32);
type Seg = (Pt, Pt);

/// Disc with a white ring around it (the ring separates it from the drive icon).
fn disc(px: &mut [u8], size: usize, (cx, cy): Pt, r: f32, ring: f32, color: [u8; 3]) {
    let reach = r + ring + 1.0;
    let x0 = (cx - reach).floor().max(0.0) as usize;
    let y0 = (cy - reach).floor().max(0.0) as usize;
    let x1 = ((cx + reach).ceil() as usize).min(size);
    let y1 = ((cy + reach).ceil() as usize).min(size);
    for y in y0..y1 {
        for x in x0..x1 {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let i = (y * size + x) * 4;
            blend(px, i, [255, 255, 255], (r + ring + 0.5 - d).clamp(0.0, 1.0));
            blend(px, i, color, (r + 0.5 - d).clamp(0.0, 1.0));
        }
    }
}

/// Anti-aliased round-capped strokes.
fn strokes(px: &mut [u8], size: usize, segs: &[Seg], width: f32, color: [u8; 3]) {
    if segs.is_empty() {
        return;
    }
    let pad = width / 2.0 + 1.0;
    let (mut xmin, mut ymin, mut xmax, mut ymax) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for &(a, b) in segs {
        for p in [a, b] {
            xmin = xmin.min(p.0);
            xmax = xmax.max(p.0);
            ymin = ymin.min(p.1);
            ymax = ymax.max(p.1);
        }
    }
    let x0 = (xmin - pad).floor().max(0.0) as usize;
    let y0 = (ymin - pad).floor().max(0.0) as usize;
    let x1 = ((xmax + pad).ceil() as usize).min(size);
    let y1 = ((ymax + pad).ceil() as usize).min(size);
    for y in y0..y1 {
        for x in x0..x1 {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let d = segs.iter().map(|&(a, b)| seg_dist(fx, fy, a, b)).fold(f32::MAX, f32::min);
            blend(px, (y * size + x) * 4, color, (width / 2.0 + 0.5 - d).clamp(0.0, 1.0));
        }
    }
}

fn polyline(out: &mut Vec<Seg>, pts: &[Pt]) {
    out.extend(pts.windows(2).map(|w| (w[0], w[1])));
}

/// Elliptic arc, angles in degrees (0 = right, 90 = down).
fn arc(cx: f32, cy: f32, rx: f32, ry: f32, from: f32, to: f32) -> Vec<Pt> {
    let n = (((to - from).abs() / 10.0).ceil() as usize).max(2);
    (0..=n)
        .map(|i| {
            let t = (from + (to - from) * i as f32 / n as f32).to_radians();
            (cx + rx * t.cos(), cy + ry * t.sin())
        })
        .collect()
}

fn bezier(p0: Pt, c: Pt, p1: Pt) -> Vec<Pt> {
    (0..=14)
        .map(|i| {
            let t = i as f32 / 14.0;
            let u = 1.0 - t;
            (u * u * p0.0 + 2.0 * u * t * c.0 + t * t * p1.0, u * u * p0.1 + 2.0 * u * t * c.1 + t * t * p1.1)
        })
        .collect()
}

/// Stroke font: digit `d` in a 4 x 6 box (y down).
fn digit(d: u32) -> Vec<Seg> {
    let mut s = Vec::new();
    match d {
        0 => polyline(&mut s, &arc(2.0, 3.0, 1.75, 3.0, 0.0, 360.0)),
        1 => polyline(&mut s, &[(0.9, 1.2), (2.4, 0.0), (2.4, 6.0)]),
        2 => {
            let mut p = arc(2.0, 1.75, 1.75, 1.75, -180.0, 35.0);
            p.extend([(0.25, 6.0), (3.85, 6.0)]);
            polyline(&mut s, &p);
        }
        3 => {
            polyline(&mut s, &arc(2.0, 1.5, 1.6, 1.5, -165.0, 90.0));
            polyline(&mut s, &arc(2.0, 4.4, 1.75, 1.6, -90.0, 165.0));
        }
        4 => polyline(&mut s, &[(2.9, 6.0), (2.9, 0.0), (0.2, 4.2), (3.9, 4.2)]),
        5 => {
            let mut p = vec![(3.6, 0.0), (0.7, 0.0), (0.45, 2.75)];
            p.extend(arc(2.0, 4.1, 1.8, 1.9, -130.0, 150.0));
            polyline(&mut s, &p);
        }
        6 => {
            polyline(&mut s, &arc(2.0, 4.15, 1.75, 1.85, 0.0, 360.0));
            polyline(&mut s, &bezier((3.2, 0.2), (0.25, 0.6), (0.25, 4.15)));
        }
        7 => polyline(&mut s, &[(0.2, 0.0), (3.8, 0.0), (1.4, 6.0)]),
        8 => {
            polyline(&mut s, &arc(2.0, 1.45, 1.45, 1.45, 0.0, 360.0));
            polyline(&mut s, &arc(2.0, 4.4, 1.75, 1.6, 0.0, 360.0));
        }
        _ => {
            polyline(&mut s, &arc(2.0, 1.85, 1.75, 1.85, 0.0, 360.0));
            polyline(&mut s, &bezier((3.75, 1.85), (3.75, 5.4), (0.8, 5.8)));
        }
    }
    s
}

/// Number centered at `c`, fitted into a `w` x `h` box.
fn number(px: &mut [u8], size: usize, n: u32, c: Pt, w: f32, h: f32, color: [u8; 3]) {
    let text = n.to_string();
    const GAP: f32 = 1.2; // between digits, font units
    const STROKE: f32 = 1.0; // font units
    let count = text.len() as f32;
    let total_w = count * 4.0 + (count - 1.0) * GAP + STROKE;
    let k = (w / total_w).min(h / (6.0 + STROKE));
    let ox = c.0 - total_w * k / 2.0 + STROKE * k / 2.0;
    let oy = c.1 - 3.0 * k;
    let mut segs = Vec::new();
    for (i, ch) in text.chars().enumerate() {
        let dx = ox + i as f32 * (4.0 + GAP) * k;
        segs.extend(
            digit(ch.to_digit(10).unwrap_or(0))
                .into_iter()
                .map(|((ax, ay), (bx, by))| ((dx + ax * k, oy + ay * k), (dx + bx * k, oy + by * k))),
        );
    }
    strokes(px, size, &segs, STROKE * k, color);
}

/// The health score in a circle colored by the level (bottom right) and a small
/// check / ! / x mark (top left).
fn draw_badges(px: &mut [u8], size: usize, color: [u8; 3], level: &str, score: Option<u32>) {
    let s = size as f32;
    let ring = (s / 32.0).max(1.0);
    let white = [255, 255, 255];

    // top left: status mark (16 / 20 px icons only get the score circle)
    if size >= 24 {
        let r = s * 0.12;
        let c = (r + ring, r + ring);
        disc(px, size, c, r, ring, color);
        let mark: &[Seg] = match level {
            "good" => &[((-0.5, 0.02), (-0.14, 0.38)), ((-0.14, 0.38), (0.5, -0.32))],
            "warning" => &[((0.0, -0.55), (0.0, 0.12)), ((0.0, 0.5), (0.0, 0.5))],
            _ => &[((-0.36, -0.36), (0.36, 0.36)), ((0.36, -0.36), (-0.36, 0.36))],
        };
        let at = |p: Pt| (c.0 + p.0 * r, c.1 + p.1 * r);
        let segs: Vec<Seg> = mark.iter().map(|&(a, b)| (at(a), at(b))).collect();
        strokes(px, size, &segs, r * 0.32, white);
    }

    // bottom right: score
    let r = if size <= 16 { 4.0 } else { s * 0.20 };
    let c = (s - r - ring, s - r - ring);
    disc(px, size, c, r, ring, color);
    if size >= 32 {
        match score {
            Some(n) => {
                let n = n.min(100);
                let w = r * if n >= 100 { 1.55 } else { 1.35 };
                number(px, size, n, c, w, r * 1.0, white);
            }
            None => {
                let segs = [((c.0, c.1 - r * 0.5), (c.0, c.1 + r * 0.1)), ((c.0, c.1 + r * 0.45), (c.0, c.1 + r * 0.45))];
                strokes(px, size, &segs, r * 0.28, white);
            }
        }
    }
}

/// .ico with uncompressed 32-bit images (RGBA top-down in).
fn ico_bytes(images: &[(usize, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[0, 0, 1, 0]);
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut data = Vec::new();
    let mut offset = 6 + 16 * images.len();
    for (s, px) in images {
        let mask_row = s.div_ceil(32) * 4;
        let mut img = Vec::with_capacity(40 + s * s * 4 + mask_row * s);
        img.extend_from_slice(&40u32.to_le_bytes());
        img.extend_from_slice(&(*s as i32).to_le_bytes());
        img.extend_from_slice(&((*s * 2) as i32).to_le_bytes());
        img.extend_from_slice(&1u16.to_le_bytes());
        img.extend_from_slice(&32u16.to_le_bytes());
        img.extend_from_slice(&[0; 24]); // compression .. clr_important
        for y in (0..*s).rev() {
            for x in 0..*s {
                let i = (y * s + x) * 4;
                img.extend_from_slice(&[px[i + 2], px[i + 1], px[i], px[i + 3]]);
            }
        }
        img.resize(img.len() + mask_row * s, 0);

        let dim = if *s >= 256 { 0 } else { *s as u8 };
        out.extend_from_slice(&[dim, dim, 0, 0]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(img.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += img.len();
        data.extend_from_slice(&img);
    }
    out.extend_from_slice(&data);
    out
}

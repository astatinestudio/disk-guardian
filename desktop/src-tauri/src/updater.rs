//! Self-update from a JSON manifest (`updates.json` in the GitHub repo, same layout
//! as other projects' update manifests):
//!
//! ```json
//! {
//!   "releases":  { "1.6.0": { "release_url": ".../releases/tag/v1.6.0",
//!                             "base_url":    ".../releases/download/v1.6.0/",
//!                             "checksums_file": "SHA256SUMS.txt",
//!                             "signature_file": "SHA256SUMS.txt.sig",
//!                             "notes": { "en": "...", "fa": "..." } } },
//!   "platforms": { "windows": { "version": "1.6.0", "mandatory": false,
//!                               "downloads": { "installer-x64": { "file": "Disk-Guardian-Windows-Setup-x64.exe" }, ... } },
//!                  "macos":   { ... },
//!                  "linux":   { ... } },
//!   "announcements": [ ... shown by the UI (js/updates.js) ... ]
//! }
//! ```
//!
//! Every release carries SHA256SUMS.txt and SHA256SUMS.txt.sig, an Ed25519 signature
//! (hex) of that file made with the release key (`node scripts/release.mjs`). The app
//! only installs a file whose hash is listed in a correctly signed SHA256SUMS.txt.
//! Downloads use the system curl (Windows 10+, macOS, the Linux packages depend on it).
//!
//! Download keys (see `Kind`; scripts/release.mjs writes the same names):
//!   windows  installer-{x64,x86,arm64} (NSIS) · portable-{x64,x86,arm64} (zip, not self-updating)
//!   macos    app-{aarch64,x64} (.app.tar.gz, used here) · dmg-{aarch64,x64}
//!   linux    deb-{amd64,arm64} · rpm-{x86_64,aarch64} · appimage-{x86_64,aarch64}

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

/// The manifest, tried in order (jsDelivr mirrors GitHub where raw.githubusercontent.com is blocked).
const MANIFEST_URLS: &[&str] = &[
    "https://raw.githubusercontent.com/astatinestudio/disk-guardian/main/updates.json",
    "https://cdn.jsdelivr.net/gh/astatinestudio/disk-guardian@main/updates.json",
];

/// Ed25519 public key of the release signing key (hex, 32 bytes), written by
/// `node scripts/release.mjs keygen`.
const PUBLIC_KEY_HEX: &str = "e716d657d2e72a2c6f1afa6e55cc0991cccbe68cf5edc9744297c9f6372d014f";

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn platform_key() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// How this copy was installed, which decides how it updates itself.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    /// Windows NSIS installer (uninstall.exe next to the exe)
    Installer,
    /// macOS .app bundle
    App,
    Deb,
    Rpm,
    /// Linux AppImage ($APPIMAGE)
    AppImage,
    /// portable zip, development build, unknown package: no self-update
    Manual,
}

fn appimage_path() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()).map(PathBuf::from).filter(|p| p.is_file())
}

fn kind() -> Kind {
    let Ok(exe) = std::env::current_exe() else { return Kind::Manual };
    if cfg!(windows) {
        if exe.parent().is_some_and(|d| d.join("uninstall.exe").is_file()) { Kind::Installer } else { Kind::Manual }
    } else if cfg!(target_os = "macos") {
        if app_bundle(&exe).is_some() { Kind::App } else { Kind::Manual }
    } else if appimage_path().is_some() {
        Kind::AppImage
    } else if exe == Path::new("/usr/bin/disk-guardian") {
        let owns = |cmd: &str, args: &[&str]| Command::new(cmd).args(args).output().is_ok_and(|o| o.status.success());
        if owns("dpkg-query", &["-W", "disk-guardian"]) {
            Kind::Deb
        } else if owns("rpm", &["-q", "disk-guardian"]) {
            Kind::Rpm
        } else {
            Kind::Manual
        }
    } else {
        Kind::Manual
    }
}

/// The manifest download this copy installs itself from.
fn download_key(kind: Kind) -> Option<String> {
    let (x64, arm) = (cfg!(target_arch = "x86_64"), cfg!(target_arch = "aarch64"));
    Some(match kind {
        Kind::Installer => format!("installer-{}", if x64 { "x64" } else if arm { "arm64" } else { "x86" }),
        Kind::App => format!("app-{}", if arm { "aarch64" } else { "x64" }),
        Kind::Deb => format!("deb-{}", if arm { "arm64" } else { "amd64" }),
        Kind::Rpm => format!("rpm-{}", if arm { "aarch64" } else { "x86_64" }),
        Kind::AppImage => format!("appimage-{}", if arm { "aarch64" } else { "x86_64" }),
        Kind::Manual => return None,
    })
}

// ------------------------------------------------------------------ versions

fn parse_version(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches('v').split(['.', '-', '+']).take(3).map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse_version(candidate), parse_version(current));
    a.resize(3, 0);
    b.resize(3, 0);
    a > b
}

// ------------------------------------------------------------------ http (system curl)

fn curl() -> Command {
    let mut cmd = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    crate::collector::hide_window(&mut cmd);
    cmd.args(["-fsSL", "--retry", "2", "--connect-timeout", "15"]);
    if std::env::var_os("DISKGUARDIAN_UPDATE_URL").is_none() {
        cmd.args(["--proto", "=https"]);
    }
    cmd
}

fn fetch(url: &str, max_secs: u32) -> Result<Vec<u8>, String> {
    let out = curl().args(["--max-time", &max_secs.to_string(), url]).output()
        .map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("download failed: {url}") } else { err });
    }
    Ok(out.stdout)
}

/// Size announced by the server (last Content-Length of the redirect chain).
fn remote_size(url: &str) -> Option<u64> {
    let out = curl().args(["-I", "--max-time", "30", url]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().rev()
        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse().ok()))
}

fn download(url: &str, dest: &Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(), String> {
    let total = remote_size(url);
    let _ = std::fs::remove_file(dest);
    let mut child = curl().args(["--max-time", "1800", "-o"]).arg(dest).arg(url).spawn()
        .map_err(|e| format!("curl: {e}"))?;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err(format!("download failed: {url}"));
            }
            let n = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
            progress(n, total.or(Some(n)));
            return Ok(());
        }
        progress(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0), total);
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

// ------------------------------------------------------------------ manifest

fn manifest_urls() -> Vec<String> {
    if let Some(u) = std::env::var_os("DISKGUARDIAN_UPDATE_URL") {
        return vec![u.to_string_lossy().into_owned()];
    }
    MANIFEST_URLS.iter().map(|u| u.to_string()).collect()
}

fn load_manifest() -> Result<Value, String> {
    let mut last = String::from("no update source");
    for url in manifest_urls() {
        // raw.githubusercontent.com / jsDelivr cache for a few minutes: bypass with a query
        let sep = if url.contains('?') { '&' } else { '?' };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 60).unwrap_or(0);
        let url = if url.starts_with("http") { format!("{url}{sep}t={stamp}") } else { url };
        match fetch(&url, 30).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| format!("invalid updates.json: {e}"))) {
            Ok(v) if v.is_object() => return Ok(v),
            Ok(_) => last = "invalid updates.json".into(),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// What the manifest offers this platform.
struct Offer {
    version: String,
    mandatory: bool,
    release: Value,
    file: Option<String>,
}

fn offer(manifest: &Value) -> Option<Offer> {
    let mut plat = manifest.pointer(&format!("/platforms/{}", platform_key()))?;
    // channel layout ({"stable": {...}, "latest": {...}}) like the Android entry of other manifests
    if plat.get("version").is_none() {
        plat = plat.get("stable")?;
    }
    let version = plat["version"].as_str()?.to_string();
    let release = manifest["releases"][&version].clone();
    let file = download_key(kind()).and_then(|k| plat["downloads"][k]["file"].as_str().map(str::to_string));
    Some(Offer { version, mandatory: plat["mandatory"] == true, release, file })
}

/// Can this installation replace itself?
fn installable() -> bool {
    let has = |cmd: &str| Command::new("which").arg(cmd).output().is_ok_and(|o| o.status.success());
    match kind() {
        Kind::Installer | Kind::App => true,
        Kind::Deb | Kind::Rpm => has("pkexec"),
        Kind::AppImage => true,
        Kind::Manual => false,
    }
}

fn app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

fn check() -> Result<Value, String> {
    let manifest = load_manifest()?;
    let o = offer(&manifest);
    let available = o.as_ref().is_some_and(|o| is_newer(&o.version, VERSION));
    Ok(json!({
        "current": VERSION,
        "platform": platform_key(),
        "checked": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "available": available,
        "version": o.as_ref().map(|o| o.version.clone()),
        "mandatory": available && o.as_ref().is_some_and(|o| o.mandatory),
        "notes": o.as_ref().map(|o| o.release["notes"].clone()).unwrap_or(Value::Null),
        "release_url": o.as_ref().and_then(|o| o.release["release_url"].as_str().map(str::to_string)),
        "install_kind": format!("{:?}", kind()).to_lowercase(),
        "installable": available && installable() && o.as_ref().is_some_and(|o| o.file.is_some()) && !PUBLIC_KEY_HEX.is_empty(),
        "announcements": manifest.get("announcements").cloned().unwrap_or(json!([])),
    }))
}

// ------------------------------------------------------------------ verification

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

fn verify_signature(data: &[u8], sig_text: &str) -> Result<(), String> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let key: [u8; 32] = hex_decode(PUBLIC_KEY_HEX).and_then(|k| k.try_into().ok()).ok_or("no release key in this build")?;
    let sig: [u8; 64] = hex_decode(sig_text).and_then(|s| s.try_into().ok()).ok_or("malformed signature file")?;
    VerifyingKey::from_bytes(&key).map_err(|e| e.to_string())?
        .verify(data, &Signature::from_bytes(&sig))
        .map_err(|_| "the signature of SHA256SUMS.txt is not valid".to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// `<sha256>  <file>` lines (sha256sum format, `*` binary marker allowed).
fn expected_hash(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (h, f) = (it.next()?, it.next()?);
        (f.trim_start_matches('*') == file).then(|| h.to_ascii_lowercase())
    })
}

// ------------------------------------------------------------------ install

#[cfg(unix)]
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Starts the platform installer in a detached helper that waits for this process to
/// exit, installs (one administrator prompt) and starts the new version.
fn launch_installer(file: &Path, dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "''"));
        let script = format!(
            "try {{ Wait-Process -Id {pid} -Timeout 60 -ErrorAction SilentlyContinue }} catch {{}}\n\
             try {{ Start-Process -FilePath {} -ArgumentList '/S' -Verb RunAs -Wait }} catch {{}}\n\
             Start-Process -FilePath {}\n",
            q(file), q(&exe));
        let ps1 = dir.join("install.ps1");
        std::fs::write(&ps1, script).map_err(|e| e.to_string())?;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
            .arg(&ps1)
            .creation_flags(crate::collector::CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let app = app_bundle(&exe).ok_or("not running from an .app bundle")?;
        let app = app.display().to_string();
        let new_dir = dir.join("new");
        // runs as root (one password prompt): replace the bundle, restart the collector
        let root = format!(
            "set -e\nrm -rf {new}\nmkdir -p {new}\ntar -xzf {file} -C {new}\nNEW=$(find {new} -maxdepth 1 -name '*.app' | head -n 1)\n\
             [ -n \"$NEW\" ]\nrm -rf {app}\nmv \"$NEW\" {app}\nxattr -dr com.apple.quarantine {app} 2>/dev/null || true\n\
             launchctl kickstart -k system/io.github.diskguardian.collector 2>/dev/null || true\n",
            new = shq(&new_dir.display().to_string()), file = shq(&file.display().to_string()), app = shq(&app));
        let root_sh = dir.join("root.sh");
        std::fs::write(&root_sh, root).map_err(|e| e.to_string())?;
        let osa = format!("do shell script \"/bin/sh {}\" with administrator privileges",
            root_sh.display().to_string().replace('\\', "\\\\").replace('"', "\\\""));
        let script = format!(
            "while kill -0 {pid} 2>/dev/null; do sleep 0.5; done\n/usr/bin/osascript -e {} || true\nopen {}\n",
            shq(&osa), shq(&app));
        let sh = dir.join("install.sh");
        std::fs::write(&sh, script).map_err(|e| e.to_string())?;
        Command::new("/bin/sh").arg(&sh).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let f = shq(&file.display().to_string());
        let relaunch = |path: &str| format!("setsid {path} >/dev/null 2>&1 &");
        let mut lines = vec![format!("while kill -0 {pid} 2>/dev/null; do sleep 0.5; done")];
        match kind() {
            Kind::Deb => {
                lines.push(format!("pkexec /usr/bin/apt-get install -y --allow-downgrades {f} || true"));
                lines.push(relaunch(&shq(&exe.display().to_string())));
            }
            // dnf (Fedora / RHEL), zypper (openSUSE), else plain rpm
            Kind::Rpm => {
                lines.push(format!(
                    "pkexec /bin/sh -c 'if command -v dnf >/dev/null; then dnf install -y \"$0\"; \
                     elif command -v zypper >/dev/null; then zypper --non-interactive install --allow-unsigned-rpm \"$0\"; \
                     else rpm -Uvh --replacepkgs \"$0\"; fi' {f} || true"));
                lines.push(relaunch(&shq(&exe.display().to_string())));
            }
            Kind::AppImage => {
                let target = appimage_path().ok_or("no AppImage")?;
                let t = shq(&target.display().to_string());
                // replace the AppImage (password only when its folder is not writable), then
                // restart the collector service when it runs from this AppImage
                lines.push(format!("chmod 755 {f}"));
                lines.push(format!("if [ -w \"$(dirname {t})\" ]; then mv -f {f} {t}; else pkexec /bin/mv -f {f} {t}; fi"));
                lines.push(format!(
                    "if systemctl is-active --quiet disk-guardian.service && grep -qF {t} /etc/systemd/system/disk-guardian.service 2>/dev/null; \
                     then pkexec /bin/systemctl restart disk-guardian.service || true; fi"));
                lines.push(relaunch(&t));
            }
            _ => return Err("this installation cannot update itself".into()),
        }
        let script = lines.join("\n") + "\n";
        let sh = dir.join("install.sh");
        std::fs::write(&sh, script).map_err(|e| e.to_string())?;
        Command::new("setsid").arg("/bin/sh").arg(&sh).spawn()
            .or_else(|_| Command::new("/bin/sh").arg(&sh).spawn())
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Download + verify the offered update. Returns the verified installer file.
fn prepare(mut progress: impl FnMut(u64, Option<u64>)) -> Result<(PathBuf, PathBuf), String> {
    let manifest = load_manifest()?;
    let o = offer(&manifest).ok_or("no update for this platform")?;
    if !is_newer(&o.version, VERSION) {
        return Err("already up to date".into());
    }
    let file = o.file.ok_or("no download for this platform")?;
    let base = o.release["base_url"].as_str().ok_or("release without base_url")?;
    let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
    let sums_name = o.release["checksums_file"].as_str().unwrap_or("SHA256SUMS.txt");
    let sig_name = o.release["signature_file"].as_str().unwrap_or("SHA256SUMS.txt.sig");
    let safe = |n: &str| !n.is_empty() && !n.contains(['/', '\\']) && n != "..";
    if !safe(&file) || !safe(sums_name) || !safe(sig_name) {
        return Err("invalid file name in updates.json".into());
    }

    let sums = fetch(&format!("{base}{sums_name}"), 60)?;
    let sig = fetch(&format!("{base}{sig_name}"), 60)?;
    verify_signature(&sums, &String::from_utf8_lossy(&sig))?;
    let sums = String::from_utf8_lossy(&sums).into_owned();
    let want = expected_hash(&sums, &file).ok_or("the file is not listed in SHA256SUMS.txt")?;

    let dir = std::env::temp_dir().join("disk-guardian-update").join(&o.version);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&file);
    if !dest.is_file() || sha256_file(&dest)? != want {
        download(&format!("{base}{file}"), &dest, &mut progress)?;
        if sha256_file(&dest)? != want {
            let _ = std::fs::remove_file(&dest);
            return Err("the downloaded file is damaged (SHA-256 mismatch)".into());
        }
    }
    Ok((dest, dir))
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub async fn check_update() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(check).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let (file, dir) = tauri::async_runtime::spawn_blocking(move || prepare(|done, total| {
        let _ = handle.emit("update-progress", json!({"done": done, "total": total}));
    })).await.map_err(|e| e.to_string())??;
    launch_installer(&file, &dir)?;
    let _ = app.emit("update-installing", ());
    std::thread::sleep(std::time::Duration::from_millis(600));
    app.exit(0);
    Ok(())
}

/// Opens an https link in the default browser (release notes, announcements).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("only https links".into());
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// `disk-guardian --check-update`: print what the manifest offers (debugging).
pub fn print_check() {
    match check() {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

/// `disk-guardian --download-update`: download + verify the offered update, no install.
pub fn print_download() {
    match prepare(|_, _| {}) {
        Ok((file, _)) => println!("verified: {}", file.display()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(is_newer("1.6.0", "1.5.0"));
        assert!(is_newer("v1.10.0", "1.9.9"));
        assert!(!is_newer("1.5.0", "1.5.0"));
        assert!(!is_newer("1.4.9", "1.5.0"));
    }

    #[test]
    fn sums() {
        let s = "abc123  Disk-Guardian-Linux-amd64.deb\nDEF  *Disk-Guardian-Windows-Setup-x64.exe\n";
        assert_eq!(expected_hash(s, "Disk-Guardian-Linux-amd64.deb").as_deref(), Some("abc123"));
        assert_eq!(expected_hash(s, "Disk-Guardian-Windows-Setup-x64.exe").as_deref(), Some("def"));
        assert_eq!(expected_hash(s, "other"), None);
    }
}

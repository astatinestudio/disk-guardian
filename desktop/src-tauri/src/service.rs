//! Collector service: install / uninstall / run.
//!
//! * Windows: a Windows service "DiskGuardian" (LocalSystem) running `disk-guardian.exe --service`.
//!   The NSIS installer calls `--install-service` / `--uninstall-service` (windows/hooks.nsh).
//! * macOS: a launchd daemon running `.../Disk Guardian.app/Contents/MacOS/disk-guardian --service`,
//!   installed from the app (administrator password prompt).
//! * Linux: the systemd unit disk-guardian.service running `/usr/bin/disk-guardian --service`.
//!   The .deb ships the unit (linux/disk-guardian.service); `--install-service` writes it to
//!   /etc/systemd/system for installs without the package.

use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::collector::{self, hide_window};

pub const SERVICE_NAME: &str = "DiskGuardian";
#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = "io.github.diskguardian.collector";
#[cfg(target_os = "macos")]
const LAUNCHD_PLIST: &str = "/Library/LaunchDaemons/io.github.diskguardian.collector.plist";
#[cfg(target_os = "linux")]
pub const SYSTEMD_UNIT: &str = "disk-guardian.service";
#[cfg(target_os = "linux")]
const SYSTEMD_UNIT_FILE: &str = "/etc/systemd/system/disk-guardian.service";
#[cfg(target_os = "linux")]
const SYSTEMD_UNIT_PACKAGED: &str = "/usr/lib/systemd/system/disk-guardian.service";

fn status_ok(cmd: &mut Command) -> bool {
    hide_window(cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

// ------------------------------------------------------------------ run

/// `disk-guardian --service`
pub fn run() {
    #[cfg(windows)]
    {
        // Started by the service control manager? Otherwise (debugging from a
        // console) run the collector in the foreground.
        if win::start() {
            return;
        }
        collector::run(Arc::new(AtomicBool::new(false)));
    }
    #[cfg(target_os = "macos")]
    {
        collector::run(Arc::new(AtomicBool::new(false)));
    }
    #[cfg(target_os = "linux")]
    {
        // systemd stops the service with SIGTERM: finish the loop and save the history
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        if let Err(e) = ctrlc::set_handler(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)) {
            eprintln!("cannot install the signal handler: {e}");
        }
        collector::run(stop);
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    define_windows_service!(ffi_service_main, service_main);

    /// Blocks while the service runs; false when not started by the service manager.
    pub fn start() -> bool {
        service_dispatcher::start(super::SERVICE_NAME, ffi_service_main).is_ok()
    }

    fn status(state: ServiceState, accept: ServiceControlAccept) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(10),
            process_id: None,
        }
    }

    fn service_main(_args: Vec<OsString>) {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_handler = stop.clone();
        let handler = move |event: ServiceControl| -> ServiceControlHandlerResult {
            match event {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    stop_handler.store(true, Ordering::SeqCst);
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };
        let Ok(handle) = service_control_handler::register(super::SERVICE_NAME, handler) else { return };
        let _ = handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN));
        crate::collector::run(stop);
        let _ = handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()));
    }
}

// ------------------------------------------------------------------ install (elevated)

/// `disk-guardian --install-service` (must run as administrator / root).
pub fn install() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    remove_legacy_service();
    #[cfg(windows)]
    {
        crate::paths::ensure_dirs();
        let bin = format!("\"{}\" --service", exe.display());
        status_ok(Command::new("sc.exe").args(["stop", SERVICE_NAME]));
        let created = status_ok(Command::new("sc.exe").args([
            "create", SERVICE_NAME, "binPath=", &bin, "start=", "auto", "DisplayName=", "Disk Guardian collector",
        ]));
        if !created && !status_ok(Command::new("sc.exe").args(["config", SERVICE_NAME, "binPath=", &bin, "start=", "auto"])) {
            return Err("sc.exe could not create the service (run as administrator)".into());
        }
        status_ok(Command::new("sc.exe").args([
            "description", SERVICE_NAME, "Reads SMART health and temperature of all disks for the Disk Guardian app.",
        ]));
        status_ok(Command::new("sc.exe").args([
            "failure", SERVICE_NAME, "reset=", "86400", "actions=", "restart/10000/restart/60000/restart/60000",
        ]));
        std::thread::sleep(std::time::Duration::from_secs(2));
        if !status_ok(Command::new("sc.exe").args(["start", SERVICE_NAME])) && !is_running() {
            return Err("the service was installed but did not start".into());
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        crate::paths::ensure_dirs();
        let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let plist = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>--service</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#, esc(&exe.display().to_string()), esc(&crate::paths::data_dir().join("collector.err").display().to_string()));
        std::fs::write(LAUNCHD_PLIST, plist).map_err(|e| format!("cannot write {LAUNCHD_PLIST}: {e}"))?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(LAUNCHD_PLIST, std::fs::Permissions::from_mode(0o644));
        }
        status_ok(Command::new("launchctl").args(["bootout", &format!("system/{LAUNCHD_LABEL}")]));
        if !status_ok(Command::new("launchctl").args(["bootstrap", "system", LAUNCHD_PLIST])) {
            return Err("launchctl bootstrap failed".into());
        }
        status_ok(Command::new("launchctl").args(["enable", &format!("system/{LAUNCHD_LABEL}")]));
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        crate::paths::ensure_dirs();
        if !std::path::Path::new(SYSTEMD_UNIT_PACKAGED).is_file() {
            std::fs::write(SYSTEMD_UNIT_FILE, systemd_unit(&service_exe(&exe)))
                .map_err(|e| format!("cannot write {SYSTEMD_UNIT_FILE}: {e}"))?;
        }
        status_ok(Command::new("systemctl").arg("daemon-reload"));
        // the former Python collector writes the same state file
        status_ok(Command::new("systemctl").args(["disable", "--now", "linuxhealth-collector.service"]));
        if !status_ok(Command::new("systemctl").args(["enable", "--now", SYSTEMD_UNIT])) {
            return Err("systemctl could not start disk-guardian.service".into());
        }
        Ok(())
    }
}

/// What the service runs: the AppImage file itself when started from one (the
/// running binary lives in a temporary mount that disappears).
#[cfg(target_os = "linux")]
fn service_exe(exe: &std::path::Path) -> String {
    std::env::var("APPIMAGE").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| exe.display().to_string())
}

/// Unit for installs without the package (same as linux/disk-guardian.service).
/// An AppImage runs extracted (no FUSE needed under systemd).
#[cfg(target_os = "linux")]
fn systemd_unit(exe: &str) -> String {
    let unit = include_str!("../linux/disk-guardian.service").replace("/usr/bin/disk-guardian", exe);
    if std::env::var("APPIMAGE").is_ok_and(|p| p == exe) {
        unit.replace("[Service]\n", "[Service]\nEnvironment=APPIMAGE_EXTRACT_AND_RUN=1\n")
    } else {
        unit
    }
}

/// The collector service of the app's former name (Disk Health) would read the same
/// disks twice: stop and remove it. Its history is copied by paths::migrate_legacy_data.
fn remove_legacy_service() {
    #[cfg(windows)]
    {
        if status_ok(Command::new("sc.exe").args(["query", "DiskHealth"])) {
            status_ok(Command::new("sc.exe").args(["stop", "DiskHealth"]));
            std::thread::sleep(std::time::Duration::from_secs(2));
            status_ok(Command::new("sc.exe").args(["delete", "DiskHealth"]));
        }
    }
    #[cfg(target_os = "macos")]
    {
        const OLD: &str = "/Library/LaunchDaemons/io.github.linuxhealth.diskhealth.collector.plist";
        if std::path::Path::new(OLD).exists() {
            status_ok(Command::new("launchctl").args(["bootout", "system/io.github.linuxhealth.diskhealth.collector"]));
            let _ = std::fs::remove_file(OLD);
        }
    }
    #[cfg(target_os = "linux")]
    {
        status_ok(Command::new("systemctl").args(["disable", "--now", "disk-health.service"]));
        let _ = std::fs::remove_file("/etc/systemd/system/disk-health.service");
    }
}

/// `disk-guardian --uninstall-service`
pub fn uninstall() -> Result<(), String> {
    #[cfg(windows)]
    {
        status_ok(Command::new("sc.exe").args(["stop", SERVICE_NAME]));
        std::thread::sleep(std::time::Duration::from_secs(2));
        status_ok(Command::new("sc.exe").args(["delete", SERVICE_NAME]));
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        status_ok(Command::new("launchctl").args(["bootout", &format!("system/{LAUNCHD_LABEL}")]));
        let _ = std::fs::remove_file(LAUNCHD_PLIST);
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        status_ok(Command::new("systemctl").args(["disable", "--now", SYSTEMD_UNIT]));
        let _ = std::fs::remove_file(SYSTEMD_UNIT_FILE);
        status_ok(Command::new("systemctl").arg("daemon-reload"));
        Ok(())
    }
}

/// Is the collector service installed and running (best effort)?
pub fn is_running() -> bool {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("sc.exe");
        cmd.args(["query", SERVICE_NAME]);
        hide_window(&mut cmd);
        cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).contains("RUNNING")).unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        status_ok(Command::new("launchctl").args(["print", &format!("system/{LAUNCHD_LABEL}")]))
    }
    #[cfg(target_os = "linux")]
    {
        status_ok(Command::new("systemctl").args(["is-active", "--quiet", SYSTEMD_UNIT]))
    }
}

// ------------------------------------------------------------------ from the (unprivileged) app

/// Install / start the collector with an administrator prompt (UAC, macOS password
/// dialog, polkit). Blocks until the user answered.
pub fn install_elevated() -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let script = format!(
            "$p = Start-Process -FilePath '{}' -ArgumentList '--install-service' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
            exe.display().to_string().replace('\'', "''")
        );
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        if status_ok(&mut cmd) { Ok(()) } else { Err("cancelled or failed".into()) }
    }
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // shell-quote for `do shell script`, then escape for the AppleScript string
        let shell = format!("'{}' --install-service", exe.display().to_string().replace('\'', r"'\''"));
        let apple = format!(
            "do shell script \"{}\" with administrator privileges",
            shell.replace('\\', "\\\\").replace('"', "\\\"")
        );
        if status_ok(Command::new("osascript").args(["-e", &apple])) { Ok(()) } else { Err("cancelled or failed".into()) }
    }
    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut cmd = Command::new("pkexec");
        match std::env::var("APPIMAGE").ok().filter(|p| !p.is_empty()) {
            // pkexec clears the environment: tell the AppImage to run extracted and where it is
            Some(img) => cmd.args(["env", "APPIMAGE_EXTRACT_AND_RUN=1", &format!("APPIMAGE={img}"), &img, "--install-service"]),
            None => cmd.arg(exe).arg("--install-service"),
        };
        if status_ok(&mut cmd) {
            Ok(())
        } else {
            Err("cancelled or failed".into())
        }
    }
}

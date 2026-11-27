//! Where the collector publishes its state and reads requests.
//!
//! * Windows: %ProgramData%\DiskGuardian            (Rust collector, Windows service)
//! * macOS:   /Library/Application Support/DiskGuardian (Rust collector, launchd daemon)
//! * Linux:   /run/diskguardian (state, requests) and /var/lib/diskguardian (history),
//!            systemd service disk-guardian.service

use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    // development: run a collector and the app against a private directory
    if let Some(dir) = std::env::var_os("DISKGUARDIAN_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("DiskGuardian")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/DiskGuardian")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from(std::env::var("DISKGUARDIAN_RUN_DIR").unwrap_or_else(|_| "/run/diskguardian".into()))
    }
}

pub fn state_file() -> PathBuf {
    data_dir().join("state.json")
}

pub fn requests_dir() -> PathBuf {
    data_dir().join("requests")
}

pub fn history_file() -> PathBuf {
    // Linux: /run is a tmpfs, the history must survive a reboot (systemd StateDirectory)
    #[cfg(all(unix, not(target_os = "macos")))]
    if std::env::var_os("DISKGUARDIAN_DATA_DIR").is_none() {
        return PathBuf::from(std::env::var("DISKGUARDIAN_LIB_DIR").unwrap_or_else(|_| "/var/lib/diskguardian".into()))
            .join("history.json");
    }
    data_dir().join("history.json")
}

pub fn log_file() -> PathBuf {
    data_dir().join("collector.log")
}

/// History written under the app's former name (Disk Health), if any.
fn legacy_history_file() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("DiskHealth").join("history.json")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/DiskHealth/history.json")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from("/var/lib/linuxhealth/history.json")
    }
}

/// Keep the temperature / usage history of a Disk Health install (collector side).
pub fn migrate_legacy_data() {
    if std::env::var_os("DISKGUARDIAN_DATA_DIR").is_some() {
        return;
    }
    let (old, new) = (legacy_history_file(), history_file());
    if !new.exists() && old.is_file() {
        let _ = std::fs::copy(&old, &new);
    }
}

/// Create the data directories (collector side, runs as admin / root).
/// Every local user may drop request files (refresh / self-test) into `requests`.
pub fn ensure_dirs() {
    let _ = std::fs::create_dir_all(requests_dir());
    if let Some(dir) = history_file().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    migrate_legacy_data();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // BUILTIN\Users: modify (create request files) on the requests folder only
        let _ = std::process::Command::new("icacls")
            .arg(requests_dir())
            .args(["/grant", "*S-1-5-32-545:(OI)(CI)M", "/Q"])
            .creation_flags(crate::collector::CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(data_dir(), std::fs::Permissions::from_mode(0o755));
        // world writable + sticky: users cannot delete each other's requests
        // (Linux narrows this to the request group, see linux::secure_requests_dir)
        let _ = std::fs::set_permissions(requests_dir(), std::fs::Permissions::from_mode(0o1777));
    }
}

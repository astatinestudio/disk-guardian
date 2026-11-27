// Disk Guardian — cross-platform desktop app (Windows, macOS, Linux).
//
//   disk-guardian                      the app (tray icon, window, floating widget)
//   disk-guardian --minimized          start in the tray (autostart)
//   disk-guardian --service            collector service (Windows service / launchd / systemd, as admin / root)
//   disk-guardian --install-service    register + start the collector service (admin / root)
//   disk-guardian --uninstall-service  remove it
//   disk-guardian --once               read every disk once and print the raw JSON (admin / root)
//   disk-guardian --clear-explorer     Windows: remove the health labels / icons from File Explorer
//   disk-guardian --check-update       print what updates.json offers this installation
//   disk-guardian --download-update    download + verify that update (no install)

// No console window in release builds on Windows (also used by the service).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod collector;
#[cfg(windows)]
mod explorer;
#[cfg(target_os = "linux")]
mod linux;
mod paths;
mod service;
#[cfg(windows)]
mod taskbar;
mod tray_icon;
mod updater;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |flag: &str| args.iter().any(|a| a == flag);

    if has("--service") {
        service::run();
    } else if has("--install-service") {
        let r = service::install();
        if let Err(e) = &r {
            collector::log(&format!("install failed: {e}"));
        }
        std::process::exit(if r.is_ok() { 0 } else { 1 });
    } else if has("--uninstall-service") {
        std::process::exit(if service::uninstall().is_ok() { 0 } else { 1 });
    } else if has("--clear-explorer") {
        #[cfg(windows)]
        explorer::clear_all();
    } else if has("--check-update") {
        updater::print_check();
    } else if has("--download-update") {
        updater::print_download();
    } else if has("--once") {
        collector::once();
    } else {
        app::run(has("--minimized"));
    }
}

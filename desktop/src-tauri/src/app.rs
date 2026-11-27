//! The desktop app: main window, floating widget, tray icon, settings.
//! It never needs admin rights; it reads the collector's state file and drops
//! request files (refresh / self-test) for it.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use crate::{paths, service, tray_icon};

const TRAY_ID: &str = "disk-guardian";
const WIDGET_WIDTH: f64 = 320.0;

pub struct Shared {
    settings: Mutex<Value>,
    settings_path: PathBuf,
    settings_dirty: AtomicBool,
    lang: Mutex<String>,
    widget_item: Mutex<Option<CheckMenuItem<Wry>>>,
    /// width of the taskbar widget in logical pixels (set by taskbar.js)
    taskbar_width: Mutex<f64>,
}

fn default_settings() -> Value {
    json!({
        "language": "auto",
        "temp-unit": "C",
        "disk-aliases": {},
        "hidden-disks": [],
        "default-disk": "",
        // On Linux the GNOME Shell extension already shows temperatures in the panel.
        "tray-enabled": !cfg!(target_os = "linux"),
        "tray-mode": "max",
        "float-enabled": false,
        "float-x": -1,
        "float-y": -1,
        "float-compact": false,
        "float-expanded": false,
        "float-opacity": 94,
        "float-locked": false,
        // Windows: temperatures inside the taskbar, left of the clock
        "taskbar-enabled": cfg!(windows),
        // Windows: health label + badge on the drives in File Explorer ("This PC")
        "explorer-health": cfg!(windows),
        "autostart": false,
        // updates.json is checked at start and every 6 hours (js/updates.js)
        "update-check": true,
        "update-dismissed": "",
        "announcements-seen": [],
        "temp-warn-hdd": 50, "temp-crit-hdd": 58,
        "temp-warn-ssd": 60, "temp-crit-ssd": 70,
        "temp-warn-nvme": 65, "temp-crit-nvme": 78,
    })
}

fn load_settings(path: &PathBuf) -> Value {
    let mut s = default_settings();
    if let Ok(Value::Object(saved)) = fs::read_to_string(path).map_err(|_| ()).and_then(|t| serde_json::from_str(&t).map_err(|_| ())) {
        for (k, v) in saved {
            s[k] = v;
        }
    }
    s
}

fn save_settings(shared: &Shared) {
    let text = serde_json::to_string_pretty(&*shared.settings.lock().unwrap()).unwrap_or_default();
    if let Some(dir) = shared.settings_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&shared.settings_path, text);
}

fn setting_bool(app: &AppHandle, key: &str) -> bool {
    app.state::<Shared>().settings.lock().unwrap()[key].as_bool().unwrap_or(false)
}

// ------------------------------------------------------------------ state file

fn read_state() -> Value {
    let path = paths::state_file();
    let base = json!({"path": path, "platform": std::env::consts::OS});
    let mut v = base;
    match fs::read_to_string(&path) {
        Ok(text) => {
            v["status"] = json!("ok");
            v["text"] = json!(text);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => v["status"] = json!("missing"),
        Err(e) => {
            v["status"] = json!("error");
            v["error"] = json!(e.to_string());
        }
    }
    v
}

// ------------------------------------------------------------------ tray

/// English texts of the tray; TRAY_TEXTS holds them in the same order per UI language
/// (same wording as extension/lib/locales/*.js).
const TRAY_KEYS: [&str; 5] = ["Open Disk Guardian", "Floating widget", "Refresh now", "Quit", "Collector service is not running"];

const TRAY_TEXTS: &[(&str, [&str; 5])] = &[
    ("ar", ["فتح صحة الأقراص", "الأداة العائمة", "تحديث الآن", "خروج", "خدمة الجمع لا تعمل"]),
    ("de", ["Festplattenzustand öffnen", "Schwebendes Widget", "Jetzt aktualisieren", "Beenden", "Der Sammeldienst läuft nicht"]),
    ("es", ["Abrir Salud del disco", "Widget flotante", "Actualizar ahora", "Salir", "El servicio recolector no se está ejecutando"]),
    ("fa", ["باز کردن سلامت دیسک‌ها", "ویجت شناور", "به‌روزرسانی فوری", "خروج", "سرویس جمع‌آوری اطلاعات اجرا نمی‌شود"]),
    ("fr", ["Ouvrir Santé des disques", "Widget flottant", "Actualiser maintenant", "Quitter", "Le service de collecte ne fonctionne pas"]),
    ("hi", ["डिस्क स्वास्थ्य खोलें", "फ़्लोटिंग विजेट", "अभी रीफ़्रेश करें", "बाहर निकलें", "कलेक्टर सेवा नहीं चल रही है"]),
    ("id", ["Buka Kesehatan Disk", "Widget mengambang", "Segarkan sekarang", "Keluar", "Layanan pengumpul tidak berjalan"]),
    ("it", ["Apri Salute dei dischi", "Widget fluttuante", "Aggiorna ora", "Esci", "Il servizio di raccolta non è in esecuzione"]),
    ("ja", ["ディスクヘルスを開く", "フローティングウィジェット", "今すぐ更新", "終了", "収集サービスが実行されていません"]),
    ("ko", ["디스크 상태 열기", "플로팅 위젯", "지금 새로 고침", "종료", "수집 서비스가 실행 중이 아닙니다"]),
    ("nl", ["Schijfgezondheid openen", "Zwevende widget", "Nu vernieuwen", "Afsluiten", "De verzamelservice draait niet"]),
    ("pl", ["Otwórz Kondycję dysków", "Pływający widżet", "Odśwież teraz", "Zakończ", "Usługa zbierająca nie działa"]),
    ("pt", ["Abrir Saúde do Disco", "Widget flutuante", "Atualizar agora", "Sair", "O serviço coletor não está em execução"]),
    ("ru", ["Открыть «Здоровье дисков»", "Плавающий виджет", "Обновить сейчас", "Выход", "Служба сбора данных не запущена"]),
    ("tr", ["Disk Sağlığı'nı aç", "Kayan pencere öğesi", "Şimdi yenile", "Çıkış", "Toplayıcı hizmeti çalışmıyor"]),
    ("uk", ["Відкрити «Стан дисків»", "Плаваючий віджет", "Оновити зараз", "Вихід", "Служба збору даних не запущена"]),
    ("vi", ["Mở Sức khỏe ổ đĩa", "Tiện ích nổi", "Làm mới ngay", "Thoát", "Dịch vụ thu thập không chạy"]),
    ("zh", ["打开磁盘健康", "悬浮小部件", "立即刷新", "退出", "收集服务未运行"]),
];

fn tr(app: &AppHandle, key: &'static str) -> &'static str {
    let lang = app.state::<Shared>().lang.lock().unwrap().clone();
    let i = TRAY_KEYS.iter().position(|k| *k == key);
    match (i, TRAY_TEXTS.iter().find(|(l, _)| *l == lang)) {
        (Some(i), Some((_, texts))) => texts[i],
        _ => key,
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>)> {
    let open = MenuItem::with_id(app, "open", tr(app, "Open Disk Guardian"), true, None::<&str>)?;
    let widget = CheckMenuItem::with_id(app, "widget", tr(app, "Floating widget"), true,
        setting_bool(app, "float-enabled"), None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", tr(app, "Refresh now"), true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", tr(app, "Quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &widget, &refresh, &sep, &quit])?;
    Ok((menu, widget))
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let (menu, widget_item) = build_menu(app)?;
    *app.state::<Shared>().widget_item.lock().unwrap() = Some(widget_item);
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Disk Guardian")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app, None),
            "widget" => {
                let on = !setting_bool(app, "float-enabled");
                apply_patch(app, json!({"float-enabled": on}));
            }
            "refresh" => {
                let _ = write_request(&json!({"action": "refresh"}));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle(), None);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    update_tray(app, &read_state());
    Ok(())
}

fn rebuild_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok((menu, item)) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
            *app.state::<Shared>().widget_item.lock().unwrap() = Some(item);
        }
    }
}

fn temp_level(settings: &Value, disk: &Value, t: i64) -> &'static str {
    let class = if disk["kind"] == "nvme" { "nvme" } else if disk["media"] == "hdd" { "hdd" } else { "ssd" };
    let warn = settings[format!("temp-warn-{class}")].as_i64().unwrap_or(60);
    let crit = settings[format!("temp-crit-{class}")].as_i64().unwrap_or(70);
    if t >= crit { "crit" } else if t >= warn { "warn" } else { "ok" }
}

fn display_name(settings: &Value, disk: &Value) -> String {
    let key = disk["key"].as_str().unwrap_or("");
    if let Some(alias) = settings["disk-aliases"][key].as_str().filter(|s| !s.is_empty()) {
        return alias.to_string();
    }
    disk["model"].as_str()
        .or_else(|| disk["raw"]["model_name"].as_str())
        .or_else(|| disk["name"].as_str())
        .unwrap_or("?")
        .trim()
        .to_string()
}

/// Panel-like summary: hottest disk (or the default disk) in the icon / title,
/// every disk in the tooltip.
fn update_tray(app: &AppHandle, state: &Value) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let settings = app.state::<Shared>().settings.lock().unwrap().clone();
    let fahrenheit = settings["temp-unit"] == "F";
    let conv = |c: i64| if fahrenheit { (c as f64 * 9.0 / 5.0 + 32.0).round() as i64 } else { c };
    let unit = if fahrenheit { "°F" } else { "°C" };
    let parsed: Value = state["text"].as_str().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null);
    let hidden: Vec<&str> = settings["hidden-disks"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let disks: Vec<&Value> = parsed["disks"].as_array().map(|a| a.iter().collect()).unwrap_or_default();

    let mut lines = vec!["Disk Guardian".to_string()];
    let mut best: Option<(i64, &'static str)> = None;
    let default_key = settings["default-disk"].as_str().unwrap_or("");
    let by_default = settings["tray-mode"] == "default" && disks.iter().any(|d| d["key"] == default_key);
    for d in &disks {
        let key = d["key"].as_str().unwrap_or("");
        if hidden.contains(&key) {
            continue;
        }
        let name = display_name(&settings, d);
        match d["temperature"]["current"].as_i64() {
            Some(t) => {
                let level = temp_level(&settings, d, t);
                lines.push(format!("{name}: {}{unit}", conv(t)));
                let pick = if by_default { key == default_key } else { best.map(|b| t > b.0).unwrap_or(true) };
                if pick {
                    best = Some((t, level));
                }
            }
            None if d["temperature"]["standby"] == true => lines.push(format!("{name}: 💤")),
            None => lines.push(format!("{name}: —")),
        }
    }
    if state["status"] != "ok" {
        lines.push(tr(app, "Collector service is not running").to_string());
    }
    let _ = tray.set_tooltip(Some(lines.join("\n")));

    #[cfg(windows)]
    {
        let img = match best {
            Some((t, level)) => Some(tray_icon::render(&conv(t).to_string(), level)),
            None => app.default_window_icon().cloned(),
        };
        let _ = tray.set_icon(img);
    }
    #[cfg(not(windows))]
    {
        let title = best.map(|(t, _)| format!("{}°", conv(t))).unwrap_or_default();
        let _ = tray.set_title(Some(title));
        let _ = tray_icon::level_color; // the colored icon is only drawn on Windows
    }
}

// ------------------------------------------------------------------ windows

fn url_encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn show_main(app: &AppHandle, disk: Option<String>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(key) = disk {
            let _ = app.emit_to("main", "select-disk", key);
        }
    } else {
        // a new window would miss the event: pass the disk in the URL instead
        let url = match disk {
            Some(key) => format!("index.html#disk={}", url_encode(&key)),
            None => "index.html".to_string(),
        };
        // own title bar (index.html .topbar): no system frame on Windows / Linux,
        // on macOS the traffic lights float over the page
        let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
            .title("Disk Guardian")
            .inner_size(1100.0, 740.0)
            .min_inner_size(780.0, 540.0)
            .center();
        #[cfg(target_os = "macos")]
        let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.decorations(false).shadow(true);
        let _ = builder.build();
    }
}

fn open_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("widget") {
        let _ = w.show();
        return;
    }
    let (x, y) = {
        let s = app.state::<Shared>();
        let s = s.settings.lock().unwrap();
        (s["float-x"].as_f64().unwrap_or(-1.0), s["float-y"].as_f64().unwrap_or(-1.0))
    };
    let (x, y) = if x >= 0.0 && y >= 0.0 {
        (x, y)
    } else {
        // top right corner of the primary monitor
        match app.primary_monitor().ok().flatten() {
            Some(m) => {
                let sf = m.scale_factor();
                let pos = m.position().to_logical::<f64>(sf);
                let size = m.size().to_logical::<f64>(sf);
                (pos.x + size.width - WIDGET_WIDTH - 32.0, pos.y + 64.0)
            }
            None => (64.0, 64.0),
        }
    };
    let built = WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("widget.html".into()))
        .title("Disk Guardian widget")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible_on_all_workspaces(true)
        .inner_size(WIDGET_WIDTH, 480.0)
        .position(x, y)
        .visible(false) // shown by widget.js once the content is laid out
        .build();
    if let Err(e) = built {
        eprintln!("cannot open the floating widget: {e}");
    }
}

// ------------------------------------------------------------------ taskbar (Windows)

#[cfg(windows)]
fn place_taskbar(app: &AppHandle) {
    let Some(w) = app.get_webview_window("taskbar") else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    let sf = w.scale_factor().unwrap_or(1.0);
    let width = (*app.state::<Shared>().taskbar_width.lock().unwrap() * sf).ceil() as i32;
    crate::taskbar::place(hwnd.0 as isize, width.max(24));
}

fn open_taskbar(app: &AppHandle) {
    #[cfg(windows)]
    {
        if app.get_webview_window("taskbar").is_some() {
            return;
        }
        let built = WebviewWindowBuilder::new(app, "taskbar", WebviewUrl::App("taskbar.html".into()))
            .title("Disk Guardian taskbar")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .inner_size(90.0, 40.0)
            .visible(false) // shown by place_taskbar once docked
            .build();
        match built {
            Ok(_) => place_taskbar(app),
            Err(e) => eprintln!("cannot open the taskbar widget: {e}"),
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

fn close_taskbar(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("taskbar") {
        let _ = w.destroy();
    }
}

fn close_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("widget") {
        let _ = w.close();
    }
}

// ------------------------------------------------------------------ settings

/// Merge `patch` into the settings, persist, apply and broadcast.
fn apply_patch(app: &AppHandle, patch: Value) -> Value {
    let shared = app.state::<Shared>();
    let (old, new) = {
        let mut s = shared.settings.lock().unwrap();
        let old = s.clone();
        if let Value::Object(p) = patch {
            for (k, v) in p {
                s[k] = v;
            }
        }
        (old, s.clone())
    };
    save_settings(&shared);

    let changed = |k: &str| old[k] != new[k];
    if changed("tray-enabled") {
        if new["tray-enabled"] == true {
            let _ = create_tray(app);
        } else {
            let _ = app.remove_tray_by_id(TRAY_ID);
        }
    }
    if changed("float-enabled") {
        if new["float-enabled"] == true { open_widget(app) } else { close_widget(app) }
    }
    if changed("taskbar-enabled") {
        if new["taskbar-enabled"] == true { open_taskbar(app) } else { close_taskbar(app) }
    }
    if let Some(item) = shared.widget_item.lock().unwrap().as_ref() {
        let _ = item.set_checked(new["float-enabled"] == true);
    }
    if changed("autostart") {
        let al = app.autolaunch();
        let _ = if new["autostart"] == true { al.enable() } else { al.disable() };
    }
    #[cfg(windows)]
    if changed("explorer-health") && new["explorer-health"] != true {
        crate::explorer::clear_all();
    }
    update_tray(app, &read_state());
    let _ = app.emit("settings-changed", new.clone());
    if changed("language") || changed("explorer-health") {
        // the windows re-send the File Explorer labels (new language / turned on)
        let _ = app.emit("state-changed", ());
    }
    new
}

fn write_request(req: &Value) -> Result<(), String> {
    let dir = paths::requests_dir();
    let name = format!("req-{}-{}.json", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    fs::write(dir.join(name), req.to_string()).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission".to_string(),
        std::io::ErrorKind::NotFound => "not-running".to_string(),
        _ => e.to_string(),
    })
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn get_state() -> Value {
    read_state()
}

#[tauri::command]
fn get_settings(shared: tauri::State<'_, Shared>) -> Value {
    shared.settings.lock().unwrap().clone()
}

#[tauri::command]
async fn set_settings(app: AppHandle, patch: Value) -> Result<Value, String> {
    Ok(apply_patch(&app, patch))
}

/// The UI resolved the language ("auto" -> system language); translate the tray menu.
#[tauri::command]
fn set_ui_language(app: AppHandle, lang: String) {
    let shared = app.state::<Shared>();
    let changed = {
        let mut l = shared.lang.lock().unwrap();
        let changed = *l != lang;
        *l = lang;
        changed
    };
    if changed {
        rebuild_tray_menu(&app);
        update_tray(&app, &read_state());
    }
}

#[tauri::command]
fn send_request(request: Value) -> Result<(), String> {
    write_request(&request)
}

#[tauri::command]
async fn install_service() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(service::install_elevated).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn service_running() -> bool {
    tauri::async_runtime::spawn_blocking(service::is_running).await.unwrap_or(false)
}

#[tauri::command]
async fn show_main_window(app: AppHandle, disk: Option<String>) {
    show_main(&app, disk);
}

/// taskbar.js measured its content (logical pixels): resize + re-dock.
#[tauri::command]
fn taskbar_resize(app: AppHandle, width: f64) {
    *app.state::<Shared>().taskbar_width.lock().unwrap() = width;
    #[cfg(windows)]
    place_taskbar(&app);
}

#[tauri::command]
fn taskbar_light() -> bool {
    #[cfg(windows)]
    return crate::taskbar::light_theme();
    #[cfg(not(windows))]
    false
}

/// The UI computed every drive letter's health (normalize.js): show it in File Explorer.
#[cfg(windows)]
#[tauri::command]
async fn set_explorer_health(app: AppHandle, drives: Vec<crate::explorer::Drive>) {
    if !setting_bool(&app, "explorer-health") {
        return;
    }
    let _ = tauri::async_runtime::spawn_blocking(move || crate::explorer::apply(drives)).await;
}

#[cfg(not(windows))]
#[tauri::command]
fn set_explorer_health(drives: Value) {
    let _ = drives;
}

#[tauri::command]
fn platform_info() -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "service": if cfg!(target_os = "linux") { "disk-guardian" } else { service::SERVICE_NAME },
    })
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ------------------------------------------------------------------ run

/// Re-reads the state file when the collector rewrites it, updates the tray and
/// tells the windows; also persists settings changed by widget dragging.
fn spawn_watcher(app: AppHandle) {
    thread::spawn(move || {
        let mut last = String::new();
        loop {
            let path = paths::state_file();
            let sig = match fs::metadata(&path) {
                Ok(m) => format!("{:?}-{}", m.modified().ok(), m.len()),
                Err(e) => format!("{:?}", e.kind()),
            };
            if sig != last {
                last = sig;
                update_tray(&app, &read_state());
                let _ = app.emit("state-changed", ());
            }
            let shared = app.state::<Shared>();
            if shared.settings_dirty.swap(false, Ordering::SeqCst) {
                save_settings(&shared);
            }
            // keep the taskbar widget docked (Explorer restarts, taskbar / DPI changes)
            #[cfg(windows)]
            place_taskbar(&app);
            thread::sleep(Duration::from_millis(1000));
        }
    });
}

pub fn run(minimized: bool) {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app, None)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .invoke_handler(tauri::generate_handler![
            get_state, get_settings, set_settings, set_ui_language, send_request, install_service,
            service_running, show_main_window, platform_info, quit_app, taskbar_resize, taskbar_light,
            set_explorer_health, crate::updater::check_update, crate::updater::install_update, crate::updater::open_url
        ])
        .setup(move |app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            // settings saved under the app's former name (Disk Health)
            if !settings_path.exists() {
                if let Some(old) = settings_path.parent().and_then(|d| d.parent())
                    .map(|d| d.join("io.github.linuxhealth.DiskHealth").join("settings.json"))
                    .filter(|p| p.is_file())
                {
                    if let Some(dir) = settings_path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::copy(old, &settings_path);
                }
            }
            let settings = load_settings(&settings_path);
            // "auto" is resolved by the UI (navigator.languages), which then calls set_ui_language
            let lang = settings["language"].as_str().filter(|l| *l != "auto").unwrap_or("en");
            app.manage(Shared {
                settings: Mutex::new(settings.clone()),
                settings_path,
                settings_dirty: AtomicBool::new(false),
                lang: Mutex::new(lang.to_string()),
                widget_item: Mutex::new(None),
                taskbar_width: Mutex::new(90.0),
            });
            let handle = app.handle().clone();
            if settings["tray-enabled"] == true {
                if let Err(e) = create_tray(&handle) {
                    eprintln!("tray icon not available: {e}");
                }
            }
            if settings["float-enabled"] == true {
                open_widget(&handle);
            }
            if settings["taskbar-enabled"] == true {
                open_taskbar(&handle);
            }
            let background = app.tray_by_id(TRAY_ID).is_some() || settings["float-enabled"] == true || settings["taskbar-enabled"] == true;
            if !minimized || !background {
                show_main(&handle, None);
            }
            spawn_watcher(handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                // keep running in the tray / with the widget
                let app = window.app_handle();
                if app.tray_by_id(TRAY_ID).is_some() || setting_bool(app, "float-enabled") || app.get_webview_window("taskbar").is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            WindowEvent::Moved(pos) if window.label() == "widget" => {
                let sf = window.scale_factor().unwrap_or(1.0);
                let p = pos.to_logical::<f64>(sf);
                let shared = window.app_handle().state::<Shared>();
                let mut s = shared.settings.lock().unwrap();
                s["float-x"] = json!(p.x.round());
                s["float-y"] = json!(p.y.round());
                shared.settings_dirty.store(true, Ordering::SeqCst);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building the Disk Guardian app");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { code: None, api, .. } => {
            // last window closed: stay alive while the tray icon exists
            if app.tray_by_id(TRAY_ID).is_some() {
                api.prevent_exit();
            }
        }
        // nobody keeps the Explorer labels up to date once the app is gone
        #[cfg(windows)]
        RunEvent::Exit => crate::explorer::clear_all(),
        _ => {}
    });
}

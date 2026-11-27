//! Windows: temperatures inside the taskbar.
//!
//! Windows 11 has no API for taskbar widgets (desk bands are gone), so — like
//! TrafficMonitor — the small "taskbar" window is made a child of the taskbar
//! (Shell_TrayWnd) and placed left of the notification area (TrayNotifyWnd).
//! app.rs calls place() again every 2 s, which re-docks the window after an
//! Explorer restart and follows taskbar size / DPI changes.

use std::mem::zeroed;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetParent, GetWindowRect, SetParent, SetWindowPos, GWL_STYLE, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, WS_CAPTION, WS_CHILD, WS_POPUP,
    WS_THICKFRAME,
};

// The *LongPtr functions exist only on 64-bit Windows; 32-bit uses the plain ones.
#[cfg(target_pointer_width = "64")]
use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW as get_style_raw, SetWindowLongPtrW as set_style_raw};
#[cfg(target_pointer_width = "32")]
use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongW as get_style_raw, SetWindowLongW as set_style_raw};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Dock `hwnd` into the taskbar with the given width (physical pixels).
/// Returns false when there is no horizontal taskbar to dock into.
pub fn place(hwnd: isize, width: i32) -> bool {
    let tray_class = wide("Shell_TrayWnd");
    let notify_class = wide("TrayNotifyWnd");
    // SAFETY: plain Win32 calls on window handles; every handle is checked before use
    // and the RECTs are local out-parameters.
    unsafe {
        let taskbar = FindWindowW(tray_class.as_ptr(), null());
        if taskbar.is_null() {
            return false;
        }
        let mut tb: RECT = zeroed();
        if GetWindowRect(taskbar, &mut tb) == 0 {
            return false;
        }
        let (tb_w, tb_h) = (tb.right - tb.left, tb.bottom - tb.top);
        if tb_w <= tb_h {
            return false; // vertical taskbar (Windows 10 only): not supported
        }
        let h = hwnd as HWND;
        if GetParent(h) != taskbar {
            let style = get_style_raw(h, GWL_STYLE) as u32;
            let child = (style & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
            set_style_raw(h, GWL_STYLE, child as _);
            if SetParent(h, taskbar).is_null() {
                return false;
            }
        }
        let notify = FindWindowExW(taskbar, null_mut(), notify_class.as_ptr(), null());
        let right = if notify.is_null() {
            tb_w - 280
        } else {
            let mut nr: RECT = zeroed();
            GetWindowRect(notify, &mut nr);
            nr.left - tb.left
        };
        let x = (right - width - 6).max(0);
        SetWindowPos(h, null_mut(), x, 0, width, tb_h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW) != 0
    }
}

/// Does the taskbar use the light theme? (Settings → Personalization → Colors → Windows mode)
pub fn light_theme() -> bool {
    let mut cmd = std::process::Command::new("reg");
    cmd.args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "SystemUsesLightTheme"]);
    crate::collector::hide_window(&mut cmd);
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("0x1"))
        .unwrap_or(false)
}

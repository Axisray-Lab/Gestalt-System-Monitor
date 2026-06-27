//! Gestalt System Monitor desktop dock.
//!
//! The window loads the monitor's bottom-strip "deck" UI and is docked to the
//! bottom edge of the primary monitor as a Windows **AppBar** — i.e. it is
//! integrated into the desktop layout (the shell reserves that edge of the work
//! area, like a second taskbar), so maximized windows stop above the dock instead
//! of being covered by it. This is deliberately NOT a floating always-on-top
//! overlay, which would either cover other windows or get buried behind them.

/// Height of the docked strip, in physical pixels. Kept in sync with the window
/// height in `tauri.conf.json`.
#[cfg(target_os = "windows")]
const DOCK_HEIGHT_PX: i32 = 320;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, Monitor};

const DESKTOP_SETTINGS_FILE: &str = "desktop-settings.json";
const LOCAL_SERVICE_PORT: u16 = 7788;
const LOCAL_SERVICE_CHECK_INTERVAL: Duration = Duration::from_secs(3);
const DEFAULT_LAUNCH_SOURCE: &str = "standalone";

static LOCAL_SERVICE_CHILD: Mutex<Option<Child>> = Mutex::new(None);
// Set true once the persisted launch source has been pushed to a live agent this
// session; reset on (re)spawn so a fresh agent re-receives a non-default choice.
static LAUNCH_SOURCE_APPLIED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    monitor_id: Option<String>,
    // Dev launch source: "standalone" (repo editor build, default) | "steam".
    // Stored in the OS app-config dir (outside the repo); the real exe path lives in
    // the gitignored Monitor/.env.local, never here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLaunchSettings {
    /// The persisted choice shown in the dock toggle.
    source: String,
    /// Whether the running agent acknowledged the choice this call.
    applied: bool,
    /// Human-readable detail: resolved exe, or why it could not apply.
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMonitorInfo {
    id: String,
    label: String,
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    primary: bool,
    selected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMonitorSettings {
    selected_monitor_id: String,
    monitors: Vec<DesktopMonitorInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalServiceStatus {
    Current,
    Stale,
    Offline,
}

#[cfg(target_os = "windows")]
mod appbar {
    use std::{
        mem,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::UI::Shell::{
        SHAppBarMessage, ABE_BOTTOM, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS,
        ABN_FULLSCREENAPP, ABN_POSCHANGED, ABN_WINDOWARRANGE, APPBARDATA,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW,
        SetWindowPos, GWLP_WNDPROC, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW, WM_APP,
        WM_DISPLAYCHANGE, WM_SETTINGCHANGE, WNDPROC,
    };

    #[derive(Clone, Copy)]
    pub struct TargetMonitorRect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[derive(Clone, Copy)]
    struct AppbarState {
        hwnd_raw: isize,
        height_px: i32,
        registered: bool,
        subclassed_hwnd_raw: isize,
        old_wndproc_raw: isize,
        target_monitor_rect: Option<TargetMonitorRect>,
    }

    static APPBAR_STATE: Mutex<AppbarState> = Mutex::new(AppbarState {
        hwnd_raw: 0,
        height_px: 0,
        registered: false,
        subclassed_hwnd_raw: 0,
        old_wndproc_raw: 0,
        target_monitor_rect: None,
    });
    static POSITIONING: AtomicBool = AtomicBool::new(false);

    // A private callback message id used by Windows Shell AppBar notifications.
    const APPBAR_CALLBACK: u32 = WM_APP + 0x42;

    fn appbar_data(hwnd: HWND) -> APPBARDATA {
        APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: hwnd,
            uCallbackMessage: APPBAR_CALLBACK,
            uEdge: ABE_BOTTOM,
            rc: RECT::default(),
            lParam: LPARAM(0),
        }
    }

    fn primary_monitor_rect(hwnd: HWND) -> RECT {
        unsafe {
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(hmon, &mut mi).as_bool() {
                mi.rcMonitor
            } else {
                RECT {
                    left: 0,
                    top: 0,
                    right: 1280,
                    bottom: 800,
                }
            }
        }
    }

    /// Register a bottom-edge AppBar reserving `height_px` of the primary monitor's
    /// work area, then move the window into the reserved strip.
    pub fn register(hwnd_raw: isize, height_px: i32) {
        let previous_registered_hwnd = {
            let mut state = APPBAR_STATE.lock().unwrap();
            let previous = if state.registered && state.hwnd_raw != 0 && state.hwnd_raw != hwnd_raw
            {
                Some(state.hwnd_raw)
            } else {
                None
            };
            if previous.is_some() {
                state.registered = false;
                state.hwnd_raw = 0;
            }
            state.hwnd_raw = hwnd_raw;
            state.height_px = height_px;
            previous
        };

        if let Some(previous) = previous_registered_hwnd {
            remove_hwnd(HWND(previous as _));
        }

        install_wndproc(hwnd_raw);
        ensure_registered();
        reassert();
    }

    pub fn set_target_monitor(rect: TargetMonitorRect) {
        APPBAR_STATE.lock().unwrap().target_monitor_rect = Some(rect);
        reassert();
    }

    /// Re-assert both the Shell work-area reservation and the actual window rect.
    /// Fullscreen apps and display changes can leave the Shell reservation intact
    /// while the HWND has drifted above the reserved strip; this keeps them in sync.
    pub fn reassert() {
        if POSITIONING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let state = *APPBAR_STATE.lock().unwrap();
        if state.registered && state.hwnd_raw != 0 && state.height_px > 0 {
            unsafe {
                position_hwnd(
                    HWND(state.hwnd_raw as _),
                    state.height_px,
                    state.target_monitor_rect,
                );
            }
        }

        POSITIONING.store(false, Ordering::SeqCst);
    }

    /// Deregister the appbar so the reserved desktop space is released. MUST run on
    /// exit — otherwise the work area stays shrunk until the shell restarts.
    pub fn remove() {
        let state = {
            let mut state = APPBAR_STATE.lock().unwrap();
            let snapshot = *state;
            state.hwnd_raw = 0;
            state.height_px = 0;
            state.registered = false;
            state.subclassed_hwnd_raw = 0;
            state.old_wndproc_raw = 0;
            state.target_monitor_rect = None;
            snapshot
        };

        if state.registered && state.hwnd_raw != 0 {
            remove_hwnd(HWND(state.hwnd_raw as _));
        }

        if state.subclassed_hwnd_raw != 0 && state.old_wndproc_raw != 0 {
            unsafe {
                let _ = SetWindowLongPtrW(
                    HWND(state.subclassed_hwnd_raw as _),
                    GWLP_WNDPROC,
                    state.old_wndproc_raw,
                );
            }
        }
    }

    fn ensure_registered() {
        let (hwnd_raw, should_register) = {
            let mut state = APPBAR_STATE.lock().unwrap();
            if state.hwnd_raw == 0 || state.registered {
                (state.hwnd_raw, false)
            } else {
                state.registered = true;
                (state.hwnd_raw, true)
            }
        };

        if should_register {
            unsafe {
                let hwnd = HWND(hwnd_raw as _);
                let mut abd = appbar_data(hwnd);
                SHAppBarMessage(ABM_NEW, &mut abd);
            }
        }
    }

    fn install_wndproc(hwnd_raw: isize) {
        let mut state = APPBAR_STATE.lock().unwrap();
        if state.subclassed_hwnd_raw == hwnd_raw {
            return;
        }

        if state.subclassed_hwnd_raw != 0 && state.old_wndproc_raw != 0 {
            unsafe {
                let _ = SetWindowLongPtrW(
                    HWND(state.subclassed_hwnd_raw as _),
                    GWLP_WNDPROC,
                    state.old_wndproc_raw,
                );
            }
        }

        unsafe {
            let old = GetWindowLongPtrW(HWND(hwnd_raw as _), GWLP_WNDPROC);
            let _ = SetWindowLongPtrW(
                HWND(hwnd_raw as _),
                GWLP_WNDPROC,
                appbar_wndproc as *const () as isize,
            );
            state.subclassed_hwnd_raw = hwnd_raw;
            state.old_wndproc_raw = old;
        }
    }

    unsafe fn position_hwnd(
        hwnd: HWND,
        height_px: i32,
        target_monitor_rect: Option<TargetMonitorRect>,
    ) {
        let mut abd = appbar_data(hwnd);

        // 1) Propose a full-width strip along the bottom of the primary monitor.
        let mon = target_monitor_rect
            .map(|rect| RECT {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
            })
            .unwrap_or_else(|| primary_monitor_rect(hwnd));
        abd.uEdge = ABE_BOTTOM;
        abd.rc = RECT {
            left: mon.left,
            top: mon.bottom - height_px,
            right: mon.right,
            bottom: mon.bottom,
        };

        // 2) Let the shell adjust for the taskbar / other appbars, then re-pin
        //    our width and height against whatever bottom it gave back.
        SHAppBarMessage(ABM_QUERYPOS, &mut abd);
        abd.rc.left = mon.left;
        abd.rc.right = mon.right;
        abd.rc.top = abd.rc.bottom - height_px;

        // 3) Commit the reservation (this is what shrinks the work area).
        SHAppBarMessage(ABM_SETPOS, &mut abd);

        // 4) Place the window inside the reserved rectangle. Even when the work
        //    area is still reserved, fullscreen transitions can drift the HWND.
        let target_width = abd.rc.right - abd.rc.left;
        let target_height = abd.rc.bottom - abd.rc.top;
        let mut current = RECT::default();
        let already_there = GetWindowRect(hwnd, &mut current).is_ok()
            && current.left == abd.rc.left
            && current.top == abd.rc.top
            && current.right == abd.rc.right
            && current.bottom == abd.rc.bottom;

        if !already_there {
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                abd.rc.left,
                abd.rc.top,
                target_width,
                target_height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    fn remove_hwnd(hwnd: HWND) {
        unsafe {
            let mut abd = appbar_data(hwnd);
            SHAppBarMessage(ABM_REMOVE, &mut abd);
        }
    }

    unsafe extern "system" fn appbar_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == APPBAR_CALLBACK {
            match wparam.0 as u32 {
                ABN_POSCHANGED | ABN_FULLSCREENAPP | ABN_WINDOWARRANGE => reassert(),
                _ => {}
            }
        } else if matches!(msg, WM_DISPLAYCHANGE | WM_SETTINGCHANGE) {
            reassert();
        }

        let old_wndproc_raw = APPBAR_STATE.lock().unwrap().old_wndproc_raw;
        if old_wndproc_raw != 0 {
            let old_wndproc: WNDPROC = mem::transmute(old_wndproc_raw);
            CallWindowProcW(old_wndproc, hwnd, msg, wparam, lparam)
        } else {
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }
}

#[cfg(target_os = "windows")]
mod single_instance {
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    /// Acquire a session-wide named mutex. Returns `false` if another dock instance
    /// already holds it (caller should exit to avoid stacking a 2nd AppBar). The
    /// handle is intentionally leaked so it stays held until the OS reclaims it on
    /// process exit (which also lets the next instance acquire cleanly).
    pub fn acquire() -> bool {
        unsafe {
            // The handle is deliberately never closed: HANDLE is a plain Copy value
            // with no RAII drop, so the mutex stays held for the whole process
            // lifetime and is released by the OS on exit.
            match CreateMutexW(None, true, w!("GestaltSystemMonitorDock_SingleInstance")) {
                Ok(_handle) => GetLastError() != ERROR_ALREADY_EXISTS,
                // If the mutex can't be created, don't block startup.
                Err(_) => true,
            }
        }
    }
}

fn monitor_id(monitor: &Monitor) -> String {
    let position = monitor.position();
    let size = monitor.size();
    let name = monitor
        .name()
        .map(|name| name.as_str())
        .unwrap_or("display");
    format!(
        "{}@{},{}:{}x{}",
        name, position.x, position.y, size.width, size.height
    )
}

fn monitor_label(index: usize, monitor: &Monitor, primary: bool) -> String {
    let position = monitor.position();
    let size = monitor.size();
    let prefix = monitor
        .name()
        .cloned()
        .unwrap_or_else(|| format!("屏幕 {}", index + 1));
    let primary_suffix = if primary { " · 主屏" } else { "" };
    format!(
        "{} · {}x{} @ {},{}{}",
        prefix, size.width, size.height, position.x, position.y, primary_suffix
    )
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("无法读取设置目录: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建设置目录: {err}"))?;
    Ok(dir.join(DESKTOP_SETTINGS_FILE))
}

fn load_desktop_settings(app: &AppHandle) -> DesktopSettings {
    let Ok(path) = settings_path(app) else {
        return DesktopSettings::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return DesktopSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_desktop_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw =
        serde_json::to_string_pretty(settings).map_err(|err| format!("无法序列化设置: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("无法保存设置: {err}"))
}

fn desktop_monitor_settings_for(
    app: &AppHandle,
    requested_monitor_id: Option<String>,
    strict: bool,
    persist: bool,
) -> Result<DesktopMonitorSettings, String> {
    let monitors = app
        .available_monitors()
        .map_err(|err| format!("无法枚举显示器: {err}"))?;
    if monitors.is_empty() {
        return Err("没有可用显示器".to_string());
    }

    let primary_id = app
        .primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(monitor_id);
    let requested = requested_monitor_id.or_else(|| load_desktop_settings(app).monitor_id);
    let selected_index = if let Some(id) = requested.as_deref() {
        match monitors
            .iter()
            .position(|monitor| monitor_id(monitor) == id)
        {
            Some(index) => index,
            None if strict => return Err("目标显示器已不可用".to_string()),
            None => primary_id
                .as_deref()
                .and_then(|id| {
                    monitors
                        .iter()
                        .position(|monitor| monitor_id(monitor) == id)
                })
                .unwrap_or(0),
        }
    } else {
        primary_id
            .as_deref()
            .and_then(|id| {
                monitors
                    .iter()
                    .position(|monitor| monitor_id(monitor) == id)
            })
            .unwrap_or(0)
    };

    let selected_monitor = &monitors[selected_index];
    let selected_monitor_id = monitor_id(selected_monitor);

    #[cfg(target_os = "windows")]
    {
        let position = selected_monitor.position();
        let size = selected_monitor.size();
        appbar::set_target_monitor(appbar::TargetMonitorRect {
            left: position.x,
            top: position.y,
            right: position.x + size.width as i32,
            bottom: position.y + size.height as i32,
        });
    }

    if persist {
        // Preserve other fields (e.g. launch_source) — only update the monitor id.
        let mut settings = load_desktop_settings(app);
        settings.monitor_id = Some(selected_monitor_id.clone());
        save_desktop_settings(app, &settings)?;
    }

    let monitors = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let id = monitor_id(monitor);
            let primary = primary_id.as_deref() == Some(id.as_str());
            let position = monitor.position();
            let size = monitor.size();
            DesktopMonitorInfo {
                selected: id == selected_monitor_id,
                label: monitor_label(index, monitor, primary),
                id,
                name: monitor.name().cloned(),
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale_factor: monitor.scale_factor(),
                primary,
            }
        })
        .collect();

    Ok(DesktopMonitorSettings {
        selected_monitor_id,
        monitors,
    })
}

#[tauri::command]
fn desktop_monitor_settings(app: AppHandle) -> Result<DesktopMonitorSettings, String> {
    desktop_monitor_settings_for(&app, None, false, false)
}

#[tauri::command]
fn desktop_set_monitor(
    app: AppHandle,
    monitor_id: String,
) -> Result<DesktopMonitorSettings, String> {
    desktop_monitor_settings_for(&app, Some(monitor_id), true, true)
}

// --- dev launch source (local standalone vs Steam) ----------------------------

fn normalize_launch_source(source: &str) -> String {
    match source.trim().to_lowercase().as_str() {
        "steam" => "steam".to_string(),
        _ => DEFAULT_LAUNCH_SOURCE.to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct AgentSourceResponse {
    ok: Option<bool>,
    #[serde(rename = "executablePath")]
    executable_path: Option<String>,
    error: Option<String>,
}

/// One-shot HTTP/1.1 request to the local agent over a TCP stream (the same loopback
/// transport `local_service_status` already uses). Returns the response BODY only.
fn agent_request(method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let mut stream = connect_localhost(LOCAL_SERVICE_PORT)?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(2000)));
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost:{port}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        method = method,
        path = path,
        port = LOCAL_SERVICE_PORT,
        len = body.len(),
        body = body,
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("写入本地服务失败: {err}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| format!("读取本地服务失败: {err}"))?;
    Ok(response
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default())
}

/// POST the chosen source to the running agent. Returns (applied, human detail).
fn push_launch_source(source: &str) -> (bool, String) {
    let payload = format!("{{\"source\":\"{source}\"}}");
    match agent_request("POST", "/launch/source", Some(&payload)) {
        Ok(body) => match serde_json::from_str::<AgentSourceResponse>(&body) {
            Ok(parsed) => {
                if parsed.ok.unwrap_or(false) {
                    let exe = parsed.executable_path.unwrap_or_default();
                    (true, if exe.is_empty() { "已应用".to_string() } else { exe })
                } else {
                    (
                        false,
                        parsed.error.unwrap_or_else(|| "本地服务拒绝了该启动源".to_string()),
                    )
                }
            }
            Err(_) => (false, "本地服务返回无法解析".to_string()),
        },
        Err(err) => (false, format!("本地服务未运行（已保存，下次启动生效）: {err}")),
    }
}

/// On startup / after a respawn, push a persisted non-default source to the agent.
/// Standalone is the agent's own default (via .env.local), so it needs no push.
fn apply_persisted_launch_source(app: &AppHandle) {
    if LAUNCH_SOURCE_APPLIED.load(Ordering::SeqCst) {
        return;
    }
    let source = load_desktop_settings(app)
        .launch_source
        .map(|s| normalize_launch_source(&s))
        .unwrap_or_else(|| DEFAULT_LAUNCH_SOURCE.to_string());
    if source == DEFAULT_LAUNCH_SOURCE {
        LAUNCH_SOURCE_APPLIED.store(true, Ordering::SeqCst);
        return;
    }
    if local_service_status(LOCAL_SERVICE_PORT) != LocalServiceStatus::Current {
        return; // agent not ready yet; retry next supervisor tick
    }
    let (ok, detail) = push_launch_source(&source);
    if ok {
        LAUNCH_SOURCE_APPLIED.store(true, Ordering::SeqCst);
        log::info!("applied persisted launch source '{source}': {detail}");
    } else {
        log::warn!("could not apply persisted launch source '{source}': {detail}");
    }
}

#[tauri::command]
fn desktop_launch_settings(app: AppHandle) -> Result<DesktopLaunchSettings, String> {
    let source = load_desktop_settings(&app)
        .launch_source
        .map(|s| normalize_launch_source(&s))
        .unwrap_or_else(|| DEFAULT_LAUNCH_SOURCE.to_string());
    let detail = match agent_request("GET", "/launch/source", None) {
        Ok(body) => serde_json::from_str::<AgentSourceResponse>(&body)
            .ok()
            .and_then(|r| r.executable_path.or(r.error))
            .unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(DesktopLaunchSettings {
        source,
        applied: LAUNCH_SOURCE_APPLIED.load(Ordering::SeqCst),
        detail,
    })
}

#[tauri::command]
fn desktop_set_launch_source(app: AppHandle, source: String) -> Result<DesktopLaunchSettings, String> {
    let normalized = normalize_launch_source(&source);
    let mut settings = load_desktop_settings(&app);
    settings.launch_source = Some(normalized.clone());
    save_desktop_settings(&app, &settings)?;
    let (applied, detail) = push_launch_source(&normalized);
    if applied {
        LAUNCH_SOURCE_APPLIED.store(true, Ordering::SeqCst);
    }
    Ok(DesktopLaunchSettings {
        source: normalized,
        applied,
        detail,
    })
}

fn ensure_local_service() -> Result<(), String> {
    reap_managed_local_service();
    // If we already have a live managed child (it may still be cold-starting and not
    // yet bound to the port), do NOT spawn a second tree — that was the duplicate-agent
    // bug where the slot was overwritten and the first tree orphaned.
    if LOCAL_SERVICE_CHILD.lock().unwrap().is_some() {
        return Ok(());
    }
    match local_service_status(LOCAL_SERVICE_PORT) {
        LocalServiceStatus::Current => return Ok(()),
        LocalServiceStatus::Stale => {
            stop_local_service_on_port(LOCAL_SERVICE_PORT)?;
            wait_for_local_service_to_close(LOCAL_SERVICE_PORT);
        }
        LocalServiceStatus::Offline => {}
    }

    if local_service_status(LOCAL_SERVICE_PORT) == LocalServiceStatus::Current {
        return Ok(());
    }

    spawn_local_service()
}

fn local_service_status(port: u16) -> LocalServiceStatus {
    let Ok(mut stream) = connect_localhost(port) else {
        return LocalServiceStatus::Offline;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let request =
        format!("GET /launcher HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return LocalServiceStatus::Offline;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return LocalServiceStatus::Offline;
    }

    if !response.contains("\"kind\":\"launcherStatus\"") {
        return LocalServiceStatus::Offline;
    }

    if response.contains("\"autoSave\"") && response.contains("\"batches\"") {
        LocalServiceStatus::Current
    } else {
        LocalServiceStatus::Stale
    }
}

fn connect_localhost(port: u16) -> Result<TcpStream, String> {
    let addrs = ("localhost", port)
        .to_socket_addrs()
        .map_err(|err| format!("无法解析本地服务地址: {err}"))?;
    for addr in addrs {
        if let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(350)) {
            return Ok(stream);
        }
    }
    Err("本地服务未监听".to_string())
}

fn spawn_local_service() -> Result<(), String> {
    let mut command = local_service_command()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = command
        .spawn()
        .map_err(|err| format!("无法启动本地服务: {err}"))?;
    *LOCAL_SERVICE_CHILD.lock().unwrap() = Some(child);
    // A freshly spawned agent starts on its default (standalone) source; re-push any
    // persisted non-default choice on the next supervisor tick.
    LAUNCH_SOURCE_APPLIED.store(false, Ordering::SeqCst);
    Ok(())
}

fn local_service_command() -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let root = dev_workspace_root()?;
        let mut command = Command::new(if cfg!(target_os = "windows") {
            "npm.cmd"
        } else {
            "npm"
        });
        command.current_dir(root).args(["run", "agent", "--"]);
        return Ok(command);
    }

    let exe = std::env::current_exe().map_err(|err| format!("无法定位程序目录: {err}"))?;
    let dir = exe.parent().ok_or_else(|| "无法定位程序目录".to_string())?;
    let sidecar = dir.join(if cfg!(target_os = "windows") {
        "gsm-agent.exe"
    } else {
        "gsm-agent"
    });
    if !sidecar.is_file() {
        return Err("本地服务组件缺失".to_string());
    }

    Ok(Command::new(sidecar))
}

fn dev_workspace_root() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|desktop| desktop.parent())
        .and_then(|packages| packages.parent())
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位工作区目录".to_string())
}

fn stop_managed_local_service() {
    if let Some(mut child) = LOCAL_SERVICE_CHILD.lock().unwrap().take() {
        // In dev the child is `npm.cmd run agent` (npm -> tsx -> node agent -> games);
        // child.kill() reaps only npm, orphaning the real agent (port 7788) and every
        // game it launched. Tree-kill first, then reap the wrapper zombie.
        stop_process_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
    LAUNCH_SOURCE_APPLIED.store(false, Ordering::SeqCst);
}

fn reap_managed_local_service() {
    let mut child_slot = LOCAL_SERVICE_CHILD.lock().unwrap();
    let Some(child) = child_slot.as_mut() else {
        return;
    };
    if matches!(child.try_wait(), Ok(Some(_))) {
        *child_slot = None;
    }
}

fn stop_local_service_on_port(port: u16) -> Result<(), String> {
    for pid in pids_listening_on_port(port)? {
        if pid == std::process::id() {
            continue;
        }
        stop_process_tree(pid);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn pids_listening_on_port(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|err| format!("无法检查本地服务端口: {err}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in text.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        let local = parts.get(1).copied().unwrap_or_default();
        let Some(pid) = parts.last().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        if local.ends_with(&suffix) && !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    Ok(pids)
}

#[cfg(not(target_os = "windows"))]
fn pids_listening_on_port(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .output()
        .map_err(|err| format!("无法检查本地服务端口: {err}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .split_whitespace()
        .filter_map(|value| value.parse::<u32>().ok())
        .collect())
}

#[cfg(target_os = "windows")]
fn stop_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output();
}

#[cfg(not(target_os = "windows"))]
fn stop_process_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output();
}

fn wait_for_local_service_to_close(port: u16) {
    for _ in 0..30 {
        if local_service_status(port) == LocalServiceStatus::Offline {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single-instance: refuse to start a 2nd dock, which would stack a 2nd Windows
    // AppBar reservation on top of the first (a recurring "the bottom strip is
    // double-reserved" leak). The first instance holds a named mutex for its lifetime.
    #[cfg(target_os = "windows")]
    {
        if !single_instance::acquire() {
            return;
        }
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_monitor_settings,
            desktop_set_monitor,
            desktop_launch_settings,
            desktop_set_launch_source
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let service_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                if let Err(err) = ensure_local_service() {
                    log::error!("could not start local service: {err}");
                }
                // Re-apply a persisted non-default launch source once the agent is up.
                apply_persisted_launch_source(&service_handle);
                std::thread::sleep(LOCAL_SERVICE_CHECK_INTERVAL);
            });

            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                if let Err(err) = desktop_monitor_settings_for(&handle, None, false, false) {
                    log::error!("could not apply saved monitor setting: {err}");
                }

                if let Some(window) = app.get_webview_window("dock") {
                    match window.hwnd() {
                        Ok(hwnd) => appbar::register(hwnd.0 as isize, DOCK_HEIGHT_PX),
                        Err(e) => log::error!("could not get dock window HWND: {e}"),
                    }
                } else {
                    log::error!("dock window not found at setup");
                }

                std::thread::spawn(|| loop {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    appbar::reassert();
                });
            }

            Ok(())
        })
        .on_window_event(|_window, event| {
            // Belt-and-suspenders: release the reserved edge the moment the dock
            // window is asked to close, not only on full app exit.
            #[cfg(target_os = "windows")]
            match event {
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    appbar::remove();
                }
                tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
                | tauri::WindowEvent::Focused(_) => {
                    appbar::reassert();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            if let tauri::RunEvent::Exit = _event {
                // Release the reserved desktop edge when the app exits.
                #[cfg(target_os = "windows")]
                appbar::remove();
                // Tree-kill the managed agent (npm -> node -> games), then sweep any
                // agent still holding the port (e.g. one spawned by the web dev server)
                // so nothing is left running after the dock exits.
                stop_managed_local_service();
                let _ = stop_local_service_on_port(LOCAL_SERVICE_PORT);
            }
        });
}

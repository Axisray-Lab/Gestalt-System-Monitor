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
        mpsc::{self, Sender},
        Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Monitor};

const DESKTOP_SETTINGS_FILE: &str = "desktop-settings.json";
const LOCAL_SERVICE_PORT: u16 = 7788;
const LOCAL_SERVICE_CHECK_INTERVAL: Duration = Duration::from_secs(3);
const DEFAULT_LAUNCH_SOURCE: &str = "standalone";

struct ManagedLocalService {
    child: Child,
    owner_token: String,
}

struct BackgroundWorker {
    stop: Sender<()>,
    join: JoinHandle<()>,
}

static LOCAL_SERVICE_CHILD: Mutex<Option<ManagedLocalService>> = Mutex::new(None);
static BACKGROUND_WORKERS: Mutex<Vec<BackgroundWorker>> = Mutex::new(Vec::new());
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);
static APPBAR_LEASE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
#[cfg(target_os = "windows")]
static PROCESS_JOB_HANDLE: Mutex<Option<isize>> = Mutex::new(None);
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
    Foreign,
    Offline,
}

#[cfg(target_os = "windows")]
mod appbar {
    use super::SHUTTING_DOWN;
    use std::{
        mem,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };
    use windows::Win32::Foundation::{
        GetLastError, SetLastError, HWND, LPARAM, LRESULT, RECT, WIN32_ERROR, WPARAM,
    };
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
    // Serializes registration, positioning and removal. In particular, this makes
    // ABM_REMOVE the final Shell operation once shutdown begins.
    static APPBAR_OPERATION: Mutex<()> = Mutex::new(());
    static POSITIONING: AtomicBool = AtomicBool::new(false);

    struct PositioningGuard;

    impl PositioningGuard {
        fn try_acquire() -> Option<Self> {
            POSITIONING
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .ok()
                .map(|_| Self)
        }

        fn acquire() -> Self {
            loop {
                if let Some(guard) = Self::try_acquire() {
                    return guard;
                }
                std::thread::yield_now();
            }
        }
    }

    impl Drop for PositioningGuard {
        fn drop(&mut self) {
            POSITIONING.store(false, Ordering::SeqCst);
        }
    }

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
    pub fn register(hwnd_raw: isize, height_px: i32) -> Result<(), String> {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return Err("Monitor is already shutting down".to_string());
        }
        // SHAppBarMessage synchronously delivers ABN_POSCHANGED back into our
        // subclassed WndProc. Hold the recursion guard before the operation lock so
        // that callback returns instead of deadlocking on the non-reentrant mutex.
        let _positioning = PositioningGuard::acquire();
        let _operation = APPBAR_OPERATION
            .lock()
            .map_err(|_| "AppBar operation lock poisoned".to_string())?;
        let (previous_registered_hwnd, already_registered) = {
            let mut state = APPBAR_STATE
                .lock()
                .map_err(|_| "AppBar state lock poisoned".to_string())?;
            let already_registered =
                state.registered && state.hwnd_raw == hwnd_raw && state.height_px == height_px;
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
            (previous, already_registered)
        };

        if let Some(previous) = previous_registered_hwnd {
            remove_hwnd(HWND(previous as _));
        }

        if already_registered {
            let state = APPBAR_STATE
                .lock()
                .map_err(|_| "AppBar state lock poisoned".to_string())
                .map(|state| *state)?;
            unsafe {
                position_hwnd(
                    HWND(state.hwnd_raw as _),
                    state.height_px,
                    state.target_monitor_rect,
                )?;
            }
            return Ok(());
        }

        install_wndproc(hwnd_raw)?;
        let registered = unsafe {
            let hwnd = HWND(hwnd_raw as _);
            let mut abd = appbar_data(hwnd);
            SHAppBarMessage(ABM_NEW, &mut abd) != 0
        };
        if !registered {
            restore_wndproc();
            let mut state = APPBAR_STATE
                .lock()
                .map_err(|_| "AppBar state lock poisoned".to_string())?;
            state.hwnd_raw = 0;
            state.height_px = 0;
            return Err("Windows Shell rejected ABM_NEW".to_string());
        }

        let state = {
            let mut state = APPBAR_STATE
                .lock()
                .map_err(|_| "AppBar state lock poisoned".to_string())?;
            state.registered = true;
            *state
        };
        let positioned = unsafe {
            position_hwnd(
                HWND(state.hwnd_raw as _),
                state.height_px,
                state.target_monitor_rect,
            )
        };
        if let Err(err) = positioned {
            remove_hwnd(HWND(hwnd_raw as _));
            restore_wndproc();
            if let Ok(mut state) = APPBAR_STATE.lock() {
                state.hwnd_raw = 0;
                state.height_px = 0;
                state.registered = false;
            }
            return Err(err);
        }
        Ok(())
    }

    pub fn set_target_monitor(rect: TargetMonitorRect) {
        if let Ok(mut state) = APPBAR_STATE.lock() {
            state.target_monitor_rect = Some(rect);
        }
        reassert();
    }

    /// Re-assert both the Shell work-area reservation and the actual window rect.
    /// Fullscreen apps and display changes can leave the Shell reservation intact
    /// while the HWND has drifted above the reserved strip; this keeps them in sync.
    pub fn reassert() {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        let Some(_positioning) = PositioningGuard::try_acquire() else {
            return;
        };

        let Ok(_operation) = APPBAR_OPERATION.lock() else {
            return;
        };
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        let Ok(state) = APPBAR_STATE.lock().map(|state| *state) else {
            return;
        };
        if state.registered && state.hwnd_raw != 0 && state.height_px > 0 {
            unsafe {
                let _ = position_hwnd(
                    HWND(state.hwnd_raw as _),
                    state.height_px,
                    state.target_monitor_rect,
                );
            }
        }
    }

    /// Deregister the appbar so the reserved desktop space is released. MUST run on
    /// exit — otherwise the work area stays shrunk until the shell restarts.
    pub fn remove() {
        let _positioning = PositioningGuard::acquire();
        let Ok(_operation) = APPBAR_OPERATION.lock() else {
            return;
        };
        let state = {
            let Ok(mut state) = APPBAR_STATE.lock() else {
                return;
            };
            let snapshot = *state;
            state.hwnd_raw = 0;
            state.height_px = 0;
            state.registered = false;
            state.target_monitor_rect = None;
            snapshot
        };

        if state.registered && state.hwnd_raw != 0 {
            remove_hwnd(HWND(state.hwnd_raw as _));
        }

        // Keep the old WndProc in state until ABM_REMOVE has finished: Shell can
        // synchronously deliver a final callback during removal and our subclass
        // still has to forward that message to Wry's original procedure.
        restore_wndproc();
        super::clear_appbar_lease();
    }

    pub fn window_handle_raw() -> isize {
        APPBAR_STATE
            .lock()
            .map(|state| state.hwnd_raw)
            .unwrap_or_default()
    }

    fn install_wndproc(hwnd_raw: isize) -> Result<(), String> {
        let mut state = APPBAR_STATE
            .lock()
            .map_err(|_| "AppBar state lock poisoned".to_string())?;
        if state.subclassed_hwnd_raw == hwnd_raw {
            return Ok(());
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
            SetLastError(WIN32_ERROR(0));
            let old = GetWindowLongPtrW(HWND(hwnd_raw as _), GWLP_WNDPROC);
            if old == 0 && GetLastError() != WIN32_ERROR(0) {
                return Err(format!("GetWindowLongPtrW failed: {}", GetLastError().0));
            }
            SetLastError(WIN32_ERROR(0));
            let replaced = SetWindowLongPtrW(
                HWND(hwnd_raw as _),
                GWLP_WNDPROC,
                appbar_wndproc as *const () as isize,
            );
            if replaced == 0 && GetLastError() != WIN32_ERROR(0) {
                return Err(format!("SetWindowLongPtrW failed: {}", GetLastError().0));
            }
            state.subclassed_hwnd_raw = hwnd_raw;
            state.old_wndproc_raw = old;
        }
        Ok(())
    }

    fn restore_wndproc() {
        let Ok(mut state) = APPBAR_STATE.lock() else {
            return;
        };
        if state.subclassed_hwnd_raw != 0 && state.old_wndproc_raw != 0 {
            unsafe {
                let _ = SetWindowLongPtrW(
                    HWND(state.subclassed_hwnd_raw as _),
                    GWLP_WNDPROC,
                    state.old_wndproc_raw,
                );
            }
        }
        state.subclassed_hwnd_raw = 0;
        state.old_wndproc_raw = 0;
    }

    unsafe fn position_hwnd(
        hwnd: HWND,
        height_px: i32,
        target_monitor_rect: Option<TargetMonitorRect>,
    ) -> Result<(), String> {
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
        if SHAppBarMessage(ABM_SETPOS, &mut abd) == 0 {
            return Err("Windows Shell rejected ABM_SETPOS".to_string());
        }

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
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                abd.rc.left,
                abd.rc.top,
                target_width,
                target_height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|err| format!("SetWindowPos failed: {err}"))?;
        }
        Ok(())
    }

    fn remove_hwnd(hwnd: HWND) {
        unsafe {
            let mut abd = appbar_data(hwnd);
            SHAppBarMessage(ABM_REMOVE, &mut abd);
        }
    }

    /// Remove a Shell registration left by a process that died before it could run
    /// its in-process teardown. Used by the out-of-process watchdog and stale lease
    /// recovery; ABM_REMOVE keys the registration by the original HWND value.
    pub fn remove_stale(hwnd_raw: isize) {
        if hwnd_raw == 0 {
            return;
        }
        let _positioning = PositioningGuard::acquire();
        let Ok(_operation) = APPBAR_OPERATION.lock() else {
            return;
        };
        remove_hwnd(HWND(hwnd_raw as _));
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

        let old_wndproc_raw = APPBAR_STATE
            .lock()
            .map(|state| state.old_wndproc_raw)
            .unwrap_or(0);
        if old_wndproc_raw != 0 {
            let old_wndproc: WNDPROC = mem::transmute(old_wndproc_raw);
            CallWindowProcW(old_wndproc, hwnd, msg, wparam, lparam)
        } else {
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppbarLease {
    hwnd_raw: isize,
    owner_pid: u32,
    height_px: i32,
}

#[cfg(target_os = "windows")]
fn appbar_lease_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("appbar-lease.json"))
        .map_err(|err| format!("无法定位 AppBar lease 目录: {err}"))
}

#[cfg(target_os = "windows")]
fn read_appbar_lease(path: &PathBuf) -> Result<Option<AppbarLease>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("无法读取 AppBar lease {}: {err}", path.display())),
    };
    serde_json::from_str::<AppbarLease>(&contents)
        .map(Some)
        .map_err(|err| format!("AppBar lease {} 已损坏: {err}", path.display()))
}

#[cfg(target_os = "windows")]
fn recover_stale_appbar_lease(path: &PathBuf) -> Result<(), String> {
    let Some(lease) = read_appbar_lease(path)? else {
        return Ok(());
    };
    if lease.hwnd_raw != 0 {
        appbar::remove_stale(lease.hwnd_raw);
        log::warn!(
            "removed stale AppBar lease from pid {} (hwnd={})",
            lease.owner_pid,
            lease.hwnd_raw
        );
    }
    fs::remove_file(path)
        .map_err(|err| format!("无法清理旧 AppBar lease {}: {err}", path.display()))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn remove_owned_appbar_lease(path: &PathBuf, owner_pid: u32, hwnd_raw: isize) {
    match read_appbar_lease(path) {
        Ok(Some(lease)) if lease.owner_pid != owner_pid || lease.hwnd_raw != hwnd_raw => {
            // A newer Monitor instance has already replaced the lease. Never let an
            // older watchdog deregister or delete the new instance's AppBar.
            return;
        }
        Ok(_) => {}
        Err(_) => {
            // The watchdog owns the old HWND and the lease guard excludes a newer
            // writer, so a corrupt lease is safe to discard here.
        }
    }
    appbar::remove_stale(hwnd_raw);
    let _ = fs::remove_file(path);
}

#[cfg(target_os = "windows")]
fn persist_appbar_lease(path: PathBuf, hwnd_raw: isize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建 AppBar lease 目录: {err}"))?;
    }
    let lease = AppbarLease {
        hwnd_raw,
        owner_pid: std::process::id(),
        height_px: DOCK_HEIGHT_PX,
    };
    let payload = serde_json::to_vec_pretty(&lease)
        .map_err(|err| format!("无法序列化 AppBar lease: {err}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, payload).map_err(|err| format!("无法写入 AppBar lease: {err}"))?;
    fs::rename(&temporary, &path).map_err(|err| format!("无法提交 AppBar lease: {err}"))?;
    *APPBAR_LEASE_PATH.lock().unwrap() = Some(path);
    Ok(())
}

fn clear_appbar_lease() {
    if let Ok(mut slot) = APPBAR_LEASE_PATH.lock() {
        if let Some(path) = slot.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(target_os = "windows")]
mod appbar_lease_guard {
    use windows::core::w;
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

    pub struct Guard(HANDLE);

    impl Guard {
        pub fn acquire() -> Result<Self, String> {
            unsafe {
                let handle =
                    CreateMutexW(None, false, w!("GestaltSystemMonitorDock_AppbarLeaseGuard"))
                        .map_err(|err| format!("CreateMutexW(AppBar lease) failed: {err}"))?;
                let wait = WaitForSingleObject(handle, 10_000);
                if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
                    return Ok(Self(handle));
                }
                let _ = CloseHandle(handle);
                if wait == WAIT_TIMEOUT {
                    Err("等待 AppBar lease 锁超时".to_string())
                } else {
                    Err(format!("等待 AppBar lease 锁失败: {}", wait.0))
                }
            }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                let _ = ReleaseMutex(self.0);
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn initialize_process_job() -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|err| format!("CreateJobObjectW failed: {err}"))?;
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        if let Err(err) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(job);
            return Err(format!("SetInformationJobObject failed: {err}"));
        }
        if let Err(err) = AssignProcessToJobObject(job, GetCurrentProcess()) {
            let _ = CloseHandle(job);
            return Err(format!("AssignProcessToJobObject failed: {err}"));
        }
        *PROCESS_JOB_HANDLE.lock().unwrap() = Some(job.0 as isize);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_appbar_watchdog(hwnd_raw: isize, lease_path: &PathBuf) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use windows::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW};

    let exe = std::env::current_exe().map_err(|err| format!("无法定位 watchdog 程序: {err}"))?;
    let owner_pid = std::process::id().to_string();
    let hwnd = hwnd_raw.to_string();
    let mut broker = Command::new(exe)
        .arg("--appbar-watchdog-broker")
        .arg(owner_pid)
        .arg(hwnd)
        .arg(lease_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags((CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW).0)
        .spawn()
        .map_err(|err| format!("无法启动 AppBar watchdog broker: {err}"))?;
    let status = broker
        .wait()
        .map_err(|err| format!("无法等待 AppBar watchdog broker: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("AppBar watchdog broker 启动失败: {status}"))
    }
}

#[cfg(target_os = "windows")]
fn spawn_detached_appbar_watchdog(
    parent_pid: u32,
    hwnd_raw: isize,
    lease_path: &PathBuf,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    let exe = std::env::current_exe().map_err(|err| format!("无法定位 watchdog 程序: {err}"))?;
    Command::new(exe)
        .arg("--appbar-watchdog")
        .arg(parent_pid.to_string())
        .arg(hwnd_raw.to_string())
        .arg(lease_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法启动 AppBar watchdog: {err}"))
}

#[cfg(target_os = "windows")]
fn maybe_run_appbar_watchdog() -> bool {
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
    };

    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str);
    if !matches!(
        mode,
        Some("--appbar-watchdog") | Some("--appbar-watchdog-broker")
    ) {
        return false;
    }
    let Some(parent_pid) = args.get(2).and_then(|value| value.parse::<u32>().ok()) else {
        return true;
    };
    let Some(hwnd_raw) = args.get(3).and_then(|value| value.parse::<isize>().ok()) else {
        return true;
    };
    let Some(lease_path) = args.get(4).map(PathBuf::from) else {
        return true;
    };
    if mode == Some("--appbar-watchdog-broker") {
        let exit_code = if spawn_detached_appbar_watchdog(parent_pid, hwnd_raw, &lease_path).is_ok()
        {
            0
        } else {
            1
        };
        std::process::exit(exit_code);
    }
    // Never clean a live parent's registration merely because OpenProcess was
    // temporarily denied. Retry until the process handle signals, or Windows says
    // the PID no longer exists. The broker starts this watcher before ABM_NEW, so
    // the normal path obtains the handle while the parent is certainly alive.
    loop {
        match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) } {
            Ok(parent) => {
                let wait = unsafe { WaitForSingleObject(parent, INFINITE) };
                let _ = unsafe { CloseHandle(parent) };
                if wait == WAIT_OBJECT_0 {
                    break;
                }
            }
            Err(err) if err.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => {
                break;
            }
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    // A newer instance may briefly hold the cross-process lease guard while it
    // replaces the stale lease. Keep retrying; once acquired, owner matching makes
    // an old watcher harmless to the new instance.
    loop {
        if let Ok(_guard) = appbar_lease_guard::Guard::acquire() {
            remove_owned_appbar_lease(&lease_path, parent_pid, hwnd_raw);
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    true
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn console_ctrl_handler(
    control_type: u32,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
    use windows::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

    if !matches!(
        control_type,
        CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT
    ) {
        return BOOL(0);
    }

    // Console control handlers run on an OS-created thread. Release the Shell
    // reservation synchronously first; then ask the normal Tauri close path to
    // stop workers and the owned agent when the process is allowed to continue.
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    let hwnd_raw = appbar::window_handle_raw();
    appbar::remove();
    if hwnd_raw != 0 && PostMessageW(HWND(hwnd_raw as _), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() {
        return BOOL(1);
    }
    // If the event loop can no longer accept WM_CLOSE, let Windows continue to its
    // default console handler so the process does not remain alive but unusable.
    BOOL(0)
}

#[cfg(target_os = "windows")]
fn install_console_ctrl_handler() -> Result<(), String> {
    use windows::Win32::System::Console::SetConsoleCtrlHandler;

    unsafe { SetConsoleCtrlHandler(Some(console_ctrl_handler), true) }
        .map_err(|err| format!("SetConsoleCtrlHandler failed: {err}"))
}

#[cfg(not(target_os = "windows"))]
fn maybe_run_appbar_watchdog() -> bool {
    false
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
    agent_http_request(method, path, body, &[]).map(|(_, body)| body)
}

fn agent_http_request(
    method: &str,
    path: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> Result<(u16, String), String> {
    let mut stream = connect_localhost(LOCAL_SERVICE_PORT)?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(2000)));
    let body = body.unwrap_or("");
    let extra_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost:{port}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\n{extra_headers}Connection: close\r\n\r\n{body}",
        method = method,
        path = path,
        port = LOCAL_SERVICE_PORT,
        len = body.len(),
        extra_headers = extra_headers,
        body = body,
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("写入本地服务失败: {err}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| format!("读取本地服务失败: {err}"))?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "本地服务返回了无效 HTTP 响应".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "本地服务返回了无效 HTTP 状态".to_string())?;
    Ok((status, body.to_string()))
}

fn request_owned_agent_shutdown(owner_token: &str) -> Result<(), String> {
    let (status, _) = agent_http_request(
        "POST",
        "/shutdown",
        None,
        &[("x-gsm-owner-token", owner_token)],
    )?;
    if status == 202 {
        Ok(())
    } else {
        Err(format!("owned agent rejected shutdown with HTTP {status}"))
    }
}

/// POST the chosen source to the running agent. Returns (applied, human detail).
fn push_launch_source(source: &str) -> (bool, String) {
    let payload = format!("{{\"source\":\"{source}\"}}");
    match agent_request("POST", "/launch/source", Some(&payload)) {
        Ok(body) => match serde_json::from_str::<AgentSourceResponse>(&body) {
            Ok(parsed) => {
                if parsed.ok.unwrap_or(false) {
                    let exe = parsed.executable_path.unwrap_or_default();
                    (
                        true,
                        if exe.is_empty() {
                            "已应用".to_string()
                        } else {
                            exe
                        },
                    )
                } else {
                    (
                        false,
                        parsed
                            .error
                            .unwrap_or_else(|| "本地服务拒绝了该启动源".to_string()),
                    )
                }
            }
            Err(_) => (false, "本地服务返回无法解析".to_string()),
        },
        Err(err) => (
            false,
            format!("本地服务未运行（已保存，下次启动生效）: {err}"),
        ),
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
fn desktop_set_launch_source(
    app: AppHandle,
    source: String,
) -> Result<DesktopLaunchSettings, String> {
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

#[tauri::command]
fn desktop_quit(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("dock")
        .ok_or_else(|| "dock window not found".to_string())?;
    window
        .close()
        .map_err(|err| format!("无法关闭 Monitor: {err}"))
}

fn register_background_worker(join: JoinHandle<()>, stop: Sender<()>) {
    BACKGROUND_WORKERS
        .lock()
        .unwrap()
        .push(BackgroundWorker { stop, join });
}

fn stop_background_workers() {
    let workers = BACKGROUND_WORKERS
        .lock()
        .map(|mut workers| std::mem::take(&mut *workers))
        .unwrap_or_default();
    for worker in &workers {
        let _ = worker.stop.send(());
    }
    for worker in workers {
        if let Err(err) = worker.join.join() {
            log::error!("background worker panicked during shutdown: {err:?}");
        }
    }
}

fn shutdown_runtime() {
    if SHUTDOWN_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    appbar::remove();
    stop_background_workers();
    stop_managed_local_service();
}

fn ensure_local_service() -> Result<(), String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
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
            return Err(format!(
                "localhost:{LOCAL_SERVICE_PORT} is a compatible but outdated agent; stop it explicitly before launching the desktop"
            ));
        }
        LocalServiceStatus::Foreign => {
            return Err(format!(
                "localhost:{LOCAL_SERVICE_PORT} is owned by another service; refusing to kill or replace it"
            ));
        }
        LocalServiceStatus::Offline => {}
    }

    match local_service_status(LOCAL_SERVICE_PORT) {
        LocalServiceStatus::Current => return Ok(()),
        LocalServiceStatus::Offline => {}
        LocalServiceStatus::Stale | LocalServiceStatus::Foreign => {
            return Err(format!(
                "localhost:{LOCAL_SERVICE_PORT} became occupied while starting the managed agent"
            ));
        }
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
        return LocalServiceStatus::Foreign;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return LocalServiceStatus::Foreign;
    }

    if !response.contains("\"kind\":\"launcherStatus\"") {
        return LocalServiceStatus::Foreign;
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
    let owner_token = new_owner_token()?;
    command
        .env("GSM_OWNER_TOKEN", &owner_token)
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
    *LOCAL_SERVICE_CHILD.lock().unwrap() = Some(ManagedLocalService { child, owner_token });
    // A freshly spawned agent starts on its default (standalone) source; re-push any
    // persisted non-default choice on the next supervisor tick.
    LAUNCH_SOURCE_APPLIED.store(false, Ordering::SeqCst);
    Ok(())
}

fn new_owner_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("无法生成 agent ownership token: {err}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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
        if let Ok(config) = std::env::var("GSM_AGENT") {
            if config.trim().eq_ignore_ascii_case("off") {
                return Err("GSM_AGENT=off disables the desktop-managed agent".to_string());
            }
            command.args(config.split_whitespace());
        }
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
    if let Some(mut managed) = LOCAL_SERVICE_CHILD.lock().unwrap().take() {
        // Ask the owned agent to flush recorders and terminate its games first. The
        // desktop Job Object is the crash/failure backstop, not the primary shutdown.
        if let Err(err) = request_owned_agent_shutdown(&managed.owner_token) {
            log::warn!("owned agent did not accept graceful shutdown: {err}");
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            match managed.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                _ => {
                    if let Err(err) = stop_process_tree(managed.child.id()) {
                        log::warn!("owned agent tree shutdown fallback failed: {err}");
                    }
                    if let Err(err) = managed.child.kill() {
                        log::debug!("owned agent root was already gone: {err}");
                    }
                    if let Err(err) = managed.child.wait() {
                        log::warn!("could not reap owned agent root: {err}");
                    }
                    break;
                }
            }
        }
    }
    LAUNCH_SOURCE_APPLIED.store(false, Ordering::SeqCst);
}

fn reap_managed_local_service() {
    let mut child_slot = LOCAL_SERVICE_CHILD.lock().unwrap();
    let Some(managed) = child_slot.as_mut() else {
        return;
    };
    if matches!(managed.child.try_wait(), Ok(Some(_))) {
        *child_slot = None;
    }
}

#[cfg(target_os = "windows")]
fn stop_process_tree(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("could not run taskkill: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill exited with {status}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn stop_process_tree(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("could not run kill: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill exited with {status}"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The watchdog is the same executable in a deliberately tiny alternate mode;
    // it must not initialize Tauri, the single-instance mutex or the process Job.
    if maybe_run_appbar_watchdog() {
        return;
    }

    SHUTTING_DOWN.store(false, Ordering::SeqCst);
    SHUTDOWN_STARTED.store(false, Ordering::SeqCst);

    // Put every child spawned by the desktop (npm/node, agent sidecars and games)
    // in a kill-on-close Job Object. This is the hard-exit backstop when no Rust or
    // JavaScript teardown callback can run. Startup fails before ABM_NEW if the Job
    // cannot be established, so we never reserve desktop space without the backstop.
    #[cfg(target_os = "windows")]
    initialize_process_job().expect("could not initialize Monitor process Job Object");

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
            desktop_set_launch_source,
            desktop_quit
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                let window = app.get_webview_window("dock").ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "dock window not found")
                })?;
                let hwnd_raw = window
                    .hwnd()
                    .map_err(|err| {
                        std::io::Error::other(format!("could not get dock HWND: {err}"))
                    })?
                    .0 as isize;
                let lease_path = appbar_lease_path(&handle).map_err(std::io::Error::other)?;
                let _lease_guard =
                    appbar_lease_guard::Guard::acquire().map_err(std::io::Error::other)?;

                // Cleanup and registration share a cross-process guard with the old
                // watchdog. A late watchdog can therefore never remove a newer
                // instance's AppBar or lease.
                recover_stale_appbar_lease(&lease_path).map_err(std::io::Error::other)?;
                if let Err(err) = desktop_monitor_settings_for(&handle, None, false, false) {
                    log::error!("could not apply saved monitor setting: {err}");
                }
                spawn_appbar_watchdog(hwnd_raw, &lease_path).map_err(std::io::Error::other)?;
                appbar::register(hwnd_raw, DOCK_HEIGHT_PX).map_err(std::io::Error::other)?;
                if let Err(err) = persist_appbar_lease(lease_path, hwnd_raw) {
                    appbar::remove();
                    return Err(std::io::Error::other(err).into());
                }
                if let Err(err) = install_console_ctrl_handler() {
                    appbar::remove();
                    return Err(std::io::Error::other(err).into());
                }

                let appbar_handle = app.handle().clone();
                let (appbar_stop, appbar_stop_rx) = mpsc::channel();
                let appbar_join = std::thread::spawn(move || {
                    while let Err(mpsc::RecvTimeoutError::Timeout) =
                        appbar_stop_rx.recv_timeout(Duration::from_millis(1500))
                    {
                        if SHUTTING_DOWN.load(Ordering::SeqCst) {
                            break;
                        }
                        // Shell/AppBar calls target the dock HWND and must execute
                        // on its owning thread. Enqueue without waiting so the UI
                        // thread can join this timer during shutdown without a
                        // cross-thread SendMessage deadlock.
                        if appbar_handle.run_on_main_thread(appbar::reassert).is_err() {
                            break;
                        }
                    }
                });
                register_background_worker(appbar_join, appbar_stop);
            }

            let service_handle = app.handle().clone();
            let (service_stop, service_stop_rx) = mpsc::channel();
            let service_join = std::thread::spawn(move || loop {
                if SHUTTING_DOWN.load(Ordering::SeqCst) {
                    break;
                }
                if let Err(err) = ensure_local_service() {
                    log::error!("could not start local service: {err}");
                }
                // Re-apply a persisted non-default launch source once the agent is up.
                apply_persisted_launch_source(&service_handle);
                match service_stop_rx.recv_timeout(LOCAL_SERVICE_CHECK_INTERVAL) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            });
            register_background_worker(service_join, service_stop);

            Ok(())
        })
        .on_window_event(|_window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                shutdown_runtime();
            }
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. }
            | tauri::WindowEvent::Focused(_) => {
                appbar::reassert();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                shutdown_runtime();
            }
        });
}

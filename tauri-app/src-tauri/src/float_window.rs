//! 原生 Win32 悬浮窗（参考 Python 版 ui/float_window.py）
//!
//! 用 Win32 API 直接创建一个简单方形窗口，画一个"抽"字，
//! 鼠标按下拖拽 / 单击触发回调。比 Webview 实现轻量得多。

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
    SelectObject, SetBkMode, SetTextColor, ANTIALIASED_QUALITY, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DT_CENTER, DT_SINGLELINE, DT_VCENTER, FW_BOLD, HBRUSH, HFONT,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, PROOF_QUALITY, TRANSPARENT, VARIABLE_PITCH,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos,
    GetMessageW, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, LoadCursorW, PostMessageW,
    PostQuitMessage, RegisterClassExW, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, UnregisterClassW,
    CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, HCURSOR, HICON, HWND_TOP, IDC_ARROW, MSG, SM_CXSCREEN,
    SM_CYSCREEN, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WM_CLOSE, WM_DESTROY,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WNDCLASSEXW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use windows::Win32::UI::WindowsAndMessaging::{SetLayeredWindowAttributes, LWA_ALPHA};

const HOTSPOT_DRAG_THRESHOLD: i32 = 5;
const FLOAT_SIZE: i32 = 120;
/// 窗口右下角离屏幕边缘的间距
const FLOAT_MARGIN_RIGHT: i32 = 20;
const FLOAT_MARGIN_BOTTOM: i32 = 80;
const WM_APP_CLICK: u32 = 0x8000 + 1;
const CLASS_NAME: PCWSTR = w!("NumberSelectorFloatWnd");

/// 悬浮窗生命周期状态（用 parking_lot::Mutex 保护，不会中毒）
struct FloatState {
    /// 当前窗口句柄（仅由窗口线程写入）
    hwnd: Option<isize>,
    /// 创建线程的 JoinHandle，用于 close 时等待其退出
    thread: Option<thread::JoinHandle<()>>,
    /// 窗口线程已退出的信号
    finished: bool,
    /// 超时取消标志：置位后窗口线程若稍后才创建成功，须立即自毁退出，
    /// 否则 close_float_window 的 join() 会永久阻塞（窗口线程停在消息循环里）
    cancelled: bool,
}

impl Default for FloatState {
    fn default() -> Self {
        FloatState {
            hwnd: None,
            thread: None,
            finished: false,
            cancelled: false,
        }
    }
}

static FLOAT_STATE: Lazy<Mutex<FloatState>> = Lazy::new(|| Mutex::new(FloatState::default()));
static FLOAT_CONDVAR: Lazy<Condvar> = Lazy::new(|| Condvar::new());

/// 点击回调（供 WM_APP_CLICK 分拆到独立线程执行）
static CLICK_CALLBACK: Lazy<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>> =
    Lazy::new(|| Mutex::new(None));

/// 窗口线程内部数据：拖拽状态 + GDI 对象（字体/画刷仅在线程内使用）
struct WindowData {
    drag: DragState,
    font: HFONT,
    bg_brush: HBRUSH,
}

/// 拖拽状态：仅供窗口过程内部使用
struct DragState {
    pressed: bool,
    moved: bool,
    /// 鼠标按下时的屏幕坐标 X
    start_sx: i32,
    /// 鼠标按下时的屏幕坐标 Y
    start_sy: i32,
    /// 上次拖拽时的窗口位置 X，用于回退检测
    prev_win_left: i32,
    /// 上次拖拽时的窗口位置 Y
    prev_win_top: i32,
}

/// 设置点击回调
pub fn set_click_callback<F: Fn() + Send + Sync + 'static>(cb: F) {
    let mut g = CLICK_CALLBACK.lock();
    *g = Some(Arc::new(cb));
}

/// 关闭悬浮窗（如果存在）
/// 通过 PostMessageW 发送 WM_CLOSE，让窗口线程自行处理关闭，
/// 避免从非创建线程调用 DestroyWindow 违反 Win32 线程亲和性。
pub fn close_float_window() {
    let mut state = FLOAT_STATE.lock();
    if let Some(hwnd_raw) = state.hwnd.take() {
        let hwnd = HWND(hwnd_raw as *mut _);
        unsafe {
            // 向窗口线程发送 WM_CLOSE，由窗口线程自行 DestroyWindow
            let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
    // 持锁等待线程退出，防止 show_float_window 在旧线程未退出时创建新窗口
    if let Some(handle) = state.thread.take() {
        drop(state);
        let _ = handle.join();
    }
}

/// 显示悬浮窗（先销毁旧的，确保全局唯一）
pub fn show_float_window() -> Result<(), String> {
    let mut state = FLOAT_STATE.lock();

    // 如果已有窗口且仍在运行，直接复用
    if state.hwnd.is_some() {
        return Ok(());
    }

    // 清理可能已结束但尚未 join 的线程
    if let Some(handle) = state.thread.take() {
        let _ = handle.join();
    }

    // 在新线程中创建窗口（拥有自己的消息循环）
    let handle = thread::spawn(|| unsafe {
        if let Err(e) = create_and_run() {
            eprintln!("[float_window] create failed: {}", e);
            // 提前失败：标记结束并唤醒等待方，避免 show_float_window 白等满 5 秒。
            // Err 只发生在 hwnd 尚未保存的创建阶段，此处不会覆盖已成功状态。
            let mut state = FLOAT_STATE.lock();
            state.finished = true;
            FLOAT_CONDVAR.notify_all();
        }
    });
    state.thread = Some(handle);

    // 等待窗口创建完成或失败，使用 Condvar 避免忙等
    let _result = FLOAT_CONDVAR.wait_for(&mut state, Duration::from_secs(5));
    if state.hwnd.is_some() {
        return Ok(());
    }
    if state.finished {
        return Err("悬浮窗线程异常退出".to_string());
    }

    // 超时：置取消标志并回收线程；窗口线程若稍后才创建成功会看到标志并自毁
    state.cancelled = true;
    drop(state);
    close_float_window();
    Err("悬浮窗创建超时".to_string())
}

unsafe fn create_and_run() -> Result<(), String> {
    let hmodule = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandle: {:?}", e))?;
    let hinstance = windows::Win32::Foundation::HINSTANCE(hmodule.0);

    // 预创建 GDI 对象（仅在窗口线程中使用，避免 WM_PAINT 中反复创建/销毁）
    let bg_brush = CreateSolidBrush(COLORREF(0x00212121)); // BGR: 黑灰
    let font = CreateFontW(
        64,
        0,
        0,
        0,
        FW_BOLD.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        PROOF_QUALITY.0 as u32 | ANTIALIASED_QUALITY.0 as u32,
        (VARIABLE_PITCH.0 as u32) & 0xFF,
        w!("微软雅黑"),
    );
    let cursor: HCURSOR = LoadCursorW(None, IDC_ARROW).unwrap_or_default();

    // 注册窗口类
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: HICON::default(),
        hCursor: cursor,
        hbrBackground: bg_brush,
        lpszMenuName: PCWSTR::null(),
        lpszClassName: CLASS_NAME,
        hIconSm: HICON::default(),
    };

    // 若之前已注册过同名的窗口类，先注销再重新注册（避免第二次创建时失败）
    let _ = UnregisterClassW(CLASS_NAME, hinstance);

    let atom = RegisterClassExW(&wc);
    if atom == 0 {
        let _ = DeleteObject(bg_brush);
        let _ = DeleteObject(font);
        return Err("RegisterClassExW 失败".to_string());
    }

    // 屏幕右下角位置
    let screen_w = GetSystemMetrics(SM_CXSCREEN);
    let screen_h = GetSystemMetrics(SM_CYSCREEN);
    let x = screen_w - FLOAT_SIZE - FLOAT_MARGIN_RIGHT;
    let y = screen_h - FLOAT_SIZE - FLOAT_MARGIN_BOTTOM;

    // 窗口数据：拖拽状态 + GDI 对象，堆分配由 HWND 持有指针
    let data = Box::into_raw(Box::new(WindowData {
        drag: DragState {
            pressed: false,
            moved: false,
            start_sx: 0,
            start_sy: 0,
            prev_win_left: 0,
            prev_win_top: 0,
        },
        font,
        bg_brush,
    }));

    let ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED;
    let hwnd = CreateWindowExW(
        ex_style,
        CLASS_NAME,
        w!("悬浮窗"),
        WS_POPUP,
        x,
        y,
        FLOAT_SIZE,
        FLOAT_SIZE,
        None,
        None,
        hinstance,
        Some(data as *const _),
    )
    .map_err(|e| {
        let _ = Box::from_raw(data);
        let _ = DeleteObject(bg_brush);
        let _ = DeleteObject(font);
        format!("CreateWindowEx: {:?}", e)
    })?;

    // 把 data 指针存到窗口数据
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, data as isize);

    // 设置整体不透明度（layered window）
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 240, LWA_ALPHA);

    // 保存 HWND 并通知等待方；若等待方已超时取消，立即自毁退出，避免 join() 永久阻塞
    {
        let mut state = FLOAT_STATE.lock();
        if state.cancelled {
            drop(state);
            let _ = DestroyWindow(hwnd); // WM_DESTROY 同步清理 GWLP_USERDATA/GDI 并 PostQuitMessage
            let mut state = FLOAT_STATE.lock();
            state.finished = true;
            FLOAT_CONDVAR.notify_all();
            return Ok(());
        }
        state.hwnd = Some(hwnd.0 as isize);
        state.finished = false;
    }
    FLOAT_CONDVAR.notify_all();

    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);

    // 消息循环
    let mut msg = MSG::default();
    loop {
        // GetMessageW 返回 0=WM_QUIT 正常退出，-1=出错；-1 会被 as bool 判为 true 造成忙等死循环
        let r = GetMessageW(&mut msg, None, 0, 0);
        if r.0 <= 0 {
            break;
        }
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    // 消息循环结束，清理 WindowData 和 GDI 对象
    // 注意：WM_DESTROY 已经清理了 GWLP_USERDATA，这里只做最终兜底
    let data_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowData;
    if !data_ptr.is_null() {
        let boxed = Box::from_raw(data_ptr);
        let _ = DeleteObject(boxed.font);
        let _ = DeleteObject(boxed.bg_brush);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
    }

    {
        let mut state = FLOAT_STATE.lock();
        state.hwnd = None;
        state.finished = true;
    }
    FLOAT_CONDVAR.notify_all();

    Ok(())
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut rect = RECT::default();
                let _ = GetClientRect(hwnd, &mut rect);

                let data_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowData;

                // 背景填充
                let bg_brush = if !data_ptr.is_null() {
                    (*data_ptr).bg_brush
                } else {
                    CreateSolidBrush(COLORREF(0x00212121))
                };
                FillRect(hdc, &rect, bg_brush);
                if data_ptr.is_null() {
                    let _ = DeleteObject(bg_brush);
                }

                // 绘制"抽"字
                let _ = SetBkMode(hdc, TRANSPARENT);
                SetTextColor(hdc, COLORREF(0x00FFFFFF));

                let font = if !data_ptr.is_null() {
                    (*data_ptr).font
                } else {
                    CreateFontW(
                        64, 0, 0, 0, FW_BOLD.0 as i32, 0, 0, 0,
                        DEFAULT_CHARSET.0 as u32, OUT_DEFAULT_PRECIS.0 as u32,
                        CLIP_DEFAULT_PRECIS.0 as u32,
                        PROOF_QUALITY.0 as u32 | ANTIALIASED_QUALITY.0 as u32,
                        (VARIABLE_PITCH.0 as u32) & 0xFF, w!("微软雅黑"),
                    )
                };
                let old_font = SelectObject(hdc, font);

                let mut text: Vec<u16> = "抽".encode_utf16().collect();
                let _ = DrawTextW(
                    hdc,
                    &mut text,
                    &mut rect,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                );

                SelectObject(hdc, old_font);
                if data_ptr.is_null() {
                    let _ = DeleteObject(font);
                }

                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            WM_LBUTTONDOWN => {
                let drag = get_drag_state(hwnd);
                if let Some(drag) = drag {
                    drag.pressed = true;
                    drag.moved = false;

                    let mut pt = POINT { x: 0, y: 0 };
                    let _ = GetCursorPos(&mut pt);
                    drag.start_sx = pt.x;
                    drag.start_sy = pt.y;

                    let mut rc = RECT::default();
                    let _ = GetWindowRect(hwnd, &mut rc);
                    drag.prev_win_left = rc.left;
                    drag.prev_win_top = rc.top;

                    let _ = SetCapture(hwnd);
                }
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                let drag = get_drag_state(hwnd);
                if let Some(drag) = drag {
                    if drag.pressed {
                        let mut pt = POINT { x: 0, y: 0 };
                        let _ = GetCursorPos(&mut pt);
                        let dx = (pt.x - drag.start_sx).abs();
                        let dy = (pt.y - drag.start_sy).abs();
                        if dx > HOTSPOT_DRAG_THRESHOLD || dy > HOTSPOT_DRAG_THRESHOLD {
                            drag.moved = true;
                        }
                        if drag.moved {
                            let new_left = drag.prev_win_left + (pt.x - drag.start_sx);
                            let new_top = drag.prev_win_top + (pt.y - drag.start_sy);
                            let _ = SetWindowPos(
                                hwnd,
                                HWND_TOP,
                                new_left,
                                new_top,
                                0,
                                0,
                                SWP_NOSIZE | SWP_NOZORDER,
                            );
                        }
                    }
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            WM_LBUTTONUP => {
                let _ = ReleaseCapture();
                let drag = get_drag_state(hwnd);
                if let Some(drag) = drag {
                    let was_click = drag.pressed && !drag.moved;
                    drag.pressed = false;
                    drag.moved = false;
                    if was_click {
                        // 使用 PostMessageW 异步发送，避免窗口过程重入导致死锁
                        let _ = PostMessageW(hwnd, WM_APP_CLICK, WPARAM(0), LPARAM(0));
                    }
                }
                LRESULT(0)
            }
            x if x == WM_APP_CLICK => {
                // 1) 先自关闭悬浮窗（异步投递 WM_CLOSE）
                let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
                // 2) 在新线程中执行回调，不阻塞悬浮窗线程的消息循环
                let g = CLICK_CALLBACK.lock();
                if let Some(cb) = g.as_ref() {
                    let cb = cb.clone();
                    drop(g);
                    thread::spawn(move || {
                        cb();
                    });
                }
                LRESULT(0)
            }
            WM_CLOSE => {
                // 由窗口线程自行调用 DestroyWindow（满足 Win32 线程亲和性）
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                // 窗口销毁时清理 GWLP_USERDATA，避免后续重复释放
                let data_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowData;
                if !data_ptr.is_null() {
                    let boxed = Box::from_raw(data_ptr);
                    let _ = DeleteObject(boxed.font);
                    let _ = DeleteObject(boxed.bg_brush);
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                }
                {
                    let mut state = FLOAT_STATE.lock();
                    state.hwnd = None;
                }
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

/// 从 GWLP_USERDATA 获取 DragState 可变引用
unsafe fn get_drag_state(hwnd: HWND) -> Option<&'static mut DragState> {
    let data_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowData;
    if data_ptr.is_null() {
        return None;
    }
    Some(&mut (*data_ptr).drag)
}

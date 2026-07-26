//! Tauri 命令导出

use std::collections::HashSet;
use std::path::Path;

use tauri::{AppHandle, Manager};

// Windows: 调用 reg.exe 等控制台程序时抑制黑窗闪现
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use crate::config::{self, DataDirKind};

use crate::data::{self, ModesPayload, Student};
use crate::db;
use crate::draw::{
    advanced_perform_draw_v2, perform_draw, AdvancedDrawRequest,
    AdvancedDrawResult, DrawResult,
};
use crate::float_window;
use crate::lock;
use crate::settings::{
    self, AhenConfig, ImportPreview, MemoryModeStatus, NumberLimits, ParsedStudents,
    QuantityLimits, SeatDirection, TimeRange, UsbVerifyScope,
};
use crate::startup::StartupMode;

/// 主窗口 label
const MAIN_LABEL: &str = "main";
/// 高级抽号窗口 label
const ADVANCED_LABEL: &str = "advanced-draw";

#[tauri::command]
pub fn get_modes() -> ModesPayload {
    data::load_modes()
}

#[tauri::command]
pub fn get_memory_modes() -> Vec<String> {
    let mut v: Vec<String> = data::load_memory_modes().into_iter().collect();
    v.sort();
    v
}

#[tauri::command]
pub fn get_students() -> Vec<Student> {
    data::load_students()
}

#[tauri::command]
pub fn get_used(back_mode: String) -> Vec<i32> {
    let mut v: Vec<i32> = data::load_used(&back_mode).into_iter().collect();
    v.sort();
    v
}

#[tauri::command]
pub fn is_in_forbid_range() -> bool {
    data::is_in_forbid_range()
}

#[tauri::command]
pub fn start_draw(
    back_mode: String,
    max_num: i32,
    qty: i32,
    gender: Option<String>,
    save: bool,
) -> Result<DrawResult, String> {
    lock::check_other_session(StartupMode::current())?;

    let nl = settings::get_number_limits();
    let ql = settings::get_quantity_limits();
    if !((nl.min..=nl.max).contains(&(max_num as i64))) {
        return Err(format!("最大号码必须在 {}-{} 之间", nl.min, nl.max));
    }
    if !((ql.min..=ql.max).contains(&(qty as i64))) {
        return Err(format!("抽号数量必须在 {}-{} 之间", ql.min, ql.max));
    }
    // 禁用时段内非 Mode5 模式需 U盘验证
    let in_break = data::is_in_forbid_range();
    if back_mode != config::MODE5_BACK && in_break && !settings::is_usb_session_valid(in_break) {
        return Err("当前为禁用时段，请先验证U盘或使用模式五".to_string());
    }
    let students = data::load_students();
    let mut boys: HashSet<i32> = HashSet::new();
    let mut girls: HashSet<i32> = HashSet::new();
    for s in &students {
        if s.gender == "boy" {
            boys.insert(s.number);
        } else if s.gender == "girl" {
            girls.insert(s.number);
        }
    }
    let ahen = settings::get_ahen_config();
    Ok(perform_draw(
        &back_mode,
        max_num,
        qty,
        gender.as_deref(),
        &boys,
        &girls,
        save,
        &ahen,
        in_break,
    ))
}

#[tauri::command]
pub fn clear_record(back_mode: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    data::clear_record(&back_mode);
    Ok(())
}

#[tauri::command]
pub fn reset_memory_mode(back_mode: String) {
    data::reset_memory_mode(&back_mode);
}

/// U 盘验证 - 使用卷序列号 + SHA256 哈希验证
#[tauri::command]
pub fn usb_valid() -> bool {
    // 防御性：捕获可能的 panics，避免崩溃
    match std::panic::catch_unwind(|| {
        settings::check_usb_authorized()
    }) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("[usb_valid] panic caught: {:?}", e);
            false
        }
    }
}

/// 检查是否有已注册的授权U盘
#[tauri::command]
pub fn has_registered_usb() -> bool {
    settings::has_registered_usb()
}

/// 获取可移动驱动器列表
#[tauri::command]
pub fn list_removable_drives() -> Vec<String> {
    match std::panic::catch_unwind(|| {
        settings::list_removable_drives()
    }) {
        Ok(drives) => drives,
        Err(e) => {
            eprintln!("[list_removable_drives] panic caught: {:?}", e);
            Vec::new()
        }
    }
}

/// 注册指定盘符为授权U盘
#[tauri::command]
pub fn register_usb(drive: String) -> Result<String, String> {
    if settings::has_registered_usb() && !settings::check_usb_authorized() {
        return Err("注册新U盘前，请先插入并验证已授权U盘".to_string());
    }
    lock::check_other_session(StartupMode::current())?;
    settings::register_current_usb(Some(drive))
}

/// 自动检测并注册第一个可移动U盘
#[tauri::command]
pub fn auto_register_usb() -> Result<String, String> {
    if settings::has_registered_usb() && !settings::check_usb_authorized() {
        return Err("注册新U盘前，请先插入并验证已授权U盘".to_string());
    }
    lock::check_other_session(StartupMode::current())?;
    settings::register_current_usb(None)
}

/// 验证 U盘以跳过禁用时段限制（模式 1-4）
#[tauri::command]
pub fn verify_usb_for_session(scope: String) -> bool {
    let scope = match scope.as_str() {
        "permanent" => UsbVerifyScope::Permanent,
        _ => UsbVerifyScope::CurrentBreak,
    };
    settings::verify_usb_session(scope)
}

/// 判断当前 U盘会话验证是否仍有效
#[tauri::command]
pub fn is_usb_session_verified() -> bool {
    let in_break = data::is_in_forbid_range();
    settings::is_usb_session_valid(in_break)
}

/// 获取 U盘验证有效期设置
#[tauri::command]
pub fn get_usb_verify_scope() -> String {
    settings::usb_verify_scope_string(settings::get_usb_verify_scope_setting()).to_string()
}

/// 保存 U盘验证有效期设置
#[tauri::command]
pub fn save_usb_verify_scope(scope: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::save_usb_verify_scope_setting(settings::parse_usb_verify_scope(&scope));
    Ok(())
}

// ─────────── 内存模式设置 ───────────

#[tauri::command]
pub fn get_memory_mode_statuses() -> Vec<MemoryModeStatus> {
    settings::get_memory_mode_statuses()
}

#[tauri::command]
pub fn set_memory_mode(back_mode: String, enabled: bool) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::set_memory_mode(&back_mode, enabled);
    Ok(())
}

// ─────────── 时间段设置 ───────────

#[tauri::command]
pub fn get_time_ranges() -> Vec<TimeRange> {
    settings::get_time_ranges()
}

#[tauri::command]
pub fn save_time_ranges(ranges: Vec<TimeRange>) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::save_time_ranges(ranges)
}

// ─────────── 暗痕设置 ───────────

#[tauri::command]
pub fn get_ahen_config() -> AhenConfig {
    settings::get_ahen_config()
}

#[tauri::command]
pub fn save_ahen_config(config: AhenConfig) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::save_ahen_config(&config)
}

// ─────────── 座位表方向设置 ───────────

#[tauri::command]
pub fn get_seat_direction() -> String {
    match settings::get_seat_direction() {
        SeatDirection::Rtl => "rtl".to_string(),
        SeatDirection::Ltr => "ltr".to_string(),
    }
}

#[tauri::command]
pub fn save_seat_direction(direction: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    let d = match direction.as_str() {
        "ltr" => SeatDirection::Ltr,
        _ => SeatDirection::Rtl,
    };
    settings::save_seat_direction(&d)
}

// ─────────── 模式名设置 ───────────

#[tauri::command]
pub fn save_modes(front_names: Vec<String>) -> Result<(), String> {
    if front_names.len() != 4 {
        return Err("必须提供4个模式名称".to_string());
    }
    for name in &front_names {
        if name.trim().is_empty() {
            return Err("模式名称不能为空".to_string());
        }
    }
    lock::check_other_session(StartupMode::current())?;
    db::set_setting("modes_front", &front_names.join(","));
    Ok(())
}

// ─────────── 高级抽号 ───────────

#[tauri::command]
pub fn load_seatmap() -> Option<String> {
    data::load_seatmap()
}

#[tauri::command]
pub fn save_seatmap(seatmap_json: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    data::save_seatmap(&seatmap_json);
    Ok(())
}

/// 高级抽号 V2：后端完成分组 / 手动 / 性别过滤等随机逻辑
#[tauri::command]
pub fn advanced_draw_v2(req: AdvancedDrawRequest) -> Result<AdvancedDrawResult, String> {
    if req.qty < 1 {
        return Err("抽号数量必须大于 0".to_string());
    }
    lock::check_other_session(StartupMode::current())?;

    let seatmap_json = data::load_seatmap().unwrap_or_default();
    if seatmap_json.is_empty() {
        return Err("未导入座位表".to_string());
    }
    let students = data::load_students();
    let direction = settings::get_seat_direction();
    let ahen = settings::get_ahen_config();
    let in_break = data::is_in_forbid_range();
    advanced_perform_draw_v2(&req, &seatmap_json, &students, &direction, &ahen, in_break)
}

#[tauri::command]
pub fn check_students_exist() -> bool {
    let students = data::load_students();
    !students.is_empty()
}

/// 读取本地文本文件（用于导入座位表 JSON）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 返回启动视图名称
/// 优先从命令行参数（--settings）决定；若首次运行且未进入过设置，
/// 即使以抽号模式启动也先引导至设置界面。
#[tauri::command]
pub fn get_startup_view() -> String {
    match StartupMode::current() {
        StartupMode::Settings => "settings".to_string(),
        StartupMode::Draw => {
            let settings_done = db::get_setting("first_run_settings_done")
                .map(|v| v == "1")
                .unwrap_or(false);
            if settings_done {
                "draw".to_string()
            } else {
                "settings".to_string()
            }
        }
    }
}

// ─────────── 悬浮窗管理（原生 Win32 实现） ───────────

/// 关闭已存在的悬浮窗（若有），保证全局唯一
#[tauri::command]
pub fn close_float_window() {
    float_window::close_float_window();
}

/// 创建/重建悬浮窗：先销毁已有实例，再创建一个新的，确保全局只有一个悬浮窗。
#[tauri::command]
pub fn ensure_float_window() -> Result<(), String> {
    float_window::show_float_window()
}

/// 关闭悬浮窗并将主窗口前置激活
#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    float_window::close_float_window();
    if let Some(adv) = app.get_webview_window(ADVANCED_LABEL) {
        let _ = adv.hide();
    }
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

/// 高级抽号窗口最小化：隐藏自身并显示悬浮窗
#[tauri::command]
pub fn advanced_minimize_to_float(app: AppHandle) -> Result<(), String> {
    if let Some(adv) = app.get_webview_window(ADVANCED_LABEL) {
        let _ = adv.hide();
    }
    float_window::show_float_window()
}

/// 主窗口最小化时显示悬浮窗
#[tauri::command]
pub fn main_minimize_to_float() -> Result<(), String> {
    float_window::show_float_window()
}

// ─────────── 抽号参数范围 ───────────

#[tauri::command]
pub fn get_number_limits() -> NumberLimits {
    settings::get_number_limits()
}

#[tauri::command]
pub fn save_number_limits(min: i64, max: i64) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::save_number_limits(min, max)
}

#[tauri::command]
pub fn get_quantity_limits() -> QuantityLimits {
    settings::get_quantity_limits()
}

#[tauri::command]
pub fn save_quantity_limits(min: i64, max: i64) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::save_quantity_limits(min, max)
}

// ─────────── 名单导入 ───────────

/// 解析名单文件（CSV/Excel），返回按性别分组结果（不写盘）
#[tauri::command]
pub fn parse_students_file(path: String) -> Result<ParsedStudents, String> {
    settings::parse_students_file(&path)
}

/// 将解析结果覆盖写入 students_boy / students_girl
#[tauri::command]
pub fn overwrite_students(
    boys: Vec<db::StudentRecord>,
    girls: Vec<db::StudentRecord>,
) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::overwrite_students(boys, girls)
}

// ─────────── 多套名单管理 ───────────

/// 获取所有名单名称及当前活跃名单
#[tauri::command]
pub fn get_rosters_info() -> (Vec<String>, String) {
    settings::get_rosters_info()
}

/// 创建新名单
#[tauri::command]
pub fn create_roster(name: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::create_roster(&name)
}

/// 切换活跃名单
#[tauri::command]
pub fn switch_roster(name: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::switch_roster(&name)
}

/// 重命名名单
#[tauri::command]
pub fn rename_roster(old_name: String, new_name: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::rename_roster(&old_name, &new_name)
}

/// 删除名单
#[tauri::command]
pub fn delete_roster(name: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::delete_roster(&name)
}

/// 复制名单
#[tauri::command]
pub fn duplicate_roster(src: String, dst: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::duplicate_roster(&src, &dst)
}

// ─────────── 数据迁移 ───────────

#[tauri::command]
pub fn export_data(items: Vec<String>, path: String) -> Result<(), String> {
    settings::export_data(&items, &path)
}

#[tauri::command]
pub fn import_data_preview(path: String) -> Result<ImportPreview, String> {
    settings::import_data_preview(&path)
}

#[tauri::command]
pub fn import_data_apply(items: Vec<String>, path: String) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    settings::import_data_apply(&items, &path)
}

// ─────────── 引导与跨程序切换 ───────────

/// 检查指定范围（draw/settings）的首次引导是否已完成
#[tauri::command]
pub fn get_first_run_done(scope: String) -> bool {
    db::get_setting(&format!("first_run_{}_done", scope))
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// 标记指定范围的首次引导已完成
#[tauri::command]
pub fn set_first_run_done(scope: String) {
    db::set_setting(&format!("first_run_{}_done", scope), "1");
}

/// 切换到另一个程序（抽号 <-> 设置）
/// 删除当前锁文件后启动另一个程序并退出当前进程
#[tauri::command]
pub fn switch_app(app: AppHandle) -> Result<(), String> {
    let current = StartupMode::current();

    #[cfg(debug_assertions)]
    {
        // 开发模式：不退出当前进程（否则 Vite dev server 会被关闭，
        // 新进程无法连接 localhost:1420）。直接在当前主窗口切换视图即可。
        let target_view = match current {
            StartupMode::Draw => "settings",
            StartupMode::Settings => "draw",
        };
        // 关闭可能存在的高级抽号窗口
        if let Some(adv) = app.get_webview_window("advanced-draw") {
            let _ = adv.close();
        }
        let main = app.get_webview_window("main")
            .ok_or("找不到主窗口")?;
        let mut url = main.url()
            .map_err(|e| format!("无法获取当前 URL: {}", e))?;
        // 保留现有查询参数，仅替换 view
        let preserved: String = url.query()
            .unwrap_or("")
            .split('&')
            .filter(|p| !p.is_empty() && !p.starts_with("view="))
            .collect::<Vec<_>>()
            .join("&");
        let new_query = if preserved.is_empty() {
            format!("view={}", target_view)
        } else {
            format!("{}&view={}", preserved, target_view)
        };
        url.set_query(Some(&new_query));
        main.navigate(url)
            .map_err(|e| format!("导航失败: {}", e))?;

        // 更新当前模式，让后续 get_startup_view 返回正确值
        let new_mode = match current {
            StartupMode::Draw => StartupMode::Settings,
            StartupMode::Settings => StartupMode::Draw,
        };
        StartupMode::set(new_mode);
        // 释放旧锁并获取新锁，避免 check_other_session 误判
        crate::lock::SessionLock::switch_to(new_mode)?;
        return Ok(());
    }

    #[cfg(not(debug_assertions))]
    {
        let other_arg = match current {
            StartupMode::Draw => "--settings",
            StartupMode::Settings => "--draw",
        };
        spawn_new_instance_and_exit(other_arg, false)
    }
}

// ─────────── 窗口状态记忆 ───────────

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// 读取指定窗口（draw/settings）的保存状态
#[tauri::command]
pub fn get_window_state(scope: String) -> Option<WindowState> {
    db::get_setting(&format!("window_state_{}", scope))
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// 保存指定窗口的状态
#[tauri::command]
pub fn save_window_state(scope: String, state: WindowState) {
    if let Ok(json) = serde_json::to_string(&state) {
        db::set_setting(&format!("window_state_{}", scope), &json);
    }
}

// ─────────── 主题设置 ───────────

/// 读取主题设置：返回 "light" / "dark" / "system"
#[tauri::command]
pub fn get_theme() -> String {
    db::get_setting("theme").unwrap_or_else(|| "light".to_string())
}

/// 保存主题设置
#[tauri::command]
pub fn save_theme(theme: String) {
    db::set_setting("theme", &theme);
}

// ─────────── 显示格式 ───────────

/// 读取结果显示格式：返回 "number" / "name" / "number_name"
#[tauri::command]
pub fn get_display_format() -> String {
    db::get_setting("display_format").unwrap_or_else(|| "number_name".to_string())
}

/// 保存结果显示格式
#[tauri::command]
pub fn save_display_format(format: String) {
    db::set_setting("display_format", &format);
}

// ─────────── 记录过期管理 ───────────

/// 读取记录过期天数：返回 0 表示不自动清理，>0 表示保留 N 天
/// 默认 0（不自动清理）
#[tauri::command]
pub fn get_record_expire_days() -> u32 {
    db::get_setting("record_expire_days")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
}

/// 保存记录过期天数
#[tauri::command]
pub fn save_record_expire_days(days: u32) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;
    db::set_setting("record_expire_days", &days.to_string());
    Ok(())
}

/// 立即清理指定天数之前的记录（days=0 表示清空全部）
/// 返回被删除的记录数
#[tauri::command]
pub fn purge_old_records(days: u32) -> Result<usize, String> {
    lock::check_other_session(StartupMode::current())?;
    Ok(db::purge_old_records(days))
}

/// 获取指定模式的最近 N 条记录（带时间戳），按时间倒序
/// 返回 (号码, 时间戳字符串) 列表
#[tauri::command]
pub fn get_recent_records_with_time(
    mode: String,
    limit: u32,
) -> Vec<(i32, String)> {
    db::get_recent_records_with_time(&mode, limit)
}

// ─────────── 开机自启 ───────────

const AUTOSTART_REG_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE_NAME: &str = "NumberSelector";

/// 检查开机自启是否已启用
#[tauri::command]
pub fn is_autostart_enabled() -> bool {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return false,
    };
    // 规范化路径：统一小写、统一正斜杠，避免 reg query 输出格式差异导致匹配失败
    let expected = format!("\"{}\"", exe.display()).to_lowercase().replace('\\', "/");

    let mut cmd = std::process::Command::new("reg");
    cmd.args(["query", AUTOSTART_REG_KEY, "/v", AUTOSTART_VALUE_NAME]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output();
    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_lowercase().replace('\\', "/");
            stdout.contains(&expected)
        }
        Err(_) => false,
    }
}

/// 启用开机自启（写入注册表 Run 键）
#[tauri::command]
pub fn enable_autostart() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法获取程序路径: {}", e))?;
    let value = format!("\"{}\"", exe.display());

    let mut cmd = std::process::Command::new("reg");
    cmd.args([
        "add",
        AUTOSTART_REG_KEY,
        "/v",
        AUTOSTART_VALUE_NAME,
        "/t",
        "REG_SZ",
        "/d",
        &value,
        "/f",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("注册自启动失败: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "注册自启动失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// 禁用开机自启
#[tauri::command]
pub fn disable_autostart() -> Result<(), String> {
    let mut cmd = std::process::Command::new("reg");
    cmd.args([
        "delete",
        AUTOSTART_REG_KEY,
        "/v",
        AUTOSTART_VALUE_NAME,
        "/f",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("取消自启动失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 键值不存在算成功
        if !stderr.contains("unable to find") && !stderr.contains("找不到") {
            return Err(format!("取消自启动失败: {}", stderr));
        }
    }
    Ok(())
}

// ─────────── 一键重启 ───────────

/// 重启当前程序：释放锁、启动新实例、退出当前进程
#[tauri::command]
pub fn restart_app() -> Result<(), String> {
    let current = StartupMode::current();
    let arg = match current {
        StartupMode::Draw => "--draw",
        StartupMode::Settings => "--settings",
    };
    spawn_new_instance_and_exit(arg, true)
}

/// 释放当前锁、启动新实例、退出当前进程
/// clean_temp: 是否清理启动模式检测的临时文件
fn spawn_new_instance_and_exit(arg: &str, clean_temp: bool) -> Result<(), String> {
    let current = StartupMode::current();
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法获取程序路径: {}", e))?;

    // 释放当前锁：删除锁文件以允许新实例启动
    let lock_file = crate::config::data_dir().join(current.lock_file_name());
    let _ = std::fs::remove_file(&lock_file);

    if clean_temp {
        // 清理可能存在的旧临时文件，避免干扰启动模式检测
        let temp_path = std::env::temp_dir().join("ns_startup_settings.txt");
        let _ = std::fs::remove_file(&temp_path);
    }

    std::process::Command::new(&exe)
        .arg(arg)
        .spawn()
        .map_err(|e| format!("启动失败: {}", e))?;

    std::process::exit(0);
}

// ─────────── 数据目录切换 ───────────

#[derive(serde::Serialize)]
pub struct DataDirInfo {
    pub kind: String,
    pub path: String,
    pub portable_path: String,
    pub app_data_path: String,
    pub custom_path: String,
    pub overridden_by_env: bool,
}

/// 获取当前数据目录配置信息
#[tauri::command]
pub fn get_data_dir_info(app: AppHandle) -> Result<DataDirInfo, String> {
    let kind = config::current_data_dir_kind();
    let path = config::data_dir();
    let portable_path = config::portable_data_dir();
    let app_data_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let custom_path = config::bootstrap_custom_path().unwrap_or_default();

    Ok(DataDirInfo {
        kind: match kind {
            DataDirKind::Portable => "portable",
            DataDirKind::AppData => "app_data",
            DataDirKind::Custom => "custom",
        }
        .to_string(),
        path: path.to_string_lossy().to_string(),
        portable_path: portable_path.to_string_lossy().to_string(),
        app_data_path: app_data_path.to_string_lossy().to_string(),
        custom_path: custom_path.to_string_lossy().to_string(),
        overridden_by_env: config::is_env_override(),
    })
}

/// 设置数据目录类型（重启后生效）
#[tauri::command]
pub fn set_data_dir(kind: String, custom_path: Option<String>) -> Result<(), String> {
    lock::check_other_session(StartupMode::current())?;

    let kind = match kind.as_str() {
        "portable" => DataDirKind::Portable,
        "app_data" => DataDirKind::AppData,
        "custom" => DataDirKind::Custom,
        _ => return Err("无效的数据目录类型".to_string()),
    };

    let custom = custom_path.as_deref().map(Path::new);
    if kind == DataDirKind::Custom {
        let path = custom.ok_or("自定义路径不能为空")?;
        if !path.exists() {
            std::fs::create_dir_all(path)
                .map_err(|e| format!("创建自定义目录失败: {}", e))?;
        }
    }

    match kind {
        DataDirKind::Portable => config::clear_bootstrap_data_dir(),
        _ => config::set_bootstrap_data_dir(kind, custom),
    }
}

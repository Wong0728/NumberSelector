//! 智能抽号系统 - Tauri 后端

mod commands;
mod config;
mod data;
mod db;
mod draw;
mod float_window;
mod lock;
mod settings;
mod startup;
mod webview2;

use commands::*;
use tauri::{LogicalPosition, LogicalSize, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), String> {
    // WebView2 运行时保障：优先系统，其次 exe 同级 WebView2Runtime\，
    // 都没有时弹出原生引导（下载官方安装引导器 / 提示放置固定版本运行时）。
    webview2::ensure_runtime();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据目录：由引导配置（NumberSelector.config.json）决定；
            // 默认便携（程序侧），可切换为 %APPDATA% 或自定义绝对路径。
            let app_data_fallback = app.path().app_data_dir()
                .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
            let data_dir = config::resolve_data_dir(Some(app_data_fallback));
            config::set_app_data_dir(data_dir.clone());

            // 检测启动模式（--settings 或默认抽号）
            let explicit_mode = std::env::args().skip(1).any(|a| a == "--settings" || a == "--draw");
            let mut mode = startup::StartupMode::detect();

            // 若旧目录（exe 旁 data/）存在数据库，且当前使用便携目录，迁移到新目录
            if config::current_data_dir_kind() == config::DataDirKind::Portable {
                if let Some(old_dir) = config::old_data_dir() {
                    if old_dir != data_dir {
                        if let Err(e) = db::migrate_old_data(&old_dir, &data_dir) {
                            eprintln!("[migrate] 旧数据目录迁移失败: {}", e);
                        }
                    }
                }
            }

            // 初始化数据库
            db::init_databases()?;

            // 首次安装未完成设置引导前，默认进入设置程序，确保用户先完成基础配置
            let settings_done = db::get_setting("first_run_settings_done")
                .map(|v| v == "1")
                .unwrap_or(false);
            if !explicit_mode && !settings_done {
                mode = startup::StartupMode::Settings;
            }
            startup::StartupMode::set(mode);

            // 启动时按设置自动清理过期记录（0 表示不清理）
            let expire_days = db::get_setting("record_expire_days")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            if expire_days > 0 {
                let removed = db::purge_old_records(expire_days);
                if removed > 0 {
                    eprintln!("[cleanup] 启动时自动清理 {} 条过期记录（>{} 天）", removed, expire_days);
                }
            }

            // 获取本会话锁，防止同类型程序多开；存入全局静态以便切换视图时切换锁。
            let session_lock = lock::SessionLock::acquire(mode)
                .map_err(|e| format!("程序启动失败: {}", e))?;
            session_lock.store();

            // 注册悬浮窗点击回调：关闭悬浮窗 + 智能恢复窗口
            // 注意：close_float_window 由 WM_APP_CLICK 自处理，回调只负责窗口恢复
            let handle = app.handle().clone();
            float_window::set_click_callback(move || {
                // 智能判断：如果高级窗口存在且处于隐藏状态（被最小化），恢复高级窗口
                let advanced_hidden = handle.get_webview_window("advanced-draw")
                    .map(|adv| adv.is_visible().ok() == Some(false))
                    .unwrap_or(false);
                if advanced_hidden {
                    if let Some(adv) = handle.get_webview_window("advanced-draw") {
                        let _ = adv.show();
                        let _ = adv.set_focus();
                    }
                } else {
                    // 否则恢复主窗口
                    if let Some(main) = handle.get_webview_window("main") {
                        let _ = main.unminimize();
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                }
            });

            // 启动时在窗口显示前恢复保存的位置/尺寸/最大化状态，
            // 避免出现「先以默认尺寸居中显示，再被移动到记忆位置」的视觉跳跃。
            // tauri.conf.json 中 visible:false，由这里统一显式 show。
            if let Some(main_window) = app.get_webview_window("main") {
                let scope = match mode {
                    startup::StartupMode::Draw => "draw",
                    startup::StartupMode::Settings => "settings",
                };
                let saved = db::get_setting(&format!("window_state_{}", scope))
                    .and_then(|s| serde_json::from_str::<WindowState>(&s).ok());
                if let Some(ws) = saved {
                    if ws.maximized {
                        let _ = main_window.maximize();
                    } else if ws.width > 0 && ws.height > 0 {
                        let _ = main_window.set_size(LogicalSize::new(ws.width, ws.height));
                        let _ = main_window.set_position(LogicalPosition::new(ws.x, ws.y));
                    }
                }
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_modes,
            get_memory_modes,
            get_students,
            get_used,
            is_in_forbid_range,
            start_draw,
            clear_record,
            reset_memory_mode,
            usb_valid,
            verify_usb_for_session,
            is_usb_session_verified,
            get_usb_verify_scope,
            save_usb_verify_scope,
            load_seatmap,
            save_seatmap,
            advanced_draw_v2,
            check_students_exist,
            read_text_file,
            get_startup_view,
            // ── 设置命令 ──
            has_registered_usb,
            list_removable_drives,
            register_usb,
            auto_register_usb,
            get_memory_mode_statuses,
            set_memory_mode,
            get_time_ranges,
            save_time_ranges,
            get_ahen_config,
            save_ahen_config,
            get_seat_direction,
            save_seat_direction,
            save_modes,
            get_break_allow_modes,
            save_break_allow_modes,
            // ── 悬浮窗管理 ──
            close_float_window,
            ensure_float_window,
            show_main_window,
            advanced_minimize_to_float,
            main_minimize_to_float,
            // ── 抽号参数范围 ──
            get_number_limits,
            save_number_limits,
            get_quantity_limits,
            save_quantity_limits,
            // ── 名单导入 ──
            parse_students_file,
            overwrite_students,
            // ── 多套名单管理 ──
            get_rosters_info,
            create_roster,
            switch_roster,
            rename_roster,
            delete_roster,
            duplicate_roster,
            // ── 数据迁移 ──
            export_data,
            import_data_preview,
            import_data_apply,
            // ── 引导与跨程序切换 ──
            get_first_run_done,
            set_first_run_done,
            switch_app,
            // ── 窗口状态记忆 ──
            get_window_state,
            save_window_state,
            // ── 主题 ──
            get_theme,
            save_theme,
            // ── 显示格式 ──
            get_display_format,
            save_display_format,
            // ── 记录过期管理 ──
            get_record_expire_days,
            save_record_expire_days,
            purge_old_records,
            get_recent_records_with_time,
            // ── 开机自启 + 重启 ──
            is_autostart_enabled,
            enable_autostart,
            disable_autostart,
            restart_app,
            // ── 数据目录切换 ──
            get_data_dir_info,
            set_data_dir,
        ])
        .run(tauri::generate_context!())
        .map_err(|e| e.to_string())
}

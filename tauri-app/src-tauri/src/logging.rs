//! 简易文件日志：追加写入 <data_dir>/app.log，超过上限自动截断。
//! 用于现场排查（如「只能抽一次号」），前端通过 log_event 命令写入，
//! 后端关键路径（抽号 / 数据库 / 锁）直接调用。

use std::fs::OpenOptions;
use std::io::Write;

use chrono::Local;
use parking_lot::Mutex;

/// 日志文件大小上限（超过后截断重写，保留最新日志）
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn log_event(category: &str, message: &str) {
    log_with_level("info", category, message);
}

/// 带级别的日志写入。level: debug / info / warn / error
pub fn log_with_level(level: &str, category: &str, message: &str) {
    let now = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    eprintln!("{} [{}][{}] {}", now, level, category, message);

    let path = crate::config::data_dir().join("app.log");
    let _guard = WRITE_LOCK.lock();

    // 超过上限时截断，避免日志无限增长
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let head = format!(
                "{} [log] 日志超过 {}KB，已截断\n",
                now,
                MAX_LOG_BYTES / 1024
            );
            let _ = std::fs::write(&path, head);
        }
    }

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(
            format!("{} [{}][{}] {}\n", now, level, category, message).as_bytes(),
        );
    }
}

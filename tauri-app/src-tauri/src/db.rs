//! SQLite 数据库初始化与管理

use std::path::PathBuf;
use std::sync::OnceLock;

use parking_lot::Mutex;
use rusqlite::{params, Connection};

use crate::config::*;

static RECORDS_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();
static SETTINGS_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

pub fn db_dir() -> PathBuf {
    let d = data_dir();
    std::fs::create_dir_all(&d).ok();
    d
}

pub fn records_db() -> PathBuf {
    db_dir().join("records.db")
}

pub fn settings_db() -> PathBuf {
    db_dir().join("settings.db")
}

/// 初始化数据库（在应用启动时调用一次）
pub fn init_databases() -> Result<(), String> {
    if RECORDS_CONN.get().is_some() && SETTINGS_CONN.get().is_some() {
        return Ok(());
    }

    std::fs::create_dir_all(db_dir()).map_err(|e| format!("创建数据目录失败: {}", e))?;

    let records = Connection::open(records_db())
        .map_err(|e| format!("无法打开 records.db: {}", e))?;
    records
        .execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("设置 records WAL 失败: {}", e))?;
    init_records_db(&records)?;

    let settings = Connection::open(settings_db())
        .map_err(|e| format!("无法打开 settings.db: {}", e))?;
    settings
        .execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("设置 settings WAL 失败: {}", e))?;
    init_settings_db(&settings)?;

    let _ = RECORDS_CONN.set(Mutex::new(records));
    let _ = SETTINGS_CONN.set(Mutex::new(settings));

    migrate_students_from_files();
    Ok(())
}

fn records_conn() -> &'static Mutex<Connection> {
    RECORDS_CONN
        .get()
        .expect("records.db 未初始化，请先调用 init_databases")
}

fn settings_conn() -> &'static Mutex<Connection> {
    SETTINGS_CONN
        .get()
        .expect("settings.db 未初始化，请先调用 init_databases")
}

fn init_records_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS draw_records (
             id    INTEGER PRIMARY KEY AUTOINCREMENT,
             mode  TEXT    NOT NULL,
             number INTEGER NOT NULL,
             drawn_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_records_mode ON draw_records(mode);",
    )
    .map_err(|e| format!("初始化 records.db 失败: {}", e))?;
    Ok(())
}

fn init_settings_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("初始化 settings.db 失败: {}", e))?;

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
        .unwrap_or(0);
    if count == 0 {
        let mut stmt = conn
            .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)")
            .map_err(|e| format!("prepare settings insert 失败: {}", e))?;
        let fronts = DEFAULT_FRONT_1TO4.join(",");
        stmt.execute(params!["modes_front", &fronts]).ok();
        let mem = DEFAULT_MEMORY_MODES.join(",");
        stmt.execute(params!["memory_modes", &mem]).ok();
        let ranges: String = DEFAULT_RANGES
            .iter()
            .map(|(h1, m1, h2, m2)| format!("{h1} {m1} {h2} {m2}"))
            .collect::<Vec<_>>()
            .join("\n");
        stmt.execute(params!["time_ranges", &ranges]).ok();
        stmt.execute(params!["students_boy", "[]"]).ok();
        stmt.execute(params!["students_girl", "[]"]).ok();
        stmt.execute(params!["ahen_config", r#"{"enabled":false,"only_break":true,"triggers":{}}"#])
            .ok();
        stmt.execute(params!["seat_direction", "rtl"]).ok();
        stmt.execute(params!["usb_verify_scope", "current_break"]).ok();
    }
    Ok(())
}

// ───── 公开的 CRUD 方法 ─────

/// 获取模式前端名称（逗号分隔）
pub fn get_setting(key: &str) -> Option<String> {
    let conn = settings_conn().lock();
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .ok()
}

pub fn set_setting(key: &str, value: &str) {
    let conn = settings_conn().lock();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    );
}

/// 为指定模式添加抽号记录（事务批量写入，保证原子性）
pub fn add_records(mode: &str, numbers: &[i32]) {
    let conn = records_conn().lock();
    let tx = match conn.unchecked_transaction() {
        Ok(t) => t,
        Err(e) => { eprintln!("[db] begin tx 失败: {}", e); return; }
    };
    for n in numbers {
        let _ = tx.execute(
            "INSERT INTO draw_records (mode, number) VALUES (?1, ?2)",
            params![mode, n],
        );
    }
    let _ = tx.commit();
}

/// 获取指定模式的所有已抽号码
pub fn get_used_for(mode: &str) -> Vec<i32> {
    let conn = records_conn().lock();
    let mut stmt = match conn.prepare("SELECT DISTINCT number FROM draw_records WHERE mode = ?1 ORDER BY number") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[db] prepare get_used 失败: {}", e);
            return Vec::new();
        }
    };
    let nums: Vec<i32> = stmt
        .query_map(params![mode], |r| r.get(0))
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    nums
}

/// 清空指定模式的所有记录
pub fn clear_records(mode: &str) {
    let conn = records_conn().lock();
    let _ = conn.execute("DELETE FROM draw_records WHERE mode = ?1", params![mode]);
}

/// 获取所有设置键值对（用于数据导出）
pub fn get_all_settings() -> Vec<(String, String)> {
    let conn = settings_conn().lock();
    let mut stmt = match conn.prepare("SELECT key, value FROM settings ORDER BY key") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .ok();
    match rows {
        Some(iter) => iter.filter_map(|r| r.ok()).collect(),
        None => Vec::new(),
    }
}

/// 获取所有模式及其去重已抽号码（用于数据导出）
pub fn get_all_records_grouped() -> Vec<(String, Vec<i32>)> {
    let conn = records_conn().lock();
    let mut stmt = match conn.prepare(
        "SELECT DISTINCT mode, number FROM draw_records ORDER BY mode, number",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?)))
        .ok();
    let mut map: std::collections::BTreeMap<String, Vec<i32>> = std::collections::BTreeMap::new();
    if let Some(iter) = rows {
        for r in iter.flatten() {
            map.entry(r.0).or_default().push(r.1);
        }
    }
    map.into_iter().collect()
}

/// 清空所有模式的抽号记录（用于导入前重置）
pub fn clear_all_records() {
    let conn = records_conn().lock();
    let _ = conn.execute("DELETE FROM draw_records", []);
}

/// 删除指定天数之前的记录（days=0 表示清空全部）
/// 返回删除的行数
pub fn purge_old_records(days: u32) -> usize {
    let conn = records_conn().lock();
    if days == 0 {
        return conn.execute("DELETE FROM draw_records", []).unwrap_or(0);
    }
    conn.execute(
        "DELETE FROM draw_records WHERE drawn_at < datetime('now','localtime', ?1)",
        params![format!("-{} days", days)],
    )
    .unwrap_or(0)
}

/// 获取指定模式的最近 N 条记录（带时间戳），按时间倒序
pub fn get_recent_records_with_time(mode: &str, limit: u32) -> Vec<(i32, String)> {
    let conn = records_conn().lock();
    let mut stmt = match conn.prepare(
        "SELECT number, drawn_at FROM draw_records WHERE mode = ?1 ORDER BY id DESC LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt
        .query_map(params![mode, limit], |r| {
            Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?))
        })
        .ok();
    match rows {
        Some(iter) => iter.filter_map(|r| r.ok()).collect(),
        None => Vec::new(),
    }
}

/// 从旧数据目录迁移 SQLite 数据库到新的 app_data_dir
pub fn migrate_old_data(old_dir: &std::path::Path, new_dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(new_dir).map_err(|e| format!("创建新数据目录失败: {}", e))?;

    let old_records = old_dir.join("records.db");
    let old_settings = old_dir.join("settings.db");
    let new_records = new_dir.join("records.db");
    let new_settings = new_dir.join("settings.db");

    if old_records.is_file() && !new_records.is_file() {
        std::fs::copy(&old_records, &new_records)
            .map_err(|e| format!("迁移 records.db 失败: {}", e))?;
    }
    if old_settings.is_file() && !new_settings.is_file() {
        std::fs::copy(&old_settings, &new_settings)
            .map_err(|e| format!("迁移 settings.db 失败: {}", e))?;
    }

    Ok(())
}

/// 从旧版 ConfigEngine/Students/*.txt 迁移学生数据到 settings.db
fn migrate_students_from_files() {
    let boys_empty = get_setting("students_boy")
        .map(|s| s == "[]" || s.is_empty())
        .unwrap_or(true);
    let girls_empty = get_setting("students_girl")
        .map(|s| s == "[]" || s.is_empty())
        .unwrap_or(true);
    if !boys_empty || !girls_empty {
        return;
    }

    let config_engine = try_find_config_engine();
    if let Some(ce) = config_engine {
        let boys = read_student_file(&ce.join("Students/boys.txt"), "boy");
        let girls = read_student_file(&ce.join("Students/girls.txt"), "girl");
        if let Ok(json) = serde_json::to_string(&boys) {
            set_setting("students_boy", &json);
        }
        if let Ok(json) = serde_json::to_string(&girls) {
            set_setting("students_girl", &json);
        }
        migrate_time_ranges_file(&ce);
        migrate_modes_file(&ce);
    }
}

fn migrate_time_ranges_file(ce: &std::path::Path) {
    let tr = ce.join("time_ranges.txt");
    let c = match std::fs::read_to_string(&tr) {
        Ok(c) => c,
        Err(_) => return,
    };
    let trimmed = c.trim();
    if trimmed.is_empty() {
        return;
    }
    let mut ok = true;
    for line in trimmed.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() != 4 {
            ok = false;
            break;
        }
        if let Some(nums) = parse_time_parts(&parts) {
            if nums[0] > 23 || nums[2] > 23 || nums[1] > 59 || nums[3] > 59 {
                ok = false;
                break;
            }
        } else {
            ok = false;
            break;
        }
    }
    if ok {
        set_setting("time_ranges", trimmed);
    }
}

fn migrate_modes_file(ce: &std::path::Path) {
    let mf = ce.join("modes.txt");
    let c = match std::fs::read_to_string(&mf) {
        Ok(c) => c,
        Err(_) => return,
    };
    let t = c.trim();
    if t.is_empty() {
        return;
    }
    let parts: Vec<&str> = t.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if parts.len() == 4 {
        set_setting("modes_front", &parts.join(","));
    }
}

fn parse_time_parts(parts: &[&str]) -> Option<Vec<u32>> {
    parts.iter().map(|s| s.parse::<u32>().ok()).collect()
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct StudentRecord {
    pub number: i32,
    pub name: String,
    pub gender: String,
}

fn read_student_file(path: &std::path::Path, gender: &str) -> Vec<StudentRecord> {
    let mut out = Vec::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Ok(n) = parts[0].parse::<i32>() {
                    out.push(StudentRecord {
                        number: n,
                        name: parts[1..].join(" "),
                        gender: gender.to_string(),
                    });
                }
            }
        }
    }
    out
}

fn try_find_config_engine() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    if let Some(dir) = find_ancestor_dir(exe_dir, "ConfigEngine") {
        return Some(dir);
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let p = std::path::Path::new(manifest).join("../../ConfigEngine");
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// 向上遍历目录树查找名为 target 的子目录
fn find_ancestor_dir(start: &std::path::Path, target: &str) -> Option<PathBuf> {
    let mut cursor = start;
    for _ in 0..8 {
        let candidate = cursor.join(target);
        if candidate.is_dir() {
            return Some(candidate);
        }
        cursor = cursor.parent()?;
    }
    None
}

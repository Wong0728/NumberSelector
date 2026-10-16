//! 数据层：模式 / 学生 / 记录 / 时间段 / 内存模式 — 全部基于 SQLite

use std::collections::{HashMap, HashSet};

use chrono::{Local, Timelike};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Serialize;

use crate::config::*;
use crate::db;

#[derive(Debug, Clone, Serialize)]
pub struct ModesPayload {
    pub front: Vec<String>,
    pub back: Vec<String>,
    pub mode5_front: String,
    pub mode5_back: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Student {
    pub number: i32,
    pub name: String,
    pub gender: String, // "boy" | "girl"
}

/// 内存模式记录（不写盘，仅在内存模式中使用）
static MEMORY_USED: Lazy<RwLock<HashMap<String, HashSet<i32>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// 内存模式名称集合缓存
static MEMORY_MODES_CACHE: Lazy<RwLock<Option<HashSet<String>>>> =
    Lazy::new(|| RwLock::new(None));

/// 时间段缓存（避免每秒轮询 is_in_forbid_range 时重复读 DB）
static TIME_RANGES_CACHE: Lazy<RwLock<Option<Vec<(u32, u32, u32, u32)>>>> =
    Lazy::new(|| RwLock::new(None));

// ─────────── 模式 ───────────

pub fn load_modes() -> ModesPayload {
    let default_front: Vec<String> =
        DEFAULT_FRONT_1TO4.iter().map(|s| s.to_string()).collect();

    let front = if let Some(v) = db::get_setting("modes_front") {
        let parts: Vec<String> = v
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if parts.len() == 4 {
            parts
        } else {
            default_front.clone()
        }
    } else {
        db::set_setting("modes_front", &default_front.join(","));
        default_front
    };

    ModesPayload {
        front,
        back: DEFAULT_BACK_1TO4.iter().map(|s| s.to_string()).collect(),
        mode5_front: MODE5_FRONT.to_string(),
        mode5_back: MODE5_BACK.to_string(),
    }
}

// ─────────── 内存模式 ───────────

fn load_memory_modes_raw() -> HashSet<String> {
    let valid: HashSet<String> = DEFAULT_BACK_1TO4
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(MODE5_BACK.to_string()))
        .collect();

    let default_set: HashSet<String> = DEFAULT_MEMORY_MODES
        .iter()
        .map(|s| s.to_string())
        .collect();

    if let Some(v) = db::get_setting("memory_modes") {
        let mut set: HashSet<String> = HashSet::new();
        for s in v.split(',') {
            let t = s.trim();
            if !t.is_empty() && valid.contains(t) {
                set.insert(t.to_string());
            }
        }
        // 键存在即以保存值为准：空集合是合法状态（用户主动关闭全部内存模式），
        // 只有键完全缺失才初始化默认值。Mode5 由 load_memory_modes 强制补回。
        set
    } else {
        db::set_setting("memory_modes", &DEFAULT_MEMORY_MODES.join(","));
        default_set
    }
}

pub fn load_memory_modes() -> HashSet<String> {
    let mut cache = MEMORY_MODES_CACHE.write();
    if let Some(ref cached) = *cache {
        return cached.clone();
    }
    let mut set = load_memory_modes_raw();
    // Mode5 强制为内存模式
    set.insert(MODE5_BACK.to_string());
    *cache = Some(set.clone());
    set
}

pub fn is_memory_mode(back: &str) -> bool {
    load_memory_modes().contains(back)
}

/// 重置缓存的 memory modes（当 setting 被修改时）
pub fn invalidate_memory_modes_cache() {
    MEMORY_MODES_CACHE.write().take();
}

// ─────────── 学生 ───────────

pub fn load_students() -> Vec<Student> {
    let mut out = Vec::new();
    for gender in &["boy", "girl"] {
        let key = if *gender == "boy" {
            "students_boy"
        } else {
            "students_girl"
        };
        if let Some(json) = db::get_setting(key) {
            match serde_json::from_str::<Vec<crate::db::StudentRecord>>(&json) {
                Ok(records) => {
                    for r in records {
                        out.push(Student {
                            number: r.number,
                            name: r.name,
                            gender: r.gender,
                        });
                    }
                }
                // 名单 JSON 损坏时静默变空名单会让性别过滤抽出「幽灵号码」，必须留痕
                Err(e) => {
                    crate::logging::log_with_level(
                        "error",
                        "data",
                        &format!("名单数据解析失败 key={}：{}（按空名单处理）", key, e),
                    );
                }
            }
        }
    }
    out
}

// ─────────── 记录 ───────────

pub fn load_used(back: &str) -> HashSet<i32> {
    if is_memory_mode(back) {
        return MEMORY_USED.read().get(back).cloned().unwrap_or_default();
    }
    let nums = db::get_used_for(back);
    nums.into_iter().collect()
}

pub fn save_record(back: &str, nums: &[i32]) {
    if is_memory_mode(back) {
        let mut g = MEMORY_USED.write();
        g.entry(back.to_string())
            .or_default()
            .extend(nums.iter().copied());
        return;
    }
    db::add_records(back, nums);
}

pub fn clear_record(back: &str) {
    if is_memory_mode(back) {
        if let Some(s) = MEMORY_USED.write().get_mut(back) {
            s.clear();
        }
        return;
    }
    db::clear_records(back);
}

pub fn reset_memory_mode(back: &str) {
    if let Some(s) = MEMORY_USED.write().get_mut(back) {
        s.clear();
    }
}

/// 清空所有内存模式的记录（切换名单/导入数据时调用）
pub fn clear_all_memory_used() {
    let mut g = MEMORY_USED.write();
    for (_, set) in g.iter_mut() {
        set.clear();
    }
}

// ─────────── 时间段 ───────────

pub fn load_time_ranges() -> Vec<(u32, u32, u32, u32)> {
    {
        let cache = TIME_RANGES_CACHE.read();
        if let Some(ref cached) = *cache {
            return cached.clone();
        }
    }

    let default_ranges: Vec<(u32, u32, u32, u32)> = DEFAULT_RANGES.to_vec();
    let result = if let Some(v) = db::get_setting("time_ranges") {
        let mut out: Vec<(u32, u32, u32, u32)> = Vec::new();
        let mut bad = false;
        for line in v.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let nums: Vec<&str> = line.split_whitespace().collect();
            if nums.len() != 4 {
                bad = true;
                break;
            }
            let parsed: Result<Vec<u32>, _> =
                nums.iter().map(|s| s.parse::<u32>()).collect();
            match parsed {
                Ok(v) => {
                    let valid = v.iter().enumerate().all(|(i, n)| {
                        if i % 2 == 0 { *n <= 23 } else { *n <= 59 }
                    });
                    if !valid {
                        bad = true;
                        break;
                    }
                    out.push((v[0], v[1], v[2], v[3]));
                }
                Err(_) => {
                    bad = true;
                    break;
                }
            }
        }
        // 只有格式损坏（bad）才回退默认；空列表是合法状态（用户删除全部时段 = 全天可抽号）
        if bad {
            persist_default_ranges(&default_ranges);
            default_ranges
        } else {
            out
        }
    } else {
        persist_default_ranges(&default_ranges);
        default_ranges
    };

    *TIME_RANGES_CACHE.write() = Some(result.clone());
    result
}

/// 重置时间段缓存（当 setting 被修改时调用）
pub fn invalidate_time_ranges_cache() {
    *TIME_RANGES_CACHE.write() = None;
}

/// 将默认时间段写入设置表（首次初始化或数据损坏回退时调用）
fn persist_default_ranges(ranges: &[(u32, u32, u32, u32)]) {
    let s = ranges
        .iter()
        .map(|(h1, m1, h2, m2)| format!("{h1} {m1} {h2} {m2}"))
        .collect::<Vec<_>>()
        .join("\n");
    db::set_setting("time_ranges", &s);
}

// ─────────── 座位表 (Seatmap) ───────────

pub fn load_seatmap() -> Option<String> {
    db::get_setting("seatmap")
}

pub fn save_seatmap(json: &str) {
    db::set_setting("seatmap", json);
}

pub fn is_in_forbid_range() -> bool {
    let now = Local::now();
    let now_min = now.hour() * 60 + now.minute();
    for (h1, m1, h2, m2) in load_time_ranges() {
        let s = h1 * 60 + m1;
        let e = h2 * 60 + m2;
        // 零长度时段（起止相同）视为无意义，直接跳过
        if s == e {
            continue;
        }
        if s < e {
            if now_min >= s && now_min <= e {
                return true;
            }
        } else if now_min >= s || now_min <= e {
            return true;
        }
    }
    false
}

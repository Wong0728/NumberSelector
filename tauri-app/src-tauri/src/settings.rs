//! 设置管理：U盘验证、内存模式、时间段、暗痕等

use sha2::{Sha256, Digest};
use serde::{Deserialize, Serialize};

use crate::config::*;
use crate::data;
use crate::db;

// ═══════════════════════════════════════════════
//  U盘验证（基于卷序列号）
// ═══════════════════════════════════════════════

/// 获取所有可移动驱动器盘符（如 D:, E:）
fn get_removable_drives() -> Vec<String> {
    let mut drives = Vec::new();
    unsafe {
        let bitmask = windows::Win32::Storage::FileSystem::GetLogicalDrives();
        if bitmask == 0 {
            eprintln!("[settings] GetLogicalDrives 返回 0，API 调用失败");
            return drives;
        }
        for i in 0..26 {
            if (bitmask & (1 << i)) != 0 {
                let drive_letter = (b'A' + i) as char;
                let root = format!("{}:\\", drive_letter);
                let root_wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                let drive_type = windows::Win32::Storage::FileSystem::GetDriveTypeW(
                    windows::core::PCWSTR::from_raw(root_wide.as_ptr()),
                );
                // DRIVE_REMOVABLE = 2
                if drive_type == 2 {
                    drives.push(format!("{}:", drive_letter));
                }
            }
        }
    }
    drives
}

/// 获取指定驱动器的卷序列号
fn get_volume_serial(drive: &str) -> Option<u32> {
    let root_wide: Vec<u16> = format!("{}\\", drive)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut serial_number: u32 = 0;
        let result = windows::Win32::Storage::FileSystem::GetVolumeInformationW(
            windows::core::PCWSTR::from_raw(root_wide.as_ptr()),
            None,
            None,
            Some(&mut serial_number),
            None,
            None,
        );
        if result.is_ok() {
            Some(serial_number)
        } else {
            None
        }
    }
}

/// 计算卷序列号的 SHA256 哈希（加盐）
fn hash_serial(serial: u32, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serial.to_le_bytes());
    hasher.update(salt.as_bytes());
    hex::encode(hasher.finalize())
}

/// 获取或生成盐值（使用密码学安全的 OsRng）
fn get_salt() -> String {
    if let Some(s) = db::get_setting("usb_salt") {
        if !s.is_empty() {
            return s;
        }
    }
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let salt = format!("ns_salt_{}", hex::encode(&bytes));
    db::set_setting("usb_salt", &salt);
    salt
}

/// 检测是否有已授权的U盘插入
pub fn check_usb_authorized() -> bool {
    let salt = get_salt();
    let stored_hash = match db::get_setting("usb_authorized") {
        Some(h) => h,
        None => return false, // 尚未注册任何U盘
    };

    for drive in get_removable_drives() {
        if let Some(serial) = get_volume_serial(&drive) {
            let h = hash_serial(serial, &salt);
            if h == stored_hash {
                return true;
            }
        }
    }
    false
}

/// 注册当前插入的第一个可移动U盘为授权U盘
pub fn register_current_usb(drive: Option<String>) -> Result<String, String> {
    let target_drive = if let Some(d) = drive {
        d
    } else {
        let drives = get_removable_drives();
        if drives.is_empty() {
            return Err("未检测到可移动U盘".to_string());
        }
        drives[0].clone()
    };

    let serial = get_volume_serial(&target_drive)
        .ok_or_else(|| format!("无法读取 {} 的卷序列号", target_drive))?;

    let salt = get_salt();
    let h = hash_serial(serial, &salt);
    db::set_setting("usb_authorized", &h);
    Ok(format!("{} 已注册为授权U盘", target_drive))
}

/// 获取可移动驱动器列表（前端选择用）
pub fn list_removable_drives() -> Vec<String> {
    get_removable_drives()
}

/// 检查是否已有注册的U盘
pub fn has_registered_usb() -> bool {
    db::get_setting("usb_authorized").is_some_and(|h| !h.is_empty())
}

// ═══════════════════════════════════════════════
//  内存模式设置
// ═══════════════════════════════════════════════

#[derive(Serialize, Deserialize)]
pub struct MemoryModeStatus {
    pub mode_back: String,
    pub mode_front: String,
    pub enabled: bool,
    pub forced: bool, // Mode5 强制为内存模式
}

pub fn get_memory_mode_statuses() -> Vec<MemoryModeStatus> {
    let modes = data::load_modes();
    let current_memory = data::load_memory_modes();

    let mut result = Vec::new();
    for (front, back) in modes.front.iter().zip(modes.back.iter()) {
        result.push(MemoryModeStatus {
            mode_back: back.clone(),
            mode_front: front.clone(),
            enabled: current_memory.contains(back.as_str()),
            forced: false,
        });
    }
    result.push(MemoryModeStatus {
        mode_back: MODE5_BACK.to_string(),
        mode_front: MODE5_FRONT.to_string(),
        enabled: true,
        forced: true,
    });
    result
}

pub fn set_memory_mode(back_mode: &str, memory: bool) {
    if back_mode == MODE5_BACK {
        return; // Mode5 强制为内存模式
    }

    let mut modes = data::load_memory_modes();
    if memory {
        modes.insert(back_mode.to_string());
    } else {
        modes.remove(back_mode);
    }

    // 保存到数据库
    let mut sorted: Vec<&str> = modes.iter()
        .filter(|m| m.as_str() != MODE5_BACK)
        .map(|m| m.as_str())
        .collect();
    sorted.sort();
    db::set_setting("memory_modes", &sorted.join(","));

    // 使用现有的缓存失效机制
    data::invalidate_memory_modes_cache();
}

// ═══════════════════════════════════════════════
//  时间段设置
// ═══════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
pub struct TimeRange {
    pub h1: u32,
    pub m1: u32,
    pub h2: u32,
    pub m2: u32,
}

fn range_to_minutes(r: &TimeRange) -> (i32, i32) {
    let start = (r.h1 as i32) * 60 + (r.m1 as i32);
    let mut end = (r.h2 as i32) * 60 + (r.m2 as i32);
    // 跨午夜情况：结束时间算到第二天
    if end < start {
        end += 24 * 60;
    }
    (start, end)
}

fn ranges_overlap(a: &TimeRange, b: &TimeRange) -> bool {
    let (a_start, a_end) = range_to_minutes(a);
    let (b_start, b_end) = range_to_minutes(b);
    // 考虑跨午夜：将区间统一放到 0..1440 并处理跨天
    // 简单比较：如果 a 跨天，拆成两段
    let a_segments = if a_end > 24 * 60 {
        vec![(a_start, 24 * 60), (0, a_end - 24 * 60)]
    } else {
        vec![(a_start, a_end)]
    };
    let b_segments = if b_end > 24 * 60 {
        vec![(b_start, 24 * 60), (0, b_end - 24 * 60)]
    } else {
        vec![(b_start, b_end)]
    };

    for (as1, ae1) in &a_segments {
        for (bs1, be1) in &b_segments {
            if as1 < be1 && bs1 < ae1 {
                return true;
            }
        }
    }
    false
}

fn merge_ranges(a: &TimeRange, b: &TimeRange) -> TimeRange {
    let (a_start, a_end) = range_to_minutes(a);
    let (b_start, b_end) = range_to_minutes(b);

    let a_crosses = a_end > 24 * 60;
    let b_crosses = b_end > 24 * 60;

    let (mut a_s, mut a_e) = (a_start, a_end);
    let (mut b_s, mut b_e) = (b_start, b_end);

    // 若一方跨午夜、另一方不跨，且不跨方的起始时间落在跨午夜方的「次日」段内，
    // 则将不跨方整体后移一天，使两者处于同一时间轴上再取 min/max。
    if b_crosses && !a_crosses && a_start < (b_end - 24 * 60) {
        a_s += 24 * 60;
        a_e += 24 * 60;
    }
    if a_crosses && !b_crosses && b_start < (a_end - 24 * 60) {
        b_s += 24 * 60;
        b_e += 24 * 60;
    }

    let start = a_s.min(b_s);
    let end = a_e.max(b_e);

    TimeRange {
        h1: ((start / 60) % 24) as u32,
        m1: (start % 60) as u32,
        h2: ((end / 60) % 24) as u32,
        m2: (end % 60) as u32,
    }
}

pub fn get_time_ranges() -> Vec<TimeRange> {
    data::load_time_ranges()
        .into_iter()
        .map(|(h1, m1, h2, m2)| TimeRange { h1, m1, h2, m2 })
        .collect()
}

pub fn save_time_ranges(ranges: Vec<TimeRange>) -> Result<(), String> {
    // 1. 基本范围校验
    for (i, r) in ranges.iter().enumerate() {
        if r.h1 > 23 || r.m1 > 59 || r.h2 > 23 || r.m2 > 59 {
            return Err(format!("时段{}的时间值超出有效范围", i + 1));
        }
    }

    // 2. 去除零长度区间
    let mut cleaned: Vec<TimeRange> = ranges
        .into_iter()
        .filter(|r| !(r.h1 == r.h2 && r.m1 == r.m2))
        .collect();

    // 3. 检查结束时间是否晚于开始时间（允许跨午夜）
    for (i, r) in cleaned.iter().enumerate() {
        let start = (r.h1 as i32) * 60 + (r.m1 as i32);
        let end = (r.h2 as i32) * 60 + (r.m2 as i32);
        if end == start {
            return Err(format!("时段{}结束时间不能等于开始时间", i + 1));
        }
    }

    // 4. 自动合并重叠/包含的时段
    if !cleaned.is_empty() {
        cleaned.sort_by(|a, b| {
            let (a_start, _) = range_to_minutes(a);
            let (b_start, _) = range_to_minutes(b);
            a_start.cmp(&b_start)
        });
        let mut merged: Vec<TimeRange> = vec![cleaned[0].clone()];
        for r in cleaned.into_iter().skip(1) {
            let last = merged.last_mut().unwrap();
            if ranges_overlap(last, &r) {
                *last = merge_ranges(last, &r);
            } else {
                merged.push(r);
            }
        }
        cleaned = merged;
    }

    let s = cleaned
        .iter()
        .map(|r| format!("{} {} {} {}", r.h1, r.m1, r.h2, r.m2))
        .collect::<Vec<_>>()
        .join("\n");
    db::set_setting("time_ranges", &s);
    data::invalidate_time_ranges_cache();
    Ok(())
}

// ═══════════════════════════════════════════════
//  暗痕设置 (Ahen)
// ═══════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
pub struct AhenConfig {
    pub enabled: bool,
    pub only_break: bool,
    pub triggers: std::collections::HashMap<String, String>, // "抽到号码" -> "显示号码"
}

pub fn get_ahen_config() -> AhenConfig {
    db::get_setting("ahen_config")
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or(AhenConfig {
            enabled: false,
            only_break: true,
            triggers: std::collections::HashMap::new(),
        })
}

pub fn save_ahen_config(config: &AhenConfig) -> Result<(), String> {
    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
    db::set_setting("ahen_config", &json);
    Ok(())
}

// ═══════════════════════════════════════════════
//  座位表方向设置
// ═══════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SeatDirection {
    #[serde(rename = "rtl")]
    Rtl,
    #[serde(rename = "ltr")]
    Ltr,
}

impl Default for SeatDirection {
    fn default() -> Self {
        SeatDirection::Rtl
    }
}

pub fn get_seat_direction() -> SeatDirection {
    db::get_setting("seat_direction")
        .and_then(|v| serde_json::from_str(&format!("\"{}\"", v)).ok())
        .unwrap_or_default()
}

pub fn save_seat_direction(direction: &SeatDirection) -> Result<(), String> {
    let s = match direction {
        SeatDirection::Rtl => "rtl",
        SeatDirection::Ltr => "ltr",
    };
    db::set_setting("seat_direction", s);
    Ok(())
}

// ═══════════════════════════════════════════════
//  U盘验证有效期（内存状态）
// ═══════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsbVerifyScope {
    /// 仅当前禁用时段有效
    CurrentBreak,
    /// 程序运行期间一直有效
    Permanent,
}

impl Default for UsbVerifyScope {
    fn default() -> Self {
        UsbVerifyScope::CurrentBreak
    }
}

pub fn parse_usb_verify_scope(s: &str) -> UsbVerifyScope {
    match s {
        "permanent" => UsbVerifyScope::Permanent,
        _ => UsbVerifyScope::CurrentBreak,
    }
}

pub fn usb_verify_scope_string(scope: UsbVerifyScope) -> &'static str {
    match scope {
        UsbVerifyScope::CurrentBreak => "current_break",
        UsbVerifyScope::Permanent => "permanent",
    }
}

/// 当前 U盘会话验证状态
#[derive(Default)]
struct UsbSessionState {
    verified: bool,
    scope: UsbVerifyScope,
}

static USB_SESSION: std::sync::Mutex<UsbSessionState> =
    std::sync::Mutex::new(UsbSessionState { verified: false, scope: UsbVerifyScope::CurrentBreak });

/// 验证 U盘，并在通过后将当前会话标记为已验证
pub fn verify_usb_session(scope: UsbVerifyScope) -> bool {
    if !check_usb_authorized() {
        return false;
    }
    if let Ok(mut s) = USB_SESSION.lock() {
        s.verified = true;
        s.scope = scope;
    }
    true
}

/// 判断当前会话是否仍可使用 U盘验证跳过禁用时段限制
/// 当不在禁用时段且 scope 为 CurrentBreak 时，自动失效
pub fn is_usb_session_valid(in_break: bool) -> bool {
    if let Ok(mut s) = USB_SESSION.lock() {
        if !s.verified {
            return false;
        }
        if s.scope == UsbVerifyScope::CurrentBreak && !in_break {
            // 当前禁用时段已结束，验证失效
            s.verified = false;
            return false;
        }
        return true;
    }
    false
}

/// 获取持久化设置中的验证有效期默认值
pub fn get_usb_verify_scope_setting() -> UsbVerifyScope {
    db::get_setting("usb_verify_scope")
        .map(|s| parse_usb_verify_scope(&s))
        .unwrap_or_default()
}

pub fn save_usb_verify_scope_setting(scope: UsbVerifyScope) {
    db::set_setting("usb_verify_scope", usb_verify_scope_string(scope));
}

// ═══════════════════════════════════════════════
//  抽号参数范围设置（锁在设置页，需 U盘验证进入）
// ═══════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
pub struct NumberLimits {
    pub min: i64,
    pub max: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct QuantityLimits {
    pub min: i64,
    pub max: i64,
}

pub fn get_number_limits() -> NumberLimits {
    let min = db::get_setting("num_limit_min")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(MIN_NUMBER_LIMIT);
    let max = db::get_setting("num_limit_max")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(MAX_NUMBER_LIMIT);
    NumberLimits { min, max }
}

pub fn get_quantity_limits() -> QuantityLimits {
    let min = db::get_setting("qty_limit_min")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(MIN_QUANTITY_LIMIT);
    let max = db::get_setting("qty_limit_max")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(MAX_QUANTITY_LIMIT);
    QuantityLimits { min, max }
}

pub fn save_number_limits(min: i64, max: i64) -> Result<(), String> {
    if min < 1 {
        return Err("号码下限必须大于等于 1".to_string());
    }
    if max < min {
        return Err("号码上限必须大于等于下限".to_string());
    }
    db::set_setting("num_limit_min", &min.to_string());
    db::set_setting("num_limit_max", &max.to_string());
    Ok(())
}

pub fn save_quantity_limits(min: i64, max: i64) -> Result<(), String> {
    if min < 1 {
        return Err("数量下限必须大于等于 1".to_string());
    }
    if max < min {
        return Err("数量上限必须大于等于下限".to_string());
    }
    db::set_setting("qty_limit_min", &min.to_string());
    db::set_setting("qty_limit_max", &max.to_string());
    Ok(())
}

// ═══════════════════════════════════════════════
//  名单导入（CSV / Excel，仅导入覆盖）
// ═══════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
pub struct ParsedStudents {
    pub format: String,
    pub header: bool,
    pub boys: Vec<db::StudentRecord>,
    pub girls: Vec<db::StudentRecord>,
}

/// 读取名单文件并解析，返回按性别分组的结果（不写盘）
pub fn parse_students_file(path: &str) -> Result<ParsedStudents, String> {
    let p = std::path::Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let (rows, format) = match ext.as_str() {
        "csv" | "txt" => {
            let text = read_text_decoded(p)?;
            (parse_csv_rows(&text), "csv".to_string())
        }
        "xlsx" | "xlsm" | "xls" => (read_excel_rows(p)?, ext.to_string()),
        _ => {
            return Err("不支持的文件格式，请使用 CSV 或 Excel(.xlsx/.xls)".to_string());
        }
    };

    let header = !rows.is_empty()
        && rows[0]
            .get(0)
            .map(|s| s.trim().parse::<i32>().is_err())
            .unwrap_or(true);
    let (boys, girls) = rows_to_students(rows)?;
    Ok(ParsedStudents {
        format,
        header,
        boys,
        girls,
    })
}

/// 将解析结果覆盖写入 students_boy / students_girl，并同步到当前名单
pub fn overwrite_students(
    boys: Vec<db::StudentRecord>,
    girls: Vec<db::StudentRecord>,
) -> Result<(), String> {
    let boy_json =
        serde_json::to_string(&boys).map_err(|e| format!("序列化失败: {}", e))?;
    let girl_json =
        serde_json::to_string(&girls).map_err(|e| format!("序列化失败: {}", e))?;
    db::set_setting("students_boy", &boy_json);
    db::set_setting("students_girl", &girl_json);
    // 同步到当前名单
    sync_active_roster(&boys, &girls);
    Ok(())
}

// ═══════════════════════════════════════════════
//  多套名单管理
// ═══════════════════════════════════════════════

/// 单套名单数据
#[derive(Serialize, Deserialize, Clone)]
struct RosterEntry {
    boy: Vec<db::StudentRecord>,
    girl: Vec<db::StudentRecord>,
}

/// 名单集合：名称 → 数据
type RosterMap = std::collections::BTreeMap<String, RosterEntry>;

/// 读取所有名单（如不存在则从当前 students 迁移创建默认名单）
fn load_rosters() -> RosterMap {
    if let Some(json) = db::get_setting("rosters") {
        if let Ok(map) = serde_json::from_str::<RosterMap>(&json) {
            if !map.is_empty() {
                return map;
            }
        }
    }
    // 迁移：从现有 students_boy / students_girl 创建默认名单
    let mut map = RosterMap::new();
    map.insert(
        "默认名单".to_string(),
        RosterEntry {
            boy: load_students_setting("students_boy"),
            girl: load_students_setting("students_girl"),
        },
    );
    let json = serde_json::to_string(&map).unwrap_or_default();
    db::set_setting("rosters", &json);
    db::set_setting("active_roster", "默认名单");
    map
}

fn save_rosters(map: &RosterMap) {
    if let Ok(json) = serde_json::to_string(map) {
        db::set_setting("rosters", &json);
    }
}

/// 将当前 students 同步到活跃名单
fn sync_active_roster(boys: &[db::StudentRecord], girls: &[db::StudentRecord]) {
    let mut map = load_rosters();
    let active = db::get_setting("active_roster").unwrap_or_else(|| "默认名单".to_string());
    map.insert(
        active,
        RosterEntry {
            boy: boys.to_vec(),
            girl: girls.to_vec(),
        },
    );
    save_rosters(&map);
}

/// 获取所有名单名称及当前活跃名单
pub fn get_rosters_info() -> (Vec<String>, String) {
    let map = load_rosters();
    let active = db::get_setting("active_roster").unwrap_or_else(|| "默认名单".to_string());
    let names: Vec<String> = map.keys().cloned().collect();
    (names, active)
}

/// 创建新名单（空）
pub fn create_roster(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名单名称不能为空".to_string());
    }
    let mut map = load_rosters();
    if map.contains_key(name) {
        return Err("该名单名称已存在".to_string());
    }
    map.insert(
        name.to_string(),
        RosterEntry {
            boy: vec![],
            girl: vec![],
        },
    );
    save_rosters(&map);
    Ok(())
}

/// 切换活跃名单，同时更新 students_boy / students_girl
pub fn switch_roster(name: &str) -> Result<(), String> {
    let map = load_rosters();
    let entry = map
        .get(name)
        .ok_or_else(|| format!("名单「{}」不存在", name))?;
    let boy_json = serde_json::to_string(&entry.boy).map_err(|e| format!("序列化失败: {}", e))?;
    let girl_json = serde_json::to_string(&entry.girl).map_err(|e| format!("序列化失败: {}", e))?;
    db::set_setting("students_boy", &boy_json);
    db::set_setting("students_girl", &girl_json);
    db::set_setting("active_roster", name);
    // 切换名单后清空所有抽号记录，避免不同名单的记录混淆
    db::clear_all_records();
    data::clear_all_memory_used();
    Ok(())
}

/// 重命名名单
pub fn rename_roster(old_name: &str, new_name: &str) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("名单名称不能为空".to_string());
    }
    let mut map = load_rosters();
    let entry = map
        .remove(old_name)
        .ok_or_else(|| format!("名单「{}」不存在", old_name))?;
    if map.contains_key(new_name) {
        // 放回去
        map.insert(old_name.to_string(), entry);
        return Err("该名单名称已存在".to_string());
    }
    map.insert(new_name.to_string(), entry);
    save_rosters(&map);
    // 如果重命名的是当前活跃名单，更新 active_roster
    let active = db::get_setting("active_roster").unwrap_or_default();
    if active == old_name {
        db::set_setting("active_roster", new_name);
    }
    Ok(())
}

/// 删除名单（至少保留一个）
pub fn delete_roster(name: &str) -> Result<(), String> {
    let mut map = load_rosters();
    if map.len() <= 1 {
        return Err("至少需要保留一个名单".to_string());
    }
    if map.remove(name).is_none() {
        return Err(format!("名单「{}」不存在", name));
    }
    save_rosters(&map);
    // 如果删除的是当前活跃名单，切换到第一个
    let active = db::get_setting("active_roster").unwrap_or_default();
    if active == name {
        let first = map.keys().next().cloned().unwrap_or_default();
        let entry = map.get(&first).cloned();
        db::set_setting("active_roster", &first);
        if let Some(e) = entry {
            let boy_json = serde_json::to_string(&e.boy).unwrap_or_default();
            let girl_json = serde_json::to_string(&e.girl).unwrap_or_default();
            db::set_setting("students_boy", &boy_json);
            db::set_setting("students_girl", &girl_json);
            db::clear_all_records();
            data::clear_all_memory_used();
        }
    }
    Ok(())
}

/// 复制名单
pub fn duplicate_roster(src: &str, dst: &str) -> Result<(), String> {
    let dst = dst.trim();
    if dst.is_empty() {
        return Err("名单名称不能为空".to_string());
    }
    let mut map = load_rosters();
    let entry = map
        .get(src)
        .ok_or_else(|| format!("名单「{}」不存在", src))?
        .clone();
    if map.contains_key(dst) {
        return Err("该名单名称已存在".to_string());
    }
    map.insert(dst.to_string(), entry);
    save_rosters(&map);
    Ok(())
}

// ── 文件读取与解析辅助 ──

fn read_text_decoded(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map_err(|e| format!("UTF-8 解码失败: {}", e));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&u16s).map_err(|e| format!("UTF-16 解码失败: {}", e));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&u16s).map_err(|e| format!("UTF-16 解码失败: {}", e));
    }
    Ok(match String::from_utf8(bytes.clone()) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("[settings] 文件非 UTF-8 编码，使用 lossy 转换，部分字符可能丢失");
            String::from_utf8_lossy(&bytes).to_string()
        }
    })
}

fn parse_csv_rows(text: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut field = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => row.push(std::mem::take(&mut field)),
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    if !row_empty(&row) {
                        rows.push(std::mem::take(&mut row));
                    }
                }
                '\r' => {}
                _ => field.push(c),
            }
        }
    }
    row.push(field);
    if !row_empty(&row) {
        rows.push(row);
    }
    rows
}

fn row_empty(row: &[String]) -> bool {
    row.iter().all(|s| s.trim().is_empty())
}

fn read_excel_rows(path: &std::path::Path) -> Result<Vec<Vec<String>>, String> {
    use calamine::{open_workbook, Reader, Xls, Xlsx};
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let range = match ext.as_str() {
        "xls" => {
            let mut wb: Xls<_> =
                open_workbook(path).map_err(|e| format!("打开 Excel 失败: {}", e))?;
            wb.worksheet_range_at(0)
                .ok_or_else(|| "工作簿中没有工作表".to_string())?
                .map_err(|e| format!("读取工作表失败: {}", e))?
        }
        _ => {
            let mut wb: Xlsx<_> =
                open_workbook(path).map_err(|e| format!("打开 Excel 失败: {}", e))?;
            wb.worksheet_range_at(0)
                .ok_or_else(|| "工作簿中没有工作表".to_string())?
                .map_err(|e| format!("读取工作表失败: {}", e))?
        }
    };

    Ok(range_to_rows(&range))
}

fn range_to_rows(range: &calamine::Range<calamine::DataType>) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for row in range.rows() {
        let cells: Vec<String> = row.iter().map(cell_to_string).collect();
        if !row_empty(&cells) {
            out.push(cells);
        }
    }
    out
}

fn cell_to_string(d: &calamine::DataType) -> String {
    if let Some(s) = d.get_string() {
        return s.to_string();
    }
    if let Some(i) = d.get_int() {
        return i.to_string();
    }
    if let Some(f) = d.get_float() {
        return if f.fract() == 0.0 {
            format!("{}", f as i64)
        } else {
            f.to_string()
        };
    }
    String::new()
}

fn rows_to_students(
    rows: Vec<Vec<String>>,
) -> Result<(Vec<db::StudentRecord>, Vec<db::StudentRecord>), String> {
    if rows.is_empty() {
        return Err("文件没有数据".to_string());
    }
    let first = &rows[0];
    let first_num_parses = first
        .get(0)
        .map(|s| s.trim().parse::<i32>().is_ok())
        .unwrap_or(false);

    let (start, num_col, name_col, gender_col) = if !first_num_parses {
        let (nc, mc, gc) = find_columns(first)?;
        (1usize, nc, mc, gc)
    } else {
        if first.len() < 3 {
            return Err("表格至少需要：号码、姓名、性别 三列".to_string());
        }
        (0usize, 0usize, 1usize, 2usize)
    };

    let mut boys = Vec::new();
    let mut girls = Vec::new();
    for (i, row) in rows.iter().enumerate().skip(start) {
        let num_str = row.get(num_col).map(|s| s.trim()).unwrap_or("");
        if num_str.is_empty() {
            continue;
        }
        let number = num_str
            .parse::<i32>()
            .map_err(|_| format!("第 {} 行号码不是有效数字: {}", i + 1, num_str))?;
        let name = row
            .get(name_col)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let gender_raw = row
            .get(gender_col)
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default();
        let gender = normalize_gender(&gender_raw).ok_or_else(|| {
            format!("第 {} 行性别无法识别: '{}'（应为 男/女）", i + 1, gender_raw)
        })?;
        let rec = db::StudentRecord {
            number,
            name,
            gender: gender.to_string(),
        };
        if gender == "boy" {
            boys.push(rec);
        } else {
            girls.push(rec);
        }
    }

    if boys.is_empty() && girls.is_empty() {
        return Err("未解析到任何学生数据".to_string());
    }
    Ok((boys, girls))
}

fn find_columns(header: &[String]) -> Result<(usize, usize, usize), String> {
    let mut num_col = None;
    let mut name_col = None;
    let mut gender_col = None;
    for (i, cell) in header.iter().enumerate() {
        let h = cell.trim().to_lowercase();
        if num_col.is_none() && (h.contains('号') || h == "number" || h == "no" || h == "id") {
            num_col = Some(i);
        }
        if name_col.is_none() && (h.contains('名') || h == "name") {
            name_col = Some(i);
        }
        if gender_col.is_none() && (h.contains('性') || h == "gender" || h == "sex") {
            gender_col = Some(i);
        }
    }
    match (num_col, name_col, gender_col) {
        (Some(n), Some(m), Some(g)) => Ok((n, m, g)),
        _ => Err(format!(
            "表头缺少必要列（号码/姓名/性别），当前表头: {:?}",
            header
        )),
    }
}

fn normalize_gender(s: &str) -> Option<&'static str> {
    match s {
        "男" | "男生" | "m" | "male" | "boy" | "1" => Some("boy"),
        "女" | "女生" | "f" | "female" | "girl" | "0" => Some("girl"),
        _ => None,
    }
}

// ═══════════════════════════════════════════════
//  数据迁移：导出 / 导入（勾选项）
// ═══════════════════════════════════════════════

const SENSITIVE_SETTINGS: &[&str] = &["usb_salt", "usb_authorized"];

#[derive(Serialize, Deserialize)]
struct StudentsBundle {
    boy: Vec<db::StudentRecord>,
    girl: Vec<db::StudentRecord>,
}

#[derive(Serialize, Deserialize)]
struct RecordsBundle {
    mode: String,
    numbers: Vec<i32>,
}

#[derive(Serialize, Deserialize)]
struct ExportBundle {
    version: u32,
    exported_at: String,
    /// SHA-256 校验和（对除本字段外的内容计算）。旧版文件无此字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    checksum: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    settings: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    students: Option<StudentsBundle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seatmap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    records: Option<Vec<RecordsBundle>>,
}

fn load_students_setting(key: &str) -> Vec<db::StudentRecord> {
    db::get_setting(key)
        .and_then(|json| serde_json::from_str::<Vec<db::StudentRecord>>(&json).ok())
        .unwrap_or_default()
}

/// 导出勾选的数据到指定路径
pub fn export_data(items: &[String], path: &str) -> Result<(), String> {
    let mut bundle = ExportBundle {
        version: 1,
        exported_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        checksum: None,
        settings: None,
        students: None,
        seatmap: None,
        records: None,
    };

    if items.iter().any(|s| s == "settings") {
        let mut m = serde_json::Map::new();
        for (k, v) in db::get_all_settings() {
            if SENSITIVE_SETTINGS.contains(&k.as_str()) {
                continue;
            }
            m.insert(k, serde_json::Value::String(v));
        }
        bundle.settings = Some(serde_json::Value::Object(m));
    }
    if items.iter().any(|s| s == "students") {
        bundle.students = Some(StudentsBundle {
            boy: load_students_setting("students_boy"),
            girl: load_students_setting("students_girl"),
        });
    }
    if items.iter().any(|s| s == "seatmap") {
        if let Some(s) = db::get_setting("seatmap") {
            bundle.seatmap = Some(s);
        }
    }
    if items.iter().any(|s| s == "records") {
        let recs: Vec<RecordsBundle> = db::get_all_records_grouped()
            .into_iter()
            .map(|(mode, numbers)| RecordsBundle { mode, numbers })
            .collect();
        bundle.records = Some(recs);
    }

    // 计算校验和：对不含 checksum 字段的 bundle 做紧凑 JSON 序列化后取 SHA-256
    let payload_json =
        serde_json::to_string(&bundle).map_err(|e| format!("序列化失败: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    let hash = hasher.finalize();
    bundle.checksum = Some(format!("{:x}", hash));

    let json =
        serde_json::to_string_pretty(&bundle).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

#[derive(Serialize)]
pub struct ImportPreview {
    pub has_settings: bool,
    pub settings_count: usize,
    pub has_students: bool,
    pub boys_count: usize,
    pub girls_count: usize,
    pub has_seatmap: bool,
    pub has_records: bool,
    pub records: Vec<(String, usize)>,
    /// 校验和状态："valid"=校验通过, "invalid"=校验失败(文件已损坏), "none"=旧版文件无校验和
    pub checksum_status: String,
}

/// 验证导出文件的 SHA-256 校验和
/// 返回 ("valid" | "invalid" | "none", 解析后的 bundle)
/// 使用类型化结构体重新序列化以确保与导出时序列化方式一致
fn verify_and_parse_bundle(text: &str) -> (String, Option<ExportBundle>) {
    let mut bundle: ExportBundle = match serde_json::from_str(text) {
        Ok(b) => b,
        Err(_) => return ("invalid".to_string(), None),
    };

    // 取出存储的校验和，然后将 checksum 置空以重新计算
    let stored_checksum = bundle.checksum.take();

    // 对不含 checksum 的 bundle 做紧凑 JSON 序列化（与导出时一致）
    let payload = match serde_json::to_string(&bundle) {
        Ok(s) => s,
        Err(_) => return ("invalid".to_string(), None),
    };
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    let computed = format!("{:x}", hasher.finalize());

    let status = match &stored_checksum {
        Some(stored) if !stored.is_empty() => {
            if stored == &computed {
                "valid".to_string()
            } else {
                "invalid".to_string()
            }
        }
        _ => "none".to_string(), // 旧版文件无 checksum 字段
    };

    (status, Some(bundle))
}

/// 预览备份文件中可恢复的内容
pub fn import_data_preview(path: &str) -> Result<ImportPreview, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读取文件失败: {}", e))?;

    let (checksum_status, bundle_opt) = verify_and_parse_bundle(&text);
    let bundle = bundle_opt.ok_or_else(|| "解析备份文件失败: 文件格式错误或已损坏".to_string())?;

    let mut p = ImportPreview {
        has_settings: false,
        settings_count: 0,
        has_students: false,
        boys_count: 0,
        girls_count: 0,
        has_seatmap: false,
        has_records: false,
        records: vec![],
        checksum_status,
    };
    if let Some(serde_json::Value::Object(m)) = &bundle.settings {
        p.has_settings = true;
        p.settings_count = m.len();
    }
    if let Some(s) = &bundle.students {
        p.has_students = true;
        p.boys_count = s.boy.len();
        p.girls_count = s.girl.len();
    }
    if bundle.seatmap.is_some() {
        p.has_seatmap = true;
    }
    if let Some(recs) = &bundle.records {
        p.has_records = true;
        p.records = recs.iter().map(|r| (r.mode.clone(), r.numbers.len())).collect();
    }
    Ok(p)
}

/// 按勾选项从备份文件恢复数据
pub fn import_data_apply(items: &[String], path: &str) -> Result<(), String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读取文件失败: {}", e))?;

    let (checksum_status, bundle_opt) = verify_and_parse_bundle(&text);
    // 校验失败时拒绝导入
    if checksum_status == "invalid" {
        return Err("文件校验失败：数据可能已损坏，拒绝导入".to_string());
    }
    let bundle = bundle_opt.ok_or_else(|| "解析备份文件失败: 文件格式错误或已损坏".to_string())?;

    if items.iter().any(|s| s == "settings") {
        if let Some(serde_json::Value::Object(m)) = &bundle.settings {
            for (k, v) in m {
                if SENSITIVE_SETTINGS.contains(&k.as_str()) {
                    continue;
                }
                let val = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                db::set_setting(k, &val);
            }
            // 导入设置可能改变内存模式集合和时间段，失效缓存
            data::invalidate_memory_modes_cache();
            data::invalidate_time_ranges_cache();
        }
    }
    if items.iter().any(|s| s == "students") {
        if let Some(s) = &bundle.students {
            let boy_json =
                serde_json::to_string(&s.boy).map_err(|e| format!("序列化失败: {}", e))?;
            let girl_json =
                serde_json::to_string(&s.girl).map_err(|e| format!("序列化失败: {}", e))?;
            db::set_setting("students_boy", &boy_json);
            db::set_setting("students_girl", &girl_json);
            // 同步到当前活跃名单
            sync_active_roster(&s.boy, &s.girl);
        }
    }
    if items.iter().any(|s| s == "seatmap") {
        if let Some(sm) = &bundle.seatmap {
            db::set_setting("seatmap", sm);
        }
    }
    if items.iter().any(|s| s == "records") {
        if let Some(recs) = &bundle.records {
            db::clear_all_records();
            data::clear_all_memory_used();
            for r in recs {
                db::add_records(&r.mode, &r.numbers);
            }
        }
    }
    Ok(())
}

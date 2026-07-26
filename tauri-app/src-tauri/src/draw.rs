//! 抽号引擎（纯计算，动画交给前端）

use std::collections::{HashMap, HashSet};

use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::data::{load_used, save_record, Student};
use crate::settings::{AhenConfig, SeatDirection};

#[derive(Debug, Serialize)]
pub struct DrawResult {
    pub picked: Vec<i32>,
    pub actual_qty: i32,
    pub message: Option<String>, // 信息提示（数量不足等）
    pub all_used: bool,          // 候选池为空
    pub display_picked: Vec<i32>, // 暗痕映射后的显示号码（动画用），无暗痕时与 picked 相同
    pub animation_numbers: Vec<i32>, // 动画滚动用随机数（后端 rand::thread_rng() 生成）
}

#[derive(Debug, Serialize)]
pub struct AdvancedDrawResult {
    pub picked: Vec<i32>,
    pub picked_names: Vec<String>,
    pub drawn_seats: Vec<String>, // 实际抽中的座位 key，用于前端精确高亮
    pub all_used: bool,
    pub display_picked: Vec<i32>, // 暗痕映射后的显示号码
}

/// 应用暗痕映射
fn apply_ahen(numbers: &[i32], ahen: &AhenConfig, in_break: bool) -> Vec<i32> {
    if !ahen.enabled {
        return numbers.to_vec();
    }
    if ahen.only_break && !in_break {
        return numbers.to_vec();
    }
    numbers
        .iter()
        .map(|n| {
            ahen.triggers
                .get(&n.to_string())
                .and_then(|s| s.parse::<i32>().ok())
                .unwrap_or(*n)
        })
        .collect()
}

/// 将号码列表映射为 "姓名 性别符号" 格式（无匹配则显示号码本身）
fn build_picked_names(picked: &[i32], students: &[Student]) -> Vec<String> {
    let stu_map: HashMap<i32, &Student> = students.iter().map(|s| (s.number, s)).collect();
    picked
        .iter()
        .map(|n| {
            if let Some(s) = stu_map.get(n) {
                format!("{} {}", s.name, if s.gender == "boy" { "♂" } else { "♀" })
            } else {
                n.to_string()
            }
        })
        .collect()
}

pub fn perform_draw(
    back_mode: &str,
    max_num: i32,
    qty: i32,
    gender_filter: Option<&str>, // "boy" / "girl" / None
    boys: &HashSet<i32>,
    girls: &HashSet<i32>,
    save: bool,
    ahen: &AhenConfig,
    in_break: bool,
) -> DrawResult {
    let used = load_used(back_mode);
    let mut avail: HashSet<i32> = (1..=max_num).collect();
    for u in &used {
        avail.remove(u);
    }

    // 记录无性别过滤时的可用数量，用于更明确的提示
    let avail_without_gender = avail.len() as i32;

    if let Some(g) = gender_filter {
        let pool = if g == "boy" { boys } else { girls };
        avail = avail.intersection(pool).copied().collect();
    }

    if avail.is_empty() {
        return DrawResult {
            picked: vec![],
            actual_qty: 0,
            message: None,
            all_used: true,
            display_picked: vec![],
            animation_numbers: vec![],
        };
    }

    let actual_qty = qty.min(avail.len() as i32);
    let mut sorted: Vec<i32> = avail.into_iter().collect();
    sorted.sort();
    let mut rng = rand::thread_rng();
    let picked: Vec<i32> = sorted
        .choose_multiple(&mut rng, actual_qty as usize)
        .copied()
        .collect();

    if save {
        save_record(back_mode, &picked);
    }

    let message = if actual_qty < qty {
        if gender_filter.is_some() && avail_without_gender >= qty {
            let g_name = if gender_filter == Some("boy") { "男生" } else { "女生" };
            Some(format!(
                "{}可用号码不足，实际抽取 {} 个",
                g_name, actual_qty
            ))
        } else {
            Some(format!("可用号码不足，实际抽取 {} 个", actual_qty))
        }
    } else {
        None
    };

    // 为前端动画生成一组随机数，避免使用浏览器 Math.random()
    let animation_numbers: Vec<i32> = (0..40)
        .map(|_| rng.gen_range(1..=max_num))
        .collect();

    DrawResult {
        picked: picked.clone(),
        display_picked: apply_ahen(&picked, ahen, in_break),
        actual_qty,
        message,
        all_used: false,
        animation_numbers,
    }
}

// ═════════════════════════════════════════════════════════════════
//  高级抽号 V2：后端执行分组 / 手动 / 性别过滤 / 暗痕等随机逻辑
// ═════════════════════════════════════════════════════════════════

/// 座位表数据（仅高级抽号后端解析用）
#[derive(Debug, Deserialize)]
pub struct SeatmapData {
    pub v: Option<i32>,
    pub grid: (i32, i32),
    pub seats: HashMap<String, Vec<String>>,
    pub disabled: Option<Vec<String>>,
}

/// 高级抽号请求
#[derive(Debug, Deserialize)]
pub struct AdvancedDrawRequest {
    pub back_mode: String,
    pub draw_type: String, // big_group / group4 / group6 / column / manual
    pub rule: String,      // per_group_n / pick_group
    pub qty: i32,
    /// 选中的范围名（大组/小组/列名）或手动模式中的座位 key
    pub selected: Vec<String>,
    pub boy_enabled: bool,
    pub girl_enabled: bool,
    pub save: bool,
}

fn normalize_seat_gender(g: &str) -> &str {
    match g {
        "男" => "boy",
        "女" => "girl",
        _ => g,
    }
}

/// 将座位 key 映射为学生编号
fn seat_to_number(seat_key: &str, seatmap: &SeatmapData, students: &[Student]) -> Option<i32> {
    let info = seatmap.seats.get(seat_key)?;
    let name = info.first()?;
    if name.is_empty() {
        return None;
    }
    students.iter().find(|s| s.name == *name).map(|s| s.number)
}

fn seat_gender<'a>(seat_key: &'a str, seatmap: &'a SeatmapData) -> Option<&'a str> {
    let info = seatmap.seats.get(seat_key)?;
    let g = info.get(1)?;
    Some(normalize_seat_gender(g))
}

fn gender_pass(seat_key: &str, seatmap: &SeatmapData, boy_enabled: bool, girl_enabled: bool) -> bool {
    match seat_gender(seat_key, seatmap) {
        Some("boy") => boy_enabled,
        Some("girl") => girl_enabled,
        _ => true,
    }
}

/// 按座位表方向构建列索引序列（从右到左或从左到右）
fn col_indices(cols: i32, direction: &SeatDirection) -> Vec<i32> {
    match direction {
        SeatDirection::Rtl => (1..=cols).collect(),
        SeatDirection::Ltr => (1..=cols).rev().collect(),
    }
}

/// 构建高级抽号分组（与前端算法保持一致）
pub fn build_advanced_groups(
    seatmap_json: &str,
    draw_type: &str,
    direction: &SeatDirection,
) -> Result<HashMap<String, Vec<String>>, String> {
    let seatmap: SeatmapData = serde_json::from_str(seatmap_json)
        .map_err(|e| format!("座位表 JSON 解析失败: {}", e))?;
    let (rows, cols) = seatmap.grid;
    let disabled: HashSet<String> = seatmap.disabled.unwrap_or_default().into_iter().collect();

    let all_seats = collect_all_seats(rows, cols, &disabled);
    let ordered_cols = col_indices(cols, direction);

    let groups = match draw_type {
        "big_group" => build_big_groups(&all_seats, &ordered_cols),
        "group4" | "group6" => build_small_groups(&all_seats, &ordered_cols, draw_type),
        "column" => build_column_groups(&all_seats, &ordered_cols),
        _ => HashMap::new(),
    };

    Ok(groups)
}

/// 遍历网格收集未禁用的座位 key
fn collect_all_seats(rows: i32, cols: i32, disabled: &HashSet<String>) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    for r in 1..=rows {
        for c in 1..=cols {
            let key = format!("{}-{}", r, c);
            if !disabled.contains(&key) {
                all.push(key);
            }
        }
    }
    all
}

/// 大组：相邻两列合并
fn build_big_groups(
    all_seats: &[String],
    ordered_cols: &[i32],
) -> HashMap<String, Vec<String>> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for bg_idx in (0..ordered_cols.len()).step_by(2) {
        let right_col = ordered_cols[bg_idx];
        let left_col = ordered_cols.get(bg_idx + 1).copied();
        let gn = bg_idx / 2 + 1;
        let seats_in = col_pair_seats(all_seats, right_col, left_col.unwrap_or(0));
        if !seats_in.is_empty() {
            groups.insert(format!("第{}大组", gn), seats_in);
        }
    }
    groups
}

/// 小组（4人/6人）：按行块切分相邻两列
fn build_small_groups(
    all_seats: &[String],
    ordered_cols: &[i32],
    draw_type: &str,
) -> HashMap<String, Vec<String>> {
    let rows_per_chunk: i32 = if draw_type == "group4" { 2 } else { 3 };
    let min_group_size = if draw_type == "group4" { 4 } else { 6 };
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut gid = 1;

    for bg_idx in (0..ordered_cols.len()).step_by(2) {
        let right_col = ordered_cols[bg_idx];
        let left_col = ordered_cols.get(bg_idx + 1).copied();

        let right_seats: Vec<String> = seats_in_col(all_seats, right_col);
        let left_seats: Vec<String> = left_col
            .map(|lc| seats_in_col(all_seats, lc))
            .unwrap_or_default();

        if right_seats.is_empty() && left_seats.is_empty() {
            continue;
        }

        let pairs = chunk_pairs_by_row(&right_seats, &left_seats, rows_per_chunk, min_group_size);
        for grp in pairs {
            groups.insert(format!("第{}小组", gid), grp);
            gid += 1;
        }
    }
    groups
}

/// 按列号筛选座位
fn seats_in_col(all_seats: &[String], col: i32) -> Vec<String> {
    all_seats
        .iter()
        .filter(|s| parse_col(s) == Some(col))
        .cloned()
        .collect()
}

/// 将相邻两列座位按行块切分为若干小组，末尾不足 min_size 则并入前一组
fn chunk_pairs_by_row(
    right_seats: &[String],
    left_seats: &[String],
    rows_per_chunk: i32,
    min_size: usize,
) -> Vec<Vec<String>> {
    let max_row = right_seats
        .iter()
        .chain(left_seats.iter())
        .filter_map(|s| parse_row(s))
        .max()
        .unwrap_or(0);

    let mut pairs: Vec<Vec<String>> = Vec::new();
    for start_row in (1..=max_row).step_by(rows_per_chunk as usize) {
        let mut chunk: Vec<String> = Vec::new();
        for s in right_seats.iter().chain(left_seats.iter()) {
            if let Some(r) = parse_row(s) {
                if r >= start_row && r < start_row + rows_per_chunk {
                    chunk.push(s.clone());
                }
            }
        }
        if !chunk.is_empty() {
            pairs.push(chunk);
        }
    }

    while pairs.len() >= 2 && pairs[pairs.len() - 1].len() < min_size {
        let last = pairs.pop().unwrap();
        let prev = pairs.len() - 1;
        pairs[prev].extend(last);
    }
    pairs
}

/// 列分组：每列单独成组
fn build_column_groups(
    all_seats: &[String],
    ordered_cols: &[i32],
) -> HashMap<String, Vec<String>> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for (idx, &c) in ordered_cols.iter().enumerate() {
        let col_seats = seats_in_col(all_seats, c);
        if !col_seats.is_empty() {
            groups.insert(format!("第{}列", idx + 1), col_seats);
        }
    }
    groups
}

fn parse_row(seat_key: &str) -> Option<i32> {
    seat_key.split('-').next()?.parse().ok()
}

fn parse_col(seat_key: &str) -> Option<i32> {
    seat_key.split('-').nth(1)?.parse().ok()
}

/// 两列组合排序：右列先取两个，再左列取两个，交替
fn col_pair_seats(all_seats: &[String], col_a: i32, col_b: i32) -> Vec<String> {
    let right_col: Vec<String> = all_seats
        .iter()
        .filter(|s| parse_col(s) == Some(col_a))
        .cloned()
        .collect();
    let left_col: Vec<String> = all_seats
        .iter()
        .filter(|s| parse_col(s) == Some(col_b))
        .cloned()
        .collect();

    let mut result: Vec<String> = Vec::new();
    let max_len = right_col.len().max(left_col.len());
    for i in (0..max_len).step_by(2) {
        for j in i..(i + 2).min(right_col.len()) {
            result.push(right_col[j].clone());
        }
        for j in i..(i + 2).min(left_col.len()) {
            result.push(left_col[j].clone());
        }
    }
    result
}

/// 执行高级抽号 V2（后端完成所有随机逻辑）
pub fn advanced_perform_draw_v2(
    req: &AdvancedDrawRequest,
    seatmap_json: &str,
    students: &[Student],
    direction: &SeatDirection,
    ahen: &AhenConfig,
    in_break: bool,
) -> Result<AdvancedDrawResult, String> {
    let seatmap: SeatmapData = serde_json::from_str(seatmap_json)
        .map_err(|e| format!("座位表 JSON 解析失败: {}", e))?;
    let used = load_used(&req.back_mode);

    let pools = build_pools(req, &seatmap, seatmap_json, direction)?;
    if pools.is_empty() {
        return Ok(empty_advanced_result());
    }

    let (filtered_pools, pool_seats) = filter_pools(&pools, &seatmap, students, &used, req.boy_enabled, req.girl_enabled);
    if filtered_pools.is_empty() {
        return Ok(empty_advanced_result());
    }

    let mut rng = rand::thread_rng();
    let (picked, picked_seat_indices) = pick_from_pools(req, &filtered_pools, &mut rng);
    if picked.is_empty() {
        return Ok(empty_advanced_result());
    }

    if req.save {
        save_record(&req.back_mode, &picked);
    }

    let picked_names = build_picked_names(&picked, students);
    let drawn_seats = map_drawn_seats(&picked_seat_indices, &pool_seats);

    Ok(AdvancedDrawResult {
        display_picked: apply_ahen(&picked, ahen, in_break),
        picked,
        picked_names,
        drawn_seats,
        all_used: false,
    })
}

/// 空结果（候选池为空）
fn empty_advanced_result() -> AdvancedDrawResult {
    AdvancedDrawResult {
        picked: vec![],
        picked_names: vec![],
        drawn_seats: vec![],
        all_used: true,
        display_picked: vec![],
    }
}

/// 根据抽号类型构建候选座位池
fn build_pools(
    req: &AdvancedDrawRequest,
    seatmap: &SeatmapData,
    seatmap_json: &str,
    direction: &SeatDirection,
) -> Result<Vec<Vec<String>>, String> {
    if req.draw_type == "manual" {
        let mut seats: Vec<String> = req
            .selected
            .iter()
            .filter(|k| seatmap.seats.contains_key(*k))
            .cloned()
            .collect();
        seats.sort_by(|a, b| {
            let ra = parse_row(a).unwrap_or(0);
            let rb = parse_row(b).unwrap_or(0);
            let ca = parse_col(a).unwrap_or(0);
            let cb = parse_col(b).unwrap_or(0);
            (ra, ca).cmp(&(rb, cb))
        });
        return Ok(if seats.is_empty() { vec![] } else { vec![seats] });
    }

    let groups = build_advanced_groups(seatmap_json, &req.draw_type, direction)?;
    Ok(req
        .selected
        .iter()
        .filter_map(|name| groups.get(name).cloned())
        .collect())
}

/// 对每个 pool 应用性别过滤和已抽过滤，返回 (号码池, 对应座位 key 池)
fn filter_pools(
    pools: &[Vec<String>],
    seatmap: &SeatmapData,
    students: &[Student],
    used: &HashSet<i32>,
    boy_enabled: bool,
    girl_enabled: bool,
) -> (Vec<Vec<i32>>, Vec<Vec<String>>) {
    let mut filtered_pools: Vec<Vec<i32>> = Vec::new();
    let mut pool_seats: Vec<Vec<String>> = Vec::new();
    for pool in pools {
        let mut nums: Vec<i32> = Vec::new();
        let mut seats: Vec<String> = Vec::new();
        for seat_key in pool {
            if !gender_pass(seat_key, seatmap, boy_enabled, girl_enabled) {
                continue;
            }
            if let Some(n) = seat_to_number(seat_key, seatmap, students) {
                if n > 0 && !used.contains(&n) {
                    nums.push(n);
                    seats.push(seat_key.clone());
                }
            }
        }
        if !nums.is_empty() {
            filtered_pools.push(nums);
            pool_seats.push(seats);
        }
    }
    (filtered_pools, pool_seats)
}

/// 按规则从池中抽取号码，返回 (picked 号码, (pool_idx, seat_idx) 索引)
fn pick_from_pools(
    req: &AdvancedDrawRequest,
    filtered_pools: &[Vec<i32>],
    rng: &mut impl rand::Rng,
) -> (Vec<i32>, Vec<(usize, usize)>) {
    let mut picked: Vec<i32> = Vec::new();
    let mut picked_seat_indices: Vec<(usize, usize)> = Vec::new();

    match req.rule.as_str() {
        "pick_group" => {
            let k = (req.qty as usize).min(filtered_pools.len());
            let indices: Vec<usize> = (0..filtered_pools.len())
                .collect::<Vec<_>>()
                .choose_multiple(rng, k)
                .copied()
                .collect();
            for &pool_idx in &indices {
                for (seat_idx, &n) in filtered_pools[pool_idx].iter().enumerate() {
                    picked.push(n);
                    picked_seat_indices.push((pool_idx, seat_idx));
                }
            }
        }
        _ => {
            for (pool_idx, nums) in filtered_pools.iter().enumerate() {
                let k = (req.qty as usize).min(nums.len());
                let chosen: Vec<usize> = (0..nums.len())
                    .collect::<Vec<_>>()
                    .choose_multiple(rng, k)
                    .copied()
                    .collect();
                for seat_idx in chosen {
                    picked.push(nums[seat_idx]);
                    picked_seat_indices.push((pool_idx, seat_idx));
                }
            }
        }
    }
    (picked, picked_seat_indices)
}

/// 根据索引把抽中的号码映射回座位 key
fn map_drawn_seats(
    picked_seat_indices: &[(usize, usize)],
    pool_seats: &[Vec<String>],
) -> Vec<String> {
    let mut drawn_seats: Vec<String> = Vec::new();
    for (pool_idx, seat_idx) in picked_seat_indices {
        if let Some(seat) = pool_seats.get(*pool_idx).and_then(|v| v.get(*seat_idx)) {
            drawn_seats.push(seat.clone());
        }
    }
    drawn_seats
}

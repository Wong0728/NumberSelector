//! 常量与数据目录

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const DEFAULT_FRONT_1TO4: [&str; 4] = ["模式一", "模式二", "模式三", "模式四"];
pub const DEFAULT_BACK_1TO4: [&str; 4] = ["Mode1", "Mode2", "Mode3", "Mode4"];
pub const MODE5_FRONT: &str = "模式五";
pub const MODE5_BACK: &str = "Mode5";

pub const MAX_NUMBER_LIMIT: i64 = 100;
pub const MIN_NUMBER_LIMIT: i64 = 1;
pub const MAX_QUANTITY_LIMIT: i64 = 5;
pub const MIN_QUANTITY_LIMIT: i64 = 1;

/// 默认禁用时段（精简默认项，避免引导卡片过高）
pub const DEFAULT_RANGES: &[(u32, u32, u32, u32)] = &[
    (12, 10, 14, 20),
    (17, 35, 23, 59),
];

/// 默认内存模式
pub const DEFAULT_MEMORY_MODES: &[&str] = &["Mode3", "Mode4", "Mode5"];

/// 启动引导配置文件名，位于 exe 同级
const BOOTSTRAP_CONFIG_NAME: &str = "NumberSelector.config.json";
/// 开发模式覆盖数据目录的环境变量
const NS_DATA_DIR_ENV: &str = "NS_DATA_DIR";

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 数据目录类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataDirKind {
    /// 程序侧便携目录
    Portable,
    /// 系统应用数据目录（%APPDATA% 等）
    AppData,
    /// 自定义绝对路径
    Custom,
}

/// 设置应用数据目录（应在 Tauri setup 中调用）
pub fn set_app_data_dir(dir: PathBuf) {
    let _ = APP_DATA_DIR.set(dir);
}

/// 获取当前生效的应用数据目录
///
/// 优先级：
/// 1. `NS_DATA_DIR` 环境变量（仅开发模式注入）。
/// 2. 启动时通过 `set_app_data_dir` 显式设置的目录。
/// 3. exe 同级的 `NumberSelector.config.json` 中 `data_dir` 字段：
///    - `"portable"` 或缺省 → 程序侧默认便携目录。
///    - `"app_data"` → 传入的系统应用数据目录回退路径。
///    - 绝对路径 → 直接使用。
/// 4. 默认便携目录。
pub fn data_dir() -> PathBuf {
    if let Some(dir) = dev_override_data_dir() {
        return dir;
    }
    APP_DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| resolve_data_dir(None))
}

fn dev_override_data_dir() -> Option<PathBuf> {
    std::env::var(NS_DATA_DIR_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// 当前是否被 `NS_DATA_DIR` 环境变量覆盖（开发模式）
pub fn is_env_override() -> bool {
    dev_override_data_dir().is_some()
}

/// 解析数据目录。`app_data_fallback` 仅在引导配置指定 `"app_data"` 时使用。
pub fn resolve_data_dir(app_data_fallback: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = bootstrap_data_dir(app_data_fallback.as_ref()) {
        return dir;
    }
    default_portable_data_dir()
}

/// 读取引导配置 JSON（公共辅助，避免多处重复读取解析）
fn read_bootstrap_config() -> Option<serde_json::Value> {
    let config_path = bootstrap_config_path()?;
    let content = std::fs::read_to_string(&config_path).ok()?;
    serde_json::from_str(&content).ok()
}

/// 从引导配置提取 data_dir 字符串
fn bootstrap_data_dir_str() -> Option<String> {
    read_bootstrap_config()?
        .get("data_dir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 当前生效的数据目录类型
pub fn current_data_dir_kind() -> DataDirKind {
    let dir = bootstrap_data_dir_str().unwrap_or_else(|| "portable".to_string());
    match dir.as_str() {
        "portable" | "" => DataDirKind::Portable,
        "app_data" => DataDirKind::AppData,
        _ => DataDirKind::Custom,
    }
}

/// 默认便携数据目录
/// - 开发模式：项目根目录的 data/
/// - 生产模式：优先 dist-package/data/（exe 在 dist-package/app/ 下），否则 exe 同级 data/
pub fn default_portable_data_dir() -> PathBuf {
    if is_dev_build() {
        if let Some(dir) = dev_project_root_data_dir() {
            return dir;
        }
    }

    if let Some(dir) = package_data_dir() {
        return dir;
    }

    exe_dir()
        .map(|d| d.join("data"))
        .unwrap_or_else(|| PathBuf::from("data"))
}

/// 程序侧默认便携目录（别名）
pub fn portable_data_dir() -> PathBuf {
    default_portable_data_dir()
}

/// 程序包数据目录：dist-package/app/NumberSelector.exe -> dist-package/data/
pub fn package_data_dir() -> Option<PathBuf> {
    let exe_dir = exe_dir()?;
    let parent = exe_dir.parent()?;
    if exe_dir.file_name()?.to_str()? == "app" {
        return Some(parent.join("data"));
    }
    None
}

/// 尝试定位旧的数据目录（exe 同级 data/），用于迁移
pub fn old_data_dir() -> Option<PathBuf> {
    exe_dir()
        .map(|exe| exe.join("data"))
        .filter(|p| p.is_dir())
}

/// 获取 exe 所在目录
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
}

/// 引导配置文件路径
pub fn bootstrap_config_path() -> Option<PathBuf> {
    exe_dir().map(|dir| dir.join(BOOTSTRAP_CONFIG_NAME))
}

/// 读取引导配置中的自定义路径（若存在且为自定义类型）
pub fn bootstrap_custom_path() -> Option<PathBuf> {
    let dir = bootstrap_data_dir_str()?;
    if dir == "portable" || dir == "app_data" || dir.is_empty() {
        return None;
    }
    let path = PathBuf::from(dir);
    if path.is_absolute() {
        Some(path)
    } else {
        exe_dir().map(|exe| exe.join(path))
    }
}

/// 从引导配置读取数据目录
fn bootstrap_data_dir(app_data_fallback: Option<&PathBuf>) -> Option<PathBuf> {
    let dir = bootstrap_data_dir_str()?;
    match dir.as_str() {
        "portable" | "" => Some(default_portable_data_dir()),
        "app_data" => app_data_fallback.cloned(),
        _ => {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                Some(path)
            } else {
                exe_dir().map(|exe| exe.join(path))
            }
        }
    }
}

/// 写入引导配置文件
pub fn set_bootstrap_data_dir(kind: DataDirKind, custom_path: Option<&Path>) -> Result<(), String> {
    let config_path = bootstrap_config_path().ok_or("无法获取程序路径")?;
    let value = match kind {
        DataDirKind::Portable => "portable".to_string(),
        DataDirKind::AppData => "app_data".to_string(),
        DataDirKind::Custom => {
            let path = custom_path.ok_or("自定义路径不能为空")?;
            if !path.is_absolute() {
                return Err("自定义路径必须是绝对路径".to_string());
            }
            path.to_string_lossy().to_string()
        }
    };
    let json = serde_json::json!({ "data_dir": value });
    let json_str = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, json_str)
        .map_err(|e| format!("写入引导配置失败: {}", e))?;
    Ok(())
}

/// 删除引导配置文件（恢复默认便携目录）
pub fn clear_bootstrap_data_dir() -> Result<(), String> {
    let config_path = bootstrap_config_path().ok_or("无法获取程序路径")?;
    if config_path.exists() {
        std::fs::remove_file(&config_path)
            .map_err(|e| format!("删除引导配置失败: {}", e))?;
    }
    Ok(())
}

/// 是否处于开发模式（结果缓存，首次调用后不再重复检测）
fn is_dev_build() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        // cargo run / cargo tauri dev 会设置 CARGO_MANIFEST_DIR
        if std::env::var_os("CARGO_MANIFEST_DIR").is_some() {
            return true;
        }
        // 兜底：根据 exe 路径判断
        if let Ok(exe) = std::env::current_exe() {
            let s = exe.to_string_lossy();
            return s.contains("/target/debug/")
                || s.contains("\\target\\debug\\")
                || s.contains("/target/release/")
                || s.contains("\\target\\release\\");
        }
        false
    })
}

/// 开发模式下定位项目根目录的 data/
fn dev_project_root_data_dir() -> Option<PathBuf> {
    let mut cursor = exe_dir()?;
    for _ in 0..8 {
        if cursor.join("tauri-app").is_dir() {
            return Some(cursor.join("data"));
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

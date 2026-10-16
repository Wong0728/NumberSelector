//! 启动模式检测：抽号 / 设置
//!
//! 优先从命令行参数读取，例如 `NumberSelector.exe --settings`。
//! 保留旧的临时文件机制作为兼容 fallback。

use parking_lot::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupMode {
    Draw,
    Settings,
}

static CURRENT_MODE: Mutex<Option<StartupMode>> = Mutex::new(None);

impl StartupMode {
    pub fn detect() -> Self {
        let mut explicit_draw = false;
        for arg in std::env::args().skip(1) {
            if arg == "--settings" {
                return StartupMode::Settings;
            }
            if arg == "--draw" {
                explicit_draw = true;
            }
        }
        if explicit_draw {
            return StartupMode::Draw;
        }
        Self::from_temp_file()
    }

    fn from_temp_file() -> Self {
        let temp_path = std::env::temp_dir().join("ns_startup_settings.txt");
        if let Ok(content) = std::fs::read_to_string(&temp_path) {
            // 一次性语义：读完即删。本程序自身不写该文件（仅旧版启动器写），
            // 不删的话一个遗留文件会让之后所有无参启动（含开机自启）都进设置模式
            let _ = std::fs::remove_file(&temp_path);
            let trimmed = content.trim().trim_start_matches('\u{FEFF}').trim();
            if trimmed == "settings" {
                return StartupMode::Settings;
            }
        }
        StartupMode::Draw
    }

    pub fn set(mode: StartupMode) {
        *CURRENT_MODE.lock() = Some(mode);
    }

    pub fn current() -> Self {
        CURRENT_MODE.lock().unwrap_or(StartupMode::Draw)
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            StartupMode::Draw => "抽号程序",
            StartupMode::Settings => "设置程序",
        }
    }

    pub fn other_display_name(&self) -> &'static str {
        match self {
            StartupMode::Draw => "设置程序",
            StartupMode::Settings => "抽号程序",
        }
    }

    pub fn lock_file_name(&self) -> &'static str {
        match self {
            StartupMode::Draw => ".draw.lock",
            StartupMode::Settings => ".settings.lock",
        }
    }

    pub fn other_lock_file_name(&self) -> &'static str {
        match self {
            StartupMode::Draw => ".settings.lock",
            StartupMode::Settings => ".draw.lock",
        }
    }
}

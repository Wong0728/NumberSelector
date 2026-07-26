//! 跨进程互斥锁：防止抽号程序和设置程序同时操作数据库。
//!
//! 每个程序启动时会持有一个会话级文件锁（.draw.lock / .settings.lock），
//! 进程异常退出时操作系统会自动释放该锁。
//! 在进行写操作前，先检查对方锁是否被持有，若被持有则提示用户。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use fs2::FileExt;
use parking_lot::Mutex;

use crate::config;
use crate::startup::StartupMode;

pub struct SessionLock {
    #[allow(dead_code)]
    file: File,
}

/// 全局持有的会话锁，用于在开发模式切换视图时释放/重新获取
static SESSION_LOCK: Mutex<Option<SessionLock>> = Mutex::new(None);

impl SessionLock {
    /// 在应用启动时调用，持有本程序会话锁直到进程退出。
    /// 启动前会先检查对方程序是否已在运行，若对方已运行则拒绝启动。
    pub fn acquire(mode: StartupMode) -> Result<Self, String> {
        std::fs::create_dir_all(&config::data_dir())
            .map_err(|e| format!("创建数据目录失败: {}", e))?;

        // 先检查对方程序是否正在运行
        check_other_session(mode)?;

        let path = lock_path(mode.lock_file_name());
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| format!("打开锁文件失败: {}", e))?;

        file.try_lock_exclusive()
            .map_err(|_| format!("{}已有另一个实例在运行", mode.display_name()))?;

        let pid = std::process::id().to_string();
        let _ = file.write_all(pid.as_bytes());

        Ok(Self { file })
    }

    /// 将当前锁存入全局静态，使其在进程生命周期内保持持有
    pub fn store(self) {
        let mut g = SESSION_LOCK.lock();
        *g = Some(self);
    }

    /// 切换到另一个模式的锁：释放旧锁并获取新锁
    pub fn switch_to(new_mode: StartupMode) -> Result<(), String> {
        // 释放旧锁（drop 旧 SessionLock → 关闭文件 → 释放文件锁）
        {
            let mut g = SESSION_LOCK.lock();
            let _ = g.take();
        }
        // 获取新锁
        let new_lock = Self::acquire(new_mode)?;
        new_lock.store();
        Ok(())
    }
}

/// 检查对方程序是否正在运行。若对方锁为残留锁（进程已退出）则自动清理。
pub fn check_other_session(mode: StartupMode) -> Result<(), String> {
    let path = lock_path(mode.other_lock_file_name());
    if !path.exists() {
        return Ok(());
    }

    let file = OpenOptions::new()
        .write(true)
        .create(false)
        .open(&path)
        .map_err(|e| format!("检查对方锁状态失败: {}", e))?;

    match file.try_lock_exclusive() {
        Ok(()) => {
            // 成功拿到对方锁，说明对方进程已退出，锁文件是残留。
            // 不删除锁文件——在 drop(file) 和 remove_file 之间存在竞态窗口，
            // 另一个进程可能在此期间创建并锁定同一路径，remove_file 会误删其锁文件。
            // 残留文件无害：下次 acquire 会 truncate，下次 check 会重新检测。
            drop(file);
            Ok(())
        }
        Err(_) => Err(format!(
            "{}正在操作数据库，请稍后再试",
            mode.other_display_name()
        )),
    }
}

fn lock_path(name: &str) -> PathBuf {
    config::data_dir().join(name)
}

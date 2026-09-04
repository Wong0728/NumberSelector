//! WebView2 运行时保障：系统检测 → 便携目录 → 无运行时时的原生引导
//!
//! 检测优先级：
//! 1. 系统已安装的 Evergreen 运行时（注册表 pv 值）。
//! 2. exe 同级 `WebView2Runtime\`（Fixed Version 绿色运行时，需含 msedgewebview2.exe），
//!    通过 WEBVIEW2_BROWSER_EXECUTABLE_FOLDER 环境变量启用（WebView2 加载器原生支持）。
//! 3. 都没有时：用原生 MessageBox 引导——下载官方 2MB 安装引导器到 C 盘下载文件夹
//!    （只下载不安装，由用户手动运行），或打开便携目录让用户放入固定版本运行时。

use std::io::Read;
use std::path::PathBuf;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK, MB_YESNO,
    MESSAGEBOX_RESULT, MESSAGEBOX_STYLE, SW_SHOWNORMAL,
};

/// WebView2 Runtime 在 EdgeUpdate\Clients 下的注册表 GUID
const RUNTIME_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
/// 官方 Evergreen 安装引导器固定链接（自动指向最新版，约 1.7MB）
/// 注意：fwlink 2124701 现指向 X64 完整离线安装包（约 258MB），勿用
const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
/// 引导器保存文件名
const BOOTSTRAPPER_FILENAME: &str = "MicrosoftEdgeWebview2Setup.exe";
/// 便携运行时目录名（exe 同级）
const PORTABLE_DIR_NAME: &str = "WebView2Runtime";
/// 便携运行时的标志文件
const PORTABLE_MARKER: &str = "msedgewebview2.exe";

/// 确保 WebView2 运行时可用；不可用时引导用户，处理后退出进程。
pub fn ensure_runtime() {
    if is_system_runtime_available() {
        return;
    }
    if let Some(dir) = portable_runtime_dir() {
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &dir);
        return;
    }
    guide_missing_runtime();
}

/// 按微软文档检测系统是否已安装 WebView2 运行时（读 EdgeUpdate\Clients\{GUID} 的 pv 值）
fn is_system_runtime_available() -> bool {
    #[cfg(debug_assertions)]
    if std::env::var_os("NS_SIMULATE_NO_WEBVIEW2").is_some() {
        return false;
    }
    read_runtime_pv(HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\EdgeUpdate\Clients").is_some()
        || read_runtime_pv(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
        )
        .is_some()
        || read_runtime_pv(HKEY_CURRENT_USER, r"Software\Microsoft\EdgeUpdate\Clients").is_some()
}

/// 读取指定注册表位置的 pv 值（存在且非空即视为已安装）
fn read_runtime_pv(root: HKEY, subkey: &str) -> Option<String> {
    let sub_wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let value_wide: Vec<u16> = "pv".encode_utf16().chain(std::iter::once(0)).collect();
    let mut guid_wide = RUNTIME_GUID.encode_utf16().collect::<Vec<u16>>();
    guid_wide.push(0);

    unsafe {
        let mut hclients = HKEY::default();
        if RegOpenKeyExW(
            root,
            PCWSTR::from_raw(sub_wide.as_ptr()),
            0,
            KEY_READ,
            &mut hclients,
        ) != ERROR_SUCCESS
        {
            return None;
        }

        let mut hguid = HKEY::default();
        let opened = RegOpenKeyExW(
            hclients,
            PCWSTR::from_raw(guid_wide.as_ptr()),
            0,
            KEY_READ,
            &mut hguid,
        ) == ERROR_SUCCESS;
        let _ = RegCloseKey(hclients);
        if !opened {
            return None;
        }

        let mut buf = [0u8; 128]; // pv 形如 "121.x.xxxx.xxx"，足够容纳
        let mut size = buf.len() as u32;
        let result = RegQueryValueExW(
            hguid,
            PCWSTR::from_raw(value_wide.as_ptr()),
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(hguid);
        if result != ERROR_SUCCESS || size == 0 || size as usize > buf.len() {
            return None;
        }

        let units: Vec<u16> = buf[..size as usize]
            .chunks_exact(2)
            .take_while(|c| c[0] != 0 || c[1] != 0)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let pv = String::from_utf16(&units).ok()?;
        if pv.trim().is_empty() {
            None
        } else {
            Some(pv)
        }
    }
}

/// exe 同级 WebView2Runtime\ 目录（含 msedgewebview2.exe 才有效）
fn portable_runtime_dir() -> Option<PathBuf> {
    let dir = crate::config::exe_dir()?.join(PORTABLE_DIR_NAME);
    if dir.join(PORTABLE_MARKER).is_file() {
        Some(dir)
    } else {
        None
    }
}

/// 无运行时时的引导流程（不再返回）
fn guide_missing_runtime() -> ! {
    let portable_dir = crate::config::exe_dir().map(|d| d.join(PORTABLE_DIR_NAME));

    let choice = message_box(
        MB_YESNO | MB_ICONWARNING,
        "未检测到 WebView2 运行时，程序无法显示界面。\n\n\
         是否自动下载微软官方安装引导器（约 2MB）？\n\
         仅保存到 C 盘下载文件夹，不会自动安装。",
    );

    if choice == IDYES {
        match download_bootstrapper() {
            Ok(path) => {
                let run = message_box(
                    MB_YESNO | MB_ICONINFORMATION,
                    &format!(
                        "下载完成，已保存到：\n{}\n\n是否立即运行安装程序？\n（安装过程由你手动操作，程序不会自动安装）",
                        path.display()
                    ),
                );
                if run == IDYES {
                    open_with_shell(&path);
                    message_box(
                        MB_OK | MB_ICONINFORMATION,
                        "请在安装完成后重新打开本程序。",
                    );
                } else {
                    message_box(
                        MB_OK | MB_ICONINFORMATION,
                        &format!("稍后请手动运行：\n{}", path.display()),
                    );
                }
            }
            Err(e) => {
                let open_page = message_box(
                    MB_YESNO | MB_ICONWARNING,
                    &format!(
                        "下载失败：{}\n\n\
                         是否打开微软官网手动下载？\n\
                         也可以将「固定版本 WebView2 运行时」解压到程序目录的 \
                         {} 文件夹后重新打开本程序。",
                        e, PORTABLE_DIR_NAME
                    ),
                );
                if open_page == IDYES {
                    open_with_shell("https://developer.microsoft.com/microsoft-edge/webview2/");
                }
            }
        }
    } else if let Some(dir) = &portable_dir {
        let _ = std::fs::create_dir_all(dir);
        open_with_shell(dir);
        message_box(
            MB_OK | MB_ICONINFORMATION,
            &format!(
                "已打开 {} 文件夹。\n\n\
                 请从微软官网下载「固定版本 WebView2 运行时」并解压到该文件夹\n\
                 （确保其中有 msedgewebview2.exe），然后重新打开本程序。",
                PORTABLE_DIR_NAME
            ),
        );
    }

    std::process::exit(0);
}

fn message_box(flags: MESSAGEBOX_STYLE, text: &str) -> MESSAGEBOX_RESULT {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR::from_raw(wide.as_ptr()),
            w!("智能抽号系统"),
            flags,
        )
    }
}

/// 下载官方安装引导器到 C 盘下载文件夹（Downloads 缺失时退回 %TEMP%）
fn download_bootstrapper() -> Result<PathBuf, String> {
    let file_path = download_dir()?.join(BOOTSTRAPPER_FILENAME);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build();
    let response = agent
        .get(BOOTSTRAPPER_URL)
        .call()
        .map_err(|e| format!("{}", e))?;

    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取下载内容失败: {}", e))?;

    // 引导器约 2MB；明显过小说明拿到的是错误页而非安装包
    if bytes.len() < 512 * 1024 {
        return Err(format!("下载内容异常（仅 {} 字节）", bytes.len()));
    }

    std::fs::write(&file_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(file_path)
}

fn download_dir() -> Result<PathBuf, String> {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let downloads = PathBuf::from(profile).join("Downloads");
        if downloads.is_dir() {
            return Ok(downloads);
        }
    }
    Ok(std::env::temp_dir())
}

/// 用系统默认方式打开文件 / 文件夹 / URL
fn open_with_shell(target: impl AsRef<std::path::Path>) -> bool {
    let wide: Vec<u16> = target
        .as_ref()
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR::from_raw(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 as isize > 32
}

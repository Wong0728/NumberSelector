// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use windows::core::{w, PCWSTR};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

fn main() {
    if let Err(e) = number_selector_lib::run() {
        show_error(&e);
        std::process::exit(1);
    }
}

fn show_error(message: &str) {
    let wide: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = MessageBoxW(
            None,
            PCWSTR::from_raw(wide.as_ptr()),
            w!("智能抽号系统"),
            MB_OK | MB_ICONERROR,
        );
    }
}

"""开发脚本 - 启动抽号程序（Tauri 完整桌面应用）"""
import os
import sys
import subprocess

def main():
    print("正在启动抽号程序开发环境...")

    # 自动定位 tauri-app 目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    tauri_dir = os.path.join(script_dir, "tauri-app")
    if not os.path.isdir(tauri_dir):
        tauri_dir = script_dir  # 脚本已经在 tauri-app 内

    # 删除启动临时文件（避免残留导致错误跳转）
    for temp_name in ("ns_startup_draw.txt", "ns_startup_settings.txt"):
        temp_file = os.path.join(os.environ["TEMP"], temp_name)
        try:
            os.remove(temp_file)
        except FileNotFoundError:
            pass

    print(f"[抽号] 工作目录: {tauri_dir}")
    print("[抽号] 启动 npm run tauri dev ...")

    os.chdir(tauri_dir)
    result = subprocess.run(["npm", "run", "tauri", "dev"], shell=True)
    sys.exit(result.returncode)

if __name__ == "__main__":
    main()

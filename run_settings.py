"""开发脚本 - 启动设置程序（Tauri 完整桌面应用）
独立的设置程序，与抽号程序共享同一个数据库，设置可以操纵抽号程序的配置。"""
import os
import sys
import subprocess

def main():
    print("正在启动设置程序开发环境...")

    # 写入临时文件，告诉应用启动时跳转到设置界面
    # Python 的 open().write() 写入纯 UTF-8，不带 BOM
    # 使用独立文件名，避免与 run_draw.py 的临时文件竞争
    temp_file = os.path.join(os.environ["TEMP"], "ns_startup_settings.txt")
    with open(temp_file, "w", encoding="utf-8") as f:
        f.write("settings")

    # 验证文件是否写入成功
    if os.path.isfile(temp_file):
        with open(temp_file, "r", encoding="utf-8") as f:
            content = f.read()
        print(f"[设置] 启动标记已写入: '{content}'")
    else:
        print("[设置] 警告: 启动标记文件写入失败！")

    # 自动定位 tauri-app 目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    tauri_dir = os.path.join(script_dir, "tauri-app")
    if not os.path.isdir(tauri_dir):
        tauri_dir = script_dir  # 脚本已经在 tauri-app 内

    print(f"[设置] 工作目录: {tauri_dir}")
    print("[设置] 启动 npm run tauri dev ...")

    os.chdir(tauri_dir)
    try:
        result = subprocess.run(["npm", "run", "tauri", "dev"], shell=True)
        sys.exit(result.returncode)
    finally:
        # 退出时清理临时文件
        try:
            os.remove(temp_file)
        except FileNotFoundError:
            pass

if __name__ == "__main__":
    main()

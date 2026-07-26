"""开发脚本 - 模拟首次运行并启动设置引导

用法：
    python simulate_first_run.py

作用：
    1. 删除项目根目录 data/settings.db 中的首次运行完成标记，让程序重新进入引导流程。
    2. 设置 NS_DATA_DIR 环境变量，让开发模式下的 Rust 后端也使用同一 data/ 目录
       （否则 Tauri 会读取 %APPDATA%/com.wongjy.numberselector/ 下的数据库，
       导致清除标记不生效）。
    3. 写入启动标记，让程序直接打开设置页。
    4. 启动 npm run tauri dev。
    5. 退出时清理启动标记。
"""

import os
import sys
import subprocess
import sqlite3


def get_project_root() -> str:
    """脚本所在目录即为项目根目录。"""
    return os.path.dirname(os.path.abspath(__file__))


def get_data_dir(project_root: str) -> str:
    """开发模式下数据目录位于项目根目录的 data/。"""
    return os.path.join(project_root, "data")


def reset_first_run_flags(data_dir: str) -> None:
    """删除 settings.db 中的首次运行完成标记。"""
    db_path = os.path.join(data_dir, "settings.db")
    if not os.path.isfile(db_path):
        print(f"[模拟首次运行] 数据库不存在，应用启动后会自动创建: {db_path}")
        return

    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        for scope in ("settings", "draw"):
            key = f"first_run_{scope}_done"
            cur.execute("DELETE FROM settings WHERE key = ?", (key,))
            print(f"[模拟首次运行] 已清除标记: {key}")
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[模拟首次运行] 警告：清除标记失败: {e}")


def write_startup_marker() -> str:
    """写入设置页启动标记，返回文件路径。"""
    temp_file = os.path.join(os.environ["TEMP"], "ns_startup_settings.txt")
    with open(temp_file, "w", encoding="utf-8") as f:
        f.write("settings")
    print(f"[模拟首次运行] 启动标记已写入: {temp_file}")
    return temp_file


def cleanup_startup_marker(temp_file: str) -> None:
    try:
        os.remove(temp_file)
    except FileNotFoundError:
        pass


def main() -> int:
    print("[模拟首次运行] 准备模拟首次运行环境...")

    project_root = get_project_root()
    data_dir = get_data_dir(project_root)
    os.makedirs(data_dir, exist_ok=True)

    reset_first_run_flags(data_dir)
    temp_file = write_startup_marker()

    tauri_dir = os.path.join(project_root, "tauri-app")
    if not os.path.isdir(tauri_dir):
        print("[模拟首次运行] 错误：找不到 tauri-app 目录", file=sys.stderr)
        return 1

    print(f"[模拟首次运行] 工作目录: {tauri_dir}")
    print(f"[模拟首次运行] 开发数据目录: {data_dir}")
    print("[模拟首次运行] 启动 npm run tauri dev ...")

    # 开发模式下让 Rust 后端也使用项目根目录的 data/，
    # 否则 Tauri 会使用 %APPDATA%/com.wongjy.numberselector/，
    # 导致上面清除的 settings.db 并不是程序实际读取的数据库。
    env = os.environ.copy()
    env["NS_DATA_DIR"] = data_dir

    try:
        result = subprocess.run(
            ["npm", "run", "tauri", "dev"], shell=True, cwd=tauri_dir, env=env
        )
        return result.returncode
    finally:
        cleanup_startup_marker(temp_file)


if __name__ == "__main__":
    sys.exit(main())

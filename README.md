# NumberSelector

智能抽号系统 —— 基于 Tauri 2.x 构建的跨平台桌面抽号应用，采用 React 18 前端 + Rust 后端架构。

## 功能特性

- **多种抽号模式**：支持 5 种抽号模式，满足不同场景需求
- **高级抽号**：按座位表分组抽号，适用于教室、会议室等场景
- **学生信息管理**：导入学生名单（支持 Excel），按性别筛选抽号
- **记录公示**：实时查看各模式抽号记录，支持持久化与内存模式
- **U 盘验证**：禁用时段内通过授权 U 盘验证解锁高级模式
- **首次引导**：新用户交互式引导，快速上手
- **暗色/亮色主题**：一键切换，自适应系统偏好
- **悬浮窗**：最小化后显示悬浮快捷操作窗
- **全局快捷键**：空格/回车抽号、R 重置、F 全屏、T 置顶

## 技术栈

- **前端**：React 18 + TypeScript + Vite
- **后端**：Rust + Tauri 2.x
- **数据库**：SQLite（通过 rusqlite）
- **构建**：Tauri CLI（NSIS 安装包）

## 项目结构

```
.
├── tauri-app/              # Tauri 应用主目录
│   ├── src/                # React 前端源码
│   │   ├── App.tsx         # 抽号主界面
│   │   ├── Settings.tsx    # 设置程序界面
│   │   ├── AdvancedDraw.tsx# 高级抽号界面
│   │   ├── Guide.tsx       # 首次引导组件
│   │   └── api.ts          # 前端 API 封装
│   ├── src-tauri/          # Rust 后端源码
│   │   ├── src/            # Rust 源码
│   │   ├── Cargo.toml      # Rust 依赖配置
│   │   └── tauri.conf.json # Tauri 应用配置
│   └── package.json        # Node.js 依赖配置
├── run_draw.py             # 开发脚本：启动抽号程序
├── run_settings.py         # 开发脚本：启动设置程序
└── simulate_first_run.py   # 开发脚本：模拟首次运行
```

## 开发环境

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/tools/install) >= 1.70
- Python 3（仅用于开发脚本）

### 安装依赖

```bash
cd tauri-app
npm install
```

### 启动开发服务器

```bash
# 方式 1：使用 Python 脚本
python run_draw.py       # 启动抽号程序
python run_settings.py   # 启动设置程序

# 方式 2：直接使用 npm
cd tauri-app
npm run tauri dev
```

### 构建生产版本

```bash
cd tauri-app
npm run tauri build
```

构建产物位于 `tauri-app/src-tauri/target/release/bundle/`。

## 数据存储

- **开发模式**：数据存储在项目根目录的 `data/` 文件夹下
- **生产模式**：数据存储在系统应用数据目录（`%APPDATA%/com.wongjy.numberselector/`）

## 版本说明

当前版本：`0.1.0`

## 作者

WongJY

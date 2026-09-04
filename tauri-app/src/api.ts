import { invoke } from "@tauri-apps/api/core";

export interface ModesPayload {
  front: string[];
  back: string[];
  mode5_front: string;
  mode5_back: string;
}

export interface Student {
  number: number;
  name: string;
  gender: "boy" | "girl";
}

export interface DrawResult {
  picked: number[];
  actual_qty: number;
  message: string | null;
  all_used: boolean;
  display_picked: number[];
  animation_numbers: number[];
}

export interface AdvancedDrawResult {
  picked: number[];
  picked_names: string[];
  drawn_seats: string[];
  all_used: boolean;
  display_picked: number[];
}

export interface AdvancedDrawV2Args {
  back_mode: string;
  draw_type: string;
  rule: string;
  qty: number;
  selected: string[];
  boy_enabled: boolean;
  girl_enabled: boolean;
  save: boolean;
}

export interface MemoryModeStatus {
  mode_back: string;
  mode_front: string;
  enabled: boolean;
  forced: boolean;
}

export interface TimeRange {
  h1: number;
  m1: number;
  h2: number;
  m2: number;
}

export interface AhenConfig {
  enabled: boolean;
  only_break: boolean;
  triggers: Record<string, string>;
}

export type SeatDirection = "rtl" | "ltr";
export type UsbVerifyScope = "current_break" | "permanent";

export interface NumberLimits {
  min: number;
  max: number;
}

export interface QuantityLimits {
  min: number;
  max: number;
}

export interface StudentRecord {
  number: number;
  name: string;
  gender: string;
}

export interface ParsedStudents {
  format: string;
  header: boolean;
  boys: StudentRecord[];
  girls: StudentRecord[];
}

export interface ImportPreview {
  has_settings: boolean;
  settings_count: number;
  has_students: boolean;
  boys_count: number;
  girls_count: number;
  has_seatmap: boolean;
  has_records: boolean;
  records: [string, number][];
  checksum_status: "valid" | "invalid" | "none";
}

export interface DataDirInfo {
  kind: "portable" | "app_data" | "custom";
  path: string;
  portable_path: string;
  app_data_path: string;
  custom_path: string;
  overridden_by_env: boolean;
}

export const api = {
  // ── 基础抽号 ──
  getModes: () => invoke<ModesPayload>("get_modes"),
  getMemoryModes: () => invoke<string[]>("get_memory_modes"),
  getStudents: () => invoke<Student[]>("get_students"),
  getUsed: (back_mode: string) => invoke<number[]>("get_used", { backMode: back_mode }),
  isInForbidRange: () => invoke<boolean>("is_in_forbid_range"),
  startDraw: (args: {
    back_mode: string;
    max_num: number;
    qty: number;
    gender: string | null;
    save: boolean;
  }) =>
    invoke<DrawResult>("start_draw", {
      backMode: args.back_mode,
      maxNum: args.max_num,
      qty: args.qty,
      gender: args.gender,
      save: args.save,
    }),
  clearRecord: (back_mode: string) =>
    invoke<void>("clear_record", { backMode: back_mode }),
  resetMemoryMode: (back_mode: string) =>
    invoke<void>("reset_memory_mode", { backMode: back_mode }),
  usbValid: () => invoke<boolean>("usb_valid"),

  // ── U盘会话验证（禁用时段内受限模式） ──
  verifyUsbForSession: (scope: UsbVerifyScope) =>
    invoke<boolean>("verify_usb_for_session", { scope }),
  isUsbSessionVerified: () => invoke<boolean>("is_usb_session_verified"),
  getUsbVerifyScope: () => invoke<UsbVerifyScope>("get_usb_verify_scope"),
  saveUsbVerifyScope: (scope: UsbVerifyScope) =>
    invoke<void>("save_usb_verify_scope", { scope }),

  // ── 高级抽号 ──
  loadSeatmap: () => invoke<string | null>("load_seatmap"),
  saveSeatmap: (seatmap_json: string) =>
    invoke<void>("save_seatmap", { seatmapJson: seatmap_json }),
  advancedDrawV2: (args: AdvancedDrawV2Args) =>
    invoke<AdvancedDrawResult>("advanced_draw_v2", {
      req: {
        back_mode: args.back_mode,
        draw_type: args.draw_type,
        rule: args.rule,
        qty: args.qty,
        selected: args.selected,
        boy_enabled: args.boy_enabled,
        girl_enabled: args.girl_enabled,
        save: args.save,
      },
    }),
  getSeatDirection: () => invoke<SeatDirection>("get_seat_direction"),
  saveSeatDirection: (direction: SeatDirection) =>
    invoke<void>("save_seat_direction", { direction }),
  checkStudentsExist: () => invoke<boolean>("check_students_exist"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),

  // ── 设置 - U盘验证 ──
  hasRegisteredUsb: () => invoke<boolean>("has_registered_usb"),
  listRemovableDrives: () => invoke<string[]>("list_removable_drives"),
  registerUsb: (drive: string) => invoke<string>("register_usb", { drive }),
  autoRegisterUsb: () => invoke<string>("auto_register_usb"),

  // ── 设置 - 内存模式 ──
  getMemoryModeStatuses: () => invoke<MemoryModeStatus[]>("get_memory_mode_statuses"),
  setMemoryMode: (back_mode: string, enabled: boolean) =>
    invoke<void>("set_memory_mode", { backMode: back_mode, enabled }),

  // ── 设置 - 时间段 ──
  getTimeRanges: () => invoke<TimeRange[]>("get_time_ranges"),
  saveTimeRanges: (ranges: TimeRange[]) =>
    invoke<void>("save_time_ranges", { ranges }),

  // ── 设置 - 暗痕 ──
  getAhenConfig: () => invoke<AhenConfig>("get_ahen_config"),
  saveAhenConfig: (config: AhenConfig) =>
    invoke<void>("save_ahen_config", { config }),

  // ── 设置 - 模式名 ──
  saveModes: (front_names: string[]) =>
    invoke<void>("save_modes", { frontNames: front_names }),

  // ── 设置 - 禁用时段可用模式 ──
  getBreakAllowModes: () => invoke<string[]>("get_break_allow_modes"),
  saveBreakAllowModes: (modes: string[]) =>
    invoke<void>("save_break_allow_modes", { modes }),

  // ── 设置 - 抽号参数范围 ──
  getNumberLimits: () => invoke<NumberLimits>("get_number_limits"),
  saveNumberLimits: (min: number, max: number) =>
    invoke<void>("save_number_limits", { min, max }),
  getQuantityLimits: () => invoke<QuantityLimits>("get_quantity_limits"),
  saveQuantityLimits: (min: number, max: number) =>
    invoke<void>("save_quantity_limits", { min, max }),

  // ── 设置 - 名单导入 ──
  parseStudentsFile: (path: string) =>
    invoke<ParsedStudents>("parse_students_file", { path }),
  overwriteStudents: (boys: StudentRecord[], girls: StudentRecord[]) =>
    invoke<void>("overwrite_students", { boys, girls }),

  // ── 多套名单管理 ──
  getRostersInfo: () => invoke<[string[], string]>("get_rosters_info"),
  createRoster: (name: string) =>
    invoke<void>("create_roster", { name }),
  switchRoster: (name: string) =>
    invoke<void>("switch_roster", { name }),
  renameRoster: (oldName: string, newName: string) =>
    invoke<void>("rename_roster", { oldName, newName }),
  deleteRoster: (name: string) =>
    invoke<void>("delete_roster", { name }),
  duplicateRoster: (src: string, dst: string) =>
    invoke<void>("duplicate_roster", { src, dst }),

  // ── 设置 - 数据迁移 ──
  exportData: (items: string[], path: string) =>
    invoke<void>("export_data", { items, path }),
  importDataPreview: (path: string) =>
    invoke<ImportPreview>("import_data_preview", { path }),
  importDataApply: (items: string[], path: string) =>
    invoke<void>("import_data_apply", { items, path }),

  // ── 引导与跨程序切换 ──
  getFirstRunDone: (scope: "draw" | "settings") =>
    invoke<boolean>("get_first_run_done", { scope }),
  setFirstRunDone: (scope: "draw" | "settings") =>
    invoke<void>("set_first_run_done", { scope }),
  switchApp: () => invoke<void>("switch_app"),

  // ── 窗口状态记忆 ──
  getWindowState: (scope: "draw" | "settings") =>
    invoke<{ x: number; y: number; width: number; height: number; maximized: boolean } | null>(
      "get_window_state", { scope }
    ),
  saveWindowState: (
    scope: "draw" | "settings",
    state: { x: number; y: number; width: number; height: number; maximized: boolean }
  ) => invoke<void>("save_window_state", { scope, state }),

  // ── 主题 ──
  getTheme: () => invoke<string>("get_theme"),
  saveTheme: (theme: "light" | "dark" | "system") => invoke<void>("save_theme", { theme }),

  // ── 显示格式 ──
  getDisplayFormat: () => invoke<string>("get_display_format"),
  saveDisplayFormat: (format: "number" | "name" | "number_name") =>
    invoke<void>("save_display_format", { format }),

  // ── 记录过期管理 ──
  getRecordExpireDays: () => invoke<number>("get_record_expire_days"),
  saveRecordExpireDays: (days: number) =>
    invoke<void>("save_record_expire_days", { days }),
  purgeOldRecords: (days: number) =>
    invoke<number>("purge_old_records", { days }),
  getRecentRecordsWithTime: (mode: string, limit: number) =>
    invoke<[number, string][]>("get_recent_records_with_time", { mode, limit }),

  // ── 开机自启 + 重启 ──
  isAutostartEnabled: () => invoke<boolean>("is_autostart_enabled"),
  enableAutostart: () => invoke<void>("enable_autostart"),
  disableAutostart: () => invoke<void>("disable_autostart"),
  restartApp: () => invoke<void>("restart_app"),

  // ── 数据目录切换 ──
  getDataDirInfo: () => invoke<DataDirInfo>("get_data_dir_info"),
  setDataDir: (kind: DataDirInfo["kind"], customPath?: string) =>
    invoke<void>("set_data_dir", { kind, customPath: customPath ?? null }),
};

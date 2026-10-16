import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, ModesPayload, MemoryModeStatus, TimeRange, AhenConfig, SeatDirection, UsbVerifyScope, NumberLimits, QuantityLimits, ParsedStudents, ImportPreview, DataDirInfo } from "./api";
import Guide, { GuideStep } from "./Guide";
import { useTheme } from "./useTheme";
import { useWindowState } from "./useWindowState";
import ThemeToggle from "./ThemeToggle";
import { useToast } from "./useToast";
import { useDialog } from "./useDialog";
import { Toast } from "./Toast";
import { YesNoDialog, PromptDialog } from "./Dialog";

// ═══════════════════════════════════════════════
//  设置页面（带 USB 验证门）
// ═══════════════════════════════════════════════

export default function SettingsApp() {
  // 验证状态
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true); // 是否正在验证
  const [hasRegistered, setHasRegistered] = useState(false);
  const [firstRunDone, setFirstRunDone] = useState(true);
  const { theme, setTheme } = useTheme();
  const [usbMessage, setUsbMessage] = useState(""); // USB 验证区域的提示信息
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [registerSuccess, setRegisterSuccess] = useState(false);
  const [settingsGuideStep, setSettingsGuideStep] = useState(0);

  // 设置数据
  const [modes, setModes] = useState<ModesPayload | null>(null);
  const [memoryStatuses, setMemoryStatuses] = useState<MemoryModeStatus[]>([]);
  const [timeRanges, setTimeRanges] = useState<TimeRange[]>([]);
  // 禁用时段内免 U 盘验证可用的模式（back 名称）
  const [breakAllowModes, setBreakAllowModes] = useState<string[]>(["Mode5"]);
  const [ahenConfig, setAhenConfig] = useState<AhenConfig | null>(null);
  const [seatDirection, setSeatDirection] = useState<SeatDirection>("rtl");
  const [usbVerifyScope, setUsbVerifyScope] = useState<UsbVerifyScope>("current_break");

  // UI 状态
  const { toast, showToast } = useToast();
  const authTimer = useRef<number | null>(null);
  const { dialog, setDialog, askYesNo, promptDialog, setPromptDialog, askText } = useDialog();
  const [isRegistering, setIsRegistering] = useState(false);
  const [availableDrives, setAvailableDrives] = useState<string[]>([]);
  const [selectedDrive, setSelectedDrive] = useState("");

  // 时间段编辑临时状态
  const [editingRanges, setEditingRanges] = useState<TimeRange[]>([]);
  const [rangesDirty, setRangesDirty] = useState(false);
  const [rangeRawInputs, setRangeRawInputs] = useState<Record<string, string>>({});
  const [rangeInputErrors, setRangeInputErrors] = useState<Record<string, boolean>>({});
  const [numLimitRaw, setNumLimitRaw] = useState<{ min?: string; max?: string }>({});
  const [numLimitError, setNumLimitError] = useState<{ min?: boolean; max?: boolean }>({});
  const [qtyLimitRaw, setQtyLimitRaw] = useState<{ min?: string; max?: string }>({});
  const [qtyLimitError, setQtyLimitError] = useState<{ min?: boolean; max?: boolean }>({});
  const [timeImportText, setTimeImportText] = useState("");

  // 模式名编辑
  const [editingNames, setEditingNames] = useState<string[]>([]);
  const [namesDirty, setNamesDirty] = useState(false);

  // 暗痕编辑
  const [editingAhen, setEditingAhen] = useState<AhenConfig | null>(null);
  const [ahenDirty, setAhenDirty] = useState(false);

  // 清空记录选中的模式集合
  const [selectedClearBacks, setSelectedClearBacks] = useState<Set<string>>(new Set());

  // 抽号参数范围
  const [numberLimits, setNumberLimits] = useState<NumberLimits>({ min: 1, max: 100 });
  const [quantityLimits, setQuantityLimits] = useState<QuantityLimits>({ min: 1, max: 5 });
  const [editingNumLimits, setEditingNumLimits] = useState<NumberLimits>({ min: 1, max: 100 });
  const [editingQtyLimits, setEditingQtyLimits] = useState<QuantityLimits>({ min: 1, max: 5 });
  const [limitsDirty, setLimitsDirty] = useState(false);

  // 显示格式
  const [displayFormat, setDisplayFormat] = useState<"number" | "name" | "number_name">("number_name");

  // 记录过期天数（0=不自动清理）
  const [recordExpireDays, setRecordExpireDays] = useState<number>(0);
  const [editingExpireDays, setEditingExpireDays] = useState<string>("0");
  const [expireDirty, setExpireDirty] = useState(false);

  // 开机自启
  const [autostartEnabled, setAutostartEnabled] = useState(false);

  // 数据目录
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [dataDirKind, setDataDirKind] = useState<DataDirInfo["kind"]>("portable");
  const [customDirPath, setCustomDirPath] = useState("");

  // 名单导入
  const [importPreview, setImportPreview] = useState<ParsedStudents | null>(null);
  const [nameImporting, setNameImporting] = useState(false);

  // 多套名单管理
  const [rosterNames, setRosterNames] = useState<string[]>([]);
  const [activeRoster, setActiveRoster] = useState<string>("");

  // 数据迁移 - 导出
  const [exportItems, setExportItems] = useState<Set<string>>(
    new Set(["settings", "students", "seatmap", "records"]),
  );
  // 数据迁移 - 导入
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importPreviewData, setImportPreviewData] = useState<ImportPreview | null>(null);
  const [importItems, setImportItems] = useState<Set<string>>(new Set());

  // 初始加载：检查 USB 授权状态
  // 不在此处设置 usbMessage——欢迎/引导文字由描述文案覆盖，
  // 驱动器检测状态由下面的自动刷新填充，避免重复提示
  useEffect(() => {
    (async () => {
      try {
        const [registered, valid] = await Promise.all([
          api.hasRegisteredUsb(),
          api.usbValid(),
        ]);
        setHasRegistered(registered);
        if (valid) {
          setAuthorized(true);
        }
      } catch (e) {
        setUsbMessage(`检查失败: ${e}`);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  // 在 USB 验证门界面自动刷新驱动器，减少用户操作步骤
  // 使用静默模式：不弹 toast，避免与已有文案重复
  useEffect(() => {
    if (authorized || hasRegistered) return;
    handleRefreshDrives(true).catch(() => {});
  }, [authorized, hasRegistered]);

  // 验证通过后加载设置数据
  // 每个接口独立加载，避免一个接口失败导致整个页面无法渲染
  async function loadAllSettings() {
    setSettingsLoadError(null);
    setSettingsLoading(true);
    const errors: string[] = [];

    const [m, mem, tr, ah, dir, scope, nl, ql, frd, df, ed, ddi, bam] = await Promise.all([
      api.getModes().catch(e => { errors.push(`模式: ${e}`); return null; }),
      api.getMemoryModeStatuses().catch(e => { errors.push(`内存模式: ${e}`); return [] as MemoryModeStatus[]; }),
      api.getTimeRanges().catch(e => { errors.push(`时间设置: ${e}`); return [] as TimeRange[]; }),
      api.getAhenConfig().catch(e => { errors.push(`暗痕配置: ${e}`); return null as AhenConfig | null; }),
      api.getSeatDirection().catch(e => { errors.push(`座位方向: ${e}`); return "rtl" as SeatDirection; }),
      api.getUsbVerifyScope().catch(e => { errors.push(`U盘有效期: ${e}`); return "current_break" as UsbVerifyScope; }),
      api.getNumberLimits().catch(e => { errors.push(`号码范围: ${e}`); return { min: 1, max: 100 } as NumberLimits; }),
      api.getQuantityLimits().catch(e => { errors.push(`数量范围: ${e}`); return { min: 1, max: 5 } as QuantityLimits; }),
      api.getFirstRunDone("settings").catch(e => { errors.push(`首次引导: ${e}`); return true; }),
      api.getDisplayFormat().catch(e => { errors.push(`显示格式: ${e}`); return "number_name" as const; }),
      api.getRecordExpireDays().catch(e => { errors.push(`记录过期: ${e}`); return 0; }),
      api.getDataDirInfo().catch(e => { errors.push(`数据目录: ${e}`); return null; }),
      api.getBreakAllowModes().catch(e => { errors.push(`禁用时段可用模式: ${e}`); return ["Mode5"] as string[]; }),
    ]);

    if (errors.length > 0) {
      setSettingsLoadError(`部分设置加载失败，请尝试重启程序或重新进入设置页。\n${errors.join("\n")}`);
    }

    if (m) {
      setModes(m);
      setEditingNames([...m.front]);
    }

    setMemoryStatuses(mem);
    setTimeRanges(tr);
    setBreakAllowModes(bam);
    setEditingRanges(tr.map(r => ({ ...r })));
    setRangeRawInputs({});
    setRangeInputErrors({});

    if (ah) {
      setAhenConfig(ah);
      setEditingAhen(JSON.parse(JSON.stringify(ah)));
    }

    setSeatDirection(dir || "rtl");
    setUsbVerifyScope(scope || "current_break");
    setSelectedClearBacks(new Set());
    setNumberLimits(nl);
    setQuantityLimits(ql);
    setEditingNumLimits({ ...nl });
    setEditingQtyLimits({ ...ql });
    setNumLimitRaw({});
    setNumLimitError({});
    setQtyLimitRaw({});
    setQtyLimitError({});
    setLimitsDirty(false);
    setFirstRunDone(frd);
    setDisplayFormat(
      df === "number" || df === "name" || df === "number_name" ? df : "number_name"
    );
    setRecordExpireDays(ed);
    setEditingExpireDays(String(ed));
    setExpireDirty(false);

    if (ddi) {
      setDataDirInfo(ddi);
      setDataDirKind(ddi.kind);
      setCustomDirPath(ddi.custom_path);
    }

    // 自启状态和名单信息单独加载（注册表/文件查询）
    try {
      const [auto, [names, active]] = await Promise.all([
        api.isAutostartEnabled(),
        api.getRostersInfo(),
      ]);
      setAutostartEnabled(auto);
      setRosterNames(names);
      setActiveRoster(active);
    } catch (e) { console.warn("[settings] ignored error:", e); }
    setSettingsLoading(false);
  }

  async function handleDisplayFormatChange(fmt: "number" | "name" | "number_name") {
    setDisplayFormat(fmt);
    try {
      await api.saveDisplayFormat(fmt);
      showToast("显示格式已保存", "success");
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  async function handleToggleBreakAllow(back: string) {
    const prev = breakAllowModes;
    const next = prev.includes(back)
      ? prev.filter(m => m !== back)
      : [...prev, back];
    setBreakAllowModes(next);
    try {
      await api.saveBreakAllowModes(next);
      showToast(
        next.length
          ? "禁用时段可用模式已保存"
          : "已保存：禁用时段内所有模式均需验证U盘",
        "success"
      );
    } catch (e) {
      setBreakAllowModes(prev);
      showToast(`保存失败: ${e}`, "error");
    }
  }

  function handleExpireDaysInput(v: string) {
    // 仅允许非负整数
    const cleaned = v.replace(/[^\d]/g, "");
    setEditingExpireDays(cleaned);
    setExpireDirty(cleaned !== String(recordExpireDays));
  }

  async function handleSaveExpireDays() {
    const days = parseInt(editingExpireDays, 10);
    if (isNaN(days) || days < 0) {
      showToast("请输入有效的天数（0 或正整数）", "error");
      return;
    }
    try {
      await api.saveRecordExpireDays(days);
      setRecordExpireDays(days);
      setExpireDirty(false);
      showToast(
        days === 0 ? "已关闭自动清理" : `已设置保留 ${days} 天记录`,
        "success"
      );
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  async function handlePurgeNow() {
    const days = parseInt(editingExpireDays, 10);
    if (isNaN(days) || days <= 0) {
      showToast("请先设置大于 0 的保留天数", "error");
      return;
    }
    const yes = await askYesNo(
      "立即清理",
      `确定要立即清理 ${days} 天之前的所有抽号记录吗？\n此操作不可撤销。`,
    );
    if (!yes) return;
    try {
      const removed = await api.purgeOldRecords(days);
      showToast(`已清理 ${removed} 条过期记录`, "success");
    } catch (e) {
      showToast(`清理失败: ${e}`, "error");
    }
  }

  async function handleAutostartToggle() {
    try {
      if (autostartEnabled) {
        await api.disableAutostart();
        setAutostartEnabled(false);
        showToast("已关闭开机自启", "success");
      } else {
        await api.enableAutostart();
        setAutostartEnabled(true);
        showToast("已开启开机自启", "success");
      }
    } catch (e) {
      showToast(`设置失败: ${e}`, "error");
    }
  }

  async function handleRestart() {
    const yes = await askYesNo(
      "重启程序",
      "确定要重启当前程序吗？\n重启期间会短暂关闭并重新打开。",
    );
    if (!yes) return;
    try {
      await api.restartApp();
    } catch (e) {
      showToast(`重启失败: ${e}`, "error");
    }
  }

  async function handleSelectCustomDir() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: customDirPath || undefined,
      });
      if (!selected || Array.isArray(selected)) return;
      setCustomDirPath(selected);
      setDataDirKind("custom");
    } catch (e) {
      showToast(`选择目录失败: ${e}`, "error");
    }
  }

  async function handleSaveDataDir() {
    if (dataDirKind === "custom" && !customDirPath.trim()) {
      showToast("请选择自定义目录", "error");
      return;
    }
    try {
      await api.setDataDir(
        dataDirKind,
        dataDirKind === "custom" ? customDirPath : undefined,
      );
      showToast("数据目录已保存，重启后生效", "success");
      const info = await api.getDataDirInfo();
      setDataDirInfo(info);
      setDataDirKind(info.kind);
      setCustomDirPath(info.custom_path);
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  // ── 多套名单管理 ──

  async function refreshRosters() {
    try {
      const [names, active] = await api.getRostersInfo();
      setRosterNames(names);
      setActiveRoster(active);
    } catch (e) { console.warn("[settings] ignored error:", e); }
  }

  async function handleSwitchRoster(name: string) {
    if (name === activeRoster) return;
    const yes = await askYesNo(
      "切换名单",
      `确定要切换到「${name}」吗？\n切换名单会清空所有抽号记录。`,
    );
    if (!yes) return;
    try {
      await api.switchRoster(name);
      setActiveRoster(name);
      showToast(`已切换到「${name}」`, "success");
    } catch (e) {
      showToast(`切换失败: ${e}`, "error");
    }
  }

  async function handleCreateRoster() {
    const name = await askText("请输入新名单名称");
    if (!name || !name.trim()) return;
    try {
      await api.createRoster(name.trim());
      await refreshRosters();
      showToast(`已创建名单「${name.trim()}」`, "success");
    } catch (e) {
      showToast(`创建失败: ${e}`, "error");
    }
  }

  async function handleRenameRoster(oldName: string) {
    const newName = await askText("请输入新的名单名称", oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;
    try {
      await api.renameRoster(oldName, newName.trim());
      await refreshRosters();
      showToast("已重命名", "success");
    } catch (e) {
      showToast(`重命名失败: ${e}`, "error");
    }
  }

  async function handleDeleteRoster(name: string) {
    const yes = await askYesNo(
      "删除名单",
      `确定要删除名单「${name}」吗？\n此操作不可撤销。`,
    );
    if (!yes) return;
    try {
      await api.deleteRoster(name);
      await refreshRosters();
      showToast(`已删除名单「${name}」`, "success");
    } catch (e) {
      showToast(`删除失败: ${e}`, "error");
    }
  }

  async function handleDuplicateRoster(src: string) {
    const dst = await askText("请输入复制后的名单名称", `${src} 副本`);
    if (!dst || !dst.trim()) return;
    try {
      await api.duplicateRoster(src, dst.trim());
      await refreshRosters();
      showToast(`已复制为「${dst.trim()}」`, "success");
    } catch (e) {
      showToast(`复制失败: ${e}`, "error");
    }
  }

  useEffect(() => {
    if (!authorized) return;
    loadAllSettings();
  }, [authorized]);

  // 窗口状态记忆
  useWindowState("settings");

  // ── USB 验证/注册 ──

  // silent=true：仅更新 usbMessage，不弹 toast（用于首次进入的自动刷新）
  // silent=false：手动点击刷新按钮时给出 toast 反馈
  async function handleRefreshDrives(silent = false) {
    try {
      const drives = await api.listRemovableDrives();
      setAvailableDrives(drives);
      if (drives.length > 0) {
        setSelectedDrive(drives[0]);
        setUsbMessage(`检测到 ${drives.length} 个可移动驱动器`);
      } else {
        setUsbMessage("未检测到可移动驱动器，请插入U盘");
        if (!silent) {
          showToast("未检测到U盘", "warning");
        }
      }
    } catch (e) {
      showToast(`刷新失败: ${e}`, "error");
    }
  }

  async function handleVerifyUsb() {
    setChecking(true);
    try {
      const valid = await api.usbValid();
      if (valid) {
        setAuthorized(true);
        showToast("U盘验证通过", "success");
      } else {
        setUsbMessage("验证失败：未检测到授权U盘");
        showToast("验证失败：未检测到授权U盘", "error");
      }
    } catch (e) {
      showToast(`验证失败: ${e}`, "error");
    } finally {
      setChecking(false);
    }
  }

  async function performRegistration(registerFn: () => Promise<string>) {
    setIsRegistering(true);
    try {
      const msg = await registerFn();
      setHasRegistered(true);
      setRegisterSuccess(true);
      setUsbMessage(msg || "注册成功，即将进入设置界面...");
      if (authTimer.current) window.clearTimeout(authTimer.current);
      authTimer.current = setTimeout(() => { setAuthorized(true); }, 1500);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("请先插入并验证已授权U盘")) {
        const guide = "注册新U盘前，请先插入已授权的U盘并点击“验证U盘”通过验证。如未注册过任何U盘，可直接注册。";
        setUsbMessage(guide);
        showToast(guide, "error");
      } else {
        setUsbMessage(`注册失败: ${msg}`);
        showToast(`注册失败: ${msg}`, "error");
      }
    } finally {
      setIsRegistering(false);
    }
  }

  async function handleRegisterUsb() {
    if (!selectedDrive) {
      showToast("请先选择盘符", "error");
      return;
    }
    await performRegistration(() => api.registerUsb(selectedDrive));
  }

  async function handleAutoRegister() {
    await performRegistration(() => api.autoRegisterUsb());
  }

  // ── 内存模式 ──

  async function handleMemoryModeToggle(back: string, enabled: boolean, forced: boolean) {
    if (forced) return;
    try {
      await api.setMemoryMode(back, enabled);
      setMemoryStatuses(prev =>
        prev.map(s => s.mode_back === back ? { ...s, enabled } : s)
      );
      showToast(
        `【${memoryStatuses.find(s => s.mode_back === back)?.mode_front}】已${enabled ? "启用" : "关闭"}内存模式`,
        "success"
      );
    } catch (e) {
      showToast(`设置失败: ${e}`, "error");
    }
  }

  // ── 清空记录 ──

  function toggleClearBack(back: string) {
    setSelectedClearBacks(prev => {
      const next = new Set(prev);
      if (next.has(back)) {
        next.delete(back);
      } else {
        next.add(back);
      }
      return next;
    });
  }

  async function handleClearSelected() {
    if (selectedClearBacks.size === 0) return;
    const names = allModes
      .filter(m => selectedClearBacks.has(m.back))
      .map(m => `【${m.front}】`)
      .join("、");
    const yes = await askYesNo(
      "清空记录",
      `确定要清空 ${names} 的抽号记录吗？\n此操作不可撤销。`,
    );
    if (!yes) return;
    const results: string[] = [];
    for (const back of selectedClearBacks) {
      try {
        const isMemory = memoryStatuses.find(s => s.mode_back === back)?.enabled ?? false;
        if (isMemory) {
          await api.resetMemoryMode(back);
        } else {
          await api.clearRecord(back);
        }
        const front = allModes.find(m => m.back === back)?.front || back;
        results.push(`【${front}】`);
      } catch (e) {
        showToast(`清空失败: ${e}`, "error");
        return;
      }
    }
    setSelectedClearBacks(new Set());
    showToast(`${results.join("、")} 的记录已清空`, "success");
  }


  // ── 时间段 ──

  function handleRangeChange(index: number, field: keyof TimeRange, value: string) {
    const key = `${index}-${field}`;
    setRangeRawInputs(prev => ({ ...prev, [key]: value }));

    if (value === "") {
      setRangeInputErrors(prev => ({ ...prev, [key]: false }));
      return;
    }

    const num = parseInt(value, 10);
    if (isNaN(num) || num < 0) {
      setRangeInputErrors(prev => ({ ...prev, [key]: true }));
      return;
    }

    setRangeInputErrors(prev => ({ ...prev, [key]: false }));
    setEditingRanges(prev => {
      const next = prev.map((r, i) => i === index ? { ...r, [field]: num } : r);
      return next;
    });
    setRangesDirty(true);
  }

  function handleRangeBlur(index: number, field: keyof TimeRange) {
    const key = `${index}-${field}`;
    const raw = rangeRawInputs[key];
    if (raw === undefined) return;

    const num = parseInt(raw, 10);
    if (raw === "" || isNaN(num) || num < 0) {
      const current = editingRanges[index]?.[field] ?? 0;
      setRangeRawInputs(prev => ({ ...prev, [key]: String(current) }));
      setRangeInputErrors(prev => ({ ...prev, [key]: false }));
      if (raw === "") {
        setEditingRanges(prev => {
          const next = prev.map((r, i) => i === index ? { ...r, [field]: 0 } : r);
          return next;
        });
        setRangesDirty(true);
      }
    }
  }

  function handleAddRange() {
    setEditingRanges(prev => [...prev, { h1: 0, m1: 0, h2: 0, m2: 0 }]);
    setRangesDirty(true);
  }

  function handleRemoveRange(index: number) {
    setEditingRanges(prev => prev.filter((_, i) => i !== index));
    setRangesDirty(true);
  }

  async function handleSaveRanges() {
    // 验证
    for (let i = 0; i < editingRanges.length; i++) {
      const r = editingRanges[i];
      if (r.h1 > 23 || r.m1 > 59 || r.h2 > 23 || r.m2 > 59) {
        showToast(`时段 ${i + 1} 的时间值超出有效范围`, "error");
        return;
      }
    }
    try {
      await api.saveTimeRanges(editingRanges);
      setTimeRanges(editingRanges.map(r => ({ ...r })));
      setRangeRawInputs({});
      setRangeInputErrors({});
      setRangesDirty(false);
      showToast("时间设置已保存", "success");
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  function parseTimeText(text: string): TimeRange[] {
    const ranges: TimeRange[] = [];
    const trimmed = text.trim();
    if (!trimmed) return ranges;

    // 尝试 JSON 数组，例如 [[8,0,12,0],[14,0,17,30]]
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (Array.isArray(item) && item.length >= 4) {
              const [h1, m1, h2, m2] = item.map((n: unknown) => parseInt(String(n), 10));
              if ([h1, m1, h2, m2].every(n => !Number.isNaN(n))) {
                ranges.push({ h1, m1, h2, m2 });
              }
            }
          }
        }
        if (ranges.length > 0) return ranges;
      } catch { /* 继续按文本解析 */ }
    }

    // 文本解析：支持 08:00-12:00、08:00~12:00、08,00-12,00 等
    const lines = trimmed.split(/[\n,;]+/);
    for (const line of lines) {
      const cleaned = line.trim();
      if (!cleaned) continue;
      // 匹配 08:00-12:00 或 08,00-12,00
      const m = cleaned.match(/(\d{1,2})[:，,](\d{1,2})\s*[-~～]\s*(\d{1,2})[:，,](\d{1,2})/);
      if (m) {
        const h1 = parseInt(m[1], 10);
        const m1 = parseInt(m[2], 10);
        const h2 = parseInt(m[3], 10);
        const m2 = parseInt(m[4], 10);
        if ([h1, m1, h2, m2].every(n => !Number.isNaN(n))) {
          ranges.push({ h1, m1, h2, m2 });
        }
      }
    }
    return ranges;
  }

  function handleImportTimeText() {
    const parsed = parseTimeText(timeImportText);
    if (parsed.length === 0) {
      showToast("未能解析出有效时段，请检查格式", "error");
      return;
    }
    for (let i = 0; i < parsed.length; i++) {
      const r = parsed[i];
      if (r.h1 > 23 || r.m1 > 59 || r.h2 > 23 || r.m2 > 59) {
        showToast(`时段 ${i + 1} 的时间值超出有效范围`, "error");
        return;
      }
    }
    setEditingRanges(parsed.map(r => ({ ...r })));
    setRangeRawInputs({});
    setRangeInputErrors({});
    setRangesDirty(true);
    setTimeImportText("");
    showToast(`已导入 ${parsed.length} 个时段`, "success");
  }

  // ── 模式名编辑 ──

  function handleNameChange(index: number, value: string) {
    setEditingNames(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setNamesDirty(true);
  }

  async function handleSaveNames() {
    for (let i = 0; i < editingNames.length; i++) {
      if (editingNames[i].trim() === "") {
        showToast(`模式 ${i + 1} 的名称不能为空`, "error");
        return;
      }
    }
    try {
      await api.saveModes(editingNames);
      if (modes) {
        setModes({ ...modes, front: [...editingNames] });
      }
      setNamesDirty(false);
      showToast("模式名称已保存", "success");
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  // ── 暗痕设置 ──

  function handleAhenChange(field: keyof AhenConfig, value: any) {
    if (!editingAhen) return;
    setEditingAhen({ ...editingAhen, [field]: value });
    setAhenDirty(true);
  }

  function handleAddTrigger() {
    if (!editingAhen) return;
    const triggers = { ...editingAhen.triggers };
    let counter = 0;
    let placeholder = `__new_${counter}`;
    while (triggers[placeholder] !== undefined) {
      counter++;
      placeholder = `__new_${counter}`;
    }
    triggers[placeholder] = "";
    setEditingAhen({ ...editingAhen, triggers });
    setAhenDirty(true);
  }

  function handleTriggerChange(oldKey: string, newKey: string, value: string) {
    if (!editingAhen) return;
    const entries = Object.entries(editingAhen.triggers);
    const idx = entries.findIndex(([k]) => k === oldKey);
    if (idx >= 0) entries.splice(idx, 1);
    if (newKey !== "") {
      entries.splice(idx >= 0 ? idx : entries.length, 0, [newKey, value]);
    }
    setEditingAhen({ ...editingAhen, triggers: Object.fromEntries(entries) });
    setAhenDirty(true);
  }

  function handleRemoveTrigger(key: string) {
    if (!editingAhen) return;
    const triggers = { ...editingAhen.triggers };
    delete triggers[key];
    setEditingAhen({ ...editingAhen, triggers });
    setAhenDirty(true);
  }

  async function handleSaveAhen() {
    if (!editingAhen) return;
    try {
      const cleanedTriggers: Record<string, string> = {};
      for (const [k, v] of Object.entries(editingAhen.triggers)) {
        if (k && !k.startsWith("__new_")) {
          cleanedTriggers[k] = v;
        }
      }
      const cleaned = { ...editingAhen, triggers: cleanedTriggers };
      await api.saveAhenConfig(cleaned);
      setAhenConfig(JSON.parse(JSON.stringify(cleaned)));
      setEditingAhen(JSON.parse(JSON.stringify(cleaned)));
      setAhenDirty(false);
      showToast("暗痕配置已保存", "success");
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  async function handleSaveSeatDirection(direction: SeatDirection) {
    try {
      await api.saveSeatDirection(direction);
      setSeatDirection(direction);
      showToast("座位表方向已保存", "success");
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  async function handleSaveUsbScope(scope: UsbVerifyScope) {
    try {
      await api.saveUsbVerifyScope(scope);
      setUsbVerifyScope(scope);
      showToast("U盘验证有效期已保存", "success");
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  // ── 抽号参数范围 ──

  function handleLimitChange(kind: "num" | "qty", field: "min" | "max", value: string) {
    const setRaw = kind === "num" ? setNumLimitRaw : setQtyLimitRaw;
    const setError = kind === "num" ? setNumLimitError : setQtyLimitError;
    const setEditing = kind === "num" ? setEditingNumLimits : setEditingQtyLimits;

    setRaw(prev => ({ ...prev, [field]: value }));
    if (value === "") { setError(prev => ({ ...prev, [field]: false })); return; }
    const num = parseInt(value, 10);
    if (Number.isNaN(num) || num < 1) { setError(prev => ({ ...prev, [field]: true })); return; }
    setError(prev => ({ ...prev, [field]: false }));
    setEditing(prev => ({ ...prev, [field]: num }));
    setLimitsDirty(true);
  }

  function handleLimitBlur(kind: "num" | "qty", field: "min" | "max") {
    const raw = (kind === "num" ? numLimitRaw : qtyLimitRaw)[field];
    if (raw === undefined) return;
    const setRaw = kind === "num" ? setNumLimitRaw : setQtyLimitRaw;
    const setError = kind === "num" ? setNumLimitError : setQtyLimitError;
    const setEditing = kind === "num" ? setEditingNumLimits : setEditingQtyLimits;
    const current = (kind === "num" ? editingNumLimits : editingQtyLimits)[field];

    const num = parseInt(raw, 10);
    if (raw === "" || Number.isNaN(num) || num < 1) {
      setRaw(prev => ({ ...prev, [field]: String(current) }));
      setError(prev => ({ ...prev, [field]: false }));
      if (raw === "") {
        setEditing(prev => ({ ...prev, [field]: 1 }));
        setLimitsDirty(true);
      }
    }
  }

  async function handleSaveLimits() {
    const nl = editingNumLimits;
    const ql = editingQtyLimits;
    if (nl.min < 1 || nl.min > nl.max) {
      showToast("号码：下限需 ≥1 且 ≤ 上限", "error");
      return;
    }
    if (ql.min < 1 || ql.min > ql.max) {
      showToast("数量：下限需 ≥1 且 ≤ 上限", "error");
      return;
    }
    try {
      await api.saveNumberLimits(nl.min, nl.max);
      await api.saveQuantityLimits(ql.min, ql.max);
      setNumberLimits({ ...nl });
      setQuantityLimits({ ...ql });
      setNumLimitRaw({});
      setNumLimitError({});
      setQtyLimitRaw({});
      setQtyLimitError({});
      setLimitsDirty(false);
      showToast("参数范围已保存", "success");
    } catch (e) {
      showToast(`保存失败: ${e}`, "error");
    }
  }

  // ── 名单导入 ──

  async function handleSelectNameFile() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "名单文件", extensions: ["csv", "xlsx", "xls"] }],
      });
      if (!selected) return;
      const parsed = await api.parseStudentsFile(selected);
      setImportPreview(parsed);
      showToast(
        `解析成功：男 ${parsed.boys.length} 人，女 ${parsed.girls.length} 人（${parsed.format.toUpperCase()}）`,
        "info",
      );
    } catch (e) {
      showToast(`解析失败: ${e}`, "error");
    }
  }
  async function handleConfirmImportNames() {
    if (!importPreview) return;
    const total = importPreview.boys.length + importPreview.girls.length;
    if (total === 0) {
      showToast("文件中没有有效学生数据", "error");
      return;
    }
    const yes = await askYesNo(
      "覆盖名单",
      `将覆盖现有名单：男 ${importPreview.boys.length} 人，女 ${importPreview.girls.length} 人。\n此操作不可撤销，确认继续？`,
    );
    if (!yes) return;
    setNameImporting(true);
    try {
      await api.overwriteStudents(importPreview.boys, importPreview.girls);
      showToast("名单已导入", "success");
      setImportPreview(null);
    } catch (e) {
      showToast(`写入失败: ${e}`, "error");
    } finally {
      setNameImporting(false);
    }
  }

  // ── 数据迁移 ──

  const MIGRATION_LABELS: Record<string, string> = {
    settings: "全部设置",
    students: "学生名单",
    seatmap: "座位表",
    records: "抽号记录",
  };

  function toggleExportItem(item: string) {
    setExportItems(prev => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  }
  async function handleExport() {
    const items = Array.from(exportItems);
    if (items.length === 0) {
      showToast("请至少选择一项导出", "error");
      return;
    }
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    try {
      const path = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: `抽号系统备份_${stamp}.json`,
      });
      if (!path) return;
      await api.exportData(items, path);
      showToast(`已导出到：${path}`, "success");
    } catch (e) {
      showToast(`导出失败: ${e}`, "error");
    }
  }
  async function handleSelectBackup() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const preview = await api.importDataPreview(selected);
      setImportPath(selected);
      setImportPreviewData(preview);
      const items = new Set<string>();
      if (preview.has_settings) items.add("settings");
      if (preview.has_students) items.add("students");
      if (preview.has_seatmap) items.add("seatmap");
      if (preview.has_records) items.add("records");
      setImportItems(items);
    } catch (e) {
      showToast(`读取备份失败: ${e}`, "error");
    }
  }
  function toggleImportItem(item: string) {
    setImportItems(prev => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  }
  async function handleConfirmImport() {
    if (!importPath || !importPreviewData) return;
    const items = Array.from(importItems);
    if (items.length === 0) {
      showToast("请至少选择一项恢复", "error");
      return;
    }
    const names = items.map(i => MIGRATION_LABELS[i] || i).join("、");
    const yes = await askYesNo(
      "恢复数据",
      `将从备份恢复：${names}。\n会覆盖当前对应内容，此操作不可撤销，确认继续？`,
    );
    if (!yes) return;
    try {
      await api.importDataApply(items, importPath);
      showToast("数据已恢复", "success");
      setImportPath(null);
      setImportPreviewData(null);
      setImportItems(new Set());
      await loadAllSettings();
    } catch (e) {
      showToast(`恢复失败: ${e}`, "error");
    }
  }

  // ── Dialog 节点（共用，首次运行引导时使用更高 z-index） ──
  const guideZIndex = !firstRunDone ? 10003 : undefined;
  const dialogNode = dialog && (
    <YesNoDialog dialog={dialog} setDialog={setDialog} zIndexOverride={guideZIndex} />
  );
  const promptDialogNode = promptDialog && (
    <PromptDialog prompt={promptDialog} setPrompt={setPromptDialog} zIndexOverride={guideZIndex} />
  );

  // 引导步骤定义（必须在所有 early return 之前调用，遵守 React Hooks 规则）
  // 空依赖数组是故意的：捕获的闭包（onClick/handleSelectNameFile 等）只使用
  // 稳定的 React state setter 和 useCallback 包裹的函数，不会因渲染而变旧。
  const settingsGuideSteps: GuideStep[] = useMemo(() => [
    {
      title: "首次使用设置",
      content: "完成下面几项后，即可进入抽号。",
    },
    {
      selector: "import-file-btn",
      title: "导入学生名单",
      content: "从 Excel/CSV 导入，需包含号码、姓名、性别三列。",
      action: {
        label: "选择名单文件",
        onClick: handleSelectNameFile,
      },
    },
    {
      selector: "display-format",
      title: "结果显示格式",
      content: "选择抽号结果展示号码、姓名，或两者同时显示。",
    },
    {
      selector: "time-ranges",
      title: "设置禁用时段",
      content: "添加课间等禁用时段，该时段内仅勾选的「免验证模式」可直接抽号。",
      centered: true,
    },
    {
      selector: "usb-settings",
      title: "授权 U 盘",
      content: "注册 U 盘后，禁用时段内可验证解锁全部模式。也可后续再设置。",
    },
    {
      selector: "seat-direction",
      title: "座位表方向",
      content: "高级抽号中使用，调整座位表列标头顺序。",
    },
    {
      selector: "ahen-settings",
      title: "暗痕设置",
      content: "指定号码被抽中时，动画过程显示为另一个号码。",
    },
    {
      title: "设置完成",
      content: "基本设置已完成，可以进入抽号程序。",
      primaryLabel: "进入抽号程序",
      onPrimary: async () => {
        const yes = await askYesNo(
          "进入抽号程序",
          "进入抽号程序将关闭当前设置窗口，是否继续？"
        );
        if (yes) {
          try {
            await api.setFirstRunDone("settings");
            await api.switchApp();
          } catch (e) {
            showToast(`切换失败: ${e}`, "error");
          }
        }
      },
    },
  ], []);

  // 组件卸载时清理定时器（toast 由 useToast 自行清理）
  useEffect(() => {
    return () => {
      if (authTimer.current) window.clearTimeout(authTimer.current);
    };
  }, []);

  // ── 登录验证界面 ──

  if (!authorized) {
    return (
      <div className="app settings-app">
        <div className="settings-usb-gate">
          <div className="settings-gate-card">
            <h2 className="settings-gate-title">
              {hasRegistered ? "验证授权 U 盘" : "首次使用"}
            </h2>
            <p className="settings-gate-desc">
              {hasRegistered
                ? "插入已注册的 U 盘，点击验证。"
                : "插入 U 盘注册授权，或先跳过进入设置。"}
            </p>

            {checking ? (
              <p className="settings-gate-loading">验证中…</p>
            ) : (
              <>
                <div className="settings-gate-status">
                  <span className={`pill${hasRegistered ? "" : " warn"}`}>
                    {hasRegistered ? "已注册授权U盘" : "尚未注册授权U盘"}
                  </span>
                </div>

                {hasRegistered ? (
                  // 已注册：只保留验证入口
                  <div className="settings-gate-actions">
                    <button
                      className="settings-btn primary settings-gate-main-btn"
                      onClick={handleVerifyUsb}
                    >
                      验证U盘
                    </button>
                  </div>
                ) : (
                  // 未注册：突出一个主动作，其余折叠
                  <>
                    <button
                      className="settings-btn primary settings-gate-main-btn"
                      onClick={handleAutoRegister}
                      disabled={isRegistering}
                    >
                      {isRegistering ? "注册中…" : "自动检测并注册U盘"}
                    </button>

                    {availableDrives.length > 0 && (
                      <div className="settings-drive-row">
                        <span>或选择指定U盘</span>
                        <select
                          className="settings-sel"
                          value={selectedDrive}
                          onChange={e => setSelectedDrive(e.target.value)}
                        >
                          {availableDrives.map(d => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                        <button
                          className="settings-btn secondary"
                          onClick={handleRegisterUsb}
                          disabled={!selectedDrive || isRegistering}
                        >
                          注册所选
                        </button>
                      </div>
                    )}

                    <button
                      className="settings-gate-skip-link"
                      onClick={() => setAuthorized(true)}
                    >
                      跳过，先进入设置 →
                    </button>
                  </>
                )}

                {usbMessage && (
                  <p className={`settings-gate-message${availableDrives.length === 0 && !checking ? " warning" : ""}`}>
                    {usbMessage}
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        <Toast toast={toast} />
        {dialogNode}
        {promptDialogNode}
      </div>
    );
  }

  // ── 设置主界面 ──

  // 加载中显示 loading 状态；加载失败时显示错误与重试按钮
  if (!modes) {
    if (settingsLoading && !settingsLoadError) {
      return (
        <div className="app settings-app">
          <div className="settings-usb-gate">
            <div className="settings-gate-card">
              <h2 className="settings-gate-title">设置</h2>
              <p className="settings-gate-loading">
                {registerSuccess ? "注册成功，正在加载设置..." : "正在加载设置..."}
              </p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="app settings-app">
        <div className="settings-usb-gate">
          <div className="settings-gate-card">
            <h2 className="settings-gate-title">设置</h2>
            <p className="settings-gate-message error" style={{ marginBottom: 12 }}>
              {settingsLoadError || "设置加载失败，请检查程序状态后重试。"}
            </p>
            <button className="settings-btn primary" onClick={loadAllSettings} disabled={settingsLoading}>
              重新加载设置
            </button>
          </div>
        </div>
      </div>
    );
  }

  const allModes = modes
    ? modes.back.map((b, i) => ({ back: b, front: modes.front[i] })).concat([
        { back: modes.mode5_back, front: modes.mode5_front },
      ])
    : [];

  return (
    <div className="app settings-app">
      {settingsLoadError && (
        <div className="settings-load-error">
          <strong>部分设置加载失败</strong>
          <div>{settingsLoadError}</div>
          <button
            className="settings-btn secondary"
            onClick={loadAllSettings}
            disabled={settingsLoading}
            style={{ marginTop: 10 }}
          >
            重新加载设置
          </button>
        </div>
      )}
      <div className="settings-header">
        <button
          className="settings-btn secondary settings-back-btn"
          onClick={async () => {
            const yes = await askYesNo(
              "返回抽号",
              "返回抽号程序将关闭当前设置窗口，是否继续？"
            );
            if (yes) {
              try {
                await api.switchApp();
              } catch (e) {
                showToast(`切换失败: ${e}`, "error");
              }
            }
          }}
        >
          返回抽号
        </button>
        <h1 className="settings-title">设置</h1>
        <ThemeToggle value={theme} onChange={setTheme} />
      </div>

      <div className="settings-scroll">
        {/* 名单导入 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">导入名单</h3>
          <p className="settings-card-desc">从 CSV / Excel 导入，按性别覆盖写入当前名单（需含 号码、姓名、性别 三列）</p>

          <div className="settings-row settings-actions-row" data-tour="import-file-btn">
            <button className="settings-btn secondary" onClick={handleSelectNameFile}>
              选择名单文件
            </button>
          </div>

          {importPreview && (
            <div className="settings-import-preview">
              <div className="settings-row settings-row-mb-sm">
                <span className="settings-lbl">格式</span>
                <span>{importPreview.format.toUpperCase()}（{importPreview.header ? "含表头" : "无表头"}）</span>
              </div>
              <div className="settings-row settings-row-mb-sm">
                <span className="settings-lbl">男生</span>
                <span>{importPreview.boys.length} 人</span>
                <span className="settings-cb-gap" />
                <span className="settings-lbl">女生</span>
                <span>{importPreview.girls.length} 人</span>
              </div>
              <div className="settings-row settings-actions-row">
                <button
                  className="settings-btn primary"
                  onClick={handleConfirmImportNames}
                  disabled={nameImporting}
                >
                  {nameImporting ? "写入中…" : "确认覆盖"}
                </button>
                <button
                  className="settings-btn secondary"
                  onClick={() => setImportPreview(null)}
                  disabled={nameImporting}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 显示格式 */}
        <div className="card settings-card" data-tour="display-format">
          <h3 className="settings-card-title">结果显示格式</h3>
          <p className="settings-card-desc">抽号结果的主显示内容（动画滚动时同样生效）</p>
          <div className="settings-row">
            <button
              className={`settings-btn${displayFormat === "number" ? " primary" : " secondary"}`}
              onClick={() => handleDisplayFormatChange("number")}
            >
              仅号码
            </button>
            <button
              className={`settings-btn${displayFormat === "name" ? " primary" : " secondary"}`}
              onClick={() => handleDisplayFormatChange("name")}
            >
              仅姓名
            </button>
            <button
              className={`settings-btn${displayFormat === "number_name" ? " primary" : " secondary"}`}
              onClick={() => handleDisplayFormatChange("number_name")}
            >
              号码 + 姓名
            </button>
          </div>
        </div>

        {/* 下课时间 */}
        <div className="card settings-card" data-tour="time-ranges">
          <h3 className="settings-card-title">下课时间</h3>
          <p className="settings-card-desc">禁用时段内仅勾选的「免验证模式」可直接抽号，其余模式需验证U盘</p>

          <div className="settings-row settings-row-mb-sm">
            <span className="settings-lbl">免验证模式</span>
            {allModes.map(m => (
              <label key={m.back} className="settings-cb">
                <input
                  type="checkbox"
                  checked={breakAllowModes.includes(m.back)}
                  onChange={() => handleToggleBreakAllow(m.back)}
                />
                <span>{m.front}</span>
              </label>
            ))}
          </div>

          {editingRanges.map((r, i) => (
            <div key={i} className="settings-row settings-row-mb-sm">
              <span className="settings-lbl">时段{i + 1}</span>
              <input
                className={`settings-inp${rangeInputErrors[`${i}-h1`] ? " invalid" : ""}`}
                value={rangeRawInputs[`${i}-h1`] ?? String(r.h1)}
                onChange={e => handleRangeChange(i, "h1", e.target.value)}
                onBlur={() => handleRangeBlur(i, "h1")}
                inputMode="numeric"
              />
              <span className="settings-time-sep">:</span>
              <input
                className={`settings-inp${rangeInputErrors[`${i}-m1`] ? " invalid" : ""}`}
                value={rangeRawInputs[`${i}-m1`] ?? String(r.m1)}
                onChange={e => handleRangeChange(i, "m1", e.target.value)}
                onBlur={() => handleRangeBlur(i, "m1")}
                inputMode="numeric"
              />
              <span className="settings-time-to">至</span>
              <input
                className={`settings-inp${rangeInputErrors[`${i}-h2`] ? " invalid" : ""}`}
                value={rangeRawInputs[`${i}-h2`] ?? String(r.h2)}
                onChange={e => handleRangeChange(i, "h2", e.target.value)}
                onBlur={() => handleRangeBlur(i, "h2")}
                inputMode="numeric"
              />
              <span className="settings-time-sep">:</span>
              <input
                className={`settings-inp${rangeInputErrors[`${i}-m2`] ? " invalid" : ""}`}
                value={rangeRawInputs[`${i}-m2`] ?? String(r.m2)}
                onChange={e => handleRangeChange(i, "m2", e.target.value)}
                onBlur={() => handleRangeBlur(i, "m2")}
                inputMode="numeric"
              />
              <button
                className="settings-btn secondary settings-inline-btn"
                onClick={() => handleRemoveRange(i)}
              >
                删除
              </button>
            </div>
          ))}

          <div className="settings-row settings-actions-row">
            <button className="settings-btn secondary" onClick={handleAddRange}>
              添加时间段
            </button>
            {rangesDirty && (
              <>
                <button className="settings-btn primary" onClick={handleSaveRanges}>
                  保存时间设置
                </button>
                <button
                  className="settings-btn secondary"
                  onClick={() => {
                    setEditingRanges(timeRanges.map(r => ({ ...r })));
                    setRangeRawInputs({});
                    setRangeInputErrors({});
                    setRangesDirty(false);
                  }}
                >
                  取消
                </button>
              </>
            )}
          </div>

          <div className="settings-time-import">
            <p className="settings-card-desc settings-sub-desc">从文本导入（可选）</p>
            <textarea
              className="settings-textarea"
              rows={2}
              placeholder="例如：08:00-12:00, 14:00-17:30"
              value={timeImportText}
              onChange={(e) => setTimeImportText(e.target.value)}
            />
            <div className="settings-row settings-actions-row">
              <button className="settings-btn secondary" onClick={handleImportTimeText}>
                从文本导入
              </button>
            </div>
          </div>
        </div>

        {/* U盘管理 */}
        <div className="card settings-card" data-tour="usb-settings">
          <h3 className="settings-card-title">U盘管理</h3>
          <p className="settings-card-desc">管理授权U盘（基于硬件序列号加密验证）</p>

          <div className="settings-usb-badge">
            <span className={`pill${hasRegistered ? "" : " warn"}`}>
              {hasRegistered ? "已注册授权U盘" : "未注册"}
            </span>
          </div>

          <div className="settings-row">
            <button
              className="settings-btn secondary"
              onClick={() => handleRefreshDrives()}
            >
              刷新驱动器
            </button>
            {availableDrives.length > 0 && (
              <select
                className="settings-sel"
                value={selectedDrive}
                onChange={e => setSelectedDrive(e.target.value)}
              >
                {availableDrives.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            )}
            <button
              className="settings-btn primary"
              onClick={handleRegisterUsb}
              disabled={!selectedDrive || isRegistering}
            >
              注册为授权U盘
            </button>
          </div>
        </div>

        {/* U盘验证有效期 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">U盘验证有效期</h3>
          <p className="settings-card-desc">禁用时段内通过U盘验证后，有效期范围</p>

          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="radio"
                name="usbVerifyScope"
                checked={usbVerifyScope === "current_break"}
                onChange={() => handleSaveUsbScope("current_break")}
              />
              <span>仅当前禁用时段有效（默认）</span>
            </label>
          </div>
          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="radio"
                name="usbVerifyScope"
                checked={usbVerifyScope === "permanent"}
                onChange={() => handleSaveUsbScope("permanent")}
              />
              <span>永久有效（程序运行期间一直有效）</span>
            </label>
          </div>
        </div>

        {/* 座位表方向 */}
        <div className="card settings-card" data-tour="seat-direction">
          <h3 className="settings-card-title">座位表方向</h3>
          <p className="settings-card-desc">高级抽号座位表列标头顺序（分组逻辑不变）</p>

          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="radio"
                name="seatDirection"
                checked={seatDirection === "rtl"}
                onChange={() => handleSaveSeatDirection("rtl")}
              />
              <span>从右到左（默认）</span>
            </label>
          </div>
          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="radio"
                name="seatDirection"
                checked={seatDirection === "ltr"}
                onChange={() => handleSaveSeatDirection("ltr")}
              />
              <span>从左到右</span>
            </label>
          </div>
        </div>

        {/* 暗痕设置 */}
        <div className="card settings-card" data-tour="ahen-settings">
          <h3 className="settings-card-title">暗痕设置</h3>
          <p className="settings-card-desc">当抽到指定号码时，动画过程显示为另一个预设号码</p>

          {editingAhen && (
            <>
              <div className="settings-row settings-row-mb">
                <label className="settings-cb">
                  <input
                    type="checkbox"
                    checked={editingAhen.enabled}
                    onChange={e => handleAhenChange("enabled", e.target.checked)}
                  />
                  <span>启用暗痕</span>
                </label>
                <span className="settings-cb-gap" />
                <label className="settings-cb">
                  <input
                    type="checkbox"
                    checked={editingAhen.only_break}
                    onChange={e => handleAhenChange("only_break", e.target.checked)}
                  />
                  <span>仅在禁用时段生效</span>
                </label>
              </div>

              <p className="settings-card-desc settings-sub-desc">
                替换规则（抽到号码 → 显示号码）
              </p>

              {Object.entries(editingAhen.triggers).map(([key, val]) => (
                <div key={key} className="settings-row settings-row-mb-xs">
                  <input
                    className="settings-inp"
                    placeholder="抽到"
                    value={key.startsWith("__new_") ? "" : key}
                    onChange={e => {
                      const newKey = e.target.value;
                      handleTriggerChange(key, newKey, val);
                    }}
                  />
                  <span className="settings-arrow">→</span>
                  <input
                    className="settings-inp"
                    placeholder="显示"
                    value={val}
                    onChange={e => handleTriggerChange(key, key, e.target.value)}
                  />
                  <button
                    className="settings-btn secondary settings-inline-btn"
                    onClick={() => handleRemoveTrigger(key)}
                  >
                    删除
                  </button>
                </div>
              ))}

              <div className="settings-row settings-actions-row">
                <button className="settings-btn secondary" onClick={handleAddTrigger}>
                  添加替换规则
                </button>
                {ahenDirty && (
                  <>
                    <button className="settings-btn primary" onClick={handleSaveAhen}>
                      保存暗痕设置
                    </button>
                    <button
                      className="settings-btn secondary"
                      onClick={() => {
                        if (ahenConfig) {
                          setEditingAhen(JSON.parse(JSON.stringify(ahenConfig)));
                          setAhenDirty(false);
                        }
                      }}
                    >
                      取消
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* 名单管理 */}
        <div className="card settings-card" data-tour="import-students">
          <h3 className="settings-card-title">名单管理</h3>
          <p className="settings-card-desc">
            当前名单：<b>{activeRoster || "—"}</b>。切换名单会清空抽号记录。导入名单会写入当前名单。
          </p>

          <div className="roster-list">
            {rosterNames.map(name => (
              <div
                key={name}
                className={`roster-item${name === activeRoster ? " active" : ""}`}
              >
                <button
                  className="roster-name-btn"
                  onClick={() => handleSwitchRoster(name)}
                  title={name === activeRoster ? "当前名单" : "点击切换到此名单"}
                >
                  {name}
                  {name === activeRoster && <span className="roster-active-tag">当前</span>}
                </button>
                <div className="roster-actions">
                  <button
                    className="roster-action-btn"
                    onClick={() => handleRenameRoster(name)}
                    title="重命名"
                  >
                    重命名
                  </button>
                  <button
                    className="roster-action-btn"
                    onClick={() => handleDuplicateRoster(name)}
                    title="复制"
                  >
                    复制
                  </button>
                  <button
                    className="roster-action-btn danger"
                    onClick={() => handleDeleteRoster(name)}
                    title="删除"
                    disabled={rosterNames.length <= 1}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="settings-row settings-actions-row">
            <button className="settings-btn secondary" onClick={handleCreateRoster}>
              新建名单
            </button>
          </div>
        </div>

        {/* 模式名称 + 内存模式 */}
        <div className="card settings-card settings-card-split">
          <div className="settings-card-half">
            <h3 className="settings-card-title">模式名称</h3>
            <p className="settings-card-desc">修改显示名称</p>

            {editingNames.map((name, i) => (
              <div key={i} className="settings-row settings-row-mb">
                <span className="settings-name-lbl">{allModes[i]?.front || `模式${i + 1}`}</span>
                <input
                  className="input settings-input-text"
                  value={name}
                  onChange={e => handleNameChange(i, e.target.value)}
                />
              </div>
            ))}

            {namesDirty && (
              <div className="settings-row settings-actions-row">
                <button className="settings-btn primary" onClick={handleSaveNames}>
                  保存名称
                </button>
                <button
                  className="settings-btn secondary"
                  onClick={() => {
                    if (modes) {
                      setEditingNames([...modes.front]);
                      setNamesDirty(false);
                    }
                  }}
                >
                  取消
                </button>
              </div>
            )}
          </div>

          <div className="settings-card-half">
            <h3 className="settings-card-title">内存模式</h3>
            <p className="settings-card-desc">关闭程序后自动清除</p>

            {memoryStatuses.map(s => (
              <div key={s.mode_back} className="settings-row settings-row-mb-sm">
                <label
                  className="settings-cb"
                  style={s.forced ? { opacity: 0.55, cursor: "not-allowed" } : {}}
                >
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={s.forced}
                    onChange={e => handleMemoryModeToggle(s.mode_back, e.target.checked, s.forced)}
                  />
                  <span>{s.mode_front}{s.forced ? "（强制）" : ""}</span>
                </label>
              </div>
            ))}
          </div>
        </div>

        {/* 清空记录 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">清空记录</h3>
          <p className="settings-card-desc">选择模式后点击清空</p>

          <div className="settings-clear-row">
            <div className="chip-row settings-chip-row">
              {allModes.map(({ back, front }) => (
                <button
                  key={back}
                  className={`chip${selectedClearBacks.has(back) ? " selected" : ""}`}
                  onClick={() => toggleClearBack(back)}
                >
                  {front}
                </button>
              ))}
            </div>
            <button
              className="settings-btn primary settings-clear-btn"
              disabled={selectedClearBacks.size === 0}
              onClick={handleClearSelected}
            >
              清空选中
            </button>
          </div>
        </div>

        {/* 记录过期管理 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">记录过期管理</h3>
          <p className="settings-card-desc">
            设置自动清理保留天数。设为 0 表示不自动清理。程序启动时会自动清理超过指定天数的记录。
          </p>
          <div className="settings-row" style={{ flexWrap: "wrap", gap: 8 }}>
            <label className="settings-cb" style={{ gap: 6 }}>
              <span>保留</span>
              <input
                type="number"
                min={0}
                max={3650}
                value={editingExpireDays}
                onChange={(e) => handleExpireDaysInput(e.target.value)}
                style={{ width: 80 }}
              />
              <span>天（0=不清理）</span>
            </label>
            <button
              className="settings-btn primary"
              disabled={!expireDirty}
              onClick={handleSaveExpireDays}
            >
              保存
            </button>
            <button
              className="settings-btn secondary"
              onClick={handlePurgeNow}
            >
              立即清理
            </button>
          </div>
        </div>

        {/* 系统设置：自启 + 重启 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">系统</h3>
          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="checkbox"
                checked={autostartEnabled}
                onChange={handleAutostartToggle}
              />
              <span>开机自启动</span>
            </label>
          </div>
          <div className="settings-row settings-actions-row">
            <button className="settings-btn secondary" onClick={handleRestart}>
              重启程序
            </button>
          </div>
        </div>

        {/* 抽号参数范围 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">抽号参数范围</h3>
          <p className="settings-card-desc">主界面“最大号码”与“抽号数量”的合法区间（锁在设置页）</p>

          <div className="settings-row settings-row-mb">
            <span className="settings-lbl">最大号码</span>
            <span className="settings-time-sep">下限</span>
            <input
              className={`settings-inp${numLimitError.min ? " invalid" : ""}`}
              value={numLimitRaw.min ?? String(editingNumLimits.min)}
              onChange={e => handleLimitChange("num", "min", e.target.value.replace(/\D/g, ""))}
              onBlur={() => handleLimitBlur("num", "min")}
              inputMode="numeric"
            />
            <span className="settings-time-to">上限</span>
            <input
              className={`settings-inp${numLimitError.max ? " invalid" : ""}`}
              value={numLimitRaw.max ?? String(editingNumLimits.max)}
              onChange={e => handleLimitChange("num", "max", e.target.value.replace(/\D/g, ""))}
              onBlur={() => handleLimitBlur("num", "max")}
              inputMode="numeric"
            />
          </div>
          <div className="settings-row settings-row-mb">
            <span className="settings-lbl">抽号数量</span>
            <span className="settings-time-sep">下限</span>
            <input
              className={`settings-inp${qtyLimitError.min ? " invalid" : ""}`}
              value={qtyLimitRaw.min ?? String(editingQtyLimits.min)}
              onChange={e => handleLimitChange("qty", "min", e.target.value.replace(/\D/g, ""))}
              onBlur={() => handleLimitBlur("qty", "min")}
              inputMode="numeric"
            />
            <span className="settings-time-to">上限</span>
            <input
              className={`settings-inp${qtyLimitError.max ? " invalid" : ""}`}
              value={qtyLimitRaw.max ?? String(editingQtyLimits.max)}
              onChange={e => handleLimitChange("qty", "max", e.target.value.replace(/\D/g, ""))}
              onBlur={() => handleLimitBlur("qty", "max")}
              inputMode="numeric"
            />
          </div>

          <div className="settings-row settings-actions-row">
            {limitsDirty ? (
              <>
                <button className="settings-btn primary" onClick={handleSaveLimits}>
                  保存参数范围
                </button>
                <button
                  className="settings-btn secondary"
                  onClick={() => {
                    setEditingNumLimits({ ...numberLimits });
                    setEditingQtyLimits({ ...quantityLimits });
                    setNumLimitRaw({});
                    setNumLimitError({});
                    setQtyLimitRaw({});
                    setQtyLimitError({});
                    setLimitsDirty(false);
                  }}
                >
                  取消
                </button>
              </>
            ) : (
              <span className="settings-card-desc">
                当前：号码 {numberLimits.min}-{numberLimits.max}，数量 {quantityLimits.min}-{quantityLimits.max}
              </span>
            )}
          </div>
        </div>

        {/* 数据迁移 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">数据迁移</h3>
          <p className="settings-card-desc">导出备份 / 从备份恢复（勾选需要的数据项）</p>

          <p className="settings-card-desc settings-sub-desc">导出</p>
          <div className="settings-row settings-row-mb-sm settings-cb-wrap">
            {(["settings", "students", "seatmap", "records"] as const).map(item => (
              <label key={item} className="settings-cb">
                <input
                  type="checkbox"
                  checked={exportItems.has(item)}
                  onChange={() => toggleExportItem(item)}
                />
                <span>{MIGRATION_LABELS[item]}</span>
              </label>
            ))}
          </div>
          <div className="settings-row settings-actions-row">
            <button
              className="settings-btn primary"
              onClick={handleExport}
              disabled={exportItems.size === 0}
            >
              导出所选
            </button>
          </div>

          <p className="settings-card-desc settings-sub-desc">恢复</p>
          <div className="settings-row settings-actions-row">
            <button className="settings-btn secondary" onClick={handleSelectBackup}>
              选择备份文件
            </button>
          </div>

          {importPreviewData && (
            <div className="settings-import-preview">
              {importPreviewData.checksum_status === "valid" && (
                <div className="settings-checksum-ok">
                  完整性校验通过
                </div>
              )}
              {importPreviewData.checksum_status === "invalid" && (
                <div className="settings-checksum-fail">
                  完整性校验失败：文件可能已损坏，无法恢复
                </div>
              )}
              {importPreviewData.checksum_status === "none" && (
                <div className="settings-checksum-none">
                  旧版备份文件（无校验和）
                </div>
              )}
              {importPreviewData.has_settings && (
                <label className="settings-cb settings-row-mb-xs">
                  <input
                    type="checkbox"
                    checked={importItems.has("settings")}
                    onChange={() => toggleImportItem("settings")}
                  />
                  <span>全部设置（{importPreviewData.settings_count} 项）</span>
                </label>
              )}
              {importPreviewData.has_students && (
                <label className="settings-cb settings-row-mb-xs">
                  <input
                    type="checkbox"
                    checked={importItems.has("students")}
                    onChange={() => toggleImportItem("students")}
                  />
                  <span>学生名单（男 {importPreviewData.boys_count} / 女 {importPreviewData.girls_count}）</span>
                </label>
              )}
              {importPreviewData.has_seatmap && (
                <label className="settings-cb settings-row-mb-xs">
                  <input
                    type="checkbox"
                    checked={importItems.has("seatmap")}
                    onChange={() => toggleImportItem("seatmap")}
                  />
                  <span>座位表</span>
                </label>
              )}
              {importPreviewData.has_records && (
                <label className="settings-cb settings-row-mb-xs">
                  <input
                    type="checkbox"
                    checked={importItems.has("records")}
                    onChange={() => toggleImportItem("records")}
                  />
                  <span>抽号记录（{importPreviewData.records.map(r => `${r[0]}:${r[1]}`).join("、")}）</span>
                </label>
              )}
              <div className="settings-row settings-actions-row">
                <button
                  className="settings-btn primary"
                  onClick={handleConfirmImport}
                  disabled={importItems.size === 0 || importPreviewData.checksum_status === "invalid"}
                >
                  恢复所选
                </button>
                <button
                  className="settings-btn secondary"
                  onClick={() => {
                    setImportPath(null);
                    setImportPreviewData(null);
                    setImportItems(new Set());
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 数据目录 */}
        <div className="card settings-card">
          <h3 className="settings-card-title">数据目录</h3>
          <p className="settings-card-desc">
            数据默认保存在程序同目录，便于便携使用。切换后需重启生效。
          </p>

          {dataDirInfo?.overridden_by_env && (
            <p className="settings-gate-message warning">
              开发模式：当前由 NS_DATA_DIR 环境变量覆盖，设置已禁用。
            </p>
          )}

          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="radio"
                name="dataDir"
                value="portable"
                checked={dataDirKind === "portable"}
                disabled={dataDirInfo?.overridden_by_env}
                onChange={() => setDataDirKind("portable")}
              />
              <span>程序同目录（便携）</span>
            </label>
          </div>
          {dataDirInfo && (
            <div className="settings-card-desc settings-sub-desc settings-dir-path" style={{ marginLeft: 24 }}>
              {dataDirInfo.portable_path}
            </div>
          )}

          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="radio"
                name="dataDir"
                value="app_data"
                checked={dataDirKind === "app_data"}
                disabled={dataDirInfo?.overridden_by_env}
                onChange={() => setDataDirKind("app_data")}
              />
              <span>系统应用数据目录</span>
            </label>
          </div>
          {dataDirInfo && (
            <div className="settings-card-desc settings-sub-desc settings-dir-path" style={{ marginLeft: 24 }}>
              {dataDirInfo.app_data_path}
            </div>
          )}

          <div className="settings-row settings-row-mb-sm">
            <label className="settings-cb">
              <input
                type="radio"
                name="dataDir"
                value="custom"
                checked={dataDirKind === "custom"}
                disabled={dataDirInfo?.overridden_by_env}
                onChange={() => setDataDirKind("custom")}
              />
              <span>自定义目录</span>
            </label>
          </div>
          <div className="settings-row settings-row-mb-sm" style={{ marginLeft: 24, gap: 8 }}>
            <input
              className="settings-inp"
              style={{ flex: 1 }}
              value={customDirPath}
              readOnly
              placeholder="点击右侧按钮选择文件夹"
            />
            <button
              className="settings-btn secondary"
              onClick={handleSelectCustomDir}
              disabled={dataDirInfo?.overridden_by_env}
            >
              选择文件夹
            </button>
          </div>

          {dataDirInfo && (
            <div className="settings-row settings-row-mb-sm">
              <span className="settings-card-desc settings-sub-desc settings-dir-path">
                当前生效：{dataDirInfo.path}
              </span>
            </div>
          )}

          <div className="settings-row settings-actions-row">
            <button
              className="settings-btn primary"
              onClick={handleSaveDataDir}
              disabled={dataDirInfo?.overridden_by_env}
            >
              保存目录设置
            </button>
          </div>
        </div>

        {/* 底部间距 */}
        <div style={{ height: 40 }} />
      </div>

      <Toast toast={toast} />
      {dialogNode}
      {promptDialogNode}

      {/* 首次引导 */}
      {!firstRunDone && (
        <Guide
          steps={settingsGuideSteps}
          currentStep={settingsGuideStep}
          onStepChange={setSettingsGuideStep}
          onComplete={() => {
            setFirstRunDone(true);
            api.setFirstRunDone("settings");
          }}
        />
      )}
    </div>
  );
}

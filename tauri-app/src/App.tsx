import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api, ModesPayload, Student, NumberLimits, QuantityLimits } from "./api";
import StandaloneAdvancedDraw from "./StandaloneAdvancedDraw";
import SettingsApp from "./Settings";
import Guide, { GuideStep } from "./Guide";
import { useTheme } from "./useTheme";
import { useWindowState } from "./useWindowState";
import ThemeToggle from "./ThemeToggle";
import { useToast } from "./useToast";
import { useDialog } from "./useDialog";
import { Toast } from "./Toast";
import { YesNoDialog } from "./Dialog";
import { useEscToClose } from "./useEscToClose";
import { logEvent, logDebug } from "./logger";
import { installDiagnostics } from "./diagnostics";
import { withTimeout } from "./api";

const MODE5_BACK = "Mode5";

// ── 路由 ──
export default function App() {
  const search = window.location.search;

  // 全局诊断（点击命中 / 可见性 / 定时器心跳 / 未捕获异常）→ app.log
  useEffect(() => {
    installDiagnostics();
  }, []);

  // 高级抽号窗口
  if (search.includes("view=advanced")) {
    return <StandaloneAdvancedDraw />;
  }

  // 设置窗口（开发模式下 switch_app 通过 navigate 切换视图）
  if (search.includes("view=settings")) {
    return <SettingsApp />;
  }

  // 生产模式：由 Rust 端根据启动参数决定视图
  return <AppRouter />;
}

/** 检查启动视图的包装组件（通过后端命令获取） */
function AppRouter() {
  const [view, setView] = useState<"draw" | "settings" | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const startupView = await invoke<string>("get_startup_view");
        setView(startupView === "settings" ? "settings" : "draw");
      } catch (e) {
        console.warn("[AppRouter] get_startup_view failed:", e);
        setView("draw");
      }
    })();
  }, []);

  if (view === "settings") {
    return <SettingsApp />;
  }

  if (view === null) {
    return (
      <div className="app" style={{ alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "var(--text-hint)" }}>加载中…</span>
      </div>
    );
  }

  return <MainApp />;
}

function MainApp() {
  const [modes, setModes] = useState<ModesPayload | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [memoryModes, setMemoryModes] = useState<Set<string>>(new Set());
  const [firstRunDone, setFirstRunDone] = useState(true);
  const { theme, setTheme } = useTheme();

  const [backMode, setBackMode] = useState<string | null>(null);
  const [maxNum, setMaxNum] = useState<string>("50");
  const [qty, setQty] = useState<string>("1");
  const [gender, setGender] = useState<"boy" | "girl" | null>(null);

  // 抽号参数范围（来自设置页，默认 1-100 / 1-5）
  const [numberLimits, setNumberLimits] = useState<NumberLimits>({ min: 1, max: 100 });
  const [quantityLimits, setQuantityLimits] = useState<QuantityLimits>({ min: 1, max: 5 });

  const [inBreak, setInBreak] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifyingUsb, setVerifyingUsb] = useState(false);
  // 触屏点按后 :hover 会残留在最后一个元素上，跟踪指针类型，触屏时关掉 hover 灰底
  const [touchPointer, setTouchPointer] = useState(false);
  const trackPointer = (e: ReactPointerEvent) => {
    const touch = e.pointerType !== "mouse";
    setTouchPointer((prev) => (prev === touch ? prev : touch));
  };
  // 禁用时段内免 U 盘验证可用的模式（back 名称）
  const [breakAllow, setBreakAllow] = useState<string[]>(["Mode5"]);
  const [usbVerifyOpen, setUsbVerifyOpen] = useState(false);
  const [usbVerifyScope, setUsbVerifyScope] = useState<"current_break" | "permanent">("current_break");

  // 抽号结果显示
  const [displayNum, setDisplayNum] = useState<string>("");
  const [displayName, setDisplayName] = useState<string>("");
  const [displayGender, setDisplayGender] = useState<"boy" | "girl" | "">("");
  const [pulseKey, setPulseKey] = useState(0);
  const [drawing, setDrawing] = useState(false);

  // toast / dialog
  const { toast, showToast } = useToast();
  const { dialog, setDialog, askYesNo } = useDialog();

  // 记录公示面板
  const [showRecords, setShowRecords] = useState(false);

  // 全屏 / 置顶
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isTopmost, setIsTopmost] = useState(false);

  // 显示格式：number / name / number_name
  const [displayFormat, setDisplayFormat] = useState<"number" | "name" | "number_name">("number_name");

  // 右上角菜单
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [drawGuideStep, setDrawGuideStep] = useState(0);

  const animTimers = useRef<number[]>([]);
  // 防止 handleStart 在 React 状态更新延迟期间（如按住 Enter 键 repeat）被重复调用
  const drawingRef = useRef(false);

  // USB 验证模态 Esc 关闭
  const usbVerifyMaskRef = useRef<HTMLDivElement>(null);
  useEscToClose(usbVerifyOpen, () => setUsbVerifyOpen(false), usbVerifyMaskRef);

  // 学生编号 -> 信息映射
  const stuMap = useMemo(() => {
    const m = new Map<number, Student>();
    students.forEach((s) => m.set(s.number, s));
    return m;
  }, [students]);

  const { boysCount, girlsCount } = useMemo(() => {
    let boys = 0, girls = 0;
    for (const s of students) {
      if (s.gender === "boy") boys++;
      else if (s.gender === "girl") girls++;
    }
    return { boysCount: boys, girlsCount: girls };
  }, [students]);

  // 初始化
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, mem, st, ib, scope, nl, ql, frd, df, bam] = await Promise.all([
          api.getModes(),
          api.getMemoryModes(),
          api.getStudents(),
          api.isInForbidRange(),
          api.getUsbVerifyScope(),
          api.getNumberLimits(),
          api.getQuantityLimits(),
          api.getFirstRunDone("draw"),
          api.getDisplayFormat(),
          api.getBreakAllowModes().catch(() => ["Mode5"] as string[]),
        ]);
        if (cancelled) return;
        setModes(m);
        setMemoryModes(new Set(mem));
        setStudents(st);
        setInBreak(ib);
        setBreakAllow(bam);
        setUsbVerifyScope(scope === "permanent" ? "permanent" : "current_break");
        setNumberLimits(nl);
        setQuantityLimits(ql);
        setFirstRunDone(frd);
        setDisplayFormat(
          df === "number" || df === "name" || df === "number_name" ? df : "number_name"
        );
        logDebug(
          "init",
          `初始化完成：模式=${m.front.length + 1} 学生=${st.length}(男${st.filter((s) => s.gender === "boy").length}/女${st.filter((s) => s.gender === "girl").length}) 禁用时段=${ib} firstRunDone=${frd} 显示格式=${df}`,
        );
      } catch (e) {
        if (!cancelled) {
          logEvent("init", `初始化失败: ${e}`);
          showToast(`初始化失败: ${e}`, "error");
        }
      }
    })();

    let pollFailStreak = 0;
    let pollBusy = false;
    // 上次见到的数据版本号：设置端（独立进程）改名单/参数后版本号变化，据此重拉数据
    let lastDataVersion: number | null = null;
    const poll = window.setInterval(async () => {
      if (pollBusy) return; // 上一轮未完成时跳过，避免请求逐秒堆积
      pollBusy = true;
      try {
        const [ib, sessionVerified, version] = await Promise.all([
          api.isInForbidRange(),
          api.isUsbSessionVerified(),
          api.getDataVersion().catch(() => null),
        ]);
        if (cancelled) return;
        if (pollFailStreak > 0) {
          logEvent("poll", `状态轮询恢复（此前连续失败 ${pollFailStreak} 次）`);
          pollFailStreak = 0;
        }
        setInBreak(ib);
        setVerified(sessionVerified);

        if (version !== null && lastDataVersion !== null && version !== lastDataVersion) {
          // 设置端修改了名单/内存模式/参数范围/模式名，重新拉取
          logEvent("poll", `检测到数据版本变化 ${lastDataVersion} → ${version}，重新加载数据`);
          try {
            const [m, mem, st, nl, ql] = await Promise.all([
              api.getModes(),
              api.getMemoryModes(),
              api.getStudents(),
              api.getNumberLimits(),
              api.getQuantityLimits(),
            ]);
            if (cancelled) return;
            setModes(m);
            setMemoryModes(new Set(mem));
            setStudents(st);
            setNumberLimits(nl);
            setQuantityLimits(ql);
          } catch (e) {
            logEvent("poll", `数据重载失败: ${e}`, "warn");
          }
        }
        if (version !== null) lastDataVersion = version;
      } catch (e) {
        pollFailStreak++;
        if (pollFailStreak === 1 || pollFailStreak % 30 === 0) {
          logEvent("poll", `状态轮询连续失败 ${pollFailStreak} 次：${e}`, "warn");
        }
      } finally {
        pollBusy = false;
      }
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      animTimers.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  // 监听主窗口最小化 → 显示悬浮窗，并保存窗口状态
  useWindowState("draw", () => {
    invoke("main_minimize_to_float").catch((e) => {
      console.warn("[float] main_minimize_to_float failed:", e);
    });
  });

  // 处于禁用时段且未验证时，若当前选中的非免验证模式应被自动取消
  useEffect(() => {
    if (inBreak && !verified && backMode && !breakAllow.includes(backMode)) {
      logEvent("lock", `进入禁用时段且未验证U盘，自动取消模式选择: ${backMode}`);
      showToast("已进入禁用时段，模式选择已取消（验证U盘后可重新选择）", "warning");
      setBackMode(null);
    }
  }, [inBreak, verified, backMode, breakAllow, showToast]);

  // 点击右下角「更多」菜单外部或按 Esc 关闭
  useEffect(() => {
    if (!moreMenuOpen) return;
    function onClick(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreMenuOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreMenuOpen]);

  // 模式禁用判断（禁用时段内非免验证模式需要 U 盘验证）
  const isModeLocked = (backName: string) =>
    inBreak && !verified && !breakAllow.includes(backName);

  // 禁用时段内免验证模式的中文名（状态条与提示文案用）
  const breakAllowNames = useMemo(() => {
    if (!modes) return [];
    const names: string[] = [];
    modes.front.forEach((front, i) => {
      if (breakAllow.includes(modes.back[i])) names.push(front);
    });
    if (breakAllow.includes(MODE5_BACK)) names.push(modes.mode5_front);
    return names;
  }, [modes, breakAllow]);

  function handleModeClick(back: string) {
    logDebug("ui", `点击模式 ${back}（当前选中=${backMode ?? "无"} drawing=${drawing} 锁定=${isModeLocked(back)}）`);
    if (drawing) return;
    if (isModeLocked(back)) {
      setUsbVerifyOpen(true);
      return;
    }
    setBackMode((prev) => (prev === back ? null : back));
  }

  function toggleGender(g: "boy" | "girl") {
    logDebug("ui", `点击性别 ${g}（当前=${gender ?? "无"} drawing=${drawing}）`);
    if (drawing) return;
    if (g === "boy" && boysCount === 0) return;
    if (g === "girl" && girlsCount === 0) return;
    setGender((prev) => (prev === g ? null : g));
  }

  function validate(): { ok: true; max: number; q: number } | { ok: false; err: string } {
    const m = parseInt(maxNum.trim(), 10);
    const q = parseInt(qty.trim(), 10);
    if (!Number.isInteger(m) || m < numberLimits.min || m > numberLimits.max)
      return { ok: false, err: `最大号码必须在 ${numberLimits.min}-${numberLimits.max} 之间` };
    if (!Number.isInteger(q) || q < quantityLimits.min || q > quantityLimits.max)
      return { ok: false, err: `抽号数量必须在 ${quantityLimits.min}-${quantityLimits.max} 之间` };
    return { ok: true, max: m, q };
  }

  const canStart = !!backMode && !drawing && validate().ok;

  // 引导步骤：先完成设置后进入抽号，教学覆盖基础到高阶功能
  const guideSteps: GuideStep[] = useMemo(() => {
    const steps: GuideStep[] = [
      {
        title: "抽号主界面",
        content: "3 步抽号：选模式 → 填参数 → 点开始。",
      },
      {
        selector: "mode-select",
        title: "选择模式",
        content: "点击要使用的模式。禁用时段内未开放的模式需先验证 U 盘。",
      },
      {
        selector: "input-area",
        title: "设置参数",
        content: "填写最大号码和抽号数量。可点「男生」「女生」按性别筛选。",
      },
      {
        selector: "start-button",
        title: "开始抽号",
        content: "点击开始，或按空格 / 回车。",
      },
      {
        selector: "reset-button",
        title: "重置记录",
        content: "按 R 或点此按钮，清空当前模式记录。",
      },
      {
        selector: "result-area",
        title: "显示格式",
        content: "这里显示抽号结果。显示内容可在设置中调整。",
      },
      {
        selector: "advanced-draw",
        title: "高级抽号",
        content: "按座位表分组抽号。需先在设置中导入座位表。",
        skipWarning: "跳过不影响基本抽号。",
      },
      {
        selector: "records",
        title: "记录公示",
        content: "查看已抽记录。",
      },
      {
        selector: "more-menu",
        title: "更多与设置",
        content: "切换主题、全屏、置顶，或进入设置程序。",
      },
      {
        title: "引导完成",
        content: "你可以留在抽号程序开始使用，或进入设置程序完善信息。",
        primaryLabel: "留在抽号",
        onPrimary: () => {
          setFirstRunDone(true);
          api.setFirstRunDone("draw").catch(() => {});
        },
        action: {
          label: "打开设置程序",
          onClick: async () => {
            setFirstRunDone(true);
            try {
              await api.setFirstRunDone("draw");
              await api.switchApp();
            } catch (e) {
              showToast(`切换失败: ${e}`, "error");
            }
          },
        },
        showSkip: false,
      },
    ];

    return steps;
  }, [setFirstRunDone]);

  // ── 显示工具 ──
  function formatSingle(num: number): { main: string; sub: string; gender: "boy" | "girl" | "" } {
    const stu = stuMap.get(num);
    const gender = stu ? stu.gender : "";
    const genderSuffix = stu ? (stu.gender === "boy" ? " ♂" : " ♀") : "";
    switch (displayFormat) {
      case "number":
        return { main: String(num), sub: "", gender };
      case "name":
        return { main: stu ? `${stu.name}${genderSuffix}` : String(num), sub: "", gender };
      case "number_name":
      default:
        return {
          main: String(num),
          sub: stu ? `${stu.name}${genderSuffix}` : "",
          gender,
        };
    }
  }

  function setDisplay(num: number) {
    const { main, sub, gender } = formatSingle(num);
    setDisplayNum(main);
    setDisplayName(sub);
    setDisplayGender(gender);
    setPulseKey((k) => k + 1);
  }

  function setDisplayMulti(nums: number[]) {
    if (displayFormat === "name") {
      const names = nums
        .map((n) => {
          const s = stuMap.get(n);
          return s ? `${s.name}${s.gender === "boy" ? "♂" : "♀"}` : String(n);
        })
        .join("  ");
      setDisplayNum(names);
      setDisplayName("");
    } else if (displayFormat === "number") {
      setDisplayNum(nums.join(", "));
      setDisplayName("");
    } else {
      setDisplayNum(nums.join(", "));
      const names = nums
        .map((n) => stuMap.get(n))
        .filter((s): s is Student => !!s)
        .map((s) => `${s.name}${s.gender === "boy" ? "♂" : "♀"}`)
        .join("  ");
      setDisplayName(names);
    }
    setDisplayGender("");
    setPulseKey((k) => k + 1);
  }

  function clearAnimTimers() {
    animTimers.current.forEach((t) => window.clearTimeout(t));
    animTimers.current = [];
  }

  /** 统一的 drawing 复位出口：每次复位都留痕，便于判断界面禁用时 drawing 的真实状态 */
  function stopDrawing(reason: string) {
    logDebug("draw", `复位 drawing：${reason}`);
    drawingRef.current = false;
    setDrawing(false);
  }

  // ── 抽号主逻辑 ──
  async function handleStart() {
    // 入口留痕：若日志有 click 但没有本行，说明点击被 disabled/遮罩吞掉；
    // 若本行后紧跟复位日志，说明流程正常结束。排查「点不动」问题的关键分叉点。
    logDebug(
      "draw",
      `开始抽号触发：backMode=${backMode} drawing=${drawing} canStart=${canStart} max=${maxNum} qty=${qty}`,
    );
    if (!backMode || drawing || drawingRef.current) return;
    drawingRef.current = true;
    const v = validate();
    if (!v.ok) {
      showToast(v.err, "error");
      return;
    }

    setDrawing(true);
    logEvent("draw", `抽号开始 mode=${backMode} max=${v.max} qty=${v.q} gender=${gender ?? "无"}`);

    try {
      const params = { back_mode: backMode, max_num: v.max, qty: v.q, gender, save: true };

      const doDraw = async () => {
        try {
          // 超时兜底：后端命令若 15 秒不返回，不能让 drawing 永久卡死
          return await withTimeout(api.startDraw(params), 15000, "抽号请求");
        } catch (e: any) {
          logEvent("draw", `抽号失败 mode=${backMode}: ${e}`);
          showToast(typeof e === "string" ? e : `抽号失败: ${e}`, "error");
          return null;
        }
      };

      let result = await doDraw();
      if (!result) { stopDrawing("抽号请求失败"); return; }

      if (result.all_used) {
        const yes = await askYesNo("提示", "所有号码已抽完，是否清空记录重新开始？");
        if (!yes) { stopDrawing("号码抽完且用户取消清空"); return; }
        try {
          await api.clearRecord(backMode);
        } catch (e: any) {
          showToast(`清空记录失败: ${e}`, "error");
          stopDrawing("清空记录失败");
          return;
        }
        result = await doDraw();
        if (!result) { stopDrawing("清空后重新抽号失败"); return; }
        if (result.all_used) {
          showToast(
            gender ? `该性别(${gender === "boy" ? "男生" : "女生"})下没有可用号码` : "没有可用号码",
            "error",
          );
          stopDrawing("清空后仍无可用号码");
          return;
        }
      }

      if (result.message) showToast(result.message, "info");
      logEvent("draw", `抽号完成 mode=${backMode} picked=${result.picked.join(",")} actual=${result.actual_qty}`);
      runAnimation(result.picked, result.display_picked ?? result.picked, result.animation_numbers ?? []);
    } catch (e) {
      // 兜底：任何未预期异常都不能让 drawing 卡死（否则整个界面禁用，只能重启）
      logEvent("draw", `抽号异常 mode=${backMode}: ${e}`, "error");
      showToast(`抽号异常: ${e}`, "error");
      clearAnimTimers();
      stopDrawing("抽号流程未预期异常");
    }
  }

  function runAnimation(picked: number[], displayPicked: number[], animationNumbers: number[]) {
    setDrawing(true);
    clearAnimTimers();

    // 空结果防御：直接复位，不进入动画
    if (picked.length === 0) {
      stopDrawing("空结果，跳过动画");
      return;
    }

    // 看门狗：动画收尾依赖 setTimeout 回调链，窗口最小化（悬浮窗）或被遮挡时
    // WebView2 可能节流甚至挂起定时器，导致 drawing 永久卡死、整个界面禁用。
    // 超时后强制复位，保证界面始终可继续抽号。
    const expectedMs = picked.length === 1 ? 2000 : picked.length * 1000;
    const watchdog = window.setTimeout(() => {
      logEvent(
        "draw",
        `动画看门狗触发（${expectedMs}ms 未正常收尾），强制复位 drawing。hidden=${document.hidden} visibility=${document.visibilityState}`,
        "warn",
      );
      clearAnimTimers();
      if (picked.length === 1) setDisplay(picked[0]);
      else setDisplayMulti(picked);
      stopDrawing("看门狗强制复位");
    }, expectedMs + 1500);
    animTimers.current.push(watchdog);

    // 禁用时段未验证：直接显示结果，无动画
    if (inBreak && !verified) {
      clearAnimTimers();
      if (picked.length === 1) {
        setDisplay(picked[0]);
      } else {
        setDisplayMulti(picked);
      }
      stopDrawing("禁用时段免动画显示");
      return;
    }

    if (picked.length === 1) {
      // 单号：随机滚动 ~2s 后定格为真实号码（暗痕时滚动显示 display 号码）
      // 随机数全部来自后端 animation_numbers，避免使用 Math.random()
      const duration = 2000;
      const interval = 80;
      const start = performance.now();
      const displayNum = displayPicked[0] ?? picked[0];
      let idx = 0;
      const tick = () => {
        if (performance.now() - start < duration) {
          const r = animationNumbers.length
            ? animationNumbers[idx % animationNumbers.length]
            : displayNum;
          setDisplay(r === picked[0] ? displayNum : r);
          idx++;
          const id = window.setTimeout(tick, interval);
          animTimers.current.push(id);
        } else {
          clearAnimTimers(); // 正常收尾：清掉看门狗等残留定时器
          setDisplay(picked[0]);
          stopDrawing(`单号动画收尾（实际耗时 ${Math.round(performance.now() - start)}ms）`);
        }
      };
      tick();
    } else {
      // 多号：逐个闪现 display 号码，最终定格显示全部真实号码
      let i = 0;
      const multiStart = performance.now();
      const showNext = () => {
        if (i < picked.length) {
          setDisplay(displayPicked[i] ?? picked[i]);
          i++;
          const id = window.setTimeout(showNext, 1000);
          animTimers.current.push(id);
        } else {
          clearAnimTimers(); // 正常收尾：清掉看门狗等残留定时器
          setDisplayMulti(picked);
          stopDrawing(`多号动画收尾（实际耗时 ${Math.round(performance.now() - multiStart)}ms）`);
        }
      };
      showNext();
    }
  }

  // ── 重置抽号记录（任何模式均可重置） ──
  async function handleResetRecord() {
    if (!backMode) {
      showToast("请先选择一个模式", "error");
      return;
    }
    const frontName = getFrontName(backMode);
    const isMem = memoryModes.has(backMode);
    const tip = isMem
      ? `确定要清空【${frontName}】的抽号记录吗？\n此操作不可撤销。`
      : `确定要清空【${frontName}】的抽号记录吗？\n此操作会删除数据库中所有记录，不可撤销。`;
    const yes = await askYesNo("重置抽号记录", tip);
    if (!yes) return;
    try {
      if (isMem) {
        await api.resetMemoryMode(backMode);
      } else {
        await api.clearRecord(backMode);
      }
      showToast(`【${frontName}】的记录已重置`, "success");
    } catch (e) {
      showToast(`重置失败: ${e}`, "error");
    }
  }

  async function handleVerifyUsbForSession() {
    if (verifyingUsb) return;
    setVerifyingUsb(true);
    try {
      const ok = await api.verifyUsbForSession(usbVerifyScope);
      if (ok) {
        setVerified(true);
        setUsbVerifyOpen(false);
        showToast("U盘验证通过，当前禁用时段内全部模式可用", "success");
      } else {
        showToast("验证失败：未检测到授权U盘", "error");
      }
    } catch (e) {
      showToast(`验证失败: ${e}`, "error");
    } finally {
      setVerifyingUsb(false);
    }
  }

  // ── 全屏 / 置顶 ──
  async function toggleFullscreen() {
    try {
      const win = getCurrentWebviewWindow();
      const next = !isFullscreen;
      await win.setFullscreen(next);
      setIsFullscreen(next);
    } catch (e) {
      showToast(`切换全屏失败: ${e}`, "error");
    }
  }

  async function toggleTopmost() {
    try {
      const win = getCurrentWebviewWindow();
      const next = !isTopmost;
      await win.setAlwaysOnTop(next);
      setIsTopmost(next);
    } catch (e) {
      showToast(`切换置顶失败: ${e}`, "error");
    }
  }

  const advWindowOpeningRef = useRef(false);
  async function openAdvancedDrawWindow() {
    if (advWindowOpeningRef.current) return; // 双击防重入：两个并发创建会互相报「窗口已存在」
    advWindowOpeningRef.current = true;
    try {
      // 若窗口已存在（可能被「返回主抽号」隐藏而未销毁），直接显示并聚焦，避免重复创建报错
      const existing = await WebviewWindow.getByLabel("advanced-draw");
      if (existing) {
        try { await existing.show(); } catch (e) { console.warn("[advanced] show failed:", e); }
        try { await existing.setFocus(); } catch (e) { console.warn("[advanced] setFocus failed:", e); }
        return;
      }
      const advWindow = new WebviewWindow("advanced-draw", {
        url: "/?view=advanced",
        title: "高级抽号",
        width: 1060,
        height: 680,
        minWidth: 800,
        minHeight: 500,
        center: true,
      });
      advWindow.once("tauri://error", (e: any) => {
        const msg = e?.payload || e?.toString() || "未知错误";
        showToast(`打开窗口失败: ${msg}`, "error");
      });
    } catch (e) {
      showToast(`打开高级抽号失败: ${e}`, "error");
    } finally {
      advWindowOpeningRef.current = false;
    }
  }

  function getFrontName(back: string): string {
    if (!modes) return back;
    if (back === MODE5_BACK) return modes.mode5_front;
    const i = modes.back.indexOf(back);
    return i >= 0 ? modes.front[i] : back;
  }

  // ── 全局键盘快捷键 ──
  // Space/Enter → 抽号；R → 重置记录；F → 全屏；T → 置顶
  const handleStartRef = useRef(handleStart);
  const handleResetRef = useRef(handleResetRecord);
  const toggleFullscreenRef = useRef(toggleFullscreen);
  const toggleTopmostRef = useRef(toggleTopmost);
  handleStartRef.current = handleStart;
  handleResetRef.current = handleResetRecord;
  toggleFullscreenRef.current = toggleFullscreen;
  toggleTopmostRef.current = toggleTopmost;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 有弹窗或新手引导气泡时禁用快捷键
      if (document.querySelector(".dialog-mask") || document.querySelector(".guide-bubble")) return;
      // 带 Ctrl/Alt/Meta 的组合键（浏览器/系统快捷键）不抢占
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;

      if (e.code === "Space" || e.key === "Enter") {
        // 按钮已聚焦时让原生行为处理，避免重复触发
        const active = document.activeElement;
        if (active && active.tagName === "BUTTON") return;
        if (canStart) {
          e.preventDefault();
          handleStartRef.current();
        }
      } else if (e.key === "r" || e.key === "R") {
        if (!drawing) {
          e.preventDefault();
          handleResetRef.current();
        }
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreenRef.current();
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        toggleTopmostRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canStart, drawing]);

  if (!modes) {
    return (
      <div className="app">
        <div style={{ margin: "auto", color: "var(--text-hint)" }}>加载中…</div>
      </div>
    );
  }

  return (
    <div
      className={`app${touchPointer ? " touch-pointer" : ""}`}
      onPointerDown={trackPointer}
      onPointerMove={trackPointer}
    >
      {/* 顶栏：左 记录公示，右 高级抽号 */}
      <div className="topbar">
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="text-button"
            data-tour="records"
            onClick={() => setShowRecords(true)}
          >
            记录公示
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            className="text-button"
            data-tour="advanced-draw"
            onClick={openAdvancedDrawWindow}
          >
            高级抽号
          </button>
        </div>
      </div>

      {/* 模式选择（居中） */}
      <div className="chip-row" data-tour="mode-select">
        <span className="chip-label">选择模式</span>
        {modes.front.map((front, i) => {
          const back = modes.back[i];
          const selected = backMode === back;
          const locked = isModeLocked(back);
          return (
            <button
              key={back}
              className={`chip${selected ? " selected" : ""}${locked ? " locked" : ""}`}
              disabled={drawing}
              onClick={() => handleModeClick(back)}
              title={locked ? "点击进行U盘验证" : ""}
            >
              {front}
            </button>
          );
        })}
        <button
          className={`chip${backMode === MODE5_BACK ? " selected" : ""}${isModeLocked(MODE5_BACK) ? " locked" : ""}`}
          disabled={drawing}
          onClick={() => handleModeClick(MODE5_BACK)}
          title={isModeLocked(MODE5_BACK) ? "点击进行U盘验证" : ""}
        >
          {modes.mode5_front}
        </button>
      </div>

      {/* 输入与性别（居中） */}
      <div className="chip-row" data-tour="input-area">
        <div className="input-group">
          <span className="chip-label">最大号码</span>
          <input
            className="input"
            value={maxNum}
            disabled={(inBreak && !verified) || drawing}
            onChange={(e) => setMaxNum(e.target.value.replace(/\D/g, ""))}
            title={`范围 ${numberLimits.min}-${numberLimits.max}`}
          />
        </div>
        <div className="input-group">
          <span className="chip-label">抽号数量</span>
          <input
            className="input"
            style={{ width: "clamp(72px, 8vw, 92px)" }}
            value={qty}
            disabled={(inBreak && !verified) || drawing}
            onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
            title={`范围 ${quantityLimits.min}-${quantityLimits.max}`}
          />
        </div>
        <button
          className={`chip boy${gender === "boy" ? " selected" : ""}`}
          disabled={boysCount === 0 || drawing}
          onClick={() => toggleGender("boy")}
        >
          男生
        </button>
        <button
          className={`chip girl${gender === "girl" ? " selected" : ""}`}
          disabled={girlsCount === 0 || drawing}
          onClick={() => toggleGender("girl")}
        >
          女生
        </button>
      </div>

      {/* 抽号 + 重置 */}
      <div className="button-row">
        <button
          className="primary-button"
          data-tour="start-button"
          disabled={!canStart}
          onClick={handleStart}
          title="空格 / 回车"
        >
          {drawing ? "抽号中…" : "开始抽号"}
        </button>
        <button
          className="text-button"
          data-tour="reset-button"
          onClick={handleResetRecord}
          disabled={drawing}
          title="R"
        >
          重置抽号记录
        </button>
      </div>

      {/* 结果区 */}
      <div className="result-area" data-tour="result-area">
        <div
          key={pulseKey}
          className={`result-number flash${
            displayGender === "boy"
              ? " gender-boy"
              : displayGender === "girl"
                ? " gender-girl"
                : ""
          }`}
        >
          {displayNum || "—"}
        </div>
        <div className="result-name">{displayName}</div>
      </div>

      {/* 状态条 */}
      <div className="statusbar">
        <span className={`pill${inBreak ? " warn" : ""}`}>
          {inBreak
            ? verified
              ? "当前为禁用时段，已通过U盘验证"
              : breakAllowNames.length > 0
                ? `当前为禁用时段（仅${breakAllowNames.join("、")}可用）`
                : "当前为禁用时段（需U盘验证）"
            : "可正常抽号"}
        </span>
        <span className="pill">
          学生：男 {boysCount} / 女 {girlsCount}
        </span>
        {backMode && (
          <span className="pill">
            {memoryModes.has(backMode) ? "内存模式" : "持久模式"}
          </span>
        )}
      </div>

      <Toast toast={toast} />
      {dialog && (
        <YesNoDialog dialog={dialog} setDialog={setDialog} />
      )}

      {/* USB 验证模态框 */}
      {usbVerifyOpen && (
        <div className="dialog-mask" ref={usbVerifyMaskRef} onClick={() => setUsbVerifyOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">禁用时段验证</div>
            <div className="dialog-message">
              当前为禁用时段，使用未开放的模式需要插入并验证已注册的授权U盘。
              <br />
              验证有效期：{usbVerifyScope === "permanent" ? "程序运行期间一直有效" : "仅当前禁用时段有效"}
            </div>
            <div className="dialog-actions">
              <button
                className="dialog-btn secondary"
                onClick={() => setUsbVerifyOpen(false)}
              >
                取消
              </button>
              <button
                className="dialog-btn primary"
                onClick={handleVerifyUsbForSession}
                disabled={verifyingUsb}
              >
                {verifyingUsb ? "验证中…" : "验证U盘"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 记录公示面板 */}
      {showRecords && modes && (
        <RecordsPanel
          modes={modes}
          students={students}
          memoryModes={memoryModes}
          onClose={() => setShowRecords(false)}
        />
      )}

      {/* 右下角「更多」菜单 */}
      <div className="more-menu" ref={moreMenuRef} data-tour="more-menu">
        <button
          className={`more-menu-button${moreMenuOpen ? " active" : ""}`}
          onClick={() => setMoreMenuOpen((v) => !v)}
          title="更多"
        >
          更多
        </button>
        {moreMenuOpen && (
          <div className="more-menu-dropdown">
            <div className="more-menu-item theme-menu-item">
              <span>主题</span>
              <ThemeToggle value={theme} onChange={setTheme} />
            </div>
            <button
              className="more-menu-item"
              onClick={() => {
                toggleFullscreen();
                setMoreMenuOpen(false);
              }}
            >
              {isFullscreen ? "退出全屏" : "进入全屏"}
            </button>
            <button
              className="more-menu-item"
              onClick={() => {
                toggleTopmost();
                setMoreMenuOpen(false);
              }}
            >
              {isTopmost ? "取消置顶" : "置顶窗口"}
            </button>
            <div className="more-menu-divider" />
            <button
              className="more-menu-item"
              disabled={drawing}
              onClick={async () => {
                if (drawing) {
                  showToast("抽号中，请稍后再切换", "warning");
                  return;
                }
                const yes = await askYesNo(
                  "打开设置程序",
                  "打开设置程序会关闭当前抽号窗口，是否继续？"
                );
                if (yes) {
                  try {
                    await api.switchApp();
                  } catch (e) {
                    showToast(`切换失败: ${e}`, "error");
                  }
                }
                setMoreMenuOpen(false);
              }}
            >
              打开设置程序
            </button>
            <button
              className="more-menu-item"
              onClick={async () => {
                const yes = await askYesNo("重启程序", "确定要重启程序吗？\n重启期间会短暂关闭并重新打开。");
                if (yes) {
                  try {
                    await api.restartApp();
                  } catch (e) {
                    showToast(`重启失败: ${e}`, "error");
                  }
                }
                setMoreMenuOpen(false);
              }}
            >
              重启程序
            </button>
          </div>
        )}
      </div>

      {/* 首次引导 */}
      {!firstRunDone && modes && (
        <Guide
          steps={guideSteps}
          currentStep={drawGuideStep}
          onStepChange={setDrawGuideStep}
          onComplete={() => {
            setFirstRunDone(true);
            api.setFirstRunDone("draw").catch(() => {});
          }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════
//  记录公示面板
// ════════════════════════════════════════════
interface RecordsPanelProps {
  modes: ModesPayload;
  students: Student[];
  memoryModes: Set<string>;
  onClose: () => void;
}

function RecordsPanel({ modes, students, memoryModes, onClose }: RecordsPanelProps) {
  const allModes = useMemo(
    () =>
      modes.back.map((b, i) => ({ back: b, front: modes.front[i] })).concat([
        { back: modes.mode5_back, front: modes.mode5_front },
      ]),
    [modes],
  );
  const [activeBack, setActiveBack] = useState<string>(allModes[0].back);
  // 每个号码最近一次抽取的时间（去重，保留最新）
  const [records, setRecords] = useState<{ num: number; time: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);
  const maskRef = useRef<HTMLDivElement>(null);

  useEscToClose(true, onClose, maskRef);

  const stuMap = useMemo(() => {
    const m = new Map<number, Student>();
    students.forEach((s) => m.set(s.number, s));
    return m;
  }, [students]);

  async function refresh(back: string) {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      // 拉取最近 500 条带时间戳的记录，按号码去重保留最新
      const rows = await api.getRecentRecordsWithTime(back, 500);
      if (reqId !== reqIdRef.current) return; // 已过期，丢弃
      const seen = new Set<number>();
      const dedup: { num: number; time: string }[] = [];
      for (const [num, time] of rows) {
        if (seen.has(num)) continue;
        seen.add(num);
        dedup.push({ num, time });
      }
      // 按号码升序排列，与原展示一致
      dedup.sort((a, b) => a.num - b.num);
      setRecords(dedup);
    } catch {
      if (reqId !== reqIdRef.current) return;
      setRecords([]);
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    refresh(activeBack);
  }, [activeBack]);

  const isMem = memoryModes.has(activeBack);

  // 将 "2026-07-09 14:30:25" 格式化为简短显示 "07-09 14:30"
  function fmtTime(t: string): string {
    if (!t) return "";
    // 兼容 "YYYY-MM-DD HH:MM:SS" 格式
    const m = t.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
    // 兜底：尝试截取中间部分，长度不够则返回原字符串
    if (t.length >= 16) return t.slice(5, 16);
    return t;
  }

  return (
    <div className="dialog-mask" ref={maskRef} onClick={onClose}>
      <div
        className="dialog records-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="records-header">
          <div className="dialog-title">记录公示</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="text-button" onClick={() => refresh(activeBack)}>刷新</button>
            <button className="text-button" onClick={onClose}>关闭</button>
          </div>
        </div>

        <div className="records-tabs">
          {allModes.map(({ back, front }) => (
            <button
              key={back}
              className={`chip records-tab${activeBack === back ? " selected" : ""}`}
              onClick={() => setActiveBack(back)}
            >
              {front}
            </button>
          ))}
        </div>

        <div className="records-meta">
          <span>
            已抽 <b>{records.length}</b> 个
          </span>
          <span className="dot">·</span>
          <span>{isMem ? "内存模式（关闭程序后清空）" : "持久模式（保存到数据库）"}</span>
        </div>

        <div className="records-body">
          {loading ? (
            <div className="records-empty">加载中…</div>
          ) : records.length === 0 ? (
            <div className="records-empty">暂无记录</div>
          ) : (
            <div className="records-grid">
              {records.map(({ num, time }) => {
                const s = stuMap.get(num);
                return (
                  <div
                    key={num}
                    className={`record-item${
                      s ? (s.gender === "boy" ? " boy" : " girl") : ""
                    }`}
                  >
                    <div className="record-num">{num}</div>
                    {s && (
                      <div className="record-name">
                        {s.name}
                        {s.gender === "boy" ? "♂" : "♀"}
                      </div>
                    )}
                    {time && (
                      <div className="record-time" title={time}>{fmtTime(time)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

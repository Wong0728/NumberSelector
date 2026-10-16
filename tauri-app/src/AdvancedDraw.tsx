import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, AdvancedDrawResult, SeatDirection, Student, withTimeout } from "./api";
import { useEscToClose } from "./useEscToClose";

// ── 常量 ──
const TYPE_LABELS = ["按大组", "4人", "6人", "按列", "手动"];
const TYPE_VALUES: Record<string, string> = {
  "按大组": "big_group",
  "4人": "group4",
  "6人": "group6",
  "按列": "column",
  "手动": "manual",
};
const RULE_LABELS = ["每组抽N", "抽一组"];
const TYPE_PHRASE: Record<string, string> = {
  big_group: "大组",
  group4: "4人小组",
  group6: "6人小组",
  column: "列",
  manual: "手动",
};

// 模式映射（前端显示 → 后端名称）
const MODE_KEYS = ["Mode1", "Mode2", "Mode3", "Mode4", "Mode5"];
const MODE_LABELS = ["模式一", "模式二", "模式三", "模式四", "模式五"];

// ── 类型定义 ──
interface SeatmapData {
  v?: number;
  grid: [number, number];
  seats: Record<string, [string, string]>;
  disabled?: string[];
}

interface SeatGenderCache {
  [key: string]: "boy" | "girl" | "";
}

interface Props {
  students: Student[];
  onClose: () => void;
  showToast: (msg: string, type?: "info" | "success" | "error" | "warning", duration?: number) => void;
  askYesNo: (title: string, message: string) => Promise<boolean>;
  standalone?: boolean;
}

// ── 性别统一：座位表 JSON 中 "男"/"女" 转 "boy"/"girl" ──
function normalizeGender(g: string): "boy" | "girl" | "" {
  if (g === "男" || g === "boy") return "boy";
  if (g === "女" || g === "girl") return "girl";
  return "";
}

// ── 组件 ──
export default function AdvancedDraw({ students, onClose, showToast, askYesNo, standalone = false }: Props) {
  const maskRef = useRef<HTMLDivElement>(null);
  useEscToClose(!standalone, onClose, maskRef);

  // 学生编号映射
  const stuMap = useMemo(() => {
    const m = new Map<number, Student>();
    students.forEach((s) => m.set(s.number, s));
    return m;
  }, [students]);

  // 姓名 -> 编号映射（保留首次出现，与后端 seat_to_number 的 find 行为一致）
  const nameToNumber = useMemo(() => {
    const m = new Map<string, number>();
    students.forEach((s) => {
      if (!m.has(s.name)) m.set(s.name, s.number);
    });
    return m;
  }, [students]);

  // 座位表数据
  const [seatmap, setSeatmap] = useState<SeatmapData | null>(null);
  const [loading, setLoading] = useState(true);

  // 性别缓存
  const [genderCache, setGenderCache] = useState<SeatGenderCache>({});

  // 座位表方向
  const [seatDirection, setSeatDirection] = useState<SeatDirection>("rtl");

  // 动作状态
  const [drawType, setDrawType] = useState("按大组");
  const [rangeSelected, setRangeSelected] = useState<Set<string>>(new Set());
  const [rule, setRule] = useState("每组抽N");
  const [qty, setQty] = useState(1);
  const [qtyInput, setQtyInput] = useState("1");

  // 性别 + 保存
  const [boyEnabled, setBoyEnabled] = useState(true);
  const [girlEnabled, setGirlEnabled] = useState(true);
  const [saveEnabled, setSaveEnabled] = useState(true);
  const [saveMode, setSaveMode] = useState("模式五");

  // 手动模式选中的座位
  const [manualSelected, setManualSelected] = useState<Set<string>>(new Set());
  // 已高亮的已抽座位
  const [drawnHighlighted, setDrawnHighlighted] = useState<string[]>([]);
  // 最新一轮抽中的座位（绿色高亮）
  const [lastDrawnSeats, setLastDrawnSeats] = useState<Set<string>>(new Set());

  // 结果
  const [resultText, setResultText] = useState("点击「开始抽取」查看结果");
  const [lastResult, setLastResult] = useState<{ numbers: number[]; names: string[]; seats: string[] } | null>(null);

  // 抽号中
  const [drawing, setDrawing] = useState(false);

  // 抽号记录弹窗
  const [showRecords, setShowRecords] = useState(false);

  // 范围多选弹窗
  const [rangePicker, setRangePicker] = useState<{
    title: string;
    options: { key: string; label: string }[];
    selected: Set<string>;
  } | null>(null);

  // 类型值
  const typeValue = TYPE_VALUES[drawType] || "big_group";

  // ── 缓存 buildGroups 结果，避免多处重复计算 ──
  const groups = useMemo(() => buildGroups(typeValue), [typeValue, seatmap, seatDirection, manualSelected]);

  // ── 缓存已用号码集合，避免多处重复构建 ──
  const usedNumbers = useMemo(() => {
    const used = new Set<number>();
    drawnHighlighted.forEach((sk) => {
      const n = seatToNumber(sk);
      if (n > 0) used.add(n);
    });
    return used;
  }, [drawnHighlighted, seatmap, nameToNumber]);

  // ── 分组叠加层 ──
  const [groupBoxes, setGroupBoxes] = useState<Array<{ top: number; left: number; width: number; height: number; label: string }>>([]);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const drawBtnRef = useRef<HTMLButtonElement>(null);
  // 防止 handleStartDraw 在 React 状态更新延迟期间被重复调用
  const drawingRef = useRef(false);

  // ── 加载座位表与方向 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [json, dir] = await Promise.all([api.loadSeatmap(), api.getSeatDirection()]);
        if (cancelled) return;
        setSeatDirection(dir || "rtl");
        if (json) {
          const data = JSON.parse(json) as SeatmapData;
          if (cancelled) return;
          setSeatmap(data);
          buildGenderCache(data);
        }
      } catch (e) {
        console.error("加载座位表失败:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function buildGenderCache(data: SeatmapData) {
    const cache: SeatGenderCache = {};
    for (const [key, info] of Object.entries(data.seats)) {
      if (info.length >= 2) {
        cache[key] = normalizeGender(info[1]);
      }
    }
    setGenderCache(cache);
  }

  // ── 持久模式下加载已抽座位 ──
  useEffect(() => {
    if (!seatmap) return;
    let cancelled = false;
    (async () => {
      try {
        const backMode = getSaveBackMode();
        const isMem = await api.getMemoryModes();
        if (cancelled) return;
        if (isMem.includes(backMode)) {
          // 内存模式不加载历史记录，必须清掉上一模式残留的高亮
          setDrawnHighlighted([]);
          return;
        }
        const used = await api.getUsed(backMode);
        if (cancelled) return;
        if (!used.length) {
          setDrawnHighlighted([]);
          return;
        }
        const usedSet = new Set(used);
        const highlighted: string[] = [];
        for (const [key, info] of Object.entries(seatmap.seats)) {
          const name = info?.[0];
          if (!name) continue;
          const num = nameToNumber.get(name);
          if (num && usedSet.has(num)) {
            highlighted.push(key);
          }
        }
        setDrawnHighlighted(highlighted);
      } catch (e) {
        console.error("加载已抽座位失败:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [seatmap, saveMode, nameToNumber]);

  // ── 导入座位表 ──
  async function handleImport() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const text = await api.readTextFile(selected);
      let data: SeatmapData;
      try {
        data = JSON.parse(text);
      } catch {
        showToast("JSON 格式错误", "error");
        return;
      }
      if (!data.grid || !data.seats) {
        showToast("JSON 格式不正确，缺少 grid 或 seats", "error");
        return;
      }
      await api.saveSeatmap(text);
      setSeatmap(data);
      buildGenderCache(data);
      setManualSelected(new Set());
      setDrawnHighlighted([]);
      setResultText("座位表导入成功！");
      showToast("座位表导入成功！", "success");
    } catch (e) {
      showToast(`导入失败: ${e}`, "error");
    }
  }

  // ── 重新导入 ──
  // 不预先清空：先让用户选中新文件，导入成功后由 handleImport 覆盖状态；
  // 若用户取消或解析失败，原座位表原样保留，避免数据被白白清掉
  async function handleReimport() {
    const yes = await askYesNo("重新导入", "确定要重新导入座位表吗？\n当前数据将被新文件覆盖。");
    if (!yes) return;
    await handleImport();
  }

  // ── 列顺序（与后端 draw.rs 的 col_indices 保持一致） ──
  function orderedColIndices(): number[] {
    if (!seatmap) return [];
    const cols = seatmap.grid[1];
    if (seatDirection === "ltr") {
      return Array.from({ length: cols }, (_, i) => cols - i); // [N, N-1, ..., 1]
    }
    return Array.from({ length: cols }, (_, i) => i + 1);      // [1, 2, ..., N]
  }

  // ── 构建分组 ──
  function buildGroups(modeValue: string): Record<string, string[]> {
    if (!seatmap) return {};
    const [rows, cols] = seatmap.grid;
    const disabled = new Set(seatmap.disabled || []);
    const orderedCols = orderedColIndices();

    function isValid(k: string) {
      return !disabled.has(k);
    }

    const allSeats: string[] = [];
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const key = `${r}-${c}`;
        if (isValid(key)) allSeats.push(key);
      }
    }

    const groups: Record<string, string[]> = {};

    function colPairSeats(colA: number, colB: number): string[] {
      // colA 是右列（大编号），colB 是左列（小编号）
      // 排序规则：右列取前2个（行升序），再左列取前2个（行升序），交替进行
      const rightCol = allSeats
        .filter((s) => parseInt(s.split("-")[1]) === colA)
        .sort((a, b) => parseInt(a.split("-")[0]) - parseInt(b.split("-")[0]));
      const leftCol = allSeats
        .filter((s) => parseInt(s.split("-")[1]) === colB)
        .sort((a, b) => parseInt(a.split("-")[0]) - parseInt(b.split("-")[0]));

      const result: string[] = [];
      const maxLen = Math.max(rightCol.length, leftCol.length);
      for (let i = 0; i < maxLen; i += 2) {
        for (let j = i; j < i + 2 && j < rightCol.length; j++) {
          result.push(rightCol[j]);
        }
        for (let j = i; j < i + 2 && j < leftCol.length; j++) {
          result.push(leftCol[j]);
        }
      }
      return result;
    }

    if (modeValue === "big_group") {
      for (let bgIdx = 0; bgIdx < orderedCols.length; bgIdx += 2) {
        const rightCol = orderedCols[bgIdx];
        const leftCol = orderedCols[bgIdx + 1];
        const gn = bgIdx / 2 + 1;
        const seatsIn = (leftCol !== undefined)
          ? colPairSeats(rightCol, leftCol)
          : colPairSeats(rightCol, 0);
        if (seatsIn.length) {
          groups[`第${gn}大组`] = seatsIn;
        }
      }
    } else if (modeValue === "group4" || modeValue === "group6") {
      const rowsPerChunk = modeValue === "group4" ? 2 : 3;  // 每个标准块取几行
      const minGroupSize = modeValue === "group4" ? 4 : 6;  // 每组最少人数
      let gid = 1;
      for (let bgIdx = 0; bgIdx < orderedCols.length; bgIdx += 2) {
        const rightCol = orderedCols[bgIdx];
        const leftCol = orderedCols[bgIdx + 1];

        const rightSeats = allSeats
          .filter((s) => parseInt(s.split("-")[1]) === rightCol)
          .sort((a, b) => parseInt(a.split("-")[0]) - parseInt(b.split("-")[0]));
        const leftSeats = (leftCol !== undefined)
          ? allSeats
            .filter((s) => parseInt(s.split("-")[1]) === leftCol)
            .sort((a, b) => parseInt(a.split("-")[0]) - parseInt(b.split("-")[0]))
          : [];

        if (!rightSeats.length && !leftSeats.length) continue;

        // 按行对分组：每 rowsPerChunk 行从右列取，再从左列取，形成一组
        const pairs: string[][] = [];
        const maxRow = Math.max(
          rightSeats.length ? parseInt(rightSeats[rightSeats.length - 1].split("-")[0]) : 0,
          leftSeats.length ? parseInt(leftSeats[leftSeats.length - 1].split("-")[0]) : 0
        );

        for (let startRow = 1; startRow <= maxRow; startRow += rowsPerChunk) {
          const chunk: string[] = [];
          for (const s of rightSeats) {
            const r = parseInt(s.split("-")[0]);
            if (r >= startRow && r < startRow + rowsPerChunk) chunk.push(s);
          }
          for (const s of leftSeats) {
            const r = parseInt(s.split("-")[0]);
            if (r >= startRow && r < startRow + rowsPerChunk) chunk.push(s);
          }
          if (chunk.length) pairs.push(chunk);
        }

        // 合并末尾不足 minGroupSize 人的小组到前一组
        // 规则：每组可以超过 minGroupSize 人，但不能少于 minGroupSize 人
        while (pairs.length >= 2 && pairs[pairs.length - 1].length < minGroupSize) {
          pairs[pairs.length - 2] = [...pairs[pairs.length - 2], ...pairs[pairs.length - 1]];
          pairs.pop();
        }

        for (const grp of pairs) {
          groups[`第${gid}小组`] = grp;
          gid++;
        }
      }
    } else if (modeValue === "column") {
      for (let idx = 0; idx < orderedCols.length; idx++) {
        const c = orderedCols[idx];
        const colSeats = allSeats
          .filter((s) => parseInt(s.split("-")[1]) === c)
          .sort((a, b) => {
            const ra = parseInt(a.split("-")[0]);
            const rb = parseInt(b.split("-")[0]);
            return ra - rb;
          });
        if (colSeats.length) {
          groups[`第${idx + 1}列`] = colSeats;
        }
      }
    } else if (modeValue === "manual") {
      const man = Array.from(manualSelected).sort((a, b) => {
        const [ra, ca] = a.split("-").map(Number);
        const [rb, cb] = b.split("-").map(Number);
        return ra !== rb ? ra - rb : ca - cb;
      });
      if (man.length) {
        groups["手动选择"] = man;
      }
    }

    return groups;
  }

  // ── 范围选项（memoized） ──
  const rangeOpts = useMemo(() => Object.keys(groups).map((k) => ({ key: k, label: k })), [groups]);

  // ── 自然语言总结（memoized） ──
  const sentence = useMemo(() => {
    const tp = TYPE_PHRASE[typeValue] || typeValue;

    if (typeValue === "manual") {
      const n = manualSelected.size;
      if (n === 0) return "请在左侧座位表点击选择 1 个或多个座位";
      if (rule === "抽一组") return `在手动选中的 ${n} 个座位中抽全组（全部可抽的人）`;
      return `在手动选中的 ${n} 个座位中各抽 ${qty} 人`;
    }

    if (!Object.keys(groups).length) return "当前类型没有可选范围";
    const chosenNames = Object.keys(groups).filter((k) => rangeSelected.has(k));
    if (!chosenNames.length) return `请选择要抽取的${tp}范围`;

    let rangeStr: string;
    if (chosenNames.length <= 3) {
      rangeStr = chosenNames.join("、");
    } else {
      rangeStr = chosenNames.slice(0, 2).join("、") + `等${chosenNames.length}个${tp}`;
    }

    if (rule === "抽一组") return `在${rangeStr}中随机抽 ${qty} 个${tp}，每${tp}全抽`;
    return `在${rangeStr}中各抽 ${qty} 人`;
  }, [groups, rangeSelected, rule, qty, typeValue, manualSelected]);

  // ── 座位辅助 ──
  function seatHasStudent(key: string): boolean {
    if (!seatmap) return false;
    const info = seatmap.seats[key];
    return !!info && !!info.length && !!info[0];
  }

  function seatToNumber(key: string): number {
    if (!seatmap) return 0;
    const info = seatmap.seats[key];
    if (!info || !info.length) return 0;
    return nameToNumber.get(info[0]) || 0;
  }

  function genderPass(key: string): boolean {
    const g = genderCache[key] || "";
    if (g === "boy") return boyEnabled;
    if (g === "girl") return girlEnabled;
    return true;
  }

  function remainingIn(seatKeys: string[]): number[] {
    const out: number[] = [];
    for (const s of seatKeys) {
      const n = seatToNumber(s);
      if (n > 0 && !usedNumbers.has(n) && genderPass(s)) out.push(n);
    }
    return out;
  }

  // ── 候选池（memoized） ──
  const candidatePool = useMemo(() => {
    if (!seatmap) return new Set<string>();
    if (typeValue === "manual") {
      return new Set(
        Array.from(manualSelected).filter((s) => seatHasStudent(s) && genderPass(s))
      );
    }
    const out = new Set<string>();
    for (const [name, seats] of Object.entries(groups)) {
      if (rangeSelected.has(name)) {
        seats.forEach((s) => out.add(s));
      }
    }
    return new Set(Array.from(out).filter((s) => seatHasStudent(s) && genderPass(s)));
  }, [seatmap, typeValue, manualSelected, groups, rangeSelected, genderCache, boyEnabled, girlEnabled]);

  // ── 候选学生集合（memoized） ──
  const poolStudentSet = useMemo(() => {
    const result = new Set<number>();
    for (const sk of candidatePool) {
      const n = seatToNumber(sk);
      if (n > 0 && !usedNumbers.has(n)) result.add(n);
    }
    return result;
  }, [candidatePool, usedNumbers, seatmap, nameToNumber]);

  // ── 预计抽中数（memoized） ──
  const expected = useMemo(() => {
    const rv = rule;

    if (typeValue === "manual") {
      const nums = remainingIn(Array.from(manualSelected));
      if (rv === "抽一组") return nums.length;
      return Math.min(qty, nums.length);
    }

    if (rv === "抽一组") {
      const availableCounts: number[] = [];
      for (const [name, seats] of Object.entries(groups)) {
        if (!rangeSelected.has(name)) continue;
        const nums = remainingIn(seats);
        if (nums.length) availableCounts.push(nums.length);
      }
      const k = Math.min(qty, availableCounts.length);
      if (!availableCounts.length) return 0;
      const avg = availableCounts.reduce((a, b) => a + b, 0) / availableCounts.length;
      return Math.round(k * avg);
    }

    let total = 0;
    for (const [name, seats] of Object.entries(groups)) {
      if (!rangeSelected.has(name)) continue;
      const nums = remainingIn(seats);
      total += Math.min(qty, nums.length);
    }
    return total;
  }, [groups, rangeSelected, rule, qty, typeValue, manualSelected, usedNumbers, genderCache, boyEnabled, girlEnabled, seatmap, nameToNumber]);

  // ── 范围按钮文字（memoized） ──
  const rangeBtnText = useMemo(() => {
    if (typeValue === "manual") return `已选 ${manualSelected.size} 个`;
    const total = rangeOpts.length;
    const chosen = rangeSelected.size;
    if (!total) return "无范围";
    if (!chosen) return "请选择…";
    if (chosen === total) return "全部";
    const names = rangeOpts.filter((o) => rangeSelected.has(o.key)).map((o) => o.key);
    if (names.length <= 3) return names.join("、");
    return names.slice(0, 2).join("、") + `等${chosen}个`;
  }, [typeValue, manualSelected, rangeOpts, rangeSelected]);

  // ── 保存模式映射 ──
  function getSaveBackMode(): string {
    const idx = MODE_LABELS.indexOf(saveMode);
    return idx >= 0 ? MODE_KEYS[idx] : "Mode5";
  }

  // ── 座位点击（手动模式） ──
  function handleSeatClick(key: string) {
    if (typeValue !== "manual") return;
    if (!seatHasStudent(key)) return;

    setManualSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  // ── 重置 ──
  async function handleResetMemory() {
    const backMode = getSaveBackMode();
    const frontName = saveMode;
    const yes = await askYesNo("重置", `确定要清空【${frontName}】的记录吗？\n此操作不可撤销。`);
    if (!yes) return;
    try {
      // clearRecord 内部自动区分内存模式/持久模式，两者都能正确清理
      await api.clearRecord(backMode);
      setDrawnHighlighted([]);
      setResultText("记录已重置");
      showToast(`【${frontName}】的记录已重置`, "success");
    } catch (e) {
      showToast(`重置失败: ${e}`, "error");
    }
  }

  // ── 开始抽取 ──
  async function handleStartDraw() {
    if (drawingRef.current) return;
    if (!seatmap) {
      showToast("请先导入座位表", "error");
      return;
    }
    if (!students.length) {
      showToast("学生数据为空，无法抽号", "error");
      setResultText("学生数据为空！请先在基本信息中导入学生名单");
      return;
    }

    const tv = typeValue;
    const rv = rule;

    if (tv === "manual") {
      if (!manualSelected.size) {
        showToast("请在左侧座位表选择至少 1 个座位", "error");
        return;
      }
    } else {
      if (!rangeSelected.size) {
        showToast("请先点击「范围」选择要抽取的组/列", "error");
        return;
      }
    }

    if (!boyEnabled && !girlEnabled) {
      showToast("请至少启用一个性别（男/女）", "error");
      return;
    }

    drawingRef.current = true;
    setDrawing(true);
    setLastDrawnSeats(new Set());
    const backMode = getSaveBackMode();

    try {
      const selected = tv === "manual" ? Array.from(manualSelected).sort() : Array.from(rangeSelected);
      // 超时兜底：后端命令若 15 秒不返回，不能让 drawing 永久卡死（与主抽号同策略）
      const result = await withTimeout(
        api.advancedDrawV2({
          back_mode: backMode,
          draw_type: tv,
          rule: rv === "抽一组" ? "pick_group" : "per_group_n",
          qty,
          selected,
          boy_enabled: boyEnabled,
          girl_enabled: girlEnabled,
          save: saveEnabled,
        }),
        15000,
        "高级抽号请求",
      );

      if (result.all_used || result.picked.length === 0) {
        showToast("该范围内所有人已抽完", "warning");
        setResultText("已抽完，请重置记录");
        return;
      }

      // 使用后端返回的精确座位映射
      if (result.drawn_seats.length) {
        setDrawnHighlighted((prev) => {
          const set = new Set(prev);
          result.drawn_seats.forEach((s: string) => set.add(s));
          return Array.from(set);
        });
        setLastDrawnSeats(new Set(result.drawn_seats));
      }

      // 显示结果
      const numsStr = result.picked.join(", ");
      const namesStr = result.picked_names.join(", ");
      setResultText(`抽中号码: ${numsStr}\n\n抽中学生: ${namesStr}`);
      setLastResult({ numbers: result.picked.slice(), names: result.picked_names.slice(), seats: (result.drawn_seats || []).slice() });
      showToast(`抽取结果: ${numsStr}`, "success");
    } catch (e) {
      showToast(`抽号失败: ${e}`, "error");
    } finally {
      drawingRef.current = false;
      setDrawing(false);
      // 重新聚焦抽取按钮，方便用空格/回车继续抽取
      setTimeout(() => drawBtnRef.current?.focus(), 0);
    }
  }

  // ── 类型改变 ──
  function handleTypeChange(newType: string) {
    setDrawType(newType);
    setRangeSelected(new Set());
    if (newType !== "手动") {
      setManualSelected(new Set());
    }
  }

  // ── 范围选择弹窗 ──
  function openRangePicker() {
    if (!rangeOpts.length) {
      showToast("当前类型无可选范围", "error");
      return;
    }
    setRangePicker({
      title:
        typeValue === "big_group"
          ? "选择大组"
          : typeValue === "group4"
          ? "选择4人小组"
          : typeValue === "group6"
          ? "选择6人小组"
          : typeValue === "column"
          ? "选择列"
          : "选择范围",
      options: rangeOpts,
      selected: new Set(rangeSelected),
    });
  }

  function applyRangePicker(selected: Set<string>) {
    setRangeSelected(selected);
    setRangePicker(null);
  }

  // ── 总数 ──
  const totalCandidates = poolStudentSet.size;

  // ── 计算分组边框（绿色框 + 标签） ──
  // 监听窗口 resize 和网格容器 resize，确保绿色框跟随
  useEffect(() => {
    function computeBoxes() {
      if (typeValue === "manual" || !seatmap || !gridContainerRef.current) {
        setGroupBoxes([]);
        return;
      }
      const container = gridContainerRef.current;
      const checkedGroups = Object.entries(groups).filter(([name]) => rangeSelected.has(name));
      const containerRect = container.getBoundingClientRect();
      const boxes: Array<{ top: number; left: number; width: number; height: number; label: string }> = [];
      const PAD = 3;

      for (const [grpName, seats] of checkedGroups) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const key of seats) {
          const el = container.querySelector(`[data-seat="${key}"]`) as HTMLElement | null;
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          minX = Math.min(minX, rect.left);
          minY = Math.min(minY, rect.top);
          maxX = Math.max(maxX, rect.right);
          maxY = Math.max(maxY, rect.bottom);
        }
        if (minX === Infinity) continue;

        const ox = minX - containerRect.left - PAD;
        const oy = minY - containerRect.top - PAD;
        const ow = maxX - minX + PAD * 2;
        const oh = maxY - minY + PAD * 2;

        boxes.push({ left: ox, top: oy, width: ow, height: oh, label: grpName });
      }
      setGroupBoxes(boxes);
    }

    computeBoxes();

    window.addEventListener("resize", computeBoxes);
    let observer: ResizeObserver | null = null;
    if (gridContainerRef.current) {
      observer = new ResizeObserver(computeBoxes);
      observer.observe(gridContainerRef.current);
    }

    return () => {
      window.removeEventListener("resize", computeBoxes);
      observer?.disconnect();
    };
  }, [typeValue, rangeSelected, seatmap, groups]);

  // ── 全局键盘快捷键 ──（必须在所有 early return 之前，保证 Hooks 顺序稳定）
  // Space/Enter → 抽取；R → 重置记录（输入框、弹窗中不触发）
  const handleStartDrawRef = useRef(handleStartDraw);
  const handleResetMemRef = useRef(handleResetMemory);
  handleStartDrawRef.current = handleStartDraw;
  handleResetMemRef.current = handleResetMemory;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 有弹窗时禁用快捷键
      if (document.querySelector(".dialog-mask")) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Space" || e.key === "Enter") {
        // 按钮已聚焦时让原生行为处理，避免重复触发
        const active = document.activeElement;
        if (active && active.tagName === "BUTTON") return;
        if (!drawing) {
          e.preventDefault();
          handleStartDrawRef.current();
        }
      } else if (e.key === "r" || e.key === "R") {
        if (!drawing) {
          e.preventDefault();
          handleResetMemRef.current();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawing]);

  // 列标头顺序（必须在所有 early return 之前调用，保证 Hooks 顺序稳定）
  const headerCols = useMemo(() => {
    if (!seatmap) return [];
    const c = seatmap.grid[1];
    if (seatDirection === "ltr") {
      return Array.from({ length: c }, (_, i) => i + 1);
    }
    return Array.from({ length: c }, (_, i) => c - i);
  }, [seatmap, seatDirection]);

  // ── 加载中 ──
  if (loading) {
    return standalone ? (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-hint)" }}>
        加载中…
      </div>
    ) : (
      <div className="dialog-mask" ref={maskRef} onClick={onClose}>
        <div className="dialog advanced-dialog" onClick={(e) => e.stopPropagation()}>
          <div style={{ textAlign: "center", padding: "40px 0", color: "var(--text-hint)" }}>
            加载中…
          </div>
        </div>
      </div>
    );
  }

  // ── 无座位表 ──
  if (!seatmap) {
    const header = (
      <div className="advanced-header">
        <div className="dialog-title">高级抽号</div>
        <button className="text-button" onClick={onClose}>关闭</button>
      </div>
    );
    const emptyBody = (
      <div className="advanced-empty">
        <div className="advanced-empty-icon">📋</div>
        <div className="advanced-empty-title">尚未导入座位表</div>
        <div className="advanced-empty-desc">请选择座位表 JSON 文件</div>
        <button className="primary-button" onClick={handleImport} style={{ marginTop: 20 }}>
          选择文件导入
        </button>
      </div>
    );
    if (standalone) {
      return (
        <>
          {header}
          {emptyBody}
        </>
      );
    }
    return (
      <div className="dialog-mask" ref={maskRef} onClick={onClose}>
        <div className="dialog advanced-dialog" onClick={(e) => e.stopPropagation()}>
          {header}
          {emptyBody}
        </div>
      </div>
    );
  }

  // 安全地处理 seatmap（已通过 early return 保障非 null）
  const sm = seatmap as SeatmapData;
  const [rows, cols] = sm.grid;
  const disabledSet = new Set(sm.disabled || []);
  const drawnSet = new Set(drawnHighlighted);
  const poolSet = candidatePool;

  // 计算单元格样式
  function cellStyle(key: string): React.CSSProperties {
    const base: React.CSSProperties = {
      width: "100%",
      height: "100%",
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 15,
      fontWeight: 700,
      cursor: typeValue === "manual" && seatHasStudent(key) ? "pointer" : "default",
      transition: "background 0.15s, border-color 0.15s",
      border: "2px solid var(--border)",
      padding: "4px 2px",
      minHeight: 40,
    };

    if (disabledSet.has(key)) {
      return { ...base, background: "var(--seat-disabled-bg)", color: "var(--seat-disabled-text)", cursor: "default" };
    }

    const info = sm.seats[key];
    const name = info?.[0] || "";
    const gender = normalizeGender(info?.[1] || "");
    const gColor = gender === "boy" ? "var(--boy)" : gender === "girl" ? "var(--girl)" : "var(--border)";
    const hasStu = !!name;

    // 本轮刚抽中：warning 橙色
    if (lastDrawnSeats.has(key)) {
      return { ...base, background: "var(--warning)", color: "var(--accent-text)", borderColor: "var(--warning)" };
    }

    // 历史已抽：灰色
    if (drawnSet.has(key)) {
      return { ...base, background: "var(--seat-drawn-bg)", color: "var(--seat-drawn-text)", borderColor: "var(--seat-drawn-border)" };
    }

    if (manualSelected.has(key)) {
      return { ...base, background: "var(--success)", color: "var(--accent-text)", borderColor: "var(--success)" };
    }

    if (typeValue !== "manual" && poolSet.has(key)) {
      return { ...base, background: "var(--seat-pool-bg)", color: gColor, borderColor: "var(--seat-pool-border)" };
    }

    return {
      ...base,
      background: "var(--bg-card)",
      color: hasStu ? gColor : "var(--text-hint)",
      borderColor: hasStu ? gColor : "var(--border)",
    };
  }

  // ── 座位网格子组件 ──
  function AdvancedGridPanel() {
    return (
      <div className="advanced-grid-panel">
        <div className="advanced-grid-container" ref={gridContainerRef} style={{ position: "relative" }}>
          {/* 列标头 */}
          <div style={{ display: "flex", paddingLeft: 32 }}>
            {headerCols.map((c) => (
              <div key={c} style={{ flex: 1, textAlign: "center", fontSize: 14, color: "var(--text)", fontWeight: 800, padding: "4px 0" }}>
                {c}
              </div>
            ))}
          </div>
          {/* 行 */}
          {Array.from({ length: rows }, (_, i) => i + 1).map((r) => (
            <div key={r} style={{ display: "flex", alignItems: "center" }}>
              <div className="advanced-row-label">{r}</div>
              {headerCols.map((c) => {
                const key = `${r}-${c}`;
                return (
                  <div data-seat={key} key={key} style={{ flex: 1, padding: 5 }} onClick={() => handleSeatClick(key)}>
                    <div style={cellStyle(key)}>
                      {disabledSet.has(key) ? "" : <span className="advanced-seat-name">{sm.seats[key]?.[0] || "+"}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {/* 分组边框（绿色连续框 + 组名标签） */}
          {groupBoxes.map((box) => (
            <div
              key={box.label}
              className="advanced-group-box"
              style={{
                position: "absolute",
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }}
            >
              <span className="advanced-group-label">{box.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── 控制面板子组件 ──
  function AdvancedControlPanel() {
    return (
      <div className="advanced-ctrl">
        {/* 总结 */}
        <div className="advanced-summary">{sentence}</div>

        {/* 控件：单列 */}
        <div className="advanced-ctrl-card">
          <div className="advanced-ctrl-row">
            <span className="advanced-lbl">类型</span>
            <select className="advanced-sel" value={drawType} onChange={(e) => handleTypeChange(e.target.value)}>
              {TYPE_LABELS.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
          </div>
          <div className="advanced-ctrl-row">
            <span className="advanced-lbl">范围</span>
            <button className="advanced-rng-btn" onClick={openRangePicker}>{rangeBtnText}</button>
          </div>
          <div className="advanced-ctrl-row">
            <span className="advanced-lbl">规则</span>
            <select className="advanced-sel" value={rule} onChange={(e) => setRule(e.target.value)}>
              {RULE_LABELS.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
          </div>
          <div className="advanced-ctrl-row">
            <span className="advanced-lbl">每组数量</span>
            <input className="advanced-inp" type="text" value={qtyInput}
              onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); setQtyInput(v); }}
              onBlur={() => { let v = parseInt(qtyInput, 10); if (isNaN(v) || v < 1) v = 1; setQty(v); setQtyInput(String(v)); }}
              onKeyDown={(e) => { if (e.key === "Enter") { let v = parseInt(qtyInput, 10); if (isNaN(v) || v < 1) v = 1; setQty(v); setQtyInput(String(v)); }}}
            />
          </div>
        </div>

        {/* 过滤 + 保存 */}
        <div className="advanced-ctrl-card advanced-filter-card">
          <label className="advanced-cb">
            <input type="checkbox" checked={boyEnabled} onChange={(e) => setBoyEnabled(e.target.checked)} />
            <span className="advanced-cb-boy">男</span>
          </label>
          <label className="advanced-cb">
            <input type="checkbox" checked={girlEnabled} onChange={(e) => setGirlEnabled(e.target.checked)} />
            <span className="advanced-cb-girl">女</span>
          </label>
          <span className="advanced-split" />
          <label className="advanced-cb">
            <input type="checkbox" checked={saveEnabled} onChange={(e) => setSaveEnabled(e.target.checked)} />
            <span className="advanced-cb-label">保存</span>
          </label>
          <select className="advanced-sel" value={saveMode} onChange={(e) => setSaveMode(e.target.value)} style={{ width: 80, fontSize: 12 }}>
            {MODE_LABELS.map((m) => (<option key={m} value={m}>{m}</option>))}
          </select>
        </div>

        {/* 统计 + 按钮 */}
        <div className="advanced-ctrl-card advanced-btn-card">
          <span className="advanced-stat">候选 <b>{totalCandidates}</b></span>
          <span style={{ color: "var(--border)", fontSize: 15 }}>·</span>
          <span className="advanced-stat">预计 <b>{expected}</b></span>
          <span style={{ flex: 1 }} />
          <button ref={drawBtnRef} className="primary-button" disabled={drawing} onClick={handleStartDraw}
            title="空格 / 回车"
            style={{ padding: "6px 14px", fontSize: 13, borderRadius: 8 }}>
            {drawing ? "…" : "抽取"}
          </button>
          <button className="text-button" onClick={handleResetMemory} disabled={drawing}
            title="R"
            style={{ padding: "6px 14px", fontSize: 13, borderRadius: 8, border: "1px solid var(--border)" }}>
            重置
          </button>
        </div>

        {/* 结果：可视化 */}
        <div className="advanced-result-card">
          <div className="advanced-result-title" style={{ fontSize: 12, marginBottom: 6 }}>抽取结果</div>
          {lastResult && lastResult.numbers.length > 0 ? (
            <div className="advanced-result-grid">
              {lastResult.numbers.map((num, i) => {
                const name = lastResult.names[i] || "";
                const seatKey = lastResult.seats[i] || "";
                const gender = genderCache[seatKey] || "";
                return (
                  <div key={`${num}-${seatKey}`} className={`advanced-result-chip${gender ? " " + gender : ""}`}>
                    <div className="advanced-result-num">{num}</div>
                    <div className="advanced-result-name">{name}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="advanced-result-empty">点击「抽取」查看结果</div>
          )}
        </div>
      </div>
    );
  }

  const advancedHeader = (
    <div className="advanced-header">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div className="dialog-title">高级抽号</div>
        <span className="advanced-result-text">{resultText.includes("抽中") ? "✓" : ""}</span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button className="text-button" onClick={handleReimport} style={{ fontSize: 13, minWidth: 80, textAlign: "center" }}>
          重新导入
        </button>
        <span className="advanced-drawn-badge" onClick={() => setShowRecords(true)} style={{ cursor: "pointer" }}>已抽 {drawnHighlighted.length} 人</span>
      </div>
    </div>
  );

  const advancedBody = (
    <>
      {advancedHeader}
      <div className="advanced-body">
        {AdvancedGridPanel()}
        {AdvancedControlPanel()}
      </div>
      {rangePicker && (
        <RangePickerModal
          title={rangePicker.title}
          options={rangePicker.options}
          initialSelected={rangePicker.selected}
          onApply={applyRangePicker}
          onClose={() => setRangePicker(null)}
        />
      )}
      {showRecords && (
        <DrawnRecordsModal
          seatmap={sm}
          drawnKeys={drawnHighlighted}
          stuMap={stuMap}
          nameToNumber={nameToNumber}
          onClose={() => setShowRecords(false)}
        />
      )}
    </>
  );

  return standalone ? (
    <div className="standalone-advanced-inner">{advancedBody}</div>
  ) : (
    <div className="dialog-mask" ref={maskRef} onClick={onClose}>
      <div className="dialog advanced-dialog" onClick={(e) => e.stopPropagation()}>
        {advancedBody}
      </div>
    </div>
  );
  }

// ════════════════════════════════════════════
//  范围多选弹窗（Chip 样式重构）
// ════════════════════════════════════════════
interface RangePickerModalProps {
  title: string;
  options: { key: string; label: string }[];
  initialSelected: Set<string>;
  onApply: (selected: Set<string>) => void;
  onClose: () => void;
}

function RangePickerModal({ title, options, initialSelected, onApply, onClose }: RangePickerModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const maskRef = useRef<HTMLDivElement>(null);

  useEscToClose(true, onClose, maskRef);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function selectAll(on: boolean) {
    if (on) {
      setSelected(new Set(options.map((o) => o.key)));
    } else {
      setSelected(new Set());
    }
  }

  return (
    <div className="dialog-mask" ref={maskRef} onClick={onClose}>
      <div className="dialog range-picker-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="range-picker-header">
          <span className="range-picker-title">{title}</span>
          <span className="range-picker-count">已选 {selected.size}/{options.length}</span>
        </div>

        <div className="range-picker-body">
          <div className="range-picker-chips">
            {options.map((opt) => (
              <button
                key={opt.key}
                className={`range-chip ${selected.has(opt.key) ? "selected" : ""}`}
                onClick={() => toggle(opt.key)}
              >
                {opt.label}
              </button>
            ))}
            {options.length === 0 && (
              <div className="range-picker-empty">暂无选项</div>
            )}
          </div>
        </div>

        <div className="range-picker-footer">
          <button className="range-picker-quick-btn" onClick={() => selectAll(true)}>
            全选
          </button>
          <button className="range-picker-quick-btn" onClick={() => selectAll(false)}>
            全不选
          </button>
          <button className="range-picker-apply-btn" onClick={() => onApply(selected)}>
            确定 ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  抽号记录弹窗
// ════════════════════════════════════════════
interface DrawnRecordsModalProps {
  seatmap: SeatmapData;
  drawnKeys: string[];
  stuMap: Map<number, Student>;
  nameToNumber: Map<string, number>;
  onClose: () => void;
}

function DrawnRecordsModal({ seatmap, drawnKeys, stuMap, nameToNumber, onClose }: DrawnRecordsModalProps) {
  const maskRef = useRef<HTMLDivElement>(null);
  const records = useMemo(() => {
    return drawnKeys
      .map((sk) => {
        const info = seatmap.seats[sk];
        if (!info || !info[0]) return null;
        const name = info[0];
        const gender = normalizeGender(info[1] || "");
        const number = nameToNumber.get(name) || 0;
        const stu = stuMap.get(number);
        return { number, name, gender, stu };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.number > 0);
  }, [drawnKeys, seatmap, stuMap, nameToNumber]);

  useEscToClose(true, onClose, maskRef);

  return (
    <div className="dialog-mask" ref={maskRef} onClick={onClose}>
      <div className="dialog records-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="records-header">
          <div className="dialog-title">抽号记录</div>
          <button className="text-button" onClick={onClose}>关闭</button>
        </div>

        <div className="records-meta">
          <span>已抽 <b>{records.length}</b> 人</span>
        </div>

        <div className="records-body">
          {records.length === 0 ? (
            <div className="records-empty">暂无记录</div>
          ) : (
            <div className="records-grid">
              {records.map((r) => (
                <div
                  key={r.number}
                  className={`record-item${r.stu ? (r.stu.gender === "boy" ? " boy" : " girl") : ""}`}
                >
                  <div className="record-num">{r.number}</div>
                  {r.name && (
                    <div className="record-name">
                      {r.name}{r.gender === "boy" ? "♂" : r.gender === "girl" ? "♀" : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

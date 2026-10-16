import { logEvent, logDebug } from "./logger";

/**
 * 全局诊断模块：全量 debug 日志，用于现场排查「界面点不动」类问题。
 *
 * 记录内容：
 * - 每次按下/点击的命中目标（pointerdown + click，捕获阶段）：
 *   若日志里有 pointerdown 但界面无响应 → 点击被遮罩/命中测试吃掉；
 *   若连 pointerdown 都没有 → WebView2/系统输入层问题。
 * - 页面可见性、窗口焦点：被遮挡/最小化时 hidden，定时器会被节流。
 * - 定时器心跳：期望 10s 一次，实际偏差大 = 定时器被节流（动画卡死的首要嫌疑）。
 * - 未捕获异常与未处理的 Promise 拒绝。
 */

let installed = false;

function describeTarget(t: EventTarget | null): string {
  if (!(t instanceof Element)) return String(t);
  const tag = t.tagName.toLowerCase();
  const tour = t.getAttribute("data-tour");
  const cls =
    typeof t.className === "string" && t.className
      ? `.${t.className.trim().split(/\s+/).join(".")}`
      : "";
  const text = (t.textContent ?? "").trim().slice(0, 12);
  return `${tag}${cls}${tour ? `[data-tour=${tour}]` : ""}${text ? ` "${text}"` : ""}`;
}

export function installDiagnostics() {
  if (installed) return;
  installed = true;

  // 输入命中诊断（捕获阶段，确保在遮罩拦截前记录）
  window.addEventListener(
    "pointerdown",
    (e) => {
      logDebug(
        "input",
        `pointerdown (${Math.round(e.clientX)},${Math.round(e.clientY)}) → ${describeTarget(e.target)}`,
      );
    },
    true,
  );
  window.addEventListener(
    "click",
    (e) => {
      logDebug(
        "input",
        `click (${Math.round(e.clientX)},${Math.round(e.clientY)}) → ${describeTarget(e.target)}`,
      );
    },
    true,
  );

  // 页面可见性：WebView2 在窗口被遮挡/最小化时会把页面标记为 hidden 并节流定时器
  document.addEventListener("visibilitychange", () => {
    logEvent("window", `页面可见性 → ${document.visibilityState}`);
  });
  window.addEventListener("blur", () => logDebug("window", "窗口失去焦点"));
  window.addEventListener("focus", () => logDebug("window", "窗口获得焦点"));

  // 定时器心跳：setTimeout 期望 10s，实际间隔偏差大说明定时器被节流/挂起
  let lastBeat = performance.now();
  window.setInterval(() => {
    const now = performance.now();
    const interval = now - lastBeat;
    lastBeat = now;
    const drift = Math.round(interval - 10000);
    if (drift > 2000) {
      logEvent(
        "timer",
        `定时器心跳偏差 ${drift}ms（期望 10000ms，实际 ${Math.round(interval)}ms），定时器疑似被节流 hidden=${document.hidden} visibility=${document.visibilityState}`,
        "warn",
      );
    } else {
      logDebug("timer", `心跳正常，间隔 ${Math.round(interval)}ms`);
    }
  }, 10000);

  // 未捕获异常 / Promise 拒绝：任何静默失败都留痕
  window.addEventListener("error", (e) => {
    logEvent(
      "crash",
      `未捕获异常: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`,
      "error",
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    logEvent("crash", `未处理的 Promise 拒绝: ${String((e as PromiseRejectionEvent).reason)}`, "error");
  });

  logDebug("diag", "诊断模块已安装");
}

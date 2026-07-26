import { useEffect, useCallback, useRef, useState, useLayoutEffect } from "react";
import { useEscToClose } from "./useEscToClose";

export interface GuideStep {
  /** 要高亮的元素的 data-tour 值。不提供则居中显示气泡 */
  selector?: string;
  title: string;
  content: string;
  skipWarning?: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  showSkip?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
  /**
   * 气泡固定在屏幕顶部居中显示，不跟随目标位置。
   * 适用于会动态变大的目标（如"下课时间"添加时段后卡片增高），
   * 避免气泡被增长的目标推出视口。
   */
  centered?: boolean;
}

interface GuideProps {
  steps: GuideStep[];
  currentStep: number;
  onStepChange: (idx: number) => void;
  onComplete: () => void;
}

/** 超大目标至少需要有多少比例留在视口内 */
const MIN_VISIBLE_RATIO = 0.5;

function getVisibleRatio(rect: DOMRect, vw: number, vh: number) {
  const overlapW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
  const overlapH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
  const area = rect.width * rect.height;
  if (!area) return 0;
  return (overlapW * overlapH) / area;
}

export default function Guide({ steps, currentStep, onStepChange, onComplete }: GuideProps) {
  const stepIdx = Math.max(0, Math.min(currentStep, steps.length - 1));
  const step = steps[stepIdx];
  const isLast = stepIdx === steps.length - 1;

  const [rect, setRect] = useState<DOMRect | null>(null);
  const [skipWarning, setSkipWarning] = useState<string | null>(null);
  const [transitionEnabled, setTransitionEnabled] = useState(false);
  // 气泡自身尺寸（ResizeObserver 实时更新），用于精确 clamp
  const [bubbleSize, setBubbleSize] = useState({ w: 300, h: 220 });
  // 触发重渲染的视口尺寸快照（resize 时更新）
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleOffsetRef = useRef({ x: 0, y: 0 });
  const [bubbleOffset, setBubbleOffset] = useState({ x: 0, y: 0 });
  // 正在主动回滚目标时，避免与滚动监听形成循环
  const adjustingRef = useRef(false);
  // 切换步骤后的短暂时间内，不额外干预初始滚动动画
  const skipVisibilityCheckUntilRef = useRef(0);
  const skipMaskRef = useRef<HTMLDivElement>(null);

  useEscToClose(!!skipWarning, () => setSkipWarning(null), skipMaskRef);

  function scrollTarget(el: Element, block: ScrollLogicalPosition) {
    adjustingRef.current = true;
    // 用 auto 瞬间归位，避免 smooth scroll 与气泡/遮罩的 RAF 更新叠加导致卡顿；
    // 归位后由 CSS transition 负责把遮罩和气泡滑过去
    el.scrollIntoView({ behavior: "auto", block, inline: "nearest" });
    window.setTimeout(() => {
      adjustingRef.current = false;
    }, 300);
  }

  // 检测目标是否在视口内；若已滑出（或超大目标可见不足），平滑回滚
  function correctTargetVisibility() {
    if (!step?.selector) return;
    if (adjustingRef.current) return;
    if (Date.now() < skipVisibilityCheckUntilRef.current) return;

    const el = document.querySelector(`[data-tour="${step.selector}"]`);
    if (!el) return;
    const rect = el.getBoundingClientRect();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fullyVisible =
      rect.top >= -1 && rect.left >= -1 && rect.bottom <= vh + 1 && rect.right <= vw + 1;
    if (fullyVisible) return;

    const fitsInViewport = rect.height <= vh && rect.width <= vw;
    if (fitsInViewport) {
      // 目标在视口内放得下时，回到正中；
      // 使用 auto 让目标瞬间归位，再由 CSS transition 带动气泡/遮罩跟上，避免滚动动画叠加造成的卡顿
      scrollTarget(el, "center");
      return;
    }

    // 超大目标：只要求一定比例可见，低于阈值时把隐藏较多的一边滚进来
    if (getVisibleRatio(rect, vw, vh) >= MIN_VISIBLE_RATIO) return;

    const hiddenTop = Math.max(0, -rect.top);
    const hiddenBottom = Math.max(0, rect.bottom - vh);
    if (hiddenTop > hiddenBottom) {
      scrollTarget(el, "start");
    } else if (hiddenBottom > hiddenTop) {
      scrollTarget(el, "end");
    } else {
      scrollTarget(el, "center");
    }
  }

  // ── 测量目标位置：仅更新 rect ──
  const measure = useCallback(() => {
    if (!step?.selector) {
      setRect(null);
      return;
    }
    const el = document.querySelector(`[data-tour="${step.selector}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    setRect(el.getBoundingClientRect());
  }, [step]);

  // ── 切换步骤：滚动目标进入视口 + 测量 + 先关闭过渡 ──
  useLayoutEffect(() => {
    setTransitionEnabled(false);
    setBubbleOffset({ x: 0, y: 0 });
    bubbleOffsetRef.current = { x: 0, y: 0 };

    if (!step?.selector) {
      setRect(null);
      return;
    }
    const el = document.querySelector(`[data-tour="${step.selector}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    // 平滑滚动让目标进入视口中央；滚动期间由 scroll 监听持续更新 rect
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    skipVisibilityCheckUntilRef.current = Date.now() + 600;
    measure();

    // 滚动动画结束后再启用过渡，避免高亮框跨屏滑动
    const t = window.setTimeout(() => setTransitionEnabled(true), 450);
    return () => window.clearTimeout(t);
  }, [step, measure]);

  // ── 滚动时重新测量：让高亮框贴住目标 ──
  // 用捕获模式监听，因为 scroll 事件不冒泡，实际滚动容器是 .settings-scroll
  // 这类子元素，只有捕获阶段才能让 window 捕获到它的 scroll 事件
  useEffect(() => {
    let raf = 0;
    let scrollEndTimer = 0;
    let transitionTimer = 0;
    const onScroll = () => {
      // 滚动过程中关闭 transition，让遮罩/高亮框紧贴目标，避免动画拖影造成卡顿
      if (transitionEnabled) setTransitionEnabled(false);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => measure());
      // 滚动停止后先修正可见性，再打开 transition 做收尾动画
      window.clearTimeout(scrollEndTimer);
      window.clearTimeout(transitionTimer);
      scrollEndTimer = window.setTimeout(() => {
        correctTargetVisibility();
        transitionTimer = window.setTimeout(() => setTransitionEnabled(true), 50);
      }, 80);
    };
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    window.addEventListener("scroll", onScroll, opts);
    return () => {
      window.removeEventListener("scroll", onScroll, opts);
      cancelAnimationFrame(raf);
      window.clearTimeout(scrollEndTimer);
      window.clearTimeout(transitionTimer);
    };
  }, [measure, transitionEnabled]);

  // ── 窗口尺寸变化：更新视口快照 + 重置拖拽 + 重算 ──
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setViewport({ w: window.innerWidth, h: window.innerHeight });
        setBubbleOffset({ x: 0, y: 0 });
        bubbleOffsetRef.current = { x: 0, y: 0 };
        measure();
        correctTargetVisibility();
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [measure]);

  // ── 目标尺寸变化（如添加时段导致卡片增高）时重新测量并修正位置 ──
  useEffect(() => {
    if (!step?.selector) return;
    const el = document.querySelector(`[data-tour="${step.selector}"]`);
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        measure();
        correctTargetVisibility();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [step, measure]);

  // ── 引导期间禁止页面级滑动，避免整个界面被手势滑出视口 ──
  // 仍允许气泡内部、以及目标区域内可滚动容器的正常滚动
  useEffect(() => {
    const isInsideBubble = (target: EventTarget | null) => {
      return target instanceof Node && bubbleRef.current?.contains(target);
    };

    const findScrollableAncestor = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      let el: Element | null = target;
      while (el && el !== document.body && el !== document.documentElement) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        const canScrollY =
          (overflowY === "auto" || overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 1;
        const canScrollX =
          (overflowX === "auto" || overflowX === "scroll") &&
          el.scrollWidth > el.clientWidth + 1;
        if (canScrollY || canScrollX) return el as HTMLElement;
        el = el.parentElement;
      }
      return null;
    };

    const onTouchMove = (e: TouchEvent) => {
      const target = e.target;
      // 气泡可滚动时允许其内部滚动
      if (isInsideBubble(target)) {
        const bubble = bubbleRef.current;
        if (bubble && bubble.scrollHeight > bubble.clientHeight + 1) return;
      }
      // 目标区域内的可滚动容器（如设置页、时间范围列表）允许正常滚动
      if (findScrollableAncestor(target)) return;
      // 其余区域（遮罩、空白等）阻止滑动，防止整体界面被拖出视口
      e.preventDefault();
    };

    const opts: AddEventListenerOptions = { passive: false, capture: true };
    document.addEventListener("touchmove", onTouchMove as EventListener, opts);
    return () => {
      document.removeEventListener("touchmove", onTouchMove as EventListener, opts);
    };
  }, []);

  // ── 引导期间锁定根元素滚动/回弹，关闭后恢复 ──
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevHtmlOverscroll = html.style.overscrollBehavior;
    const prevBodyOverscroll = body.style.overscrollBehavior;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    body.style.overscrollBehavior = "none";

    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      html.style.overscrollBehavior = prevHtmlOverscroll;
      body.style.overscrollBehavior = prevBodyOverscroll;
    };
  }, []);

  // ── 气泡自身尺寸变化：更新 bubbleSize 用于精确 clamp ──
  useEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const ro = new ResizeObserver(() => {
      setBubbleSize({ w: bubble.offsetWidth, h: bubble.offsetHeight });
    });
    ro.observe(bubble);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    bubbleOffsetRef.current = bubbleOffset;
  }, [bubbleOffset]);

  function goTo(idx: number) {
    const next = Math.max(0, Math.min(idx, steps.length - 1));
    if (next !== stepIdx) {
      setSkipWarning(null);
      onStepChange(next);
    }
  }

  function handlePrimary() {
    if (step?.onPrimary) {
      step.onPrimary();
      return;
    }
    if (isLast) {
      onComplete();
    } else {
      goTo(stepIdx + 1);
    }
  }

  function handleAction() {
    if (step?.action) {
      step.action.onClick();
    }
  }

  function handleSkip() {
    if (step?.skipWarning) {
      setSkipWarning(step.skipWarning);
    } else {
      finishGuide();
    }
  }

  function finishGuide() {
    setSkipWarning(null);
    onComplete();
  }

  // 气泡拖拽：只更新 offset，最终位置由统一 clamp 兜底
  const handleDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startY = e.clientY;
    const startOffset = bubbleOffsetRef.current;

    const onMove = (ev: PointerEvent) => {
      const dx = startOffset.x + (ev.clientX - startX);
      const dy = startOffset.y + (ev.clientY - startY);
      setBubbleOffset({ x: dx, y: dy });
    };

    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, []);

  const hasSelector = !!step?.selector;
  const useCentered = step?.centered === true;

  // 高亮框（仅视觉，不阻挡事件）
  const highlightStyle: React.CSSProperties =
    rect && hasSelector
      ? {
          position: "fixed",
          left: rect.left - 6,
          top: rect.top - 6,
          width: rect.width + 12,
          height: rect.height + 12,
          borderRadius: 10,
          boxShadow: "0 0 0 2px rgba(255,255,255,0.35), 0 0 20px rgba(0,0,0,0.25)",
          transition: transitionEnabled ? "all 0.25s ease" : "none",
          zIndex: 10001,
          pointerEvents: "none",
          willChange: "top, left, width, height",
        }
      : { display: "none" };

  // ── 气泡定位：所有模式统一用中心点 left + translateX(-50%)，方便 clamp ──
  const vw = viewport.w;
  const vh = viewport.h;
  const pad = 12;
  const maxW = Math.min(340, vw - pad * 2);
  const bw = Math.min(bubbleSize.w, maxW);
  const bh = bubbleSize.h;
  const overlayTransition = transitionEnabled ? "all 0.25s ease" : "none";

  // 计算 base 中心点位置（不含拖拽偏移）
  let baseLeft: number; // 气泡水平中心
  let baseTop: number; // 气泡顶部

  if (!hasSelector || !rect) {
    // 无目标：屏幕正中央
    baseLeft = vw / 2;
    baseTop = (vh - bh) / 2;
  } else if (useCentered) {
    // centered：顶部水平居中
    baseLeft = vw / 2;
    baseTop = pad;
  } else {
    // 跟随：目标下方优先，其次上方，最后视口中央
    const spaceBelow = vh - rect.bottom - pad;
    const spaceAbove = rect.top - pad;
    if (spaceBelow >= bh) {
      baseTop = rect.bottom + pad;
    } else if (spaceAbove >= bh) {
      baseTop = rect.top - pad - bh;
    } else {
      baseTop = Math.max(pad, (vh - bh) / 2);
    }
    baseLeft = rect.left + rect.width / 2;
  }

  // 叠加拖拽偏移
  let left = baseLeft + bubbleOffset.x;
  let top = baseTop + bubbleOffset.y;

  // 统一 clamp 到视口内（碰到边缘就限制住）
  const halfW = bw / 2;
  left = Math.max(pad + halfW, Math.min(left, vw - pad - halfW));
  top = Math.max(pad, Math.min(top, vh - bh - pad));

  const bubbleStyle: React.CSSProperties = {
    position: "fixed",
    left,
    top,
    transform: "translateX(-50%)",
    maxWidth: `${maxW}px`,
    zIndex: 10002,
  };

  const showSkip = step?.showSkip !== false && !isLast;

  return (
    <div>
      {/* 全屏暗色遮罩：有目标时挖洞高亮，无目标时整屏覆盖 */}
      {rect && hasSelector ? (
        <>
          <div
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              right: 0,
              height: Math.max(0, rect.top - 6),
              background: "rgba(0,0,0,0.5)",
              zIndex: 10000,
              pointerEvents: "auto",
              transition: overlayTransition,
            }}
          />
          <div
            style={{
              position: "fixed",
              left: 0,
              bottom: 0,
              right: 0,
              height: Math.max(0, vh - rect.bottom - 6),
              background: "rgba(0,0,0,0.5)",
              zIndex: 10000,
              pointerEvents: "auto",
              transition: overlayTransition,
            }}
          />
          <div
            style={{
              position: "fixed",
              left: 0,
              top: rect.top - 6,
              width: Math.max(0, rect.left - 6),
              height: rect.height + 12,
              background: "rgba(0,0,0,0.5)",
              zIndex: 10000,
              pointerEvents: "auto",
              transition: overlayTransition,
            }}
          />
          <div
            style={{
              position: "fixed",
              right: 0,
              top: rect.top - 6,
              width: Math.max(0, vw - rect.right - 6),
              height: rect.height + 12,
              background: "rgba(0,0,0,0.5)",
              zIndex: 10000,
              pointerEvents: "auto",
              transition: overlayTransition,
            }}
          />
        </>
      ) : (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 10000,
            pointerEvents: "auto",
          }}
        />
      )}

      {/* 高亮框（视觉层） */}
      <div style={highlightStyle} />

      {/* 气泡 */}
      <div ref={bubbleRef} style={bubbleStyle} className="guide-bubble">
        <div className="guide-drag-handle" onPointerDown={handleDragStart} title="拖动气泡">
          <div className="guide-drag-grip" />
        </div>
        <div className="guide-progress">
          {stepIdx + 1} / {steps.length}
        </div>
        <div className="guide-title">{step?.title}</div>
        <div className="guide-content">{step?.content}</div>

        {step?.action && (
          <div style={{ marginBottom: 14 }}>
            <button className="guide-btn secondary" onClick={handleAction}>
              {step.action.label}
            </button>
          </div>
        )}

        <div className="guide-actions">
          {showSkip && (
            <button className="guide-btn skip" onClick={handleSkip}>
              跳过引导
            </button>
          )}
          {stepIdx > 0 && (
            <button className="guide-btn secondary" onClick={() => goTo(stepIdx - 1)}>
              上一步
            </button>
          )}
          <button className="guide-btn primary" onClick={handlePrimary}>
            {step?.primaryLabel || (isLast ? "完成" : "下一步")}
          </button>
        </div>
      </div>

      {/* 跳过确认 */}
      {skipWarning && (
        <div className="dialog-mask" ref={skipMaskRef} style={{ zIndex: 10003 }} onClick={() => setSkipWarning(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">跳过引导？</div>
            <div className="dialog-message">{skipWarning}</div>
            <div className="dialog-actions">
              <button className="dialog-btn secondary" onClick={() => setSkipWarning(null)}>
                取消
              </button>
              <button className="dialog-btn primary" onClick={finishGuide}>
                确认跳过
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

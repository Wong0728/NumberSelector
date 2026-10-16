import { useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "./api";
import { logEvent } from "./logger";

/**
 * 窗口状态记忆 Hook：监听 resize 并防抖保存到后端。
 *
 * 启动时的窗口位置/尺寸恢复已由 Rust 端 setup 在窗口 show 之前完成，
 * 前端不再重复设置，避免「先默认位置显示再被移动」的视觉跳跃。
 *
 * onMinimize 在窗口最小化时触发（用于主窗口切换到悬浮窗）。
 */
export function useWindowState(key: "draw" | "settings", onMinimize?: () => void) {
  const cbRef = useRef(onMinimize);
  cbRef.current = onMinimize;

  useEffect(() => {
    let unlistenResize: (() => void) | null = null;
    let disposed = false;
    let lastMinimized = false;
    let saveTimer: number | null = null;
    let lastStateSig = "";

    (async () => {
      try {
        const win = getCurrentWebviewWindow();

        unlistenResize = await win.onResized(async () => {
          if (disposed) return;
          try {
            const minimized = await win.isMinimized();
            if (minimized && !lastMinimized) {
              lastMinimized = true;
              try { cbRef.current?.(); } catch (err) { console.warn(`[${key}] onMinimize failed:`, err); }
            } else if (!minimized) {
              lastMinimized = false;
            }
            if (saveTimer) window.clearTimeout(saveTimer);
            saveTimer = window.setTimeout(async () => {
              try {
                const maximized = await win.isMaximized();
                // 窗口状态变化留痕：与「最大化后点不动」类现场问题建立时间线关联
                const stateSig = `min=${minimized} max=${maximized}`;
                if (stateSig !== lastStateSig) {
                  lastStateSig = stateSig;
                  logEvent("window", `[${key}] 窗口状态变化：minimized=${minimized} maximized=${maximized}`);
                }
                const factor = await win.scaleFactor().catch(() => 1);
                const size = await win.outerSize();
                const pos = await win.outerPosition();
                const cur = {
                  x: Math.round(pos.x / factor),
                  y: Math.round(pos.y / factor),
                  width: Math.round(size.width / factor),
                  height: Math.round(size.height / factor),
                  maximized,
                };
                // 最大化或最小化时保留上次正常尺寸，只更新 maximized 标记
                if (maximized || minimized) {
                  const prev = await api.getWindowState(key);
                  if (prev && prev.width > 0 && prev.height > 0) {
                    await api.saveWindowState(key, { ...prev, maximized });
                    return;
                  }
                }
                await api.saveWindowState(key, cur);
              } catch (e) { console.warn(`[${key}] 保存窗口状态失败:`, e); }
            }, 500);
          } catch (e) { console.warn(`[${key}] onResized error:`, e); }
        });
        if (disposed && unlistenResize) {
          unlistenResize();
          unlistenResize = null;
        }
      } catch (e) { console.warn(`[${key}] resize 监听设置失败:`, e); }
    })();

    return () => {
      disposed = true;
      if (unlistenResize) unlistenResize();
      if (saveTimer) window.clearTimeout(saveTimer);
    };
  }, [key]);
}

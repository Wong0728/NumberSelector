import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { emit, listen, Event } from "@tauri-apps/api/event";
import { api } from "./api";

export type ThemeSetting = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

function isThemeSetting(v: string): v is ThemeSetting {
  return v === "light" || v === "dark" || v === "system";
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

/** 主题管理 Hook：支持 light / dark / system，应用 data-theme 到 <html> */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeSetting>(() => {
    try {
      const cached = localStorage.getItem("theme");
      if (cached && isThemeSetting(cached)) return cached;
    } catch {}
    return "system";
  });
  const themeRef = useRef<ThemeSetting>(theme);
  // 后端首次同步是否已完成：完成前不回写后端/不广播，
  // 避免用 localStorage 缓存值覆盖别的窗口刚改过的主题
  const hydratedRef = useRef(false);

  const resolvedTheme = useMemo<ResolvedTheme>(
    () => (theme === "system" ? getSystemTheme() : theme),
    [theme]
  );

  const apply = useCallback((setting: ThemeSetting) => {
    const resolved = setting === "system" ? getSystemTheme() : setting;
    applyTheme(resolved);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const t = await api.getTheme();
        const initial: ThemeSetting = isThemeSetting(t) ? t : "system";
        themeRef.current = initial;
        setThemeState(initial);
        apply(initial);
        try { localStorage.setItem("theme", initial); } catch {}
      } catch {
        apply("system");
      } finally {
        hydratedRef.current = true;
      }
    })();
  }, [apply]);

  useEffect(() => {
    themeRef.current = theme;
    apply(theme);
    try { localStorage.setItem("theme", theme); } catch {}
    if (!hydratedRef.current) return;
    api.saveTheme(theme).catch(() => console.warn("保存主题失败"));
    emit("theme-changed", theme).catch(() => {});
  }, [theme, apply]);

  // 监听其他窗口的主题变更，实现设置页与抽号页实时同步
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>("theme-changed", (event: Event<string>) => {
      const t = event.payload;
      if (isThemeSetting(t) && t !== themeRef.current) {
        themeRef.current = t;
        setThemeState(t);
        apply(t);
        try { localStorage.setItem("theme", t); } catch {}
      }
    }).then((fn) => {
      // 若组件已卸载则立即取消注册，避免泄漏
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [apply]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (themeRef.current === "system") {
        apply("system");
      }
    };
    if (mq.addEventListener) {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    } else {
      mq.addListener(onChange);
      return () => mq.removeListener(onChange);
    }
  }, [apply]);

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeState(next);
  }, []);

  return { theme, resolvedTheme, setTheme };
}

function applyTheme(t: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", t);
}

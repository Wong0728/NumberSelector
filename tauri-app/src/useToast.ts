import { useRef, useState, useCallback, useEffect } from "react";
import type { ToastState, ToastType } from "./ui";

/** Toast Hook：自动管理定时清除与卸载时清理 */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback(
    (msg: string, type: ToastType = "info", duration = 2500) => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast({ msg, type, id: Date.now() });
      toastTimer.current = window.setTimeout(() => setToast(null), duration);
    },
    []
  );

  // 卸载时清理定时器，防止内存泄漏
  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  return { toast, showToast, setToast };
}

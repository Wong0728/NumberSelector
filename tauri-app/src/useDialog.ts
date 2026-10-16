import { useState, useCallback, useEffect } from "react";
import type { DialogState, PromptState } from "./ui";
import { logEvent, logDebug } from "./logger";

/** Dialog Hook：管理 Yes/No 对话框与文本输入对话框，卸载时自动解决未完成的 Promise */
export function useDialog() {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptDialog, setPromptDialog] = useState<PromptState | null>(null);

  const askYesNo = useCallback(
    (title: string, message: string): Promise<boolean> =>
      new Promise((resolve) => {
        // 包一层收尾日志：无论按钮点击、点遮罩还是 Esc 收尾都能留痕
        const wrappedResolve = (v: boolean) => {
          logEvent("dialog", `询问框「${title}」收尾：${v ? "确定" : "取消"}`);
          resolve(v);
        };
        setDialog((prev) => {
          // 旧对话框以「取消」收尾，避免上一个 await 永挂（如抽号流程卡死在 drawing）
          if (prev) {
            logEvent("dialog", `替换未收尾的旧询问框「${prev.title}」，按取消收尾`, "warn");
            prev.resolve(false);
          }
          logEvent("dialog", `打开询问框：${title}`);
          return { title, message, resolve: wrappedResolve };
        });
      }),
    []
  );

  const askText = useCallback(
    (title: string, defaultValue = ""): Promise<string | null> =>
      new Promise((resolve) => {
        const wrappedResolve = (v: string | null) => {
          logEvent("dialog", `输入框「${title}」收尾：${v === null ? "取消" : `输入 ${v.length} 字`}`);
          resolve(v);
        };
        setPromptDialog((prev) => {
          // 同上：先收尾旧对话框再替换
          if (prev) {
            logEvent("dialog", `替换未收尾的旧输入框「${prev.title}」，按取消收尾`, "warn");
            prev.resolve(null);
          }
          logEvent("dialog", `打开输入框：${title}`);
          return { title, value: defaultValue, resolve: wrappedResolve };
        });
      }),
    []
  );

  // 卸载时解决未完成的对话框，防止调用方 Promise 永挂
  useEffect(() => {
    return () => {
      setDialog((prev) => {
        if (prev) {
          logEvent("dialog", `组件卸载，未收尾的询问框「${prev.title}」按取消收尾`, "warn");
          prev.resolve(false);
        }
        return null;
      });
      setPromptDialog((prev) => {
        if (prev) {
          logEvent("dialog", `组件卸载，未收尾的输入框「${prev.title}」按取消收尾`, "warn");
          prev.resolve(null);
        }
        return null;
      });
    };
  }, []);

  // 对话框可见状态变化时留痕（隐形/残留遮罩排查）
  useEffect(() => {
    if (dialog || promptDialog) {
      logDebug(
        "dialog",
        `对话框可见 dialog=${dialog ? `「${dialog.title}」` : "无"} prompt=${promptDialog ? `「${promptDialog.title}」` : "无"}`,
      );
    }
  }, [dialog, promptDialog]);

  return {
    dialog,
    setDialog,
    askYesNo,
    promptDialog,
    setPromptDialog,
    askText,
  };
}

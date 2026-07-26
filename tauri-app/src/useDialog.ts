import { useState, useCallback, useEffect } from "react";
import type { DialogState, PromptState } from "./ui";

/** Dialog Hook：管理 Yes/No 对话框与文本输入对话框，卸载时自动解决未完成的 Promise */
export function useDialog() {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptDialog, setPromptDialog] = useState<PromptState | null>(null);

  const askYesNo = useCallback(
    (title: string, message: string): Promise<boolean> =>
      new Promise((resolve) => setDialog({ title, message, resolve })),
    []
  );

  const askText = useCallback(
    (title: string, defaultValue = ""): Promise<string | null> =>
      new Promise((resolve) =>
        setPromptDialog({ title, value: defaultValue, resolve })
      ),
    []
  );

  // 卸载时解决未完成的对话框，防止调用方 Promise 永挂
  useEffect(() => {
    return () => {
      setDialog((prev) => {
        if (prev) prev.resolve(false);
        return null;
      });
      setPromptDialog((prev) => {
        if (prev) prev.resolve(null);
        return null;
      });
    };
  }, []);

  return {
    dialog,
    setDialog,
    askYesNo,
    promptDialog,
    setPromptDialog,
    askText,
  };
}

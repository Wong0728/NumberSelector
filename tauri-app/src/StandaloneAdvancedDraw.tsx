import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api, Student } from "./api";
import AdvancedDraw from "./AdvancedDraw";
import { useTheme } from "./useTheme";
import { useToast } from "./useToast";
import { useDialog } from "./useDialog";
import { Toast } from "./Toast";
import { YesNoDialog } from "./Dialog";

export default function StandaloneAdvancedDraw() {
  const [students, setStudents] = useState<Student[]>([]);
  const [studentsLoaded, setStudentsLoaded] = useState(false);

  useTheme();
  const { toast, showToast } = useToast();
  const { dialog, setDialog, askYesNo } = useDialog();

  // 加载学生数据；并轮询数据版本号，设置端（独立进程）改名单后自动刷新
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await api.getStudents();
        if (cancelled) return;
        setStudents(st);
      } catch (e) {
        console.error("加载学生数据失败:", e);
      } finally {
        if (!cancelled) setStudentsLoaded(true);
      }
    })();

    let lastVersion: number | null = null;
    const timer = window.setInterval(async () => {
      try {
        const v = await api.getDataVersion();
        if (cancelled) return;
        if (lastVersion !== null && v !== lastVersion) {
          const st = await api.getStudents();
          if (cancelled) return;
          setStudents(st);
        }
        lastVersion = v;
      } catch {
        // 轮询失败静默跳过，下一轮重试
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 窗口最小化：拦截 → 隐藏当前高级窗口并显示悬浮窗（点击悬浮窗时统一打开主抽号）
  useEffect(() => {
    let unlistenResize: (() => void) | null = null;
    let processing = false;
    let disposed = false;
    (async () => {
      try {
        const currentWin = getCurrentWebviewWindow();
        const fn = await currentWin.onResized(async () => {
          if (processing) return;
          processing = true;
          try {
            const minimized = await currentWin.isMinimized();
            if (!minimized) {
              processing = false;
              return;
            }
            // 先取消最小化以便下次再次触发，且立即隐藏窗口
            try {
              await currentWin.unminimize();
            } catch (e) { console.warn("[advanced] unminimize failed:", e); }
            try {
              await currentWin.hide();
            } catch (e) { console.warn("[advanced] hide failed:", e); }
            try {
              await invoke("advanced_minimize_to_float");
            } catch (err) {
              console.warn("[advanced] advanced_minimize_to_float failed:", err);
            }
            // 短暂延时，避免连续触发
            setTimeout(() => {
              processing = false;
            }, 300);
          } catch (e) {
            console.warn("[advanced] onResized error:", e);
            processing = false;
          }
        });
        // 注册完成前组件已卸载：立即解绑，避免泄漏
        if (disposed) {
          fn();
          return;
        }
        unlistenResize = fn;
      } catch (e) { console.warn("[advanced] resize listener setup failed:", e); }
    })();
    return () => {
      disposed = true;
      if (unlistenResize) unlistenResize();
    };
  }, []);

  async function handleClose() {
    // 关闭前解决未完成的对话框，防止 askYesNo 调用方永挂
    setDialog((prev) => {
      if (prev) prev.resolve(false);
      return null;
    });
    try {
      await getCurrentWebviewWindow().close();
    } catch (e) { console.warn("[advanced] close failed:", e); }
  }

  async function handleBackToMain() {
    setDialog((prev) => {
      if (prev) prev.resolve(false);
      return null;
    });
    try {
      await invoke("show_main_window");
    } catch (e) { console.warn("[advanced] show_main_window failed:", e); }
  }

  if (!studentsLoaded) {
    return (
      <div className="standalone-advanced">
        <div
          style={{
            margin: "auto",
            color: "var(--text-hint)",
            fontSize: 16,
          }}
        >
          加载中…
        </div>
      </div>
    );
  }

  return (
    <div className="standalone-advanced">
      <div className="advanced-topbar">
        <button
          className="text-button"
          onClick={handleBackToMain}
          title="返回抽号主界面"
        >
          ← 返回主抽号
        </button>
        <button
          className="text-button"
          onClick={handleClose}
          title="关闭窗口"
        >
          关闭窗口
        </button>
      </div>
      <AdvancedDraw
        students={students}
        onClose={handleClose}
        showToast={showToast}
        askYesNo={askYesNo}
        standalone
      />

      <Toast toast={toast} />
      {dialog && (
        <YesNoDialog dialog={dialog} setDialog={setDialog} />
      )}
    </div>
  );
}

import { useRef } from "react";
import type { CSSProperties } from "react";
import type { DialogState, PromptState } from "./ui";
import { useEscToClose } from "./useEscToClose";

interface CommonProps {
  /** 首次运行引导时需要更高的 z-index 覆盖 */
  zIndexOverride?: number;
}

/** Yes/No 确认对话框 */
export function YesNoDialog({
  dialog,
  setDialog,
  zIndexOverride,
}: {
  dialog: DialogState;
  setDialog: (v: null) => void;
} & CommonProps) {
  const maskRef = useRef<HTMLDivElement>(null);

  function handleCancel() {
    dialog.resolve(false);
    setDialog(null);
  }

  useEscToClose(true, handleCancel, maskRef);

  const style: CSSProperties | undefined =
    zIndexOverride != null ? { zIndex: zIndexOverride } : undefined;
  return (
    <div className="dialog-mask" ref={maskRef} style={style} onClick={handleCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{dialog.title}</div>
        <div className="dialog-message">{dialog.message}</div>
        <div className="dialog-actions">
          <button className="dialog-btn secondary" onClick={handleCancel}>
            取消
          </button>
          <button
            className="dialog-btn primary"
            onClick={() => {
              dialog.resolve(true);
              setDialog(null);
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 文本输入对话框 */
export function PromptDialog({
  prompt,
  setPrompt,
  zIndexOverride,
}: {
  prompt: PromptState;
  setPrompt: (v: PromptState | null) => void;
} & CommonProps) {
  const maskRef = useRef<HTMLDivElement>(null);

  function handleCancel() {
    prompt.resolve(null);
    setPrompt(null);
  }

  useEscToClose(true, handleCancel, maskRef);

  const style: CSSProperties | undefined =
    zIndexOverride != null ? { zIndex: zIndexOverride } : undefined;
  return (
    <div className="dialog-mask" ref={maskRef} style={style} onClick={handleCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{prompt.title}</div>
        <input
          className="settings-inp"
          style={{ margin: "10px 0", width: "100%" }}
          autoFocus
          value={prompt.value}
          onChange={(e) =>
            setPrompt({ ...prompt, value: e.target.value })
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const val = prompt.value.trim();
              prompt.resolve(val || null);
              setPrompt(null);
            }
          }}
        />
        <div className="dialog-actions">
          <button className="dialog-btn secondary" onClick={handleCancel}>
            取消
          </button>
          <button
            className="dialog-btn primary"
            onClick={() => {
              const val = prompt.value.trim();
              prompt.resolve(val || null);
              setPrompt(null);
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

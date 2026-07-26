import { useEffect } from "react";

/**
 * 模态对话框按 Esc 关闭。
 *
 * 多个模态叠加时，只关闭 DOM 中最后一个（最顶层）的 .dialog-mask 对应的模态，
 * 避免一次 Esc 把所有层全部关闭。
 *
 * @param active 是否激活监听（通常等于模态是否打开）
 * @param onClose 关闭回调
 * @param maskRef 当前模态遮罩元素的 ref，用于判断是否为最顶层
 */
export function useEscToClose(
  active: boolean,
  onClose: () => void,
  maskRef: React.RefObject<HTMLElement>,
) {
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const masks = document.querySelectorAll<HTMLElement>(".dialog-mask");
      if (!masks.length) return;
      const topmost = masks[masks.length - 1];
      if (maskRef.current !== topmost) return;
      e.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose, maskRef]);
}

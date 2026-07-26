import type { ToastState } from "./ui";

/** Toast 浮层组件 */
export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return <div className={`toast ${toast.type}`}>{toast.msg}</div>;
}

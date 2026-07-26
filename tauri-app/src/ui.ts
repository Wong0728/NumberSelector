/** 共享 UI 类型定义（Toast / Dialog） */

export type ToastType = "info" | "success" | "error" | "warning";

export interface ToastState {
  msg: string;
  type: ToastType;
  id: number;
}

export interface DialogState {
  title: string;
  message: string;
  resolve: (v: boolean) => void;
}

export interface PromptState {
  title: string;
  value: string;
  resolve: (v: string | null) => void;
}

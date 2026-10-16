import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 统一日志：同时输出到控制台和后端 app.log（<数据目录>/app.log），便于现场排查 */
export function logEvent(category: string, message: string, level: LogLevel = "info") {
  const line = `[${category}] ${message}`;
  if (level === "debug") console.debug(line);
  else if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
  invoke("log_event", { level, category, message }).catch(() => {});
}

/** debug 级别：全量过程记录，现场排查用 */
export function logDebug(category: string, message: string) {
  logEvent(category, message, "debug");
}

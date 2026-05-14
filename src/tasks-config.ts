// <cwd>/.pi/tasks-config.json — persists extension settings across sessions

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AutoMode = "off" | "cascade" | "auto";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  /**
   * @deprecated Use {@link autoMode} instead. Retained so older configs keep
   * working — `autoCascade: true` is read as `autoMode: "cascade"`.
   */
  autoCascade?: boolean;
  /**
   * Auto-advance behavior. Default: "off".
   * - "off"     — never auto-queue follow-up prompts.
   * - "cascade" — silently queue the next open unblocked task after completion
   *               or agent idle. Capped per task to prevent runaway loops.
   * - "auto"    — like cascade, but when an in_progress task is still open at
   *               agent idle, ask the user (complete / continue / stop) instead
   *               of silently retrying. Auto-disables when everything is done.
   */
  autoMode?: AutoMode;
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
}

const CONFIG_PATH = join(process.cwd(), ".pi", "tasks-config.json");

export function loadTasksConfig(): TasksConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch { return {}; }
}

export function saveTasksConfig(config: TasksConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Resolve the effective auto-advance mode, honoring the legacy
 * `autoCascade` boolean for configs written by older versions.
 */
export function getAutoMode(config: TasksConfig): AutoMode {
  if (config.autoMode) return config.autoMode;
  if (config.autoCascade === true) return "cascade";
  return "off";
}

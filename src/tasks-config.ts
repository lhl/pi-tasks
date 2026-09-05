// <agent-dir>/tasks-config.json provides global defaults.
// <workspace>/.pi/tasks-config.json provides project overrides.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type AutoMode = "off" | "cascade" | "auto";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "session-global" | "project";  // default: "session"
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
  collapseCompleted?: boolean;  // default: false
  maxVisible?: number;          // default: 10
}

function readTasksConfig(configPath: string): TasksConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as TasksConfig
      : {};
  } catch {
    return {};
  }
}

export function loadGlobalTasksConfig(agentDir = getAgentDir()): TasksConfig {
  return readTasksConfig(join(agentDir, "tasks-config.json"));
}

export function loadTasksConfig(cwd: string, agentDir = getAgentDir()): TasksConfig {
  return {
    ...loadGlobalTasksConfig(agentDir),
    ...readTasksConfig(join(cwd, ".pi", "tasks-config.json")),
  };
}

export function saveTasksConfig(config: TasksConfig, cwd: string, agentDir = getAgentDir()): void {
  const configPath = join(cwd, ".pi", "tasks-config.json");
  const globalConfig = loadGlobalTasksConfig(agentDir);
  const projectOverrides = Object.fromEntries(
    Object.entries(config).filter(([key, value]) => globalConfig[key as keyof TasksConfig] !== value),
  );
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectOverrides, null, 2));
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

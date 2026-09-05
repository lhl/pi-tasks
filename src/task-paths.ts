import { existsSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TasksConfig } from "./tasks-config.js";

type TaskScope = NonNullable<TasksConfig["taskScope"]>;

/** Name a workspace the same way Pi names its session-log directory. */
export function projectKey(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Directory for session task files stored outside the workspace. */
export function globalSessionTasksDir(cwd: string): string {
  return join(getAgentDir(), "tasks", "sessions", projectKey(cwd));
}

/** Existing per-session storage location inside a workspace. */
export function workspaceSessionTaskFile(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

/**
 * Resolve a persisted session task file.
 *
 * `session-global` keeps new files under Pi's agent directory but continues to
 * use an existing workspace file for the same session. Changing the setting
 * therefore does not move or strand task state.
 */
export function sessionTaskFile(cwd: string, sessionId: string, scope: TaskScope): string {
  const inWorkspace = workspaceSessionTaskFile(cwd, sessionId);
  if (scope !== "session-global") return inWorkspace;
  return existsSync(inWorkspace) ? inWorkspace : join(globalSessionTasksDir(cwd), `tasks-${sessionId}.json`);
}

/** Remove an empty per-workspace directory from the session-global task tree. */
export function reclaimGlobalSessionTasksDir(cwd: string): void {
  try { rmdirSync(globalSessionTasksDir(cwd)); } catch { /* another session file remains */ }
}

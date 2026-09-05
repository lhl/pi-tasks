import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  globalSessionTasksDir,
  projectKey,
  sessionTaskFile,
  workspaceSessionTaskFile,
} from "../src/task-paths.js";

const scratch: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tasks-paths-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("projectKey", () => {
  it("names a workspace the way Pi names its session-log directory", () => {
    expect(projectKey("/Users/me/work/repo")).toBe("--Users-me-work-repo--");
  });

  it("keeps different workspaces apart", () => {
    expect(projectKey("/Users/me/a")).not.toBe(projectKey("/Users/me/b"));
  });
});

describe("session task paths", () => {
  it("keeps default session files in the workspace", () => {
    expect(sessionTaskFile("/Users/me/work/repo", "abc", "session"))
      .toBe(join("/Users/me/work/repo", ".pi", "tasks", "tasks-abc.json"));
  });

  it("keeps new session-global files under Pi's agent directory", () => {
    const cwd = scratchDir();
    const agentDir = scratchDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    expect(sessionTaskFile(cwd, "abc", "session-global"))
      .toBe(join(agentDir, "tasks", "sessions", projectKey(cwd), "tasks-abc.json"));
  });

  it("continues using an existing workspace file in session-global mode", () => {
    const cwd = scratchDir();
    const existing = workspaceSessionTaskFile(cwd, "abc");
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, JSON.stringify({ nextId: 1, tasks: [] }));

    expect(sessionTaskFile(cwd, "abc", "session-global")).toBe(existing);
  });

  it("keeps different workspaces in different agent-directory paths", () => {
    const first = scratchDir();
    const second = scratchDir();
    const agentDir = scratchDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    expect(globalSessionTasksDir(first)).not.toBe(globalSessionTasksDir(second));
  });
});

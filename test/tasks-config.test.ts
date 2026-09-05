import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAutoMode, loadGlobalTasksConfig, loadTasksConfig, saveTasksConfig } from "../src/tasks-config.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("tasks config", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let globalConfigPath: string;
  let projectConfigPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-tasks-config-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    globalConfigPath = join(agentDir, "tasks-config.json");
    projectConfigPath = join(cwd, ".pi", "tasks-config.json");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty config when no files exist", () => {
    expect(loadTasksConfig(cwd, agentDir)).toEqual({});
  });

  it("loads global defaults from the agent directory", () => {
    writeJson(globalConfigPath, { autoMode: "cascade", maxVisible: 20 });

    expect(loadGlobalTasksConfig(agentDir)).toEqual({ autoMode: "cascade", maxVisible: 20 });
    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoMode: "cascade", maxVisible: 20 });
  });

  it("merges project overrides over global defaults", () => {
    writeJson(globalConfigPath, { autoMode: "cascade", maxVisible: 20, taskScope: "session-global" });
    writeJson(projectConfigPath, { autoMode: "off", maxVisible: 10 });

    expect(loadTasksConfig(cwd, agentDir)).toEqual({
      autoMode: "off",
      maxVisible: 10,
      taskScope: "session-global",
    });
  });

  it("ignores malformed and non-object config values", () => {
    writeFileSync(globalConfigPath, "{");
    writeJson(projectConfigPath, ["not", "a", "config"]);

    expect(loadTasksConfig(cwd, agentDir)).toEqual({});
  });

  it("falls back to global defaults when the project config is malformed", () => {
    writeJson(globalConfigPath, { autoMode: "auto" });
    mkdirSync(dirname(projectConfigPath), { recursive: true });
    writeFileSync(projectConfigPath, "{");

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoMode: "auto" });
  });

  it("saves only values that differ from global defaults", () => {
    writeJson(globalConfigPath, { autoMode: "cascade", maxVisible: 20 });

    saveTasksConfig({ autoMode: "cascade", maxVisible: 30, collapseCompleted: false }, cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({
      maxVisible: 30,
      collapseCompleted: false,
    });
    expect(JSON.parse(readFileSync(globalConfigPath, "utf-8"))).toEqual({ autoMode: "cascade", maxVisible: 20 });
  });

  it("preserves project overrides across save and reload cycles", () => {
    writeJson(globalConfigPath, { autoMode: "cascade", maxVisible: 20 });
    const config = loadTasksConfig(cwd, agentDir);
    config.autoMode = "off";
    saveTasksConfig(config, cwd, agentDir);

    const reloaded = loadTasksConfig(cwd, agentDir);
    expect(reloaded).toEqual({ autoMode: "off", maxVisible: 20 });
    reloaded.maxVisible = 30;
    saveTasksConfig(reloaded, cwd, agentDir);

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoMode: "off", maxVisible: 30 });
  });

  it("writes an empty project object when settings match global defaults", () => {
    writeJson(globalConfigPath, { taskScope: "session-global", collapseCompleted: true });

    saveTasksConfig(loadTasksConfig(cwd, agentDir), cwd, agentDir);

    expect(existsSync(projectConfigPath)).toBe(true);
    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({});
  });

  it("prefers autoMode over the legacy autoCascade setting", () => {
    expect(getAutoMode({ autoCascade: true })).toBe("cascade");
    expect(getAutoMode({ autoCascade: true, autoMode: "off" })).toBe("off");
  });
});

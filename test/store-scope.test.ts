import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { globalSessionTasksDir, sessionTaskFile, workspaceSessionTaskFile } from "../src/task-paths.js";
import { TaskStore } from "../src/task-store.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tasks-config.js")>("../src/tasks-config.js");
  return {
    ...actual,
    loadGlobalTasksConfig: () => ({ ...config.current }),
    loadTasksConfig: () => ({ ...config.current }),
    saveTasksConfig: () => {},
  };
});

function mockCtx(cwd: string, sessionId = "s1", persisted = true) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      getSessionFile: () => persisted ? join(cwd, `${sessionId}.jsonl`) : undefined,
    },
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      confirm: vi.fn(async () => false),
    },
  };
}

function mockPi() {
  const tools = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const bus = new EventEmitter();
  const pi = {
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand() {},
    registerMarkdownTransformer() {},
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(event: string, data: unknown) { bus.emit(event, data); },
      on(event: string, handler: (data: unknown) => void) {
        bus.on(event, handler);
        return () => { bus.off(event, handler); };
      },
    },
    sendUserMessage: vi.fn(),
  };
  return {
    pi,
    async fireLifecycle(event: string, ...args: any[]) {
      for (const handler of lifecycleHandlers.get(event) ?? []) await handler(...args);
    },
    async executeTool(name: string, params: any, ctx: any) {
      return tools.get(name).execute("call-1", params, undefined, undefined, ctx);
    },
  };
}

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-tasks-scope-"));
  cwd = join(root, "workspace");
  agentDir = join(root, "agent");
  config.current = {};
  delete process.env.PI_TASKS;
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.PI_TASKS;
  rmSync(root, { recursive: true, force: true });
});

describe("workspace-aware task storage", () => {
  it("renews native-widget claims on session changes and releases them on shutdown", async () => {
    config.current = { taskScope: "project", widgetVisible: true };
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);
    let release!: () => void;
    mock.pi.events.on("tasks:widget:ready", () => {
      mock.pi.events.emit("tasks:widget:claim", { version: 1, respond(value: () => void) { release = value; } });
    });
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Shared", description: "d" }, ctx);
    expect(ctx.ui.setWidget.mock.calls.some((args: any[]) => args[1] !== undefined)).toBe(false);
    const oldRelease = release;
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);
    expect(release).not.toBe(oldRelease);
    ctx.ui.setWidget.mockClear();
    oldRelease();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    release();
    expect(ctx.ui.setWidget.mock.lastCall?.[1]).toBeTypeOf("function");
    await mock.fireLifecycle("session_shutdown", {}, ctx);
    const respond = vi.fn();
    mock.pi.events.emit("tasks:widget:claim", { version: 1, respond });
    expect(respond).not.toHaveBeenCalled();
    expect(config.current.widgetVisible).toBe(true);
  });

  it("persists project tasks under the session workspace", async () => {
    config.current = { taskScope: "project" };
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Shared", description: "d" }, ctx);

    const file = join(cwd, ".pi", "tasks", "tasks.json");
    expect(new TaskStore(file).list().map(task => task.subject)).toEqual(["Shared"]);
    expect(file.startsWith(cwd)).toBe(true);
  });

  it("switches project stores when the session workspace changes", async () => {
    config.current = { taskScope: "project" };
    const otherCwd = join(root, "other-workspace");
    const mock = mockPi();
    initExtension(mock.pi as any);

    const firstCtx = mockCtx(cwd, "s1");
    await mock.fireLifecycle("session_start", { reason: "startup" }, firstCtx);
    await mock.executeTool("TaskCreate", { subject: "First", description: "d" }, firstCtx);

    const secondCtx = mockCtx(otherCwd, "s2");
    await mock.fireLifecycle("session_start", { reason: "new" }, secondCtx);
    await mock.executeTool("TaskCreate", { subject: "Second", description: "d" }, secondCtx);

    expect(new TaskStore(join(cwd, ".pi", "tasks", "tasks.json")).list().map(task => task.subject))
      .toEqual(["First"]);
    expect(new TaskStore(join(otherCwd, ".pi", "tasks", "tasks.json")).list().map(task => task.subject))
      .toEqual(["Second"]);
  });

  it("resolves a relative PI_TASKS path from the session workspace", async () => {
    process.env.PI_TASKS = "./custom/list.json";
    config.current = { taskScope: "memory" };
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Relative", description: "d" }, ctx);

    const file = join(cwd, "custom", "list.json");
    expect(JSON.parse(readFileSync(file, "utf-8")).tasks[0].subject).toBe("Relative");
  });

  it("does not persist session tasks when Pi has no session file", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd, "ephemeral", false);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" }, ctx);

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });
});

describe("session-global task storage", () => {
  beforeEach(() => { config.current = { taskScope: "session-global" }; });

  it("keeps a new session file outside the workspace", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Global", description: "d" }, ctx);

    const file = sessionTaskFile(cwd, "s1", "session-global");
    expect(new TaskStore(file).list().map(task => task.subject)).toEqual(["Global"]);
    expect(existsSync(join(cwd, ".pi", "tasks"))).toBe(false);
    expect(file.startsWith(agentDir)).toBe(true);
  });

  it("continues using an existing workspace session file", async () => {
    const existing = workspaceSessionTaskFile(cwd, "s1");
    new TaskStore(existing).create("Existing", "d");
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "New", description: "d" }, ctx);

    expect(new TaskStore(existing).list().map(task => task.subject)).toEqual(["Existing", "New"]);
    expect(existsSync(globalSessionTasksDir(cwd))).toBe(false);
  });
});

/**
 * Tests for prompt-injected task execution: TaskExecute, auto-continue,
 * and removal of system-reminder context pollution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function mockCtx(overrides: {
  select?: (...args: any[]) => any;
  sessionManager?: { getSessionId: () => string; getSessionFile?: () => string | undefined };
  cwd?: string;
  isIdle?: () => boolean;
} = {}) {
  return {
    isIdle: overrides.isIdle ?? (() => true),
    cwd: overrides.cwd ?? process.cwd(),
    sessionManager: {
      getBranch: () => [],
      ...(overrides.sessionManager ?? {
        getSessionId: () => "test-session",
        getSessionFile: () => "/tmp/test-session.jsonl",
      }),
    },
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(overrides.select ?? (async () => undefined)),
      input: vi.fn(async () => undefined),
      confirm: vi.fn(async () => false),
    },
  };
}

function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const markdownTransformers: Array<(markdown: string, context: { messageType: string }) => string> = [];

  const pi = {
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerMarkdownTransformer(transformer: (markdown: string, context: { messageType: string }) => string) {
      markdownTransformers.push(transformer);
    },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    async fireLifecycle(event: string, ...args: any[]) {
      const results: any[] = [];
      for (const h of lifecycleHandlers.get(event) ?? []) {
        results.push(await h(...args));
      }
      return results;
    },
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
    transformMarkdown(markdown: string, messageType = "user") {
      return markdownTransformers.reduce(
        (result, transformer) => transformer(result, { messageType }),
        markdown,
      );
    },
  };
}

async function writeConfig(config: Record<string, unknown>) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const configPath = path.join(process.cwd(), ".pi", "tasks-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
}

async function removeConfig() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  try { fs.unlinkSync(path.join(process.cwd(), ".pi", "tasks-config.json")); } catch {}
}

describe("TaskExecute prompt injection", () => {
  let mock: ReturnType<typeof mockPi>;

  beforeEach(() => {
    mock = mockPi();
    initExtension(mock.pi as any);
  });

  it("registers prompt execution and batch creation tools", () => {
    expect(mock.tools.has("TaskExecute")).toBe(true);
    expect(mock.tools.has("TaskCreateMany")).toBe(true);
  });

  it("creates multiple tasks with TaskCreateMany", async () => {
    const result = await mock.executeTool("TaskCreateMany", {
      tasks: [
        { subject: "Step one", description: "Do the first thing" },
        { subject: "Step two", description: "Do the second thing", activeForm: "Doing step two", metadata: { area: "test" } },
      ],
    });

    expect(result.content[0].text).toContain("Created 2 tasks");
    expect(result.content[0].text).toContain("#1 Step one");
    expect(result.content[0].text).toContain("#2 Step two");

    const details = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(details.content[0].text).toContain("Step two");
    expect(details.content[0].text).toContain('"area":"test"');
  });

  it("releases a valid task prompt after the current agent run", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Run tests",
      description: "Run the test suite",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    expect(result.content[0].text).toContain("Scheduled 1 task");
    expect(result.content[0].text).toContain("#1 → scheduled");
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-tasks:continuation", content: expect.stringContaining("Continue by working on task #1") }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    const task = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(task.content[0].text).toContain("Status: in_progress");
  });

  it("does not require legacy agentType", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Plain task",
      description: "No agent type needed",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Scheduled 1 task");
    expect(result.content[0].text).not.toContain("no agentType");
  });

  it("passes additional context into the queued prompt", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Explore codebase",
      description: "Find all API endpoints",
    });

    await mock.executeTool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "Focus on REST endpoints only",
    });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Focus on REST endpoints only");
  });

  it("leaves user and assistant text unchanged when it resembles a task prompt", async () => {
    const prompt = "Continue by working on task #7: \"Run tests\"\n\nLong instructions";

    expect(mock.transformMarkdown(prompt)).toBe(prompt);
    expect(mock.transformMarkdown(prompt, "assistant")).toBe(prompt);
  });

  it("releases bulk TaskExecute requests one at a time", async () => {
    await mock.executeTool("TaskCreateMany", {
      tasks: [
        { subject: "First", description: "Do first" },
        { subject: "Second", description: "Do second" },
      ],
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("task #1");

    const firstPrompt = mock.pi.sendMessage.mock.calls[0][0];
    await mock.fireLifecycle("message_start", {
      message: { role: "custom", ...firstPrompt },
    }, mockCtx());
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(mock.pi.sendMessage.mock.calls[1][0].content).toContain("task #2");
  });

  it("does not release a later explicit task while the active task is open", async () => {
    await mock.executeTool("TaskCreateMany", {
      tasks: [
        { subject: "First", description: "Do first" },
        { subject: "Second", description: "Do second" },
      ],
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    const firstPrompt = mock.pi.sendMessage.mock.calls[0][0];
    await mock.fireLifecycle("message_start", {
      message: { role: "custom", ...firstPrompt },
    }, mockCtx());
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("rejects non-existent, completed, and blocked tasks", async () => {
    await mock.executeTool("TaskCreate", { subject: "Already done", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "3", addBlockedBy: ["2"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1", "3", "999"] });
    const text = result.content[0].text;
    expect(text).toContain("#1: already completed");
    expect(text).toContain("#3: blocked by #2");
    expect(text).toContain("#999: not found");
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("TaskOutput reports prompt-queued task status without a background process", async () => {
    await mock.executeTool("TaskCreate", { subject: "Prompt task", description: "Desc" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    const result = await mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 0 });
    expect(result.content[0].text).toContain("Task #1 [in_progress]");
    expect(result.content[0].text).toContain("Prompt-queued tasks run in the main conversation");
  });

  it("does not inject system reminders into tool results", async () => {
    await mock.executeTool("TaskCreate", { subject: "Tracked", description: "Desc" });
    for (let i = 0; i < 6; i++) {
      await mock.fireLifecycle("turn_start", {}, mockCtx());
    }

    const results = await mock.fireLifecycle("tool_result", {
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
    });

    expect(results.filter(Boolean)).toHaveLength(0);
    expect(JSON.stringify(results)).not.toContain("system-reminder");
  });
});

describe("Session lifecycle", () => {
  it("shows in-memory tasks during session_start", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Visible", description: "Desc" });

    const ctx = mockCtx();
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "tasks",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
  });

  it("clears memory-scoped tasks for a new session", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Old", description: "Desc" });

    await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());
    const result = await mock.executeTool("TaskList", {});

    expect(result.content[0].text).toContain("No tasks found");
  });

  it("starts a later task batch without the preceding completed list", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Finished", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    await mock.fireLifecycle("agent_settled", {}, mockCtx());

    await mock.executeTool("TaskCreate", { subject: "Fresh", description: "Desc" });
    const result = await mock.executeTool("TaskList", {});

    expect(result.content[0].text).toContain("Fresh");
    expect(result.content[0].text).not.toContain("Finished");
  });

  it("does not persist session tasks when the conversation has no session file", async () => {
    delete process.env.PI_TASKS;
    await removeConfig();
    const sessionId = `ephemeral-${Date.now()}`;
    const fs = await import("node:fs");
    const path = await import("node:path");
    const taskFile = path.join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    try {
      const mock = mockPi();
      initExtension(mock.pi as any);
      const ctx = mockCtx({
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => undefined,
        },
      });
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "Desc" }, ctx);

      expect(fs.existsSync(taskFile)).toBe(false);
    } finally {
      try { fs.unlinkSync(taskFile); } catch {}
    }
  });
});

describe("Auto-continue with prompts", () => {
  afterEach(async () => {
    await removeConfig();
  });

  it("does not continue mid-run, and continues at the boundary by default", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "A", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "B", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    // Completing a task never injects mid-run; the run boundary owns that.
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();

    // With no configuration at all the list advances rather than stopping.
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #2");
  });

  it("stops advancing when auto mode is turned off", async () => {
    await writeConfig({ autoMode: "off" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "A", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "B", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps advancing while the task changes, and gives up once it stops changing", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Long task", description: "Desc" });

    const advance = async () => {
      await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
      const calls = mock.pi.sendMessage.mock.calls;
      const prompt = calls[calls.length - 1]?.[0];
      if (prompt) {
        await mock.fireLifecycle("message_start", {
          message: { role: "custom", ...prompt },
        }, mockCtx());
      }
      return calls.length;
    };

    // Work that keeps changing the task keeps being handed back, well past the
    // old fixed cap of three: the guard bounds a stuck task, not a long one.
    let sent = 0;
    for (let round = 0; round < 6; round++) {
      sent = await advance();
      await mock.executeTool("TaskUpdate", { taskId: "1", metadata: { round } });
    }
    expect(sent).toBe(6);

    // Once nothing about the task changes, it is dropped after the attempt budget.
    const before = mock.pi.sendMessage.mock.calls.length;
    for (let round = 0; round < 5; round++) await advance();
    expect(mock.pi.sendMessage.mock.calls.length - before).toBe(3);
  });

  it("queues the next unblocked task after completion when enabled", async () => {
    await writeConfig({ autoCascade: true });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "A", description: "Produce a result" });
    await mock.executeTool("TaskCreate", { subject: "B", description: "Use A" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "completed",
      metadata: { result: "The answer is 42" },
    });

    expect(result.content[0].text).not.toContain("queued follow-up prompt");
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();

    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    const prompt = mock.pi.sendMessage.mock.calls[0][0].content;
    expect(prompt).toContain("Continue by working on task #2");
    expect(prompt).toContain("Prerequisite task results");
    expect(prompt).toContain("The answer is 42");
  });

  it("queues an open task on agent_end when enabled", async () => {
    await writeConfig({ autoCascade: true });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Open task", description: "Do it" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #1");
  });

  it("does not queue a duplicate prompt while one is already queued", async () => {
    await writeConfig({ autoCascade: true });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Open task", description: "Do it" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("queues nothing when cascade tasks all finish in the same agent run", async () => {
    await writeConfig({ autoMode: "cascade" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "First", description: "Do it" });
    await mock.executeTool("TaskCreate", { subject: "Second", description: "Do next" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    await mock.executeTool("TaskUpdate", { taskId: "2", status: "completed" });

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("drops an explicit task completed before the run boundary", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Open task", description: "Do it" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("drops an explicit task deleted before the run boundary", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Obsolete task", description: "Do it" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "deleted" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("can retry a delivered prompt for still-open work, capped per task", async () => {
    await writeConfig({ autoCascade: true });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Open task", description: "Do it" });

    let delivered = 0;
    for (let i = 0; i < 4; i++) {
      await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
      if (mock.pi.sendMessage.mock.calls.length > delivered) {
        const prompt = mock.pi.sendMessage.mock.calls[delivered][0];
        delivered++;
        await mock.fireLifecycle("message_start", {
          message: { role: "custom", ...prompt },
        }, mockCtx());
      }
    }

    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("legacy autoCascade:true config still enables cascade mode", async () => {
    await writeConfig({ autoCascade: true });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "A", description: "Do it" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("autoMode:cascade behaves like the legacy cascade setting", async () => {
    await writeConfig({ autoMode: "cascade" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "A", description: "Do it" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
  });
});

describe("Auto mode (interactive)", () => {
  afterEach(async () => {
    await removeConfig();
  });

  async function readConfig(): Promise<Record<string, unknown>> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const configPath = path.join(process.cwd(), ".pi", "tasks-config.json");
    try { return JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { return {}; }
  }

  it("asks the user about an in_progress task at agent_end", async () => {
    await writeConfig({ autoMode: "auto" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Task #1 pending, #2 also pending
    await mock.executeTool("TaskCreate", { subject: "First", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "Second", description: "Desc" });
    // Mark #1 in_progress to simulate the agent having started it but not completed it
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    const selectMock = vi.fn(async (_title: string, choices: string[]) => choices[0]); // pick "Mark complete"
    const ctx = mockCtx({ select: selectMock });

    await mock.fireLifecycle("agent_end", { messages: [] }, ctx);

    // ui.select was invoked with a title mentioning task #1
    expect(selectMock).toHaveBeenCalled();
    expect(selectMock.mock.calls[0][0]).toContain("#1");

    // After "Mark complete", task #1 should now be completed and #2 should be queued
    const detail1 = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(detail1.content[0].text).toContain("Status: completed");

    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #2");
  });

  it("re-queues the same task when the user picks Continue", async () => {
    await writeConfig({ autoMode: "auto" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Only task", description: "Keep going" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    // Pick "Continue" (the second option)
    const selectMock = vi.fn(async (_t: string, choices: string[]) => choices[1]);
    const ctx = mockCtx({ select: selectMock });

    await mock.fireLifecycle("agent_end", { messages: [] }, ctx);

    // Should have re-queued task #1
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #1");

    // Task is still in_progress
    const detail = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(detail.content[0].text).toContain("Status: in_progress");
  });

  it("disables auto mode when the user picks Stop", async () => {
    await writeConfig({ autoMode: "auto" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Open", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    // Pick "Stop auto mode" (third option)
    const selectMock = vi.fn(async (_t: string, choices: string[]) => choices[2]);
    const ctx = mockCtx({ select: selectMock });

    await mock.fireLifecycle("agent_end", { messages: [] }, ctx);

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Auto mode stopped.", "info");
    expect((await readConfig()).autoMode).toBe("off");
  });

  it("auto-disables and notifies once every task is completed", async () => {
    await writeConfig({ autoMode: "auto" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Done", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const ctx = mockCtx();
    await mock.fireLifecycle("agent_end", { messages: [] }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Auto mode finished"),
      "info",
    );
    expect((await readConfig()).autoMode).toBe("off");
  });

  it("queues the next pending task when no in_progress task is present", async () => {
    await writeConfig({ autoMode: "auto" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Pending", description: "Do it" });

    const selectMock = vi.fn(async () => undefined);
    const ctx = mockCtx({ select: selectMock });

    await mock.fireLifecycle("agent_end", { messages: [] }, ctx);

    expect(selectMock).not.toHaveBeenCalled();
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #1");
  });

  it("skips blocked in_progress tasks", async () => {
    await writeConfig({ autoMode: "auto" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Two tasks: #1 blocks #2; mark #2 in_progress (unusual but possible after manual moves)
    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "" });
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "2", status: "in_progress" });

    const selectMock = vi.fn(async () => undefined);
    const ctx = mockCtx({ select: selectMock });

    await mock.fireLifecycle("agent_end", { messages: [] }, ctx);

    // Should NOT ask about blocked task #2; should queue #1 (the only unblocked task)
    expect(selectMock).not.toHaveBeenCalled();
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #1");
  });
});

describe("/tasks auto command", () => {
  afterEach(async () => {
    await removeConfig();
  });

  async function readConfig(): Promise<Record<string, unknown>> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const configPath = path.join(process.cwd(), ".pi", "tasks-config.json");
    try { return JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { return {}; }
  }

  it("/tasks auto sets autoMode and queues the next open task", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Work", description: "Do it" });

    const ctx = mockCtx();
    const handler = mock.commands.get("tasks")!.handler;
    await handler("auto", ctx);

    expect((await readConfig()).autoMode).toBe("auto");
    // Task is pending, no in_progress task, so a follow-up should be queued immediately.
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #1");
  });

  it.each([
    ["auto", "auto"],
    ["auto on", "auto"],
    ["auto cascade", "cascade"],
    ["menu", "auto"],
  ])("%s silently enables queueing during active work", async (command, mode) => {
    await writeConfig({ autoMode: "off" });
    const mock = mockPi();
    initExtension(mock.pi as any);
    let idle = false;
    const ctx = mockCtx({
      isIdle: () => idle,
      select: async () => "Start auto mode",
    });
    await mock.executeTool("TaskCreate", { subject: "Running", description: "Finish this" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Next", description: "Then this" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    await mock.fireLifecycle("agent_start", {}, ctx);
    ctx.ui.notify.mockClear();

    await mock.commands.get("tasks")!.handler(command === "menu" ? "" : command, ctx);

    expect((await readConfig()).autoMode).toBe(mode);
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.select).toHaveBeenCalledTimes(command === "menu" ? 1 : 0);
    const active = await mock.executeTool("TaskGet", { taskId: "1" }, ctx);
    expect(active.content[0].text).toContain("Status: in_progress");

    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" }, ctx);
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    idle = true;
    await mock.fireLifecycle("agent_end", { messages: [] }, ctx);
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage.mock.calls[0][0].content).toContain("Continue by working on task #2");
    expect(ctx.ui.select).toHaveBeenCalledTimes(command === "menu" ? 1 : 0);
    await mock.fireLifecycle("session_shutdown", { reason: "quit" }, ctx);
  });

  it("/tasks auto off disables auto mode and clears the legacy flag", async () => {
    await writeConfig({ autoCascade: true, autoMode: "auto" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    const handler = mock.commands.get("tasks")!.handler;
    await handler("auto off", ctx);

    const config = await readConfig();
    expect(config.autoMode).toBe("off");
    expect(config.autoCascade).toBeUndefined();
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("/tasks auto cascade switches to cascade mode", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Work", description: "Do it" });

    const ctx = mockCtx();
    const handler = mock.commands.get("tasks")!.handler;
    await handler("auto cascade", ctx);

    expect((await readConfig()).autoMode).toBe("cascade");
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("/tasks auto status reports the current mode without changing it", async () => {
    await writeConfig({ autoMode: "cascade" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    const handler = mock.commands.get("tasks")!.handler;
    await handler("auto status", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("cascade"),
      "info",
    );
    expect((await readConfig()).autoMode).toBe("cascade");
  });

  it("disposes the active task widget timer on session shutdown", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockPi();
      initExtension(mock.pi as any);
      await mock.executeTool("TaskCreate", { subject: "Work", description: "Do it" });
      await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
      expect(vi.getTimerCount()).toBe(1);

      await mock.fireLifecycle("session_shutdown", { reason: "quit" }, mockCtx());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Run order visibility", () => {
  afterEach(async () => {
    await removeConfig();
  });

  const text = (result: any) => result.content[0].text as string;

  async function threeTasks() {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreateMany", {
      tasks: [
        { subject: "Step one", description: "d" },
        { subject: "Step two", description: "d" },
        { subject: "Step three", description: "d" },
      ],
    });
    return mock;
  }

  it("lists open tasks in run order rather than by ID", async () => {
    const mock = await threeTasks();
    await mock.executeTool("TaskReorder", { taskId: "3", before: "1" });
    const listed = text(await mock.executeTool("TaskList", {}));
    const ids = listed.split("\n").filter(line => line.startsWith("#")).map(line => line.slice(1, 2));
    // Listing by ID here would contradict the reorder that just happened.
    expect(ids).toEqual(["3", "1", "2"]);
    expect(listed).toContain("#3 [pending] Step three  <- next");
    expect(listed).toContain("Use TaskReorder to change what comes next");
  });

  it("states that work already in progress is taken before the run order", async () => {
    const mock = await threeTasks();
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    const moved = text(await mock.executeTool("TaskReorder", { taskId: "3", before: "1" }));
    // The move is real but does not preempt, and says so at the point of the move.
    expect(moved).toContain("Run order: #3 → #1 → #2");
    expect(moved).toContain("#1 still runs next: it is already in progress");

    const listed = text(await mock.executeTool("TaskList", {}));
    expect(listed).toContain("#1 [in_progress] Step one  <- next");
    expect(listed).toContain("Work in progress is taken before any pending task");
  });

  it("skips a blocked task rather than waiting for it, and says which runs instead", async () => {
    const mock = await threeTasks();
    await mock.executeTool("TaskUpdate", { taskId: "3", addBlockedBy: ["2"] });
    const moved = text(await mock.executeTool("TaskReorder", { taskId: "3", before: "1" }));
    expect(moved).toContain("#1 runs next: #3 is blocked and will be skipped");

    const listed = text(await mock.executeTool("TaskList", {}));
    expect(listed).toContain("[blocked by #2]");
    expect(listed).toContain("#1 [pending] Step one  <- next");
  });

  it("reports when every open task is blocked", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Blocker", description: "d" });
    await mock.executeTool("TaskCreate", { subject: "Blocked", description: "d" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    // Completing the blocker is what releases the blocked task.
    expect(text(await mock.executeTool("TaskList", {}))).toContain("#1 [pending] Blocker  <- next");
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    expect(text(await mock.executeTool("TaskList", {}))).toContain("#2 [pending] Blocked  <- next");

    // A mutual dependency deadlocks the list, which is worth stating rather than
    // silently advancing nothing at every run boundary.
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });
    await mock.executeTool("TaskUpdate", { taskId: "1", addBlockedBy: ["2"] });
    const listed = text(await mock.executeTool("TaskList", {}));
    expect(listed).toContain("Nothing can run: every open task is blocked");
    expect(listed).not.toContain("<- next");
  });

  it("reports a task's own position in the run order", async () => {
    const mock = await threeTasks();
    await mock.executeTool("TaskReorder", { taskId: "3", before: "1" });
    expect(text(await mock.executeTool("TaskGet", { taskId: "3" }))).toContain("Run order: 1 of 3 open");
    expect(text(await mock.executeTool("TaskGet", { taskId: "2" }))).toContain("Run order: 3 of 3 open");
  });
});

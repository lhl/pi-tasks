/**
 * Tests for prompt-injected task execution: TaskExecute, auto-continue,
 * and removal of system-reminder context pollution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function mockCtx() {
  return {
    sessionManager: { getSessionId: () => "test-session" },
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
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
    sendUserMessage: vi.fn(),
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

  it("queues a follow-up user prompt for a valid task", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Run tests",
      description: "Run the test suite",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    expect(result.content[0].text).toContain("Queued 1 task prompt");
    expect(result.content[0].text).toContain("#1 → queued follow-up prompt");
    expect(mock.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Continue by working on task #1"),
      { deliverAs: "followUp" },
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
    expect(result.content[0].text).toContain("Queued 1 task prompt");
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

    expect(mock.pi.sendUserMessage.mock.calls[0][0]).toContain("Focus on REST endpoints only");
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
    expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("TaskOutput reports prompt-queued task status without a background process", async () => {
    await mock.executeTool("TaskCreate", { subject: "Prompt task", description: "Desc" });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

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

describe("Auto-continue with prompts", () => {
  afterEach(async () => {
    await removeConfig();
  });

  it("does not auto-continue when disabled by default", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "A", description: "Desc" });
    await mock.executeTool("TaskCreate", { subject: "B", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
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

    expect(result.content[0].text).toContain("#2 → queued follow-up prompt");
    expect(mock.pi.sendUserMessage).toHaveBeenCalledOnce();
    const prompt = mock.pi.sendUserMessage.mock.calls[0][0];
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

    expect(mock.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendUserMessage.mock.calls[0][0]).toContain("Continue by working on task #1");
  });

  it("does not queue a duplicate prompt while one is already queued", async () => {
    await writeConfig({ autoCascade: true });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Open task", description: "Do it" });
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
    await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());

    expect(mock.pi.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("can retry a delivered prompt for still-open work, capped per task", async () => {
    await writeConfig({ autoCascade: true });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Open task", description: "Do it" });

    for (let i = 0; i < 4; i++) {
      await mock.fireLifecycle("agent_end", { messages: [] }, mockCtx());
      const prompt = mock.pi.sendUserMessage.mock.calls.at(-1)?.[0] as string;
      if (prompt) {
        await mock.fireLifecycle("before_agent_start", { prompt }, mockCtx());
      }
    }

    expect(mock.pi.sendUserMessage).toHaveBeenCalledTimes(3);
  });
});

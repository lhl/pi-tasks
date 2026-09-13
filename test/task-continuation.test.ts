import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTaskContinuationGuard, taskContinuation } from "../src/task-continuation.js";
import type { Task } from "../src/types.js";

const task = (status = "in_progress") => ({ id: "1", subject: 'A "quoted" task\nwith newline', createdAt: 1, status }) as Task;
const message = (t = task()) => ({ role: "custom", timestamp: 1, ...taskContinuation(t, `Continue by working on task #1: "${t.subject}"\n\nDo work`) });
function fixture() {
  const hooks = new Map<string, (...args: any[]) => any>();
  let current: Task | undefined = task();
  const entries: any[] = [];
  const ctx = { abort: vi.fn(), ui: { notify: vi.fn() }, sessionManager: { getBranch: () => entries } };
  const delivered = vi.fn();
  const pi = {
    on: (event: string, handler: any) => hooks.set(event, handler),
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn((customType, data) => entries.push({ type: "custom", customType, data })),
  };
  installTaskContinuationGuard(pi as any, id => id === "2" ? { ...task(), id: "2" } : current, delivered);
  return { ctx, entries, delivered, pi, setTask: (t?: Task) => { current = t; },
    fire: (event: string, data: any = {}) => hooks.get(event)?.(data, ctx) };
}

describe("continuation identity and cancellation", () => {
  it("renders task metadata safely across terminal widths and expands the original instruction", () => {
    const f = fixture();
    const own = message({ ...task(), subject: "日本語 👩🏽‍💻\n\u001b]52;c;clipboard\u0007subject" });
    const render = f.pi.registerMessageRenderer.mock.calls[0][1];
    const before = structuredClone(own);
    const collapsed = render(own, { expanded: false, outputPad: 1 });
    expect(collapsed.render(120).join("\n")).toContain("Task #1 · 日本語");
    for (const width of [12, 48, 80])
      for (const line of collapsed.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line).not.toContain("\u001b");
      }
    expect(render(own, { expanded: true, outputPad: 1 }).render(120).join("\n")).toContain("Do work");
    expect(own).toEqual(before);
  });
  it("ignores unrelated custom messages and malformed task metadata", async () => {
    const f = fixture();
    f.setTask(task("completed"));
    const inputs = [{ ...message(), customType: "another-extension" }, { ...message(), details: null }];
    for (const input of inputs) await f.fire("message_start", { message: input });
    expect((await f.fire("context", { messages: inputs })).messages).toEqual(inputs);
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.delivered).not.toHaveBeenCalled();
  });
  it("never aborts a user's copied continuation text, even with an exact subject", async () => {
    const f = fixture();
    f.setTask(task("completed"));
    const user = { role: "user", content: message().content };
    await f.fire("message_start", { message: user });
    expect((await f.fire("context", { messages: [user] })).messages).toEqual([user]);
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.delivered).not.toHaveBeenCalled();
  });
  for (const disposition of ["completed", "deleted", "replaced"])
    it(`aborts an isolated ${disposition} continuation before provider handoff`, async () => {
      const f = fixture();
      const own = message();
      await f.fire("message_start", { message: own });
      f.setTask(disposition === "deleted" ? undefined : { ...task("completed"), ...(disposition === "replaced" ? { status: "pending", createdAt: 2 } : {}) });
      const result = await f.fire("context", { messages: [own] });
      expect(f.ctx.abort).toHaveBeenCalledOnce();
      expect(f.delivered).toHaveBeenCalledWith("1");
      expect(result.messages[0]).toEqual(own);
      expect(result.messages[1].content).toContain("is cancelled");
      expect(f.pi.appendEntry).toHaveBeenCalledOnce();
    });
  for (const other of [{ role: "user", content: "Please explain the result" }, { role: "toolResult", content: [{ type: "text", text: "result" }] }, message({ ...task(), id: "2" })])
    it(`preserves a ${other.role} delivered in the same request`, async () => {
      const f = fixture();
      const own = message();
      f.setTask(task("completed"));
      await f.fire("message_start", { message: own });
      await f.fire("message_start", { message: other });
      const result = await f.fire("context", { messages: [own, other] });
      expect(f.ctx.abort).not.toHaveBeenCalled();
      expect(result.messages[0]).toEqual(own);
      expect(result.messages.at(-1)).toEqual(other);
      expect(result.messages[1].content).toContain("cancelled");
    });
  it("returns cancellation context and reports failure when abort throws", async () => {
    const f = fixture();
    const own = message();
    const before = structuredClone(own);
    f.setTask(task("completed"));
    f.ctx.abort.mockImplementation(() => { throw new Error("host abort failed"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.fire("message_start", { message: own });
      const result = await f.fire("context", { messages: [own] });
      expect(result.messages[0]).toEqual(before);
      expect(result.messages[1].content).toContain("is cancelled");
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0][0]).toContain("Could not stop");
      expect(f.pi.appendEntry).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
  it("does not abort a live task and retires only the delivered queue identity", async () => {
    const f = fixture();
    const own = message();
    await f.fire("message_start", { message: own });
    expect((await f.fire("context", { messages: [own] })).messages).toEqual([own]);
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.delivered).toHaveBeenCalledOnce();
  });
  it("restores cancellation context after resume without treating historical input as new", async () => {
    const f = fixture();
    const own = message();
    f.setTask(task("completed"));
    await f.fire("message_start", { message: own });
    await f.fire("context", { messages: [own] });
    await f.fire("session_start", { reason: "resume" });
    f.ctx.abort.mockClear();
    const user = { role: "user", content: "next" };
    await f.fire("message_start", { message: user });
    const result = await f.fire("context", { messages: [own, user] });
    expect(result.messages[1].content).toContain("cancelled");
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.pi.appendEntry).toHaveBeenCalledOnce();
  });
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
for (const mixed of [false, true])
  it(`real Pi transport receives ${mixed ? "one mixed" : "zero stale-only"} request`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tasks-guard-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const runtime = await ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-key",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, noExtensions: true, noSkills: true,
      extensionFactories: [{ name: "guard", factory: pi => installTaskContinuationGuard(pi, () => task("completed"), () => {}) }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel("fixture", "fixture"),
      sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), tools: [] });
    cleanup.push(async () => { session.dispose(); });
    await session.bindExtensions({ onError: error => { throw error; } });
    const own = message();
    if (mixed) {
      await session.agent.prompt([own, { role: "user", content: [{ type: "text", text: "Please explain the result" }], timestamp: 2 }] as any);
    } else {
      // A custom message is the same application input used by sendMessage.
      await session.agent.prompt(own as any);
    }
    expect(requests.length, JSON.stringify(session.agent.state.messages)).toBe(mixed ? 1 : 0);
    const final = session.agent.state.messages.at(-1) as any;
    if (mixed) expect(final.stopReason, JSON.stringify(final)).toBe("stop");
    else expect(final.errorMessage).toMatch(/abort|cancel/i);
    if (mixed) {
      expect(JSON.stringify(requests[0])).toContain("Please explain the result");
      expect(JSON.stringify(requests[0])).toContain("is cancelled");
    }
  });

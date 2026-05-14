/**
 * @lhl/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *               Fork of @tintinweb/pi-tasks with an interactive auto-advance mode.
 *
 * Tools:
 *   TaskCreate     — Create a structured task
 *   TaskCreateMany — Create multiple tasks in one call
 *   TaskList       — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Queue task prompts in the current session
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import { TaskStore } from "./task-store.js";
import { type AutoMode, getAutoMode, loadTasksConfig, saveTasksConfig } from "./tasks-config.js";
import { isCompletedTaskExecutionStats, isTaskExecutionStats, type Task } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

function formatClockTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

/** Maximum autonomous prompt injections for the same unfinished task. */
const AUTO_CONTINUE_MAX_ATTEMPTS = 3;

export default function (pi: ExtensionAPI) {
  // Initialize store and config
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";

  /** Resolve the task store path from env/config (without session ID). */
  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks?.startsWith("/")) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (taskScope === "session") return undefined; // no session ID yet, start in-memory
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  // For project scope (or env override), create store immediately.
  // For session scope, start with in-memory and upgrade once we have the session ID.
  let latestCtx: ExtensionContext | undefined;
  let store = new TaskStore(resolveStorePath());
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store);

  function onCorruptFile(filePath: string, error: unknown) {
    debug("corrupt task store", { filePath, error });
    latestCtx?.ui.notify(
      `pi-tasks: could not read ${filePath}; keeping in-memory task state and healing on next save.`,
      "warning",
    );
  }

  store.onCorruptFile = onCorruptFile;

  // ── Prompt-injected task execution state ──
  /** Latest TaskExecute context, reused by automatic follow-up prompts. */
  let promptExecutionConfig: { additionalContext?: string } = {};
  /** Tasks that already have a follow-up prompt queued in this session. */
  const queuedTaskIds = new Set<string>();
  /** Guardrail to prevent runaway auto-continue loops on the same unfinished task. */
  const autoPromptAttempts = new Map<string, number>();
  /** Re-entrancy guard for the interactive auto-mode prompt. */
  let autoAskInFlight = false;

  /** Apply a new auto-advance mode and persist it; clears the legacy flag. */
  function setAutoMode(mode: AutoMode): void {
    cfg.autoMode = mode;
    if ("autoCascade" in cfg) delete cfg.autoCascade;
    saveTasksConfig(cfg);
  }

  function getOpenBlockers(task: Pick<Task, "blockedBy">): string[] {
    return task.blockedBy.filter(depId => store.get(depId)?.status !== "completed");
  }

  function findNextOpenTask(): Task | undefined {
    const tasks = store.list();
    return tasks.find(t => t.status === "in_progress" && getOpenBlockers(t).length === 0)
      ?? tasks.find(t => t.status === "pending" && getOpenBlockers(t).length === 0);
  }

  /** Build a follow-up user prompt for work on a task.
   *  Injects completed dependency results when available so dependent tasks can build on prerequisites.
   */
  function buildTaskPrompt(task: Task, additionalContext?: string): string {
    const desc = task.description.replace(/\\n/g, "\n");
    let prompt = `Continue by working on task #${task.id}: "${task.subject}"\n\n${desc}`;

    if (task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const raw = String(dep.metadata.result);
          const result = raw.length > 4000
            ? raw.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : raw;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n## Additional context\n\n${additionalContext}`;
    prompt += `\n\n## Task workflow\n\n` +
      `- Focus on this task only.\n` +
      `- Use TaskGet if you need to refresh details for task #${task.id}.\n` +
      `- Mark task #${task.id} in_progress before doing substantive work if it is not already in progress.\n` +
      `- When finished, call TaskUpdate with status completed. Include a concise metadata.result summary if it would help dependent tasks.\n` +
      `- If you cannot complete it, leave the task open and explain the blocker.`;
    return prompt;
  }

  function queueTaskPrompt(
    task: Task,
    options: { additionalContext?: string; explicit?: boolean; reason?: string } = {},
  ): { queued: boolean; message: string } {
    const current = store.get(task.id);
    if (!current) return { queued: false, message: `#${task.id}: not found` };
    if (current.status === "completed") return { queued: false, message: `#${current.id}: already completed` };

    const openBlockers = getOpenBlockers(current);
    if (openBlockers.length > 0) {
      return { queued: false, message: `#${current.id}: blocked by ${openBlockers.map(id => "#" + id).join(", ")}` };
    }

    if (queuedTaskIds.has(current.id)) {
      return { queued: false, message: `#${current.id}: prompt already queued` };
    }

    if (!options.explicit) {
      const attempts = autoPromptAttempts.get(current.id) ?? 0;
      if (attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
        return { queued: false, message: `#${current.id}: auto-continue limit reached` };
      }
      autoPromptAttempts.set(current.id, attempts + 1);
    }

    const previousStatus = current.status;
    if (current.status === "pending") {
      store.update(current.id, { status: "in_progress" });
    }

    const queuedTask = store.get(current.id) ?? current;
    const prompt = buildTaskPrompt(queuedTask, options.additionalContext);

    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch (err: any) {
      if (previousStatus === "pending") store.update(current.id, { status: "pending" });
      queuedTaskIds.delete(current.id);
      widget.setActiveTask(current.id, false);
      widget.update();
      return { queued: false, message: `#${current.id}: prompt queue failed — ${err?.message ?? err}` };
    }

    queuedTaskIds.add(current.id);
    widget.setActiveTask(current.id);
    widget.update();
    debug("queued task prompt", { taskId: current.id, reason: options.reason });
    return { queued: true, message: `#${current.id} → queued follow-up prompt` };
  }

  function queueNextOpenTask(reason: string): { queued: boolean; message: string } | undefined {
    if (getAutoMode(cfg) === "off") return undefined;

    const promptedInProgress = store.list().some(t => t.status === "in_progress" && queuedTaskIds.has(t.id));
    if (promptedInProgress) return undefined;

    const next = findNextOpenTask();
    if (!next) return undefined;
    return queueTaskPrompt(next, {
      additionalContext: promptExecutionConfig.additionalContext,
      reason,
    });
  }

  /**
   * In auto mode, ask the user what to do with an in_progress task that the
   * agent left open at idle. Returns whether the auto loop should continue.
   */
  async function askAutoAction(ctx: ExtensionContext, task: Task): Promise<"continue" | "stop"> {
    const labelComplete = "✓ Mark complete";
    const labelContinue = "▸ Continue (re-queue this task)";
    const labelStop = "✗ Stop auto mode";

    const title = `Task #${task.id} still in progress: ${task.subject}`;
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(title, [labelComplete, labelContinue, labelStop]);
    } catch (err: any) {
      debug("auto-mode ui.select failed", err?.message ?? err);
      return "stop";
    }

    if (!choice || choice === labelStop) {
      setAutoMode("off");
      ctx.ui.notify("Auto mode stopped.", "info");
      return "stop";
    }

    if (choice === labelComplete) {
      store.update(task.id, { status: "completed" });
      queuedTaskIds.delete(task.id);
      autoPromptAttempts.delete(task.id);
      autoClear.trackCompletion(task.id, currentTurn);
      widget.setActiveTask(task.id, false);
      widget.update();
      ctx.ui.notify(`Marked task #${task.id} complete.`, "info");
      return "continue";
    }

    if (choice === labelContinue) {
      // Reset attempt counter so the user-initiated retry is not rate-limited.
      autoPromptAttempts.delete(task.id);
      queuedTaskIds.delete(task.id);
      const result = queueTaskPrompt(task, {
        additionalContext: promptExecutionConfig.additionalContext,
        explicit: true,
        reason: "auto_continue",
      });
      if (!result.queued) {
        ctx.ui.notify(result.message, "warning");
      }
      // We already queued the task; let it run before the next advance.
      return "stop";
    }

    return "stop";
  }

  /**
   * Drive the auto-advance loop after an agent idle event.
   * In cascade mode this just re-queues the next open task. In auto mode it
   * interactively prompts the user about any in_progress task and only then
   * advances to the next pending task.
   */
  async function autoAdvance(ctx: ExtensionContext, reason: string): Promise<void> {
    if (autoAskInFlight) return;
    const mode = getAutoMode(cfg);
    if (mode === "off") return;

    const tasks = store.list();
    const open = tasks.filter(t => t.status !== "completed");

    if (open.length === 0) {
      if (mode === "auto") {
        setAutoMode("off");
        ctx.ui.notify("Auto mode finished — all tasks complete.", "info");
      }
      return;
    }

    if (mode === "cascade") {
      queueNextOpenTask(reason);
      return;
    }

    // mode === "auto"
    const inProgress = tasks.find(t => t.status === "in_progress" && getOpenBlockers(t).length === 0);
    if (inProgress) {
      autoAskInFlight = true;
      let outcome: "continue" | "stop";
      try {
        outcome = await askAutoAction(ctx, inProgress);
      } finally {
        autoAskInFlight = false;
      }
      if (outcome === "continue") {
        // Loop around in case the user marked the task complete — advance further.
        await autoAdvance(ctx, `${reason}_after_ask`);
      }
      return;
    }

    // No in_progress unblocked task. Pull the next pending task.
    queueNextOpenTask(reason);
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ── Session-scoped store upgrade ──
  // For session scope, the store starts in-memory (no session ID at init time).
  // Upgrade to file-backed on first context arrival (turn_start, before_agent_start,
  // or tool_execution_start — whichever fires first).
  let storeUpgraded = false;
  let persistedTasksShown = false;
  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (taskScope === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      store = new TaskStore(path);
      store.onCorruptFile = onCorruptFile;
      widget.setStore(store);
    }
    storeUpgraded = true;
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (taskScope === "session") store.deleteFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for auto-clear and prompt execution ──
  let currentTurn = 0;

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    const autoClearResult = autoClear.onTurnStart(currentTurn);
    if (autoClearResult.cleared) widget.update();
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
  });

  // Grab UI context early — before_agent_start fires before any tool calls,
  // so persisted tasks show up immediately on session start.
  pi.on("before_agent_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();

    // A queued follow-up is no longer merely queued once pi starts processing it.
    // Clearing here lets auto-continue retry still-open work after the turn ends,
    // subject to AUTO_CONTINUE_MAX_ATTEMPTS.
    const deliveredTaskId = event.prompt.match(/^Continue by working on task #(\d+)/)?.[1];
    if (deliveredTaskId) queuedTaskIds.delete(deliveredTaskId);
  });

  // session_switch fires on /new (reason: "new") and /resume (reason: "resume").
  // On /new: reset all session-scoped state so the store switches to the new session file.
  // On resume: reload persisted tasks from the existing session file.
  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const isResume = event?.reason === "resume";

    // Reset session-scoped state for both /new and /resume
    storeUpgraded = false;
    persistedTasksShown = false;
    currentTurn = 0;
    queuedTaskIds.clear();
    autoPromptAttempts.clear();
    promptExecutionConfig = {};
    autoClear.reset();

    // Memory mode has no file-backed store to switch — clear explicitly on /new
    if (!isResume && taskScope === "memory") {
      store.clearAll();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(isResume);
  });

  // Keep widget context fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    widget.update();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx) {
      latestCtx = ctx;
      widget.setUICtx(ctx.ui as UICtx);
    }
    const ctxForUI = ctx ?? latestCtx;
    const mode = getAutoMode(cfg);
    if (mode === "off") return;
    if (mode === "auto" && ctxForUI) {
      await autoAdvance(ctxForUI, "agent_end");
    } else {
      // Cascade (or auto without a usable UI ctx) — fall back to silent queueing.
      queueNextOpenTask("agent_end");
    }
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- The legacy \`agentType\` field is accepted for compatibility but TaskExecute now queues prompts in the current session`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({ description: "Legacy compatibility hint. Prompt execution no longer requires an agent type." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      const meta = params.metadata ?? {};
      if (params.agentType) meta.agentType = params.agentType;
      const task = store.create(params.subject, params.description, params.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
      widget.update();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskCreateMany
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreateMany",
    label: "TaskCreateMany",
    description: `Use this tool to create multiple structured tasks in a single call. Prefer this over repeated TaskCreate calls when you know all tasks upfront.

## When to Use This Tool

- When planning a multi-step effort and all tasks are known at once
- When the user provides a list of things to be done (numbered or comma-separated)
- When you want to batch-create tasks without repeated round-trips

## When NOT to Use This Tool

Skip using this tool when:
- You only have one task to create (use TaskCreate instead)
- The task list depends on the output of prior work

## Task Fields (per item)

- **subject**: A brief, actionable title in imperative form
- **description**: Detailed description of what needs to be done
- **activeForm** (optional): Present continuous form for the spinner (e.g., "Fixing bug")
- **agentType** (optional): Legacy compatibility hint; prompt execution no longer requires it
- **metadata** (optional): Arbitrary key-value pairs

## Tips

- Use TaskUpdate afterwards to set up dependencies (blocks/blockedBy) between the created tasks
- IDs are assigned sequentially in the order tasks appear in the array`,
    promptGuidelines: [
      "Use TaskCreateMany when you have multiple tasks to create at once — it is more efficient than calling TaskCreate in a loop.",
      "After bulk creation, use TaskUpdate to wire up any blocks/blockedBy dependencies between tasks.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          subject: Type.String({ description: "A brief title for the task" }),
          description: Type.String({ description: "A detailed description of what needs to be done" }),
          activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
          agentType: Type.Optional(Type.String({ description: "Legacy compatibility hint. Prompt execution no longer requires an agent type." })),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
        }),
        { description: "Array of tasks to create", minItems: 1 },
      ),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      const items = params.tasks.map(t => {
        const meta = t.metadata ?? {};
        if (t.agentType) meta.agentType = t.agentType;
        return {
          subject: t.subject,
          description: t.description,
          activeForm: t.activeForm,
          metadata: Object.keys(meta).length > 0 ? meta : undefined,
        };
      });
      const created = store.createMany(items);
      widget.update();
      const lines = [`Created ${created.length} task${created.length === 1 ? "" : "s"}:`];
      for (const task of created) {
        lines.push(`  #${task.id} ${task.subject}`);
      }
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      lines.push(`Description: ${desc}`);

      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      const executionStats = isTaskExecutionStats(task.metadata.executionStats)
        ? task.metadata.executionStats
        : undefined;
      const completedStats = isCompletedTaskExecutionStats(task.metadata.executionStats)
        ? task.metadata.executionStats
        : undefined;
      if (completedStats) {
        const tokenParts: string[] = [];
        if ((completedStats.inputTokens ?? 0) > 0) tokenParts.push(`↑ ${formatTokens(completedStats.inputTokens ?? 0)}`);
        if ((completedStats.outputTokens ?? 0) > 0) tokenParts.push(`↓ ${formatTokens(completedStats.outputTokens ?? 0)}`);
        lines.push(
          `Execution stats: started ${formatClockTime(completedStats.startedAt)} · ` +
          `ended ${formatClockTime(completedStats.completedAt ?? 0)} · ` +
          `${formatDuration(completedStats.durationMs ?? 0)}` +
          (tokenParts.length > 0 ? ` · ${tokenParts.join(" ")}` : "")
        );
      } else if (executionStats) {
        lines.push(`Execution stats: started ${formatClockTime(executionStats.startedAt)}`);
      }

      // Show metadata if non-empty. When execution stats are valid, render them separately.
      const metadataForDisplay = executionStats
        ? Object.fromEntries(Object.entries(task.metadata).filter(([key]) => key !== "executionStats"))
        : task.metadata;
      const metaKeys = Object.keys(metadataForDisplay);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(metadataForDisplay)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...rawFields } = params;
      const fields = rawFields as Parameters<TaskStore["update"]>[1];
      const { changedFields, warnings, notFound } = store.update(taskId, fields);

      if (notFound) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      // Update widget active task tracking
      let queuedNext: { queued: boolean; message: string } | undefined;
      if (fields.status === "in_progress") {
        widget.setActiveTask(taskId);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "pending") {
        queuedTaskIds.delete(taskId);
        autoPromptAttempts.delete(taskId);
        widget.setActiveTask(taskId, false);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        queuedTaskIds.delete(taskId);
        autoPromptAttempts.delete(taskId);
        widget.setActiveTask(taskId, false);
        if (fields.status === "completed") {
          autoClear.trackCompletion(taskId, currentTurn);
          queuedNext = queueNextOpenTask("task_completed");
        }
      }

      widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      if (queuedNext?.queued) msg += `
${queuedNext.message}`;
      return Promise.resolve(textResult(msg));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        const task = store.get(task_id);
        if (task) {
          const result = task.metadata?.result ? `

Result:
${String(task.metadata.result)}` : "";
          return textResult(
            `Task #${task_id} [${task.status}] — no background process is attached. ` +
            `Prompt-queued tasks run in the main conversation.${result}`,
          );
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        if (store.get(taskId)) {
          return textResult(
            `Task #${taskId} has no running background process. ` +
            `Prompt-queued tasks run in the main conversation; use TaskUpdate to change task status.`,
          );
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      store.update(taskId, { status: "completed" });
      queuedTaskIds.delete(taskId);
      autoPromptAttempts.delete(taskId);
      autoClear.trackCompletion(taskId, currentTurn);
      widget.setActiveTask(taskId, false);
      const queuedNext = queueNextOpenTask("task_stopped");
      widget.update();
      return textResult(`Task #${taskId} stopped successfully${queuedNext?.queued ? `
${queuedNext.message}` : ""}`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Queue one or more tasks as follow-up prompts in the current pi session.

## When to Use This Tool

- To start or resume task work without launching a separate agent
- Tasks must be pending or in_progress with all blockedBy dependencies completed
- Each queued task is delivered as a follow-up user message to the current agent/session

## Parameters

- **task_ids**: Array of task IDs to queue
- **additional_context**: Extra context appended to each task prompt`,
    promptGuidelines: [
      "TaskExecute queues follow-up prompts in the current session; do not launch separate agents for these tasks.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to queue as follow-up prompts" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for task prompts" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      promptExecutionConfig = { additionalContext: params.additional_context };
      const results: string[] = [];
      const queued: string[] = [];

      for (const taskId of params.task_ids) {
        const task = store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status === "completed") {
          results.push(`#${taskId}: already completed`);
          continue;
        }

        const outcome = queueTaskPrompt(task, {
          additionalContext: params.additional_context,
          explicit: true,
          reason: "TaskExecute",
        });
        if (outcome.queued) queued.push(outcome.message);
        else results.push(outcome.message);
      }

      const lines: string[] = [];
      if (queued.length > 0) {
        lines.push(
          `Queued ${queued.length} task prompt(s):
${queued.join("\n")}
` +
          `The current session will receive them as follow-up user messages.`,
        );
      }
      if (results.length > 0) lines.push(`Skipped:
${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  /** Parse '/tasks auto [on|off|cascade|status]' style args. */
  function parseAutoArg(raw: string | undefined): "on" | "off" | "cascade" | "status" | undefined {
    const v = (raw ?? "").trim().toLowerCase();
    if (v === "" || v === "on" || v === "auto") return "on";
    if (v === "off" || v === "stop" || v === "disable") return "off";
    if (v === "cascade") return "cascade";
    if (v === "status" || v === "?") return "status";
    return undefined;
  }

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed. '/tasks auto' enters auto-advance mode.",
    getArgumentCompletions: (prefix: string) => {
      const completions = ["auto", "auto off", "auto cascade", "auto status"];
      const matches = completions
        .filter(v => v.startsWith(prefix.toLowerCase()))
        .map(v => ({ value: v, label: v }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;
      const trimmed = (args ?? "").trim();

      // ── /tasks auto [...] subcommand ──
      if (trimmed.toLowerCase().startsWith("auto")) {
        const sub = parseAutoArg(trimmed.slice("auto".length));
        if (!sub) {
          ui.notify(
            `Usage: /tasks auto [on|off|cascade|status]. Current mode: ${getAutoMode(cfg)}.`,
            "warning",
          );
          return;
        }

        if (sub === "status") {
          ui.notify(`Auto-advance mode: ${getAutoMode(cfg)}.`, "info");
          return;
        }

        const newMode: AutoMode = sub === "on" ? "auto" : sub === "cascade" ? "cascade" : "off";
        setAutoMode(newMode);

        if (newMode === "off") {
          ui.notify("Auto-advance mode disabled.", "info");
          return;
        }

        ui.notify(
          newMode === "auto"
            ? "Auto mode on — will advance through open tasks and ask you about anything still in progress."
            : "Cascade mode on — will silently queue the next open task after each completion.",
          "info",
        );

        // Kick the loop immediately so the user sees progress without waiting for the next idle.
        if (newMode === "auto") {
          await autoAdvance(ctx as unknown as ExtensionContext, "tasks_auto_command");
        } else {
          const result = queueNextOpenTask("tasks_cascade_command");
          if (result?.queued) ui.notify(result.message, "info");
        }
        return;
      }

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;
        const openCount = tasks.filter(t => t.status !== "completed").length;
        const mode = getAutoMode(cfg);

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (mode === "off" && openCount > 0) {
          choices.push("Start auto mode");
        } else if (mode !== "off") {
          choices.push(`Stop auto mode (currently ${mode})`);
        }
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice === "Start auto mode") {
          setAutoMode("auto");
          ui.notify(
            "Auto mode on — will advance through open tasks and ask you about anything still in progress.",
            "info",
          );
          await autoAdvance(ctx as unknown as ExtensionContext, "tasks_menu_start_auto");
        } else if (choice.startsWith("Stop auto mode")) {
          setAutoMode("off");
          ui.notify("Auto-advance mode disabled.", "info");
          await mainMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "completed": return "✔";
            case "in_progress": return "◼";
            default: return "◻";
          }
        };

        const choices = tasks.map(t =>
          `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Extract task ID from selection
        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          store.update(taskId, { status: "in_progress" });
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          store.update(taskId, { status: "completed" });
          queuedTaskIds.delete(taskId);
          autoPromptAttempts.delete(taskId);
          autoClear.trackCompletion(taskId, currentTurn);
          widget.setActiveTask(taskId, false);
          queueNextOpenTask("task_completed_menu");
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          store.update(taskId, { status: "deleted" });
          queuedTaskIds.delete(taskId);
          autoPromptAttempts.delete(taskId);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}

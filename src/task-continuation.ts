import { randomUUID } from "node:crypto";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { Task } from "./types.js";

type AgentMessage = ContextEvent["messages"][number];

const customType = "pi-tasks:continuation";
const skippedType = "pi-tasks:skipped-continuation";
interface Identity {
  version: 1;
  requestId: string;
  taskId: string;
  createdAt: number;
}
function identity(message: AgentMessage): Identity | undefined {
  if (message.role !== "custom" || message.customType !== customType) return undefined;
  const data = message.details as Partial<Identity> | undefined;
  return data?.version === 1 && typeof data.requestId === "string" && typeof data.taskId === "string" &&
    typeof data.createdAt === "number" ? data as Identity : undefined;
}

export function taskContinuation(task: Task, content: string) {
  return { customType, content, display: true, details: {
    version: 1 as const, requestId: randomUUID(), taskId: task.id, createdAt: task.createdAt, subject: task.subject,
  } };
}

/** Identify automation by message metadata, never by text the user can type. */
export function installTaskContinuationGuard(
  pi: ExtensionAPI,
  readTask: (id: string) => Task | undefined,
  delivered: (id: string) => void,
) {
  let incoming: AgentMessage[] = [];
  const skipped = new Set<string>();
  pi.registerMessageRenderer(customType, (message, { expanded, outputPad }) => {
    const text = typeof message.content === "string" ? message.content : message.content
      .filter(part => part.type === "text").map(part => part.text).join("\n");
    // Text escapes from task subjects cannot issue terminal commands.
    const safe = stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    const details = message.details as { taskId?: string; subject?: string } | undefined;
    const summary = details?.subject === undefined ? safe.split("\n")[0]
      : stripTerminalSequences(`Task #${details.taskId} · ${details.subject}`).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    return new Text(expanded ? safe : summary, outputPad, 0);
  });
  pi.on("session_start", async (_event, ctx) => {
    incoming = [];
    skipped.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === skippedType) {
        const id = (entry.data as { requestId?: unknown })?.requestId;
        if (typeof id === "string") skipped.add(id);
      }
    }
  });
  pi.on("agent_start", async () => { incoming = []; });
  pi.on("message_start", async (event) => {
    if (event.message.role === "assistant") return;
    incoming.push(event.message);
    const own = identity(event.message);
    if (own) delivered(own.taskId);
  });
  pi.on("context", async (event, ctx) => {
    let stale = 0;
    let live = 0;
    for (const message of incoming) {
      const own = identity(message);
      if (!own) { live++; continue; }
      const task = readTask(own.taskId);
      if (task && task.createdAt === own.createdAt && task.status !== "completed") { live++; continue; }
      stale++;
      if (!skipped.has(own.requestId)) {
        skipped.add(own.requestId);
        pi.appendEntry(skippedType, { requestId: own.requestId });
        ctx.ui.notify(`Skipped stale continuation for task #${own.taskId}.`, "info");
      }
    }
    incoming = [];
    // Wait until all inputs for this request are known: a user message or tool result
    // delivered alongside a stale continuation still needs its response.
    if (stale && !live) ctx.abort();
    // Preserve source bytes for hosts that verify delivery receipts. A retained
    // cancellation note supersedes the stale instruction when other input needs a turn.
    return { messages: event.messages.flatMap((message): AgentMessage[] => {
      const own = identity(message);
      if (!own || !skipped.has(own.requestId)) return [message];
      return [message, {
        role: "custom", customType: skippedType, display: false, timestamp: message.timestamp,
        content: `The preceding automated continuation for task #${own.taskId} is cancelled. Do not execute it. Respond to any other input in this turn.`,
      }];
    }) };
  });
}

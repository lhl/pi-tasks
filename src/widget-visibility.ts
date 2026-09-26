import type { TaskWidget } from "./ui/task-widget.js";

export const TASK_WIDGET_CLAIM = "tasks:widget:claim";
export const TASK_WIDGET_READY = "tasks:widget:ready";
export interface TaskWidgetClaim {
  version: 1;
  respond: (release: () => void) => void;
}
interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
}

/** An in-process presentation claim. It does not write the saved visibility setting. */
export function installTaskWidgetVisibility(events: EventBus, widget: Pick<TaskWidget, "suppress">): () => void {
  const releases = new Set<() => void>();
  let disposed = false;
  const unsubscribe = events.on(TASK_WIDGET_CLAIM, (value) => {
    if (disposed || !value || typeof value !== "object") return;
    const request = value as Partial<TaskWidgetClaim>;
    if (request.version !== 1 || typeof request.respond !== "function") return;
    let restore: () => void;
    try {
      restore = widget.suppress();
    } catch {
      return;
    }
    const release = () => {
      if (!releases.delete(release)) return;
      try { restore(); } catch { /* A UI failure must not retain other claims. */ }
    };
    releases.add(release);
    try {
      request.respond(release);
    } catch {
      release();
    }
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const release of releases) release();
  };
}

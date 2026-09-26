import { describe, expect, it, vi } from "vitest";
import { installTaskWidgetVisibility, TASK_WIDGET_CLAIM } from "../src/widget-visibility.js";

function fixture() {
  let handler: ((data: unknown) => void) | undefined;
  const unsubscribe = vi.fn(() => { handler = undefined; });
  const restore = vi.fn();
  const suppress = vi.fn(() => restore);
  const dispose = installTaskWidgetVisibility({ on: (event, listener) => {
    expect(event).toBe(TASK_WIDGET_CLAIM);
    handler = listener;
    return unsubscribe;
  } }, { suppress });
  return { emit: (data: unknown) => handler?.(data), dispose, unsubscribe, restore, suppress };
}

describe("task widget visibility claims", () => {
  it("requires a supported request and returns an idempotent release", () => {
    const f = fixture();
    for (const input of [null, {}, { version: 2, respond() {} }, { version: 1 }]) f.emit(input);
    expect(f.suppress).not.toHaveBeenCalled();
    let release!: () => void;
    f.emit({ version: 1, respond: (value: () => void) => { release = value; } });
    expect(f.suppress).toHaveBeenCalledTimes(1);
    release();
    release();
    f.dispose();
    expect(f.restore).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge failed suppression or let a failed restore block cleanup", () => {
    const f = fixture();
    f.suppress.mockImplementationOnce(() => { throw new Error("UI unavailable"); });
    const respond = vi.fn();
    f.emit({ version: 1, respond });
    expect(respond).not.toHaveBeenCalled();
    f.emit({ version: 1, respond });
    f.emit({ version: 1, respond });
    f.restore.mockImplementationOnce(() => { throw new Error("UI detached"); });
    expect(() => f.dispose()).not.toThrow();
    expect(f.restore).toHaveBeenCalledTimes(2);
  });

  it("restores claims on callback failure or shutdown without leaking a listener", () => {
    const f = fixture();
    f.emit({ version: 1, respond() { throw new Error("consumer failed"); } });
    expect(f.restore).toHaveBeenCalledTimes(1);
    let release!: () => void;
    f.emit({ version: 1, respond: (value: () => void) => { release = value; } });
    f.dispose();
    f.dispose();
    release();
    f.emit({ version: 1, respond() {} });
    expect(f.restore).toHaveBeenCalledTimes(2);
    expect(f.suppress).toHaveBeenCalledTimes(2);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

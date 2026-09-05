/**
 * settings-menu.ts — Polished settings panel for /tasks → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions — matching pi-coding-agent's
 * own settings panel style.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { type AutoMode, getAutoMode, saveTasksConfig, type TasksConfig } from "../tasks-config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

// ── Settings panel ──────────────────────────────────────────────────────────

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: TasksConfig,
  onBack: () => Promise<void>,
  clearDelayTurns: number,
  cwd: string,
): Promise<void> {
  await ui.custom((_tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      {
        id: "taskScope",
        label: "Task storage",
        description:
          "memory: tasks live only in memory, lost when session ends. " +
          "session: persisted per session in the workspace, survives resume. " +
          "session-global: per-session storage under Pi's agent directory. " +
          "project: shared across all sessions in the workspace. " +
          "Takes effect on next session start.",
        currentValue: cfg.taskScope ?? "session",
        values: ["memory", "session", "session-global", "project"],
      },
      {
        id: "autoMode",
        label: "Auto-advance mode",
        description:
          "off: never auto-queue follow-up prompts — use TaskExecute or a manual prompt. " +
          "cascade: silently queue the next open unblocked task after a completion or agent idle (capped per task to avoid loops). " +
          "auto: like cascade, but if a task is still in_progress at agent idle, ask the user (complete / continue / stop). " +
          "Auto-disables once every task is complete. Trigger one-shot via '/tasks auto'.",
        currentValue: getAutoMode(cfg),
        values: ["off", "cascade", "auto"],
      },
      {
        id: "autoClearCompleted",
        label: "Auto-clear completed tasks",
        description:
          "never: completed tasks stay visible until manually cleared. " +
          "on_list_complete: cleared automatically after all tasks are done. " +
          "on_task_complete: each task cleared shortly after it completes. " +
          `Clearing lags ~${clearDelayTurns} turns.`,
        currentValue: cfg.autoClearCompleted ?? "on_list_complete",
        values: ["never", "on_list_complete", "on_task_complete"],
      },
    ];

    const list = new SettingsList(
      items,
      /* maxVisible */ 10,
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "autoMode") {
          cfg.autoMode = newValue as AutoMode;
          // Clear the legacy boolean field so it stops shadowing the new setting.
          if ("autoCascade" in cfg) delete cfg.autoCascade;
          saveTasksConfig(cfg, cwd);
        }
        if (id === "taskScope") {
          cfg.taskScope = newValue as TasksConfig["taskScope"];
          saveTasksConfig(cfg, cwd);
        }
        if (id === "autoClearCompleted") {
          cfg.autoClearCompleted = newValue as TasksConfig["autoClearCompleted"];
          saveTasksConfig(cfg, cwd);
        }
      },
      /* onCancel */ () => done(undefined),
    );

    // Container doesn't forward handleInput to children — subclass to fix.
    class SettingsPanel extends Container {
      handleInput(data: string) { list.handleInput(data); }
    }

    const root = new SettingsPanel();
    root.addChild(new Text(theme.bold(theme.fg("accent", "⚙  Task Settings")), 0, 0));
    // (Auto-advance mode can also be toggled at any time via '/tasks auto'.)
    root.addChild(new Spacer(1));
    root.addChild(list);

    return root;
  });

  return onBack();
}

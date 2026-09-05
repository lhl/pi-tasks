# @lhl/pi-tasks

A [pi](https://pi.dev) extension for structured task tracking and coordination. Track multi-step work with persistent tasks, dependency management, blocker-aware auto-advance, and a live widget.

> **Status:** Early release.
>
> **Fork notice:** This is a fork of [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) maintained at [github.com/lhl/pi-tasks](https://github.com/lhl/pi-tasks). Full credit for the original extension goes to [tintinweb](https://github.com/tintinweb).
>
> The fork diverged from upstream `0.5.0` and has since changed a fair amount — see the [`0.6.0` CHANGELOG entry](./CHANGELOG.md) for the full list. Highlights:
>
> - `TaskExecute` no longer spawns subagents via `@tintinweb/pi-subagents`; it schedules sequential follow-up work in the current pi session instead. The whole subagent RPC layer is removed.
> - New **interactive auto-advance mode** (`/tasks auto`, `autoMode: "auto"`) walks the task list to completion and asks the user about anything still in progress instead of silently retrying.
> - `TaskCreateMany`, persisted task execution stats (start/end/duration/tokens), and a hardened task store (corrupt-file callback, dir auto-heal, `notFound` results).
> - No more `<system-reminder>` injection into unrelated tool results.
> - Pi runtime moved to `@earendil-works/*` and `@sinclair/typebox`, peer-depended.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/lhl/pi-tasks/raw/master/media/screenshot.png" />

## Features

- **8 LLM-callable tools** — `TaskCreate`, `TaskCreateMany`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute`.
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status icons, task numbers, strikethrough for completed tasks, and a star spinner for active tasks with elapsed time and token counts.
- **Prompt-injected task execution** — `TaskExecute` schedules tasks in order and releases one follow-up prompt after each agent run. Completed, deleted, and blocked tasks are skipped before enqueueing.
- **Compact continuation display** — generated task prompts render as a one-line task label in Pi 0.84 or newer; the full prompt remains in model context.
- **Auto-advance mode** — tri-state setting (`off` / `cascade` / `auto`). `cascade` selects the next open unblocked task after the agent run ends. `auto` does the same, but when an in-progress task is still open at agent idle it asks you whether to mark it complete, continue, or stop. Toggle from the command line with `/tasks auto`.
- **Dependency management** — bidirectional `blocks`/`blockedBy` relationships with warnings for cycles, self-deps, and dangling references.
- **Shared task lists** — multiple pi sessions can share a file-backed task list for coordination.
- **File locking** — concurrent access is safe when multiple sessions share a task list.
- **Background process tracking** — track spawned processes with output buffering, blocking wait, and graceful stop.

This fork intentionally does **not** inject periodic `<system-reminder>` messages into tool results.

## Install

```bash
pi install npm:@lhl/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

Migrating from `@tintinweb/pi-tasks`? Uninstall the upstream package first (`pi uninstall @tintinweb/pi-tasks`) so only one copy is active. Existing `.pi/tasks-config.json` files are read as-is; the legacy `autoCascade: true` setting is automatically interpreted as the new `autoMode: "cascade"`.

## Widget

The extension renders a persistent widget above the editor:

```text
● 4 tasks (1 done, 1 in progress, 2 open)
  ✔ #1 Design the flux capacitor
  ✳ #2 Acquiring plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ #3 Install flux capacitor in DeLorean › blocked by #1
  ◻ #4 Test time travel at 88 mph › blocked by #2, #3
```

| Icon | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress |
| `◻` | Pending |
| `✳`/`✽` | Animated star spinner — actively executing task |

## Tools

### `TaskCreate`

Create a structured task. Used proactively for complex multi-step work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner (e.g., `Running tests`) |
| `agentType` | string | no | Legacy compatibility hint; no longer required for execution |
| `metadata` | object | no | Arbitrary key-value pairs |

### `TaskCreateMany`

Create multiple structured tasks in a single call. More efficient than repeated `TaskCreate` calls when all tasks are known upfront.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tasks` | array | yes | Array of task objects (min 1) |
| `tasks[].subject` | string | yes | Brief imperative title |
| `tasks[].description` | string | yes | Detailed context and acceptance criteria |
| `tasks[].activeForm` | string | no | Present continuous form for spinner |
| `tasks[].agentType` | string | no | Legacy compatibility hint |
| `tasks[].metadata` | object | no | Arbitrary key-value pairs |

```text
→ Created 3 tasks:
  #1 Design the API
  #2 Implement the handler
  #3 Write tests
```

### `TaskList`

List all tasks with status, owner, and blocked-by info.

```text
#1 [pending] Fix authentication bug
#2 [in_progress] Write unit tests
#3 [pending] Update docs [blocked by #1, #2]
```

Sort order: pending first, then in-progress, then completed (each group by ID).

### `TaskGet`

Get full details for a specific task, including description, dependencies, owner, and metadata.

### `TaskUpdate`

Update task fields, status, metadata, and dependencies.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Owner name |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Task IDs this task blocks |
| `addBlockedBy` | string[] | Task IDs that block this task |

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3.

### `TaskOutput`

Retrieve output from a background task process, or report the status of a prompt-queued task.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — | Task ID (required) |
| `block` | boolean | `true` | Wait for background process completion |
| `timeout` | number | `30000` | Max wait time in ms (max 600000) |

Prompt-queued tasks run in the main conversation, so they do not have separate background stdout.

### `TaskStop`

Stop a running background process associated with a task. Prompt-queued tasks run in the main conversation; use `TaskUpdate` to change their status.

### `TaskExecute`

Schedule one or more tasks for sequential follow-up work in the current pi session.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Ordered task IDs to schedule (required) |
| `additional_context` | string | Extra context appended to each task prompt |

Tasks must be `pending` or `in_progress`, and all `blockedBy` dependencies must be `completed` when scheduled. The extension waits for the active agent run to end, checks each task again, and releases one live task prompt. A later task waits until the active explicit task is completed, deleted, or blocked. Tasks that reach one of those states before release do not trigger a model turn.

A released prompt marks a pending task `in_progress`, displays the active spinner, and instructs the agent to focus on that task, use `TaskGet` if needed, and finish with `TaskUpdate`. Dependent task prompts include completed prerequisites' `metadata.result` values when available.

**Auto-advance** (`/tasks` → Settings, or `/tasks auto`) drives the task list forward automatically:

| Mode | Behavior |
|------|----------|
| `off` (default) | Never auto-queues prompts — use `TaskExecute` or manual prompts. |
| `cascade` | At each agent-run boundary, queues the next open unblocked task from live task state. Capped to a few attempts per task to prevent runaway loops. |
| `auto` | Same as cascade, but when a task is still `in_progress` at agent idle, asks you whether to **mark complete**, **continue** (re-queue), or **stop** auto mode. Auto-disables once every task is completed or cleared. |

Dependent task prompts include completed prerequisites' `metadata.result` values when available.

## Task Lifecycle

```text
pending → in_progress → completed
                      → deleted (permanently removed)
```

Tasks are created as `pending`. Mark `in_progress` before starting work, `completed` when done. `deleted` removes entirely — IDs never reset.

## Dependency Management

- **Bidirectional edges:** `addBlocks`/`addBlockedBy` maintain both sides automatically.
- **Dependency warnings:** cycles, self-dependencies, and references to non-existent tasks are stored but produce warnings in the tool response.
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`.
- **Raw data preserved:** `TaskGet` shows all edges, including completed blockers.
- **Cleanup on deletion:** removing a task cleans up all edges pointing to it.

## Task Storage

Task storage is controlled by the `taskScope` setting (`/tasks` → Settings → Task storage):

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | *(none)* | In-memory only — tasks lost when session ends |
| `session` **(default)** | `<cwd>/.pi/tasks/tasks-<sessionId>.json` | Per-session file — isolated between sessions, survives resume |
| `project` | `<cwd>/.pi/tasks/tasks.json` | Shared across all sessions in the project |

Settings (`taskScope`, `autoMode`, `autoClearCompleted`) are saved to `<cwd>/.pi/tasks-config.json`. The legacy boolean `autoCascade: true` from older versions is still read and mapped to `autoMode: "cascade"` for backward compatibility.

### Auto-clear completed tasks

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared |
| `on_list_complete` **(default)** | Clears after four later turns, or before the first task in a later settled batch |
| `on_task_complete` | Each completed task clears after four later turns; a fully completed list also retires before a later settled batch |

### Override via environment variables

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only (CI/automation) |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit absolute file path |
| `PI_TASKS` | `./tasks.json` | Relative path resolved from cwd |
| *(unset)* | | Uses `taskScope` setting (default: `session`) |
| `PI_TASKS_DEBUG` | `1` | Trace prompt queueing and debug messages to stderr |

## `/tasks` Command

Interactive menu:

```text
Tasks
├─ View all tasks (4)
├─ Create task
├─ Start auto mode             (only when there is open work and auto mode is off)
├─ Clear completed (1)
├─ Clear all (4)
└─ Settings
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete).
- **Create task** — input prompts for subject and description.
- **Start / Stop auto mode** — toggle interactive auto-advance through the task list.
- **Clear completed** — remove all completed tasks.
- **Clear all** — remove all tasks regardless of status.
- **Settings** — configure task storage, auto-advance mode, and auto-clear completed tasks.

### `/tasks auto` subcommand

Flip auto-advance on or off without opening the menu:

| Command | Effect |
|---------|--------|
| `/tasks auto` | Set mode to `auto` and immediately advance — will ask you about any in-progress task. |
| `/tasks auto cascade` | Set mode to `cascade` (silent auto-advance with attempt cap). |
| `/tasks auto off` | Disable auto-advance. |
| `/tasks auto status` | Show the current mode. |

In `auto` mode the extension prompts you at each agent idle with three choices:

- **✓ Mark complete** — marks the in-progress task as completed and advances to the next open task.
- **▸ Continue (re-queue this task)** — re-queues the same task as a follow-up prompt with a fresh attempt counter.
- **✗ Stop auto mode** — sets the mode back to `off`.

Auto mode automatically disables itself once every task is completed or cleared.

## Architecture

```text
src/
├── index.ts            # Extension entry: tools, /tasks command, widget, prompt execution
├── types.ts            # Task, TaskStatus, BackgroundProcess types
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── auto-clear.ts       # Turn-based auto-clearing of completed tasks
├── tasks-config.ts     # Config persistence
├── process-tracker.ts  # Background process output buffering and stop
└── ui/
    ├── task-widget.ts  # Persistent widget with status icons and spinner
    └── settings-menu.ts  # /tasks → Settings panel
```

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## License

MIT.

- Original `@tintinweb/pi-tasks` © [tintinweb](https://github.com/tintinweb)
- Fork additions © [lhl](https://github.com/lhl)

See [LICENSE](LICENSE) for the full text.

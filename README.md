# @tintinweb/pi-tasks

A [pi](https://pi.dev) extension for structured task tracking and coordination. Track multi-step work with persistent tasks, dependency management, and a live widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

## Features

- **8 LLM-callable tools** — `TaskCreate`, `TaskCreateMany`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute`.
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status icons, task numbers, strikethrough for completed tasks, and a star spinner for active tasks with elapsed time and token counts.
- **Prompt-injected task execution** — `TaskExecute` queues follow-up user prompts in the current pi session instead of launching subagents.
- **Auto-continue mode** — when enabled, the next open unblocked task is queued automatically after task completion or when the agent becomes idle with open work.
- **Dependency management** — bidirectional `blocks`/`blockedBy` relationships with warnings for cycles, self-deps, and dangling references.
- **Shared task lists** — multiple pi sessions can share a file-backed task list for coordination.
- **File locking** — concurrent access is safe when multiple sessions share a task list.
- **Background process tracking** — track spawned processes with output buffering, blocking wait, and graceful stop.

This fork intentionally does **not** inject periodic `<system-reminder>` messages into tool results.

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

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

Queue one or more tasks as follow-up user prompts in the current pi session.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Task IDs to queue (required) |
| `additional_context` | string | Extra context appended to each task prompt |

Tasks must be `pending` or `in_progress`, and all `blockedBy` dependencies must be `completed`. `TaskExecute` marks pending tasks `in_progress`, displays the active spinner, and calls `pi.sendUserMessage(..., { deliverAs: "followUp" })` with a task-focused prompt.

Queued prompts instruct the agent to focus on that task, use `TaskGet` if needed, mark it `in_progress`, and mark it `completed` with an optional `metadata.result` summary when done. Dependent task prompts include completed prerequisites' `metadata.result` values when available.

With **auto-continue** enabled (`/tasks` → Settings), completing a task automatically queues the next open unblocked task. If the agent becomes idle while open work remains, the extension can also queue the next task prompt. A per-task attempt cap prevents runaway repeated auto-prompts.

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

Settings (`taskScope`, `autoCascade`, `autoClearCompleted`) are saved to `<cwd>/.pi/tasks-config.json`. The internal `autoCascade` setting powers the user-facing **Auto-continue with prompts** toggle.

### Auto-clear completed tasks

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared |
| `on_list_complete` **(default)** | Cleared after all tasks are done and a few idle turns pass |
| `on_task_complete` | Each completed task cleared individually after a few turns |

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
├─ Clear completed (1)
├─ Clear all (4)
└─ Settings
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete).
- **Create task** — input prompts for subject and description.
- **Clear completed** — remove all completed tasks.
- **Clear all** — remove all tasks regardless of status.
- **Settings** — configure task storage, auto-continue, and auto-clear completed tasks.

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
npm run typecheck
npm test
```

## License

MIT — [tintinweb](https://github.com/tintinweb)

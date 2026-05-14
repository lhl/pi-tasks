# Task History and Durability

This document summarizes how task execution history is stored today and sketches a possible future direction for making task history a durable, queryable standalone feature.

## Current behavior

`pi-tasks` currently stores task state as mutable JSON, not as an append-only history log.

By default, task storage is session-scoped:

```text
<cwd>/.pi/tasks/tasks-<sessionId>.json
```

Other supported storage modes are:

```text
memory   -> no disk persistence
session  -> <cwd>/.pi/tasks/tasks-<sessionId>.json
project  -> <cwd>/.pi/tasks/tasks.json
```

Settings are stored separately:

```text
<cwd>/.pi/tasks-config.json
```

Execution stats shown in the widget, for example:

```text
✔ #24 Investigate full-attention decode gap (started 12:44:58 PM · ended 12:49:54 PM · 4m 55s · ↑ 43.3k · ↓ 4.2k)
```

are rendered from task metadata, not stored as that formatted string. The persisted task object may include:

```json
{
  "metadata": {
    "executionStats": {
      "startedAt": 1710000000000,
      "completedAt": 1710000295000,
      "durationMs": 295000,
      "inputTokens": 43300,
      "outputTokens": 4200
    }
  }
}
```

`TaskGet` and the widget render these fields as human-readable start/end times, duration, and token counts.

## Relationship to pi sessions

Pi itself stores conversation sessions as JSONL under its session directory. Tool calls such as `TaskCreate`, `TaskUpdate`, and `TaskGet` may appear in the pi session transcript, and assistant messages carry raw model usage.

However, `pi-tasks` does not currently append a separate task-history entry to the pi session/rollout log. The canonical task state is the task store JSON file. The widget text is UI-only unless it is echoed by `TaskGet` or assistant text.

## Durability characteristics

Current file-backed task storage is reasonably durable for active task state:

- task files are written atomically;
- shared files use file locking;
- missing task directories are recreated before save;
- corrupt file reads preserve in-memory state and warn rather than immediately discarding live state.

But it is not archival:

- the store represents current task state, not a complete event stream;
- completed tasks can be auto-cleared or manually deleted, removing their stats;
- if `taskScope` is `memory`, tasks are lost when the session ends;
- if pi exits mid-task, `startedAt` may be persisted but live token accumulation may be incomplete;
- edits overwrite fields rather than preserving prior values.

## Why task history could be useful

A durable task history would be valuable beyond the live widget:

- review what work was done across sessions;
- answer “what did I spend time/tokens on?”;
- correlate task activity with folders/projects, branches, sessions, models, and outcomes;
- search completed work by subject, description, result, or metadata;
- build dashboards for active vs completed work;
- preserve cleared tasks without cluttering the active UI;
- provide a lightweight project journal independent of the chat transcript.

## Possible future direction: SQLite-backed task history

A future storage layer could use SQLite instead of, or in addition to, JSON files. This would make task history efficiently queryable by session, folder, state, visibility, timestamps, and metadata.

One useful distinction would be between the full historical record and the active task list shown in the UI.

### Conceptual tables

#### `tasks`

Long-lived canonical task records.

Possible columns:

- `id` — stable task id, possibly globally unique;
- `local_id` — display id within a session/project, e.g. `#24`;
- `session_id` — pi session id where the task was created or last owned;
- `cwd` / `project_path` — working directory or project root;
- `subject`;
- `description`;
- `status` — `pending`, `in_progress`, `completed`, etc.;
- `created_at`;
- `updated_at`;
- `completed_at`;
- `owner`;
- `metadata_json`.

#### `task_execution_stats`

Execution-window and token/cost information.

Possible columns:

- `task_id`;
- `started_at`;
- `completed_at`;
- `duration_ms`;
- `input_tokens`;
- `output_tokens`;
- `cache_read_tokens`;
- `cache_write_tokens`;
- `cost`;
- `model`;
- `provider`;
- `session_id`.

#### `task_edges`

Dependency graph.

Possible columns:

- `from_task_id`;
- `to_task_id`;
- `edge_type` — e.g. `blocks`.

#### `task_events`

Append-only audit trail for lifecycle changes.

Possible columns:

- `id`;
- `task_id`;
- `event_type` — `created`, `updated`, `status_changed`, `completed`, `cleared`, `deleted`, etc.;
- `timestamp`;
- `session_id`;
- `data_json`.

#### `task_visibility` or `active_tasks`

The active/uncleared view used by the widget and `TaskList`.

Possible columns:

- `task_id`;
- `scope` — `session`, `project`, or global view;
- `session_id`;
- `cwd` / `project_path`;
- `visible`;
- `cleared_at`;
- `sort_order`.

With this split, clearing a task from the UI would only remove or update the visibility row. The historical task and execution stats would remain queryable.

## Migration considerations

A migration from JSON files to SQLite could preserve the existing UX:

1. Continue rendering the active task list from a current-state view.
2. Import existing `.pi/tasks/*.json` files into `tasks`, `task_edges`, and `task_execution_stats`.
3. Treat auto-clear as a visibility change rather than deletion from history.
4. Keep JSON export/import for portability and debugging.
5. Optionally append pi session references so task history can link back to the relevant transcript entries.

## Open questions

- Should task ids remain session-local display ids, or become globally unique with session-local aliases?
- Should history be stored per project, globally under `~/.pi`, or both?
- How should forked pi sessions and branched task histories relate to each other?
- Should task history capture model/provider/cost per turn or only aggregate per task?
- How much metadata should be indexed vs left as JSON?
- What is the retention policy for deleted tasks, sensitive metadata, and exported histories?

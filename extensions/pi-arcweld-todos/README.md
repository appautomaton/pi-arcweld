# Pi todos

An always-on todo tool for [Pi](https://github.com/earendil-works/pi). It gives the agent a coherent, first-class way to plan and track long-horizon work, in every mode, without disturbing the provider prompt cache.

## What it does

- Registers one model-facing tool, `update_todos`, that maintains an ordered task list with whole-list-replace semantics. One call submits the complete list and replaces the previous one, so a single call can add, remove, reorder, rename, or re-scope items. There are no item IDs; position is identity.
- Each item carries `content` (imperative, e.g. "Run the test suite"), `activeForm` (present-continuous, e.g. "Running the test suite", shown live while in progress), and `status` (`pending` | `in_progress` | `completed`).
- Renders a live footer badge (`📋 2/5` plus the active item) and a progress widget above the editor while work remains, and offers a `/todos` overlay. A final all-completed update stays in session history but automatically clears the live badge and widget, so finished work does not look stale.

## Cache safety

The tool is registered once at extension load and is always active. It is never toggled through `pi.setActiveTools`, so the provider prompt prefix (tools, then system, then earlier messages) stays byte-stable across turns. All evolving state rides in the conversation tail:

- the current list lives in each tool result's `details`, so branching and rewind are correct by construction;
- a short, rate-limited reminder is appended via `before_agent_start` only after the model has gone quiet, never by rewriting the system prompt or filtering earlier messages.

State is session-scoped. It is rebuilt from the active branch on `session_start` and `session_tree`; there is no external file.

## Commands

- `/todos` — open the todo overlay (interactive mode)

## Shared contract with plan mode

[`pi-arcweld-plan-mode`](../plan-mode/README.md) instructs the model to record its plan by calling `update_todos`, and reads the resulting list to drive its handoff. The only coupling is the tool name `update_todos` and the `details.todos` shape. There is no code dependency in either direction; either extension works without the other loaded.

## Loading

The user-level Pi agent loads this package through the symlink `~/.pi/agent/extensions/pi-arcweld-todos` → this directory. Run `/reload` after changing the extension.

## Development

```bash
cd extensions/pi-arcweld-todos
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
```

# Pi delegate

Scoped, in-process model handoff for [Pi](https://github.com/earendil-works/pi).

X (the user-facing session) calls `delegate`. Y runs the job in its own `createAgentSession` on a cheaper or specialized model. Y may hand one nested job to Z. Z cannot spawn. The only thing that returns is a structured contract.

This is logistics, not a scout/planner/worker workflow, and not a mailbox.

## Behaviour

- `delegate` is registered once at load. The parent tool set is never rewritten.
- Child default tools are read-only (`read`, `grep`, `find`, `ls`). `write` / `edit` / `bash` are opt-in per call.
- The child does not load parent extensions, skills, or prompt templates. `delegate_result` is always in the child's allowlist.
- Child sessions are in-memory. Esc on the parent aborts Y and Z.
- Caps: 20 child turns, 5-minute wall clock. Missing `delegate_result` becomes `needs_review`.

## Addressing

Aliases live in the machine-local file `~/.pi/agent/delegate.json` (not committed):

```json
{
  "aliases": {
    "flash": "cli-proxy-api-google/gemini-3.7-flash-high",
    "glm": "openrouter-glm/z-ai/glm-5.3"
  }
}
```

`to` may be an alias or an explicit `provider/model` id. Alias edits are read per call; `/reload` is not required. Dynamically registered parent providers are out of v1 — only file-configured models follow.

## Commands

- `/delegate` — aliases, auth availability, last result. Completions for alias names. Does not start jobs.

Ctrl+O expands the contract in the transcript. Child grep noise stays in `details`.

## Loading

The user-level Pi agent loads this package through the symlink `~/.pi/agent/extensions/delegate` → this directory. Run `/reload` after changing the extension.

## Development

```bash
cd extensions/delegate
npm run check
npm test
npm run pack:check
```

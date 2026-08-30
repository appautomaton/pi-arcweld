# Pi Arcweld: model delegation (`delegate`)

Local plan stub. Captures the design locked in the 2026-08-29 session so we can resume without reconstructing it from chat.

Repo: `/Users/ac/dev/agents/coding/pi-arcweld`
Form: curated extension under `extensions/delegate/`, same package shape as `plan-mode` / `pi-arcweld-todos`
Not: an npm subagent package, not a fork of pi-mono, not a mailbox/swarm product

---

## Intent

Different models have different cost and skill. Do not send every hop through the most expensive model.

This is **logistics**, not a baked workflow.

- X (user-facing, often `cli-proxy-api/gpt-5.6-sol`) scopes a job and calls `delegate`.
- Y runs that job in its own session, on a cheaper or specialized model (flash, GLM, Kimi, local Qwen, …).
- Y may hand a scoped job to Z. Z cannot spawn.
- The only thing that returns is a **structured contract**, plus file paths for bulky evidence.

It is not scout → planner → worker. No personas, no `/implement` pipeline, no DAG.

---

## Locked decisions

| Topic | Choice |
|---|---|
| Runtime | In-process `createAgentSession` (same Pi process). Required so CPA / GLM / local MLX providers follow. |
| Nesting | Nested, max depth 2: main → Y → Z. Z cannot spawn. |
| Addressing | Machine aliases + explicit `provider/model` IDs. No baked scout/planner/reviewer roles. |
| Child default tools | Read-only: `read`, `grep`, `find`, `ls`. `write` / `edit` / `bash` only if the caller opts in on that call. |
| Parallelism | Sequential in v1. No two writers on the same tree. |
| Communication | Call / return only. `delegate` in, `delegate_result` out. No mailbox, no duplex chat, no `subagent_send`. |
| Cache cut | New session between models is correct. Freeze prefix **inside** each child. |
| Artifacts | Paths in the result. No sidecar file in v1 (easy to add later without changing the tool schema). |
| Parent tool list | `delegate` registered once at load, never `setActiveTools` for it. |
| Child bounds | `maxTurns: 20`, wall clock 5 minutes. Cap → `blocked` with an `open_questions` note, then abort. |
| Missing `delegate_result` | Synthesize `needs_review` from `getLastAssistantText()`. User/Esc abort → `blocked`. |
| Thinking level | Inherit settings default. No per-alias policy in v1. |
| Constrained sampling | `strict: "prefer"` on `delegate_result` (not `require`; local/GLM routes may not honor require). |
| Child progress UI | Footer + transcript line. No live widget in v1. |

Example aliases (machine-local file, not committed):

```json
{
  "aliases": {
    "sol":   "cli-proxy-api/gpt-5.6-sol",
    "flash": "cli-proxy-api-google/gemini-3.7-flash-high",
    "glm":   "openrouter-glm/z-ai/glm-5.3",
    "kimi":  "cli-proxy-api/moonshotai/kimi-k3",
    "local": "mlx-genai-local/qwen3.8-27b-quality"
  }
}
```

Unknown `to` errors at execute time with the current alias/id list. Alias edits do not rewrite the parent tool schema. Read the alias file per call (mtime cache); `/reload` is not required.

---

## Why not the existing subagent world

Pi core deliberately has **no** built-in sub-agents. Official example: spawn `pi --mode json -p --no-session` with markdown agent files (scout/planner/reviewer/worker) and parent-driven `chain` / `parallel`. That is a workflow.

npm is crowded (`@narumitw/pi-subagents`, `pi-subagent-in-memory`, `@d3ara1n/pi-subagent`, …). Common shapes: subprocess isolation, role catalogs, background job brokers, bidirectional send/wait, TUI card grids. Most of them encode the workflow we do not want, and several mutate system/tools (cache-hostile).

Claude Code teammates are a **different product**: long-lived peers. `SendMessage` appends to `~/.claude/teams/{team}/inboxes/{name}.json`. The receiver does not poll; unread mail is injected into its next turn. `to: "*"` broadcasts. Control RPCs (`shutdown_request`, `plan_approval_response`) ride the same channel. Later `uds:` / `bridge:` is cross-session sockets. That is a chat bus for persistent teammates, not a scoped job ticket.

We are not copying any of that for v1.

---

## Cache

Provider KV cache is a byte-stable prefix: system + tool schemas + earlier messages.

| Boundary | Share cache? | Rule |
|---|---|---|
| X → Y (different model) | No | New `AgentSession`. Replaying X’s transcript into Y usually costs more than it saves. |
| Inside Y (or Z) | Yes, this is the one that matters | Freeze system prompt and tools at spawn. Append-only after that. |
| Y → Z | No | Another new session. Z’s result returns to Y as a **new tool result**, not a system-prompt edit. |

What we will not copy from Pi examples / npm:

- Swap tools when entering a mode (upstream plan-mode).
- Inject live alias catalogue, job list, or “you have a child” into the system prompt each turn.
- Dump Y’s full transcript back into X.
- Bidirectional send/wait loops.
- Concatenate `{previous}` into a giant prompt while also keeping old messages.

Frozen contract per child, set at spawn, kept until the child dies:

```
system:  Pi coding prompt
         + project AGENTS.md
         + spawn-time addendum (task, scope, done_when, depth, allowed tools)
tools:   chosen work tools, frozen
         + delegate          only if depth < 2
         + delegate_result   always, from turn 0 (do not add it later)
messages: one user brief, then append-only turns
```

If the job was wrong, X starts a **new** Y. It does not patch Y’s system prompt.

Children do **not** auto-load plan-mode, MCP, grok, questionnaire, etc. Those would change the child tool prefix. Cache-preserving compaction may be attached later as an explicit extra, not “load the whole parent set.”

Progress widgets are TUI-only. They must not enter model context.

---

## Communication (the contract)

Handoff is function-calling, not email.

```
You ── X (sol) ── delegate(brief) ──► Y
                     ▲                  │
                     │                  ├── work, append-only
                     │                  └── maybe delegate(brief) ──► Z
                     │                       Z cannot spawn
                     │                       Z calls delegate_result
                     │                  that payload is Y’s tool result
                     └── Y calls delegate_result
                         that payload is X’s tool result
```

`delegate` (parent and, if depth < 2, child):

```
delegate({
  to: "flash" | "cli-proxy-api/gpt-5.6-sol" | "openrouter-glm/z-ai/glm-5.3",
  task: "what to do",
  scope: "paths, invariants, what not to touch",
  done_when: "acceptance check",
  tools?: ["read","grep","find","ls"]   // default read-only
})
```

`delegate_result` (child, `terminate: true`), present from turn 0:

```
delegate_result({
  status: "done" | "blocked" | "needs_review",
  summary: "what happened, short",
  evidence: ["path:lines", "command → outcome"],
  artifacts: ["paths written or worth reading"],
  open_questions: ["only if blocked"]
})
```

If Y is blocked, it returns `blocked` and **exits**. X decides. X may spawn a new Y. Mid-flight chat is how prefixes rot.

Label the tool result as delegated-model output, never as a fake user message (instruction-injection). Cap summary size. Point at files for the rest. Nested usage is attached on the tool result so `/session` totals stay honest.

Esc on X aborts Y and Z; dispose child sessions.

---

## TUI (use Pi’s, don’t invent a second one)

The user-facing session is still Pi. The extension should be visible and abortable, not a dashboard.

v1, in order:

1. **Transcript** — `renderCall` one collapsed line: `sol → flash  read-only  “scan auth, don’t edit”`. Nested: `flash → sol`. `renderResult` collapsed: `done · 4 files · $0.012 · 38s`. Ctrl+O expands the **contract** only. Child grep noise stays in `details`, not parent model text.
2. **Footer status** while running: `delegate flash` or `delegate glm › flash`. Same pattern as plan-mode / todos. Clears when idle.
3. **Abort** — Esc already via `ctx.signal` → child `session.abort()` → grandchild. No extra keybinding in v1.
4. **`/delegate`** — user command: status, aliases (with resolved `provider/model` and auth), last result. Completions for alias names. Does not start jobs. Last result lives in the factory closure (process memory), not `appendEntry`.

Skip in v1: live widget, card grids, Ctrl+1..9 inspectors, paging, overlay games, a second transcript pane.

Print/RPC: no widget. The tool result is the UI.

---

## Package layout (keep it small)

```
extensions/delegate/
  index.ts      load, register tools/commands, shutdown
  types.ts      DelegateParams + DelegateResult
  aliases.ts    resolve "flash" or "provider/model"
  spawn.ts      createAgentSession, frozen tools, depth, abort
  ui.ts         status, widget, renderCall/renderResult
  test/
  package.json  source-only, wildcard Pi peerDependencies
  tsconfig.json same as plan-mode / todos
  README.md
  LICENSE
```

Wire later (when we implement, not in this stub):

- `extensions/README.md` inventory
- `scripts/check-workspace.sh` package check + host-peer gate
- `scripts/check-user-wiring.sh` symlink
- `~/.pi/agent/extensions/delegate` → repo path

Alias file stays machine-local (same pattern as grok/gemini being optional). Do not commit credentials or machine model maps.

---

## Explicitly not in v1

- Named personas / agent markdown catalogs
- Parent-driven chain/parallel workflows
- Mailbox, send/wait, broadcast, duplex sockets
- Background job broker, worktrees, subprocess isolation
- Installing a third-party pi-subagent package
- Auto-loading parent extensions into children
- Sidecar job markdown under `.pi/delegate/`
- Parallel writers
- Depth > 2

---

## Spawn contract (source audit, pi-mono `853a80d`)

Do not scaffold from the defaults above alone. A child `createAgentSession` is wrong unless every line here holds.

| ID | Rule |
|---|---|
| M1 | `options.tools` is the complete allowlist, including custom tools. Always include `delegate_result`. Include `delegate` only when the child's depth is `< 2`. A caller `tools: ["read"]` cannot strip the exit tool. |
| M2 | Use `appendSystemPromptOverride: (base) => [...base, addendum]`. Passing `appendSystemPrompt: [addendum]` replaces discovery and drops `APPEND_SYSTEM.md`. |
| M3 | `noExtensions: true`, `noSkills: true`, `noPromptTemplates: true`. Inject child tools via `customTools`. Never load `mcp-extension` or this extension into a child. |
| M4 | One module-scoped `ModelRuntime` (option A), passed to every child. Dynamically registered parent providers are out of v1. Validate `to` against that runtime (`getModel` + `hasConfiguredAuth`) before spawn. |
| M5 | `SessionManager.inMemory(cwd)`. `session.dispose()` on every exit path. |
| M6 | `SettingsManager.create(cwd, getAgentDir(), { projectTrusted })` where `projectTrusted` is captured from the **parent** `ctx.isProjectTrusted()` and closed over for nested Y→Z. SDK children never `bindExtensions()`, so `ctx.isProjectTrusted()` inside a child is not trustworthy. |
| G1 | `maxTurns: 20` (count `turn_end`) and 5-minute wall clock. Either cap → `status: "blocked"` + `open_questions`, then `abort()`. |
| G2 | `delegate_result` writes a closure holder. Do not parse the transcript. No payload → `needs_review` from `getLastAssistantText()`. Esc/parent abort → `blocked` ("aborted by user"). |
| G3 | Keep `terminate: true`; G1 is the backstop if the child batches another tool with `delegate_result`. First payload wins. |
| G5 | Depth is data in a closure: `makeDelegateTool(depth + 1)` injected as `customTools`. No module-level depth flag. |
| G6 | `truncateHead` on the summary (8KB / 80 lines). Cap `evidence` / `artifacts` / `open_questions` at 20 items. Label the tool result as delegated-model output. |

Child construction sketch (M1–M6): `DefaultResourceLoader` with the `no*` flags and `appendSystemPromptOverride`; allowlist = work tools + `delegate_result` + optional `delegate`; `customTools` = result holder + nested `delegate` at `depth + 1`; `modelRuntime: await sharedRuntime()`; `sessionManager: SessionManager.inMemory(cwd)`.

Do not use `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` for delegation.

## Next step

Scaffold `extensions/delegate/` at that size: types, alias resolver, spawn, tools, thin UI, tests. No mailbox, no personas, no extra interaction model.

This stub is the source of truth until the extension exists and the README can replace it.

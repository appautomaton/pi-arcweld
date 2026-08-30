# Feedback: `delegate` plan

Review target: `~/.agents/plan/pi-arcweld-delegate.md` (2026-08-29 stub)
Verified against: `pi-mono` pinned at `853a80d` (Pi `0.84.4`), the same artifact `build/pi-agent/runtime/bin/pi` runs.
Method: every technical assumption in the plan was checked against upstream source. Each claim below carries a `file:line` citation. External claims in the plan (npm package shapes, Claude Code teammate inbox mechanics) were not re-verified here; they are outside this repo and do not change any conclusion.

Audit note (2026-08-29): every citation in this document was independently re-checked against the pinned checkout line by line, then `sdk.ts`, `resource-loader.ts`, and `agent-session.ts` were read whole to trace the spawn path end to end. All citations land on or within a line or two of the cited position, and the cited APIs (`appendSystemPromptOverride`, `SessionManager.inMemory`, `ctx.isProjectTrusted`, the loader `no*` flags) all exist as described. The whole-file trace corrected one stated consequence (M3: SDK child sessions never fire `session_start`; the harms of loading extensions are different and listed there) and added two primitives (G2: `getLastAssistantText`, and `prompt()`'s throwing auth/provider path). Path convention: a bare `file.ts` is relative to `pi-mono/packages/coding-agent/src/`, `docs/` and `examples/` to `pi-mono/packages/coding-agent/`, and cross-package files are cited by full path. Watch for same-named files in `packages/agent` (`agent-loop.ts`, `file-mutation-queue.ts`): the core loop lives there, the tool plumbing we touch lives in `coding-agent`.

Reader assumption: you know what `delegate` is meant to be (scoped model handoff: X calls `delegate`, Y runs the job in its own session, only a structured contract returns), but you have not read the plan's source-level details.

---

## 1. Verdict

The architecture is sound and it survives contact with the source better than most design stubs. The in-process `createAgentSession` choice, the "call/return only" contract, the depth-2 cap, the cache-cut boundaries, and the refusal to import a mailbox/persona model are all consistent with what Pi actually exposes. Nothing in the plan requires an upstream patch to work.

Six items are **must-fix before scaffolding** because they are wrong against the source and would produce a child that cannot report its result, a child that re-spawns the parent's MCP servers, or a child that silently loses our global guidance. Eight more are **design gaps** the plan should close so the scaffolder is not making contract decisions in code.

Ranked by cost of getting it wrong:

| # | Item | Kind | Blast radius |
|---|---|---|---|
| M1 | Child tool allowlist must name `delegate_result` | must-fix | child cannot terminate cleanly |
| M2 | `appendSystemPrompt` replaces, not extends, `APPEND_SYSTEM.md` | must-fix | child loses our guidance |
| M3 | Default child loads all user extensions | must-fix | recursion + duplicate MCP processes |
| M4 | No extension access to `ModelRuntime` | must-fix (choose a route) | provider coverage in child |
| M5 | Default `SessionManager` writes a real session file per spawn | must-fix | pollutes `--continue`, leaks state |
| M6 | Child trust defaults to `true`, ignoring the parent's decision | must-fix | security posture |
| G1 | No bound on child turns / tokens / wall time | gap | runaway spend |
| G2 | Child finishes without calling `delegate_result` | gap | undefined parent result |
| G3 | `terminate: true` is batch-conditional | gap | child continues anyway |
| G4 | `/reload` for alias edits is unnecessary | gap | avoidable cache miss |
| G5 | Depth must be data in a closure, never a module flag | gap | cache-hostile + wrong depth |
| G6 | Output budgeting must be explicit | gap | context overflow in parent |
| G7 | Where child progress lives (widget vs entry) unspecified | gap | render churn |
| G8 | Cache win inside Y is unmeasured | gap | possible negative optimization |

---

## 2. Confirmed correct, with evidence

| Plan claim | Source evidence |
|---|---|
| Pi core has no built-in sub-agents | no `subagent` symbol anywhere in `packages/coding-agent/src/`; the only mechanism is the example at `examples/extensions/subagent/` (subprocess + role markdown + `/implement` prompts) |
| `delegate_result` can end the child turn | `terminate: true` stops the follow-up call when every finalized result in the batch terminates — `docs/extensions.md` "Early termination" |
| Nested LLM usage can be reported honestly | tool results accept `usage?: Usage`; Pi persists it on the tool result and folds it into footer, `/session`, and RPC totals — `extensions/types.ts:963`, `docs/extensions.md` "Usage accounting", `agent-session.ts:3329-3351` |
| Output truncation has standard limits to reuse | `truncateHead` / `truncateTail` / `DEFAULT_MAX_BYTES` (50KB) / `DEFAULT_MAX_LINES` (2000) are exported — `docs/extensions.md:2168-2200`, `core/tools/truncate.ts` |
| `delegate` registered once at load, no `setActiveTools` | `pi.registerTool` works at load and later; `setActiveTools` is what rewrites the tool set — `docs/extensions.md:1365-1372`, `1677-1700`. Note the upstream plan-mode example does swap tools (`examples/extensions/plan-mode/index.ts:106-112`); our local variant instead uses `pi.appendEntry` + `pi.sendMessage` (`extensions/plan-mode/index.ts:147,156`), which is the precedent the plan should follow |
| Ctrl+O expands the contract only | `app.tools.expand` = `ctrl+o` (`docs/keybindings.md:159`); `renderResult(result, { expanded, isPartial }, ...)` gets the flag (`docs/extensions.md:2290-2310`) |
| Footer status + transient widget + abortable tool | `ctx.ui.setStatus` / `ctx.ui.setWidget` documented (`docs/extensions.md:2584-2612`); `ctx.signal` is the agent's live abort signal (`agent-session.ts:2620`); `session.abort()` aborts and awaits idle (`agent-session.ts:1620-1624`); `session.dispose()` exists (`:882`) |
| `/delegate` with alias completions, no job starting | `pi.registerCommand(name, { getArgumentCompletions })` — `docs/extensions.md:1525-1555` |
| Print/RPC mode: the tool result is the UI | `ExtensionMode = "tui" \| "rpc" \| "json" \| "print"`, plus `ctx.hasUI` (`extensions/types.ts:307-313`) |
| Freeze system prompt and tools inside the child | the prompt is rebuilt from `selectedTools` + snippets + guidelines + append + skills + context files (`agent-session.ts:1084-1095`), so any tool-set change genuinely re-renders the prefix. The plan's rule is correct and mechanically justified |
| Child system = coding prompt + project `AGENTS.md` + addendum | `buildSystemPrompt` appends context files and skills (`system-prompt.ts:53,151-161`); loader supplies `appendSystemPrompt` and agents files (`agent-session.ts:1084-1087`) |

---

## 3. Must-fix before scaffolding

### M1 — the child's `tools` allowlist filters custom tools too

The plan's default is `tools: ["read","grep","find","ls"]`. In `createAgentSession`, `options.tools` becomes **both** the initial active set and the allowlist (`sdk.ts:258`, `const allowedToolNames = options.tools ?? ...`), and that allowlist is applied to custom tools as well:

- `agent-session.ts:2667-2669` — `isAllowedTool(name)` = in allowlist and not excluded.
- `agent-session.ts:2675-2680` — `this._customTools` is `.filter(isAllowedTool)`, so a custom tool outside the allowlist is not merely inactive, it is **absent from the registry**.
- `agent-session.ts:2735-2742` — when an allowlist exists, the active set is built by intersecting it with the registry.

Consequence with the plan as written: the child has no `delegate_result` at all, so it can never report or terminate; it rambles in prose or loops until something external kills it.

Fix: the allowlist is the *complete* tool contract.

```ts
tools: [...workTools, "delegate_result", ...(depth < 2 ? ["delegate"] : [])]
```

Also state in the plan that `delegate_result` is in the allowlist by construction, not by caller choice, so a caller asking for `tools: ["read"]` cannot accidentally build a child with no exit.

### M2 — `appendSystemPrompt` replaces the discovered `APPEND_SYSTEM.md`

`DefaultResourceLoader` only discovers an append file when the option array is empty:

```ts
// resource-loader.ts:532-542
let appendSources = this.appendSystemPromptSource;
if (!appendSources) {
  const discovered = this.discoverAppendSystemPromptFile();
  appendSources = discovered ? [discovered] : [];
}
```

and discovery is project **or** global, never both, gated on trust (`resource-loader.ts:1037-1047`): trusted project `.pi/APPEND_SYSTEM.md`, else `~/.pi/agent/APPEND_SYSTEM.md`. On this machine that global path is the symlink into `system-instruction/APPEND_SYSTEM.md`, i.e. our whole style layer.

Consequence: passing the spawn addendum as `appendSystemPrompt: [addendum]` silently drops arcweld guidance from every child, and child output style will diverge from the parent for no visible reason.

Fix: keep discovery and append to it.

```ts
appendSystemPromptOverride: (base) => [...base, spawnAddendum]
```

If instead we ever want children to ignore global guidance deliberately, say so in the plan and pass the array explicitly, so the choice is visible. Note also `resolvePromptInput` accepts either a path or literal text (`resource-loader.ts:54-69`), so the addendum can be a real string with no temp file.

### M3 — a default child loads every user extension, including our own

`createAgentSession` builds a `DefaultResourceLoader` and reloads it when none is supplied (`sdk.ts:186`), which discovers `~/.pi/agent/extensions/**`. What breaks is subtler than "children spawn MCP trees": `session_start` is emitted only from `bindExtensions()` (`agent-session.ts:2459`), which only the interactive/print/rpc modes call (`modes/print-mode.ts:76`, `modes/interactive/interactive-mode.ts:1911`, `modes/rpc/rpc-mode.ts:319`); an SDK-built child driven via `prompt()` never fires it, so `mcp-extension` would register but not connect (`extensions/mcp-extension/src/index.ts:45` boots inside the handler). The actual harms of loading extensions into a child: our own `delegate` extension re-loads and registers a depth-blind `delegate` tool at factory time, making the depth-2 cap advisory; the jiti module cache shares module-level state across sessions; the AgentSession constructor runs `_buildRuntime({ includeAllExtensionTools: true })` (`agent-session.ts:407-410`), so every extension tool enters the child's registry and system prompt unless an allowlist filters it; and the loaded extensions are zombies whose `session_start`, `resources_discover`, and UI bindings never arrive, while turn/tool/agent events still hit them, with `_extensionMode` stuck at `"print"` (`agent-session.ts:365`). Every one of those is a reason for the fix below.

`DefaultResourceLoaderOptions` gives the exact control the plan wants (`resource-loader.ts:159-194`): `noExtensions`, `noSkills`, `noPromptTemplates`, `noContextFiles`, `additionalExtensionPaths`, `extensionsOverride`.

Fix, and add these lines to the plan's frozen contract:

- `noExtensions: true` — the default. Child tools come from `customTools` injection, never from extension loading.
- If a curated child ever needs non-tool behavior, opt in through `additionalExtensionPaths` with an explicit list, and never include `mcp-extension` or `delegate` in it.
- `noSkills: true` — skills render into the prompt (`system-prompt.ts:63,161`); they add prompt bytes with no benefit to a scoped job.

Extra invariant worth writing down: because the module loader caches extension modules by path in one process-wide cache (`extensions/loader.ts:490-516`, `jiti.import` at `:510`), module-level mutable state is shared between parent and child sessions, while each session gets a fresh factory invocation. So any state the extension needs must live either in the factory closure (per session) or in the spawn call's closure (per child). Module-level singletons are not safe here, and depth in particular must ride in a closure — see G5.

### M4 — the extension API exposes `ModelRegistry`, not `ModelRuntime`

`ctx.modelRegistry` is a `ModelRegistry` that wraps a **private** `ModelRuntime` with no accessor (`model-registry.ts:32-62`); the extension context exposes `sessionManager`/`modelRegistry`/`model` getters and the string `modelRuntime` does not occur anywhere in `extensions/runner.ts` (whole-file read; the ctx getters are at `:744-751`). `createAgentSession({ modelRuntime })` wants the runtime, and when it is absent constructs a fresh one from `auth.json` / `models.json` (`sdk.ts:180`).

Two consequences the plan does not mention:

1. Resolution itself is fine: `ctx.modelRegistry.find(provider, modelId)` and `hasConfiguredAuth(model)` both exist. Use them for alias validation and error text listing the current alias and model IDs when `to` is unknown.
2. Providers that exist only because a parent extension registered them at runtime (`pi.registerProvider`, native provider registration) will not exist in a child's fresh runtime. Machine-local providers that live in `~/.pi/agent/models.json` / `auth.json` do follow, which covers CPA and GLM-style catalog entries, but "so CPA / GLM / local MLX providers follow" is only true for the file-configured path.

Pick one and record it in the plan:

- **A (recommended v1):** build one `ModelRuntime` lazily at module scope in `spawn.ts`, cache it, pass it to every child. Cheap, deterministic, no upstream change. Document that dynamically registered providers are out of scope for v1, and have unknown-provider aliases fail with that hint.
- **B:** upstream ask — expose the live runtime (e.g. `ctx.modelRuntime`) so children inherit exactly the parent's provider set. Correct, but adds API surface upstream may not want.

Either way, validate before spawn: model resolvable **and** `hasConfiguredAuth`, then fail at execute time with the alias list rather than starting a session that cannot call anything.

### M5 — pass an in-memory `SessionManager`

Without it, `createAgentSession` uses `SessionManager.create(cwd, getDefaultSessionDir(...))` (`sdk.ts:183`), so each spawn creates a persistent session file in the normal session directory, which then shows up in `SessionManager.list()` / `--continue` / resume UI as if the user started it, and leaves artifacts for every delegated job. `SessionManager.inMemory(cwd)` is the intended SDK shape (`examples/sdk/05-tools.ts`, `11-sessions.ts`; `session-manager.ts:1570`). Call `session.dispose()` on every exit path, including abort.

If we ever want child transcripts inspectable, prefer an explicit debug opt-in into a dedicated directory over the default session dir, so the resume list stays clean.

### M6 — carry the parent's project-trust decision into the child

`SettingsManager.create(cwd, agentDir, options)` defaults `projectTrusted` to `true` (`settings-manager.ts:362`). Interactive Pi resolves trust through the user (`main.ts:739-740`, `core/project-trust.ts`). A spawned child that defaults to trusted loads project `.pi/settings.json`, project `.pi/APPEND_SYSTEM.md`, and project `AGENTS.md` regardless of whether the user ever trusted the checkout, which inverts our trust model exactly where a repo-controlled prompt has the most leverage.

The parent's real state is available as `ctx.isProjectTrusted()`:

```ts
const settingsManager = SettingsManager.create(cwd, getAgentDir(), {
  projectTrusted: ctx.isProjectTrusted(),
});
```

`getAgentDir` is exported from the package index (`src/index.ts:8`), and `DefaultResourceLoader` requires both `cwd` and `agentDir`, so pass the same pair to the loader and the settings manager.

---

## 4. Design gaps to close in the plan

**G1 — nothing bounds the child.** A cheap model in a loop is how a cost-saving feature spends more than the expensive model would. Two upstream facts make this concrete: auto-compaction is on by default (`settings-manager.ts:830`), so an over-long child quietly summarizes itself and keeps going; and `session.prompt()` has no turn or budget parameter. Recommend a v1 cap that is part of the tool contract: `maxTurns` (25 is a placeholder this review is not ratifying; the plan must pick the number), counted from `turn_end` events via `session.subscribe`, calling `await child.abort()` at the cap; plus a wall-clock timeout. Both results should map onto the contract as `status: "blocked"` with an `open_questions` entry, not a silent truncation. Disabling child compaction cleanly is awkward because `SettingsManagerCreateOptions` only carries `projectTrusted` (`:189-191`) and the setters persist to disk, so a turn cap is the right lever and compaction is an upstream ask (see §7).

**G2 — define the no-`delegate_result` exit.** The child can also end by answering in prose, being aborted, hitting G1, or `prompt()` rejecting outright: `prompt()` validates model and auth before sending and throws on provider auth failure (`agent-session.ts:1231-1248`), and provider errors propagate as rejects out of `await child.prompt(...)` after the retry budget is spent (`_prepareRetry`, `:2887-2937` — note the exponential-backoff sleeps count against any G1 wall clock). Do not parse the child transcript for the payload: `delegate_result` is a `customTool` we construct in `spawn.ts`, so its `execute` closes over a result holder and the parent reads that holder after `await child.prompt(...)`. Then define the fallback explicitly: no payload ⇒ synthesize `{ status: "needs_review", summary: <child.getLastAssistantText() truncated>, ... }`; `getLastAssistantText()` (`agent-session.ts:3465`) already returns the last non-empty assistant text and skips aborted-with-no-content messages, so no bespoke scan. Decide and document which status means "child aborted" so X does not retry in a loop.

**G3 — `terminate` is batch-conditional.** Termination after `delegate_result` only applies when *every* finalized tool result in that batch terminates. If the child calls `delegate_result` alongside another tool, the child keeps going. Keep `terminate: true` (it is the common single-call case), but treat G1's cap as the real backstop, and optionally ignore further child turns once a payload exists.

**G4 — alias edits do not need `/reload`.** The plan's frozen contract keeps aliases out of the parent tool schema, and unknown `to` is an execute-time error, so nothing in the cached prefix depends on the alias file. Read the file per `delegate` call with a small mtime cache, and `/reload` is not required at all. That is strictly better than "the one expected cache miss", and it also removes the failure mode where a stale alias silently routes a job to the wrong model. `/delegate` should report the resolved `provider/model` for each alias plus auth availability.

**G5 — depth is data in a closure.** Construct the child's `delegate` tool as `makeDelegateTool(depth + 1)` and inject it via `customTools`, so depth travels with the tool instance. This is also the recursion proof: with `noExtensions: true` the child loads no extension, so the only `delegate` in the child is the one we built with the right depth. What must not happen is loading our own extension inside a child and inferring depth from module state — combined with M3 that bypasses the cap.

**G6 — bound everything that crosses the boundary.** Child output is untrusted and can be arbitrarily large. Apply `truncateHead` with `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` to the summary text, cap `evidence` / `artifacts` / `open_questions` item counts, and put the overflow in files with paths in `artifacts` (the plan already prefers paths). Label the payload as delegated-model output in the tool result text, which combined with Pi's native `toolResult` role avoids fake-user-message injection. Also decide the nesting case: Z's payload becomes Y's tool result, so Y's `delegate` must apply the same budget or two levels of "bounded" can still overflow X.

**G7 — pick one home for child progress.** The plan lists transcript line, footer status, and a 2-4 line widget. Widget content that changes per child tool call means a redraw per call; the cheap version is footer-only while running, plus the transcript line at the end, and only a widget if it updates on `turn_end` rather than every tool event. For durable non-model context, our `plan-mode` precedent is `pi.appendEntry(...)` with an entry renderer (`extensions/plan-mode/index.ts:147`), which survives resume without touching LLM context, versus `pi.sendMessage` which does enter context (`docs/extensions.md` `sendMessage` vs `appendEntry`). If we want the child's hop history visible after the fact, entries are the right mechanism; a widget cannot do that.

**G8 — the child-side cache benefit needs a number.** The plan's cache table is correct in structure, and the child's KV cache is real. But the benefit is one cached prefix reused across the child's own turns, and a scoped read-only job that finishes in 2-4 turns on a small model may never amortize a long addendum plus `AGENTS.md`. Nothing here argues against the design; it argues for measuring, since the measurement tooling already exists (`core/cache-stats.ts`, and the `showCacheMissNotices` setting at `settings-manager.ts:108`). Concretely: keep the spawn addendum short and put job detail in the single user brief message (which the plan already does), and treat the addendum as a fixed byte budget.

One more structural caution for whoever scaffolds: do not reach for `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` for delegation. Those **replace the user's active session** and have their own lifecycle footguns (`docs/extensions.md:1139-1302`). Child sessions are separate in-process objects created only through `createAgentSession`.

---

## 5. Reuse what Pi already gives us

| Need | Upstream mechanism | Citation |
|---|---|---|
| "No two writers on the same tree" as a mechanism, not a convention | `executionMode: "sequential"` on the `delegate` tool definition; one sequential tool call in a batch forces the whole batch sequential | `packages/agent/src/agent-loop.ts:417-421` (cross-package), carried through `tools/tool-definition-wrapper.ts:16`, field exists on extension tools at `extensions/types.ts:479` |
| Child writes serialize with the parent's `edit`/`write` | `withFileMutationQueue()` uses one process-wide queue map, so an in-process child participates in the same per-file queue as the parent. This is a concrete argument for in-process over the subprocess example, and worth adding to the plan's rationale | `core/tools/file-mutation-queue.ts:4` (module-level map; the `coding-agent` copy, not the same-named file in `packages/agent`), `docs/extensions.md:1923-1950` |
| Enforce the `delegate_result` shape instead of hoping | `constrainedSampling: { type: "json_schema", strict: "require" }` on the tool definition | `extensions/types.ts:465`, `pi-ai/src/types.ts:504-518` |
| Forward-compatible `delegate` parameters on resumed sessions | `prepareArguments` shim; do not widen the public schema | `docs/extensions.md` "Argument preparation" |
| Error status on the tool result | throw from `execute`; returning a value never sets `isError` | `docs/extensions.md:2015` |
| `keyHint("app.tools.expand", "to expand")` in the collapsed line | `keyHint` / `keyText` helpers | `docs/extensions.md:2316-2330` |
| Prior art for a terminating final tool | `examples/extensions/structured-output.ts` | named in the terminate docs |
| Prior art for compressing context into a new task | `examples/extensions/handoff.ts` | in-repo example |

Two things to skip: `pi.getActiveTools()`/`setActiveTools` (the plan already excludes them, and M1 makes them unnecessary), and any TUI-only "cards" or inspectors (already correctly out of v1).

---

## 6. Spawn sketch that satisfies M1-M6

```ts
// spawn.ts  — child construction, per pi-mono 853a80d
import {
  createAgentSession, DefaultResourceLoader, getAgentDir,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = ctx.cwd;
const agentDir = getAgentDir();                       // exported from the package index

const settingsManager = SettingsManager.create(cwd, agentDir, {
  projectTrusted: ctx.isProjectTrusted(),             // M6
});

const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,                                 // M3: no user exts, no nested delegate, no MCP spawns
  noSkills: true,                                     // M3: stable, smaller prefix
  noPromptTemplates: true,
  appendSystemPromptOverride: (base) => [...base, addendum], // M2: keep ~/.pi/agent/APPEND_SYSTEM.md
});
await loader.reload();

const workTools = params.tools ?? ["read", "grep", "find", "ls"];
const childToolNames = [
  ...workTools,
  "delegate_result",                                  // M1: allowlist is the whole contract
  ...(depth < 2 ? ["delegate"] : []),
];

const { session } = await createAgentSession({
  cwd,
  model,                                              // ctx.modelRegistry.find(provider, id) + hasConfiguredAuth
  modelRuntime: await sharedRuntime(),                // M4 option A
  settingsManager,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),       // M5
  tools: childToolNames,
  customTools: [
    makeDelegateResultTool((payload) => { result = payload; }),  // G2: closure holder, no transcript parsing
    ...(depth < 2 ? [makeDelegateTool(depth + 1)] : []),         // G5: depth travels in a closure
  ],
});

const onAbort = () => { void session.abort(); };      // Esc on X cascades X -> Y -> Z
ctx.signal?.addEventListener("abort", onAbort);
try {
  await session.prompt(brief);                        // one user brief, then append-only
} finally {
  ctx.signal?.removeEventListener("abort", onAbort);
  session.dispose();                                  // every exit path
}
```

`session.abort()` already awaits idle (`agent-session.ts:1620-1624`), so the abort path needs no extra sleep. Remember `ctx.signal` is the parent's *current run* signal (`agent-session.ts:2620`), so an abort listener must be removed in `finally`.

Scope of the sketch: it establishes the M1-M6 machinery only. It deliberately omits G1 (turn/wall-clock cap) and G2 (fallback payload synthesis, which status an abort maps to) because both are still open plan decisions, and omits attaching child `usage` to the returned tool result. Building the child from this sketch alone passes compilation and fails the §8 matrix; wire G1/G2/usage from the plan text before the first end-to-end test.

---

## 7. Upstream asks worth filing (small, not blocking)

Neither is required for v1; both would remove a workaround.

1. **Expose the live model runtime to extensions** (e.g. `ctx.modelRuntime`), so in-process child sessions inherit providers registered at runtime rather than only file-configured ones. Today `ModelRegistry` hides its `ModelRuntime` (`model-registry.ts:33`).
2. **A non-persisting settings override layer** on `SettingsManager`, so a spawned child can disable auto-compaction or change tool defaults without a setter that writes `~/.pi/agent/settings.json`. Today `SettingsManagerCreateOptions` carries only `projectTrusted` (`settings-manager.ts:189-191`) and `SettingsStorage` is not exported from the package index, so a duck-typed in-memory storage is the only clean route.

File these against upstream `pi`, not as `pi-mono` patches: per `AGENTS.md` the submodule stays clean and updates are fast-forwards only.

---

## 8. Suggested v1 test matrix

Each case exists because the source makes it possible.

| Case | Expected |
|---|---|
| child built with `tools: ["read"]` | `delegate_result` still present and callable (M1 regression) |
| child system prompt capture | contains `APPEND_SYSTEM.md` text, then the spawn addendum last (M2) |
| spawn with `mcp-extension` installed | no additional MCP server process starts (M3) |
| alias to an unresolvable or unauthenticated model | execute-time error listing aliases and IDs, no session created |
| child never calls `delegate_result` | synthesized `needs_review` payload, truncated last text |
| child hits `maxTurns` | payload status `blocked`, `open_questions` explains cap, child aborted, `usage` still reported |
| Esc during child run | prompt rejects/returns, child and grandchild disposed, no orphan spinner in footer or widget |
| Z returns to Y | parent X sees only Y's payload; Z's transcript never appears in X's context |
| resume an older session whose `delegate` args changed shape | `prepareArguments` normalizes, or a clear error, not a crash |
| `/session` totals after 3 delegations | child usage folded into parent totals via returned `usage` |
| non-TUI mode (`print`/`json`) | no widget or status calls attempted, tool result complete on its own |

---

## 9. Scope opinion on the package layout

The five-file split (`index` / `types` / `aliases` / `spawn` / `ui`) is the right size and matches `plan-mode` and `pi-arcweld-todos`. Two adjustments: `spawn.ts` will hold the child tool factories, so say so, or they drift into `index.ts`; and `aliases.ts` should own the per-call file read plus resolution (G4) so `spawn.ts` receives only a validated `Model`. Keep the package source-only with wildcard Pi peers, per `AGENTS.md` and the `HOST_PACKAGES` gate in `scripts/check-workspace.sh`.

Wiring is four edits, exactly as the plan says: add the two manifests to the JSON-parse and `HOST_PACKAGES` lists in `scripts/check-workspace.sh`, add a parallel check block that runs `scripts/check-extension-package.sh delegate all`, add the symlink to `scripts/check-user-wiring.sh`, and add the `extensions/README.md` inventory row. The alias file stays machine-local, same pattern as `grok-search.ts` being optional.

Bottom line: approve the architecture, fix M1-M6 in the plan text before writing code, and decide G1 and G2 explicitly since both are contract decisions that belong in the plan rather than in an `if` statement.

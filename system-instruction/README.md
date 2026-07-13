# System instruction workspace

- `baseline/SYSTEM.md` is a verbatim runtime capture from Pi `0.80.6` on `2026-07-12`, with cwd `/home/dev/agents/pi`.
- The capture came from `ctx.getSystemPrompt()` using the normal auto-discovered configuration.
- It includes Pi's default prompt, active tool snippets and guidelines, project `AGENTS.md`, discovered skills, current date, and working directory.
- It excludes provider-level tool definitions, provider-injected formatting, conversation messages, and later `before_provider_request` rewrites.
- This workspace file is not an active `.pi/SYSTEM.md` override. Re-capture after changing extensions, active tools, project context, or skills.
- `APPEND_SYSTEM.md` here is the canonical behavior-correction append file, active globally via the symlink `~/.pi/agent/APPEND_SYSTEM.md` -> this file. It refines response quality without replacing Pi's generated system prompt.
- Decision (2026-07-12): we deliberately do not use a `SYSTEM.md` override. The generated head varies with the live tool inventory (extension tools contribute their own snippets) and improves with upstream releases. A replacement would freeze both. The append layer adds behavior corrections on top of whatever Pi generates, with one known coupling: it quotes "Be concise in your responses" verbatim for precedence, so verify that string still exists on re-capture.
- Do not add a project-level `.pi/APPEND_SYSTEM.md` in any project unless it should fully replace the global file there: Pi's discovery is shadowing (project wins), not layering.

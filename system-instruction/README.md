# System instruction

This directory owns the user-level system-instruction append file used by the local Pi agent.

## Active file

`APPEND_SYSTEM.md` contains concise response and working guidelines. The user-level path is a symlink:

```text
~/.pi/agent/APPEND_SYSTEM.md -> <repository>/system-instruction/APPEND_SYSTEM.md
```

Pi appends this file to its generated system prompt. It does not replace the generated prompt, so upstream instructions, active tool guidance, project context, and discovered skills remain current.

Do not add a project-level `.pi/APPEND_SYSTEM.md` unless the project intentionally needs a replacement. Pi uses the project file instead of the global file; the two are not layered.

## Baseline captures

`baseline/SYSTEM.md`, when present, is a machine-local capture of `ctx.getSystemPrompt()` used to inspect the assembled prompt. Baseline captures are ignored by Git because they contain machine paths and runtime-specific context.

A capture includes Pi's generated prompt, active tool snippets and guidelines, project `AGENTS.md`, discovered skills, date, and working directory. It does not include provider-level tool definitions, provider-specific serialization, conversation messages, or later `before_provider_request` rewrites. Record the Pi version, capture date, and working directory alongside any capture used for comparison.

Recapture after changing the Pi version, active extensions or tools, project instructions, or skills. During review, confirm that the upstream phrase quoted by `APPEND_SYSTEM.md`—`Be concise in your responses`—still exists; that exact phrase establishes the append file's precedence rule.

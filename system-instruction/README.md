# System instruction

This directory owns the user-level system-instruction append file used by the local Pi agent.

## Active file

`APPEND_SYSTEM.md` carries Emrik's persona and standards for writing, code, and design. It uses the portable instructions from `~/.claude/CLAUDE.md` as a standalone Pi copy. The user-level path is a symlink:

```text
~/.pi/agent/APPEND_SYSTEM.md -> <repository>/system-instruction/APPEND_SYSTEM.md
```

Pi appends this file to its generated system prompt. It does not replace the generated prompt, so upstream instructions, active tool guidance, project context, and discovered skills remain current.

Do not add a project-level `.pi/APPEND_SYSTEM.md` unless the project intentionally needs a replacement. Pi uses the project file instead of the global file; the two are not layered.

## Baseline captures

`baseline/SYSTEM.md`, when present, is a machine-local capture of `ctx.getSystemPrompt()` used to inspect the assembled prompt. Baseline captures are ignored by Git because they contain machine paths and runtime-specific context.

A capture includes Pi's generated prompt, active tool snippets and guidelines, project `AGENTS.md`, discovered skills, date, and working directory. It does not include provider-level tool definitions, provider-specific serialization, conversation messages, or later `before_provider_request` rewrites. Record the Pi version, capture date, and working directory alongside any capture used for comparison.

Recapture after changing the Pi version, active extensions or tools, project instructions, or skills. Confirm that Pi's generated instructions and the active append file both appear in the assembled prompt; the addendum does not depend on an exact upstream phrase.

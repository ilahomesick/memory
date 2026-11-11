# OpenCode port of "The Memory Loop" (full parity)

This fork adds an **OpenCode V2** implementation of the MCS `memory` pack while keeping the
original Claude Code pack at the repo root for reference/upstream sync.

## What the pack does (Claude Code)

- Memory store: **`.claude/memories/*.md`** (learnings + decisions), human-readable, git-versionable.
- Retrieval: **qmd** (`--index memory-loop mcp`) over that directory (BM25 + vector + RRF; rerank/gen
  neutered to the embedding model so it degrades to RRF).
- Capture: **`continuous-learning` skill** writes memories; **`memory-audit` skill** prunes.
- Indexing: **sync-memories** hook (SessionStart + UserPromptSubmit) runs `qmd update/embed/status/cleanup`
  under a directory lock into `.claude/.kb-index/`.
- Gate: **kb-gate** dispatcher (UserPromptSubmit / PreToolUse / PostToolUse / SessionStart-compact /
  SubagentStart) that (a) requires a KB search before delegating discovery, (b) gates memory writes
  behind an active memory skill, (c) notes edits to files named by memories, (d) tracks retrievals in
  `memories/.usage.tsv`.
- Instructions: a `CLAUDE.md` section ("MANDATORY — search the KB before any task").
- Modes: `enforce | warn | observe | off`, baked at install time.

## OpenCode mapping

| Pack piece | OpenCode implementation |
|---|---|
| `.claude/memories/` | **`.opencode/memories/`** (configurable; same markdown layout) |
| `.claude/.kb-index/` | **`.opencode/.kb-index/`** |
| `.claude/.kb-gate/` | **`.opencode/.kb-gate/`** |
| memory-loop MCP | local MCP in `opencode.json`: shell launcher → `qmd --index memory-loop mcp` |
| `sync-memories` (SessionStart/PromptSubmit) | plugin: reindex on `session.created` + `session.hook("prompt")` |
| `kb-gate` UserPromptSubmit (turn stamp, skill scan, usage compaction) | `session.hook("prompt")` |
| `kb-gate` PostToolUse (record searches / skill invocations) | `tool.hook("execute.after")` |
| `kb-gate` PreToolUse (spawn/write/edit/bash) | `tool.hook("execute.before")` **+ `permission.hook("evaluate")`** to deny |
| `kb-gate` SessionStart(compact) | `session.hook("compaction")` |
| `kb-gate` SubagentStart brief | `tool.hook("execute.before")` on `task` → prepend brief to `input.prompt` |
| usage tracking (get/multi_get/Read) | `tool.hook("execute.after")` on MCP get + `read` |
| skills | OpenCode skills under `opencode/skills/` (SKILL.md, paths adapted) |
| `CLAUDE.md` section | `opencode/instructions/agents.md` (paste into AGENTS.md) |
| `autoMemoryEnabled: false` | N/A (no equivalent) |
| `mcs sync` installer | `opencode/install.mjs` (writes MCP config + copies skills + prints AGENTS.md block) |

## Key OpenCode API facts used

- Deny is via **`ctx.permission.hook("evaluate", (event) => { event.effect = "deny"; event.message = ... })`**
  (effect is mutable; there is no return-value deny on tool hooks).
- **Resolve MCP tool names dynamically** (`ctx.tool.list()` → ids containing `memory-loop`), because
  OpenCode's MCP tool naming differs from Claude Code's `mcp__server__tool`.
- Skills are invoked through OpenCode's `skill` tool; a typed prompt does not produce a `skill` tool call,
  so the prompt hook must scan the text too (same as the pack).
- Tool hook events: `execute.before {tool, sessionID, input}`, `execute.after {…, status, result}`.
- Session hooks: `prompt`, `context`, `compaction`; `ctx.event.subscribe()` for lifecycle.

## Phases

1. **Port skills + instructions** (mechanical): adapt the two SKILL.md files + AGENTS.md block.
2. **Plugin: indexing + recording + usage** (no gating): reindex on session start/prompt; record KB
   searches and skill invocations; usage tracking; sub-agent brief.
3. **Plugin: kb-gate** (hard): turn stamps, spawn/write/edit/bash checks, modes, budgets, compaction mark.
4. **Installer + docs + end-to-end verification.**

## Knowledge sources & writability

The index holds several qmd collections:

- **`memories`** — the writable capture store (`~/.memory-loop/memories`), protected by the memory
  skills (the gate denies writes without `continuous-learning`/`memory-audit`).
- **`second-brain`** — `~/second-brain`, indexed **in place**.
- **`runbooks`** — `~/.memory-loop/knowledge/runbooks/` (symlinks to standalone runbooks/handbooks).

Extra collections are declared in `~/.memory-loop/collections.json`:

```json
{ "collections": { "second-brain": { "path": "~/second-brain", "pattern": "**/*.md" } } }
```

They are **ordinary writable files**: editing them is allowed (the gate only protects `memories/`),
and the plugin reindexes the whole index on session start and on each prompt. A debounced file
watcher is planned so edits to indexed sources are picked up without waiting for the next prompt.


State files keep the pack's formats (monotonic turn counter, append-only query/denial files,
`.usage.tsv`) so behavior is comparable.

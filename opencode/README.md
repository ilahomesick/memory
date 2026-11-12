# The Memory Loop — OpenCode install

Full-parity OpenCode V2 port. See `PORT-PLAN.md` for the mapping and `instructions/agents.md`
for the AGENTS.md block.

## Prerequisites
- OpenCode V2, **qmd** (`npm i -g @tobilu/qmd`), Node ≥22.6 (or Bun).
- First index downloads the **~610 MB Qwen3-Embedding-0.6B** model (shared across projects).

## 1. Retrieval (plugin tools, not an MCP)

OpenCode spawns MCP servers service-scoped with the launch dir as cwd and no project
env, so a global index is unreachable from an MCP (`SQLITE_CANTOPEN`). Retrieval is
therefore exposed as plugin tools backed by qmd:

| tool | backing command |
|---|---|
| `memory_query` | `qmd --index memory-loop query` (hybrid BM25 + vector) |
| `memory_get` | `qmd get <path or #docid>` |
| `memory_multi_get` | `qmd multi-get <glob / list>` |

No MCP entry is needed. The tools run in the service and point qmd at the global
index via `QMD_CONFIG_DIR` / `INDEX_PATH`.

## 1b. Automation — what happens without being asked

The pack's original design is agent-invoked: tools exist, a rule says to use them,
and nothing *makes* it happen. Two plugin paths remove that reliance:

- **KB-first retrieval (default).** No context is injected into the prompt. Instead the
  first *productive* tool call of a turn (anything but `memory_*`, `skill`, `todowrite`,
  `question`) is denied once until `memory_query` has run, with a message telling the model
  to search typed `lex`/`vec` queries and continue if nothing applies. So the model
  searches before acting — its own query, its own reading of relevance — instead of being
  fed keyword guesses. One denial per turn, so a deliberate retry still works.
  Alternative: `touch ~/.memory-loop/.recall-inject` (or `MEMORY_LOOP_RECALL=inject`) turns
  on the older BM25 pre-injection; `MEMORY_LOOP_RECALL=off` disables both.
- **Automatic capture (idle).** On `session.execution.succeeded` the plugin debounces
  4 minutes, then exports the session, builds a transcript digest, and runs one
  headless pass (`opencode run --archived --auto`) that loads `continuous-learning`
  and writes ≤3 memories. One capture per session (atomic claim file), skipped when
  the digest is under 200 chars, and the capture pass itself is excluded by a
  sentinel so it cannot recurse. Set `MEMORY_LOOP_AUTOCAPTURE=off` to disable.

Deep retrieval is still a judgment call the agent makes: `memory_query` with typed
`lex`/`vec` searches, or `memory_get` for full text.

## 2. Plugin (hooks + gate)

OpenCode only auto-loads local plugins from the plugins dir, so create a bridge:

```
~/.config/opencode/plugins/memory-loop/index.ts
  export { default } from "<abs-path>/opencode/plugin/src/index.ts";
```

Mode (pack parity) via env, default `enforce`:
`MEMORY_LOOP_MODE=enforce|warn|observe|off`.

**Maintenance hatch:** `touch ~/.memory-loop/.gate-off` disables the gate for bulk
work (imports, archiving) without editing code; remove the file to re-arm. The flag
is read at plugin load, so reload after toggling.

**Gate semantics.** Deny is triggered only by statements that actually reference
`~/.memory-loop/memories`: a write/edit tool call without the skill this turn, or a
shell statement that is not a pure read (`cat`/`grep`/`ls`/`find`/`sed`-without-`-i`…)
or that hands content to an interpreter (`| sh`). Unrelated statements in the same
command (`export`, `sleep`, `opencode …`) no longer poison the check. Delegation
(`task`/spawn) requires a KB search this turn — an automatic recall satisfies it.

> Note: the deny path uses `permission.hook("evaluate")` and matches on
> `action`/`resources`; verify deny/allow behavior once per OpenCode version.

## 3. Skills

Copy `opencode/skills/*` into `~/.config/opencode/skills/` (or a project `.opencode/skills/`).

## 4. Instructions

Paste `opencode/instructions/agents.md` into your global or project `AGENTS.md`.

## 5. Verify

```bash
qmd --index memory-loop status            # after a session starts / a prompt
qmd --index memory-loop query "vec: deploy" -n 3
```

State: `~/.memory-loop/.kb-gate/` · index: `~/.memory-loop/.kb-index/` · usage: `~/.memory-loop/memories/.usage.tsv`.

## 6. Knowledge sources (writable)

Beyond the capture store (`~/.memory-loop/memories`), the index includes document collections such
as the second brain and standalone runbooks, declared in `~/.memory-loop/collections.json`:

```json
{
  "collections": {
    "second-brain": { "path": "~/second-brain", "pattern": "**/*.md" },
    "runbooks": {
      "path": "~/.memory-loop/knowledge/runbooks",
      "pattern": "**/*.md",
      "mirror": [{ "from": "~/ps5-tools/RUNBOOK.md", "to": "ps5-tools-RUNBOOK.md" }]
    }
  }
}
```

- **`second-brain`** is indexed **in place**.
- **`runbooks`** uses `mirror`: each reindex copies the current source files into the collection
  dir. qmd's glob does not follow symlinks, so a symlink farm indexes as zero files.
- All of these are **ordinary writable files** (only `~/.memory-loop/memories` is gate-protected).
- A debounced watcher (30 s) refreshes the index when any indexed file changes, so edits are
  searchable without waiting for the next prompt. Reindex also runs on session start and each
  prompt, and is skipped when a content fingerprint is unchanged.

Archived material lives in `~/.memory-loop/archive/{noise,duplicate,stale}/` with
`manifest.tsv`; it is deliberately outside the index and can be restored by moving a file back.

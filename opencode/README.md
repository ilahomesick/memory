# The Memory Loop — OpenCode install

Full-parity OpenCode V2 port. See `PORT-PLAN.md` for the mapping and `instructions/agents.md`
for the AGENTS.md block.

## Prerequisites
- OpenCode V2, **qmd** (`npm i -g @tobilu/qmd`), Node ≥22.6 (or Bun).
- First index downloads the **~610 MB Qwen3-Embedding-0.6B** model (shared across projects).

## 1. MCP server (retrieval)

`memory-loop` is a local MCP that runs `qmd --index memory-loop mcp` over `.opencode/memories/`.
Add to `~/.config/opencode/opencode.json`:

```jsonc
"mcp": {
  "memory-loop": {
    "type": "local",
    "command": [
      "/bin/sh", "-c",
      "r=$(git rev-parse --show-toplevel 2>/dev/null) || r=\"$PWD\"; d=\"$r/.opencode/.kb-index\"; PATH=\"$PATH:/opt/homebrew/bin:/usr/local/bin\"; mkdir -p \"$d\"; export QMD_CONFIG_DIR=\"$d\" INDEX_PATH=\"$d/memory-loop.sqlite\"; exec qmd --index memory-loop mcp"
    ]
  }
}
```

## 2. Plugin (hooks + gate)

OpenCode only auto-loads local plugins from the plugins dir, so create a bridge:

```
~/.config/opencode/plugins/memory-loop/index.ts
  export { default } from "<abs-path>/opencode/plugin/src/index.ts";
```

Mode (pack parity) via env, default `enforce`:
`MEMORY_LOOP_MODE=enforce|warn|observe|off`.

## 3. Skills

Copy `opencode/skills/*` into `~/.config/opencode/skills/` (or a project `.opencode/skills/`).

## 4. Instructions

Paste `opencode/instructions/agents.md` into your global or project `AGENTS.md`.

## 5. Verify

```bash
qmd --index memory-loop status            # after a session starts / a prompt
qmd --index memory-loop query "vec: deploy" -n 3
```

State: `.opencode/.kb-gate/` · index: `.opencode/.kb-index/` · usage: `.opencode/memories/.usage.tsv`.

> Note: the gate's deny path uses `permission.hook("evaluate")` and matches on
> `action`/`resources`; verify the deny/allow behavior once per OpenCode version.

## The memory-loop KB — system map

- **Contents.** `~/.memory-loop/memories/` (captured learnings) **plus** indexed sources:
  `~/second-brain` and `~/.memory-loop/knowledge/runbooks`. One index, one search. Only
  `memories/` is write-gated; the others are ordinary files — edit them freely.
- **Tools.** `memory_query` (hybrid BM25 + vector; typed `lex`/`vec`), `memory_get` (one document
  by `#docid` or path), `memory_multi_get` (glob or comma list).
- **Enforced.** The first productive tool call of a turn is denied until `memory_query` has run —
  search before you act. Writes to `memories/` need `continuous-learning` or `memory-audit` this
  turn; bash writes there are denied.
- **Automatic.** ~4 idle minutes after a session, a capture pass writes up to 3 memories through
  `continuous-learning`. Nothing is injected into your prompt: the KB reaches you only through the
  tools you call.
- **Freshness.** A watcher reindexes on file change (~30 s).
- **If the KB has nothing:** say so and continue. Never stretch a weak hit to look useful.

## Before any task: search first

Call `memory_query` before writing code, planning, or exploring. Pass both line types — neither
alone is sufficient:

- `lex` — keywords you expect **verbatim**: identifiers, error names, `"quoted phrases"`,
  `-negation`. The only thing that finds a rare exact token, and it selects which snippet you get.
- `vec` — the question in prose, as you would ask a colleague. Finds a memory worded differently.
- `intent` — what you want **and what to avoid**.

Use `rerank: false`, limit ~6. Scores are `1/rank`, not confidence — a poor match still scores 1.00
at the top. If nothing fits, re-query with different terms; a higher limit only appends a tail.

**A snippet is a lead, not evidence.** Open what you intend to use with `memory_get` /
`memory_multi_get`. Where a memory and the code disagree, the code wins — say so, and correct the
memory through `continuous-learning`.

Search again when the work changes phase: a new failure to debug, tests, refactoring, error
handling, CI/deploy, a new integration.

## Delegation

A KB result is an *input* to a sub-agent prompt, so never spawn before reading it. Every sub-agent
prompt opens with `KB context: <1-5 bullets>` or `KB context: none relevant.`
If the KB already names the files, read them yourself — the cheapest agent is none. Fanning out to
3+? Write the findings to a scratchpad once and pass `KB context: see <path>`.

## Referencing memories

Never cite memory filenames in commits, PRs, issues, chat, code comments or release notes — they
drift and outside readers cannot open them. Give the one-sentence conclusion instead:
`Batches > 500 rows trigger an ORM memory spike — chunk in 250s.`
`Related:` / `References:` links *between* memories are fine — internal graph, not a public surface.

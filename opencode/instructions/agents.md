## MANDATORY — Before Starting Any Task

Before writing code, planning, or exploring — **always search the knowledge base first**.

Use the **`memory-loop` MCP server's `query` tool**. It searches this project's own
`.opencode/memories/` — past learnings, debugging discoveries, and architectural decisions from
previous sessions, not external documentation. Pass both line types; they answer different
questions and neither is sufficient alone:

- `lex` — keywords you expect **verbatim** in the target memory: identifiers, error names,
  `"quoted phrases"`, `-negation`. It is the only thing that finds a rare exact token and it selects
  the snippet you get back.
- `vec` — prose: the question as you would ask a colleague. It finds a memory that describes your
  symptom in different words.
- `intent` — what you are looking for **and what to avoid**.

Pass both as separate searches, `rerank: false`, limit ~6.

Results carry a score of `1/rank`, not a confidence — a poor match still scores 1.00 at the top.
If nothing fits, re-query with different terms; raising the limit only appends a tail.

**Retrieve before relying on a result.** A snippet is a lead, not evidence. Fetch what you intend to
use with the MCP `get`/`multi_get` tool and read it. Never quote, summarise, or act on a memory you
have only seen as a snippet. A memory describes the code when it was captured, possibly on another
branch: where the code you read disagrees, the code wins — say so, and correct the memory through
`continuous-learning`.

### When to re-check mid-session

Search again **before starting** whenever the work shifts to a new phase, including:
- **Debugging an unexpected failure** — search by topic/domain, not the literal error message.
- **Writing or updating tests** — check testing conventions/patterns/frameworks.
- **Refactoring** — check architectural decisions and code-style preferences.
- **Error-handling / validation** — check established patterns.
- **CI/CD or deployment** — check workflow decisions.
- **New integration** — check networking/data-layer conventions.

### Delegation barrier

The KB query and any sub-agent spawn are **not** independent calls — the KB result is an *input* to
the sub-agent's prompt. Never place them in the same message, and never spawn a sub-agent before you
have read the KB results.

Every sub-agent prompt that reads or searches this codebase must open with:

```
KB context: <1-5 bullets — file paths, patterns, gotchas, decisions from the KB>
```

or the literal line `KB context: none relevant.`

Two rules that save the most work:
- **If the KB already names the files, read them directly.** Do not spawn an agent to re-find what a
  memory already told you. The cheapest outcome is no agent at all.
- **Fanning out to 3+ agents?** Write the findings once to a scratchpad file and point each agent at
  it — but keep the opener, as `KB context: see <path>`.

## Referencing memories in shared artifacts

Memory files are a project-internal KB — filenames drift, and not all readers have repo access.
**Never cite memory filenames** in commits, PR descriptions, issue trackers, chat, code comments,
docstrings, or release notes.

**Summarize the conclusion, don't paste it.** Give the reader the one sentence they need — the
trigger, constraint, or choice — sized to the artifact (one line for a commit or code comment; one
paragraph for a PR description). If the "why" won't fit, describe the outcome and skip it.

- Bad: `See learning_orm_batch_insert_memory_spike.md`
- Good: `Batches > 500 rows trigger an ORM memory spike — chunk in 250s.`

Memory-to-memory links inside `.opencode/memories/` (`Related:`, `References:`) are fine — internal
graph, not an external surface.

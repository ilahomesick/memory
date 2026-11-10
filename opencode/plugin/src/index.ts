/**
 * The Memory Loop — OpenCode V2 port (full-parity plugin).
 *
 * Implements the MCS `memory` pack's hooks against OpenCode's plugin API:
 *  - reindex `.opencode/memories/` into qmd (session start + each prompt)
 *  - record KB searches and memory-skill invocations
 *  - track memory retrievals in `.opencode/memories/.usage.tsv`
 *  - brief sub-agents and gate delegation / memory writes / bash writes
 *    (via `permission.hook("evaluate")`, which carries a mutable `effect`)
 *
 * State lives under `.opencode/.kb-gate/`; the qmd index under `.opencode/.kb-index/`.
 * Everything fails open: unexpected errors never block the session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';

const MEM_REL = '.opencode/memories';
const KB_REL = '.opencode/.kb-index';
const GATE_REL = '.opencode/.kb-gate';
const USAGE_REL = `${MEM_REL}/.usage.tsv`;
const MODE = (process.env.MEMORY_LOOP_MODE ?? 'enforce').toLowerCase() as
  | 'enforce'
  | 'warn'
  | 'observe'
  | 'off';
const MULTILINE = process.env.MEMORY_LOOP_DEBUG === '1';

type Search = { turn: number; text: string };
type SkillUse = { turn: number; name: string };
type State = {
  turn: number;
  searches: Search[];
  skills: SkillUse[];
  denialsThisTurn: number;
  compactionRow: number;
};

function log(ctx: any, msg: string) {
  try {
    if (MULTILINE) ctx?.app?.log?.info?.(`[memory-loop] ${msg}`);
  } catch {
    /* ignore */
  }
}

function projRoot(ctx: any): string {
  return ctx?.location?.directory ?? ctx?.location?.project?.directory ?? process.cwd();
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  try {
    writeFileSync(path, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function statePath(root: string, sessionID: string): string {
  const dir = join(root, GATE_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `state-${safe(sessionID || 'default')}.json`);
}

function getState(root: string, sessionID: string): State {
  const p = statePath(root, sessionID);
  return readJson<State>(p, { turn: 0, searches: [], skills: [], denialsThisTurn: 0, compactionRow: 0 });
}

function setState(root: string, sessionID: string, s: State) {
  // Keep state bounded.
  if (s.searches.length > 500) s.searches = s.searches.slice(-500);
  if (s.skills.length > 500) s.skills = s.skills.slice(-500);
  writeJson(statePath(root, sessionID), s);
}

function memorySkillActive(s: State, sessionID: string): boolean {
  // continuous-learning authorizes writes for the current turn; memory-audit for the session.
  return s.skills.some(
    (k) => (k.name === 'continuous-learning' && k.turn === s.turn) || k.name === 'memory-audit',
  );
}

function kbSearchedThisTurn(s: State): boolean {
  return s.searches.some((q) => q.turn === s.turn);
}

function normAbs(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  return abs;
}

function isMemoryPath(root: string, p: string): boolean {
  try {
    const rel = relative(root, normAbs(root, p)).replace(/\\/g, '/');
    return rel === MEM_REL || rel.startsWith(`${MEM_REL}/`);
  } catch {
    return false;
  }
}

function detectSkill(text: string): string | null {
  const m = text.match(/(?:^|\s)\/?(continuous-learning|memory-audit)\b/i);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Reindex memories into qmd (update + embed + status + cleanup), non-blocking. */
async function reindex(root: string, spawn: any) {
  try {
    const kb = join(root, KB_REL);
    if (!existsSync(kb)) mkdirSync(kb, { recursive: true });
    const memories = join(root, MEM_REL);
    const cfg = join(kb, 'memory-loop.yml');
    const model = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
    const yml = `collections:\n  memories:\n    path: '${memories.replaceAll("'", "''")}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${model}\n  generate: ${model}\n  rerank: ${model}\nglobal_context: |\n  Project memory KB: this project's own past learnings, decisions and debugging\n  discoveries — not external documentation.\n`;
    const prev = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
    if (prev !== yml) writeFileSync(cfg, yml);
    if (!existsSync(memories)) return;
    const env = { ...process.env, QMD_CONFIG_DIR: kb, INDEX_PATH: join(kb, 'memory-loop.sqlite') };
    for (const cmd of ['update', 'embed']) {
      await new Promise<void>((res) => {
        try {
          const p = spawn('qmd', ['--index', 'memory-loop', cmd], { env, stdio: 'ignore' });
          p.on?.('exit', () => res());
          p.on?.('error', () => res());
        } catch {
          res();
        }
      });
    }
  } catch {
    /* fail open */
  }
}

/** Append a retrieval row to `.usage.tsv` (append-only, one row per memory). */
function recordUsage(root: string, file: string) {
  try {
    const abs = normAbs(root, file);
    if (!isMemoryPath(root, abs) || !abs.endsWith('.md')) return;
    const rel = relative(root, abs).replace(/\\/g, '/').replace(new RegExp(`^${MEM_REL}/`), '');
    const path = join(root, USAGE_REL);
    const today = new Date().toISOString().slice(0, 10);
    const prior = existsSync(path) ? readFileSync(path, 'utf8') : '# since: ' + today + '\n';
    const lines = prior.split('\n');
    // Only append if this memory's latest row is not already today.
    for (const line of lines) {
      const [f, d] = line.split('\t');
      if (f === rel && d === today) return;
    }
    appendFileSync(path, `${rel}\t${today}\n`);
  } catch {
    /* ignore */
  }
}

function isQueryTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('memory') && n.includes('query');
}
function isGetTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('memory') && (n.includes('multi_get') || n.endsWith('get') || n.includes('_get'));
}

export default {
  id: 'memory-loop',
  async setup(ctx: any) {
    const root = projRoot(ctx);
    const spawn = (await import('node:child_process')).spawn;

    // Fail-open helpers bound to this project.
    const state = (sid: string) => getState(root, sid);

    // --- session start: index ---
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe()) {
          if (ev?.type === 'session.created') {
            void reindex(root, spawn);
          }
          if (ev?.type === 'session.execution.succeeded') {
            // Opportunistic reindex on turn completion (cheap, incremental).
            void reindex(root, spawn);
          }
        }
      } catch {
        /* ignore */
      }
    })();

    // --- prompt: turn stamp, typed-skill scan, reindex, usage compaction ---
    await ctx.session.hook('prompt', async (event: any) => {
      try {
        const sid = String(event.sessionID ?? 'default');
        const s = state(sid);
        s.turn += 1;
        s.denialsThisTurn = 0;
        const skill = detectSkill(String(event?.prompt?.text ?? ''));
        if (skill) s.skills.push({ turn: s.turn, name: skill });
        setState(root, sid, s);
        void reindex(root, spawn);
      } catch {
        /* fail open */
      }
    });

    // --- record KB searches / skill invocations / retrievals ---
    await ctx.tool.hook('execute.after', async (event: any) => {
      try {
        const sid = String(event?.sessionID ?? 'default');
        const s = state(sid);
        const tool = String(event?.tool ?? '');
        const input: any = event?.input ?? {};

        if (isQueryTool(tool)) {
          const text =
            typeof input?.query === 'string'
              ? input.query
              : JSON.stringify(input?.searches ?? input ?? '').slice(0, 2000);
          s.searches.push({ turn: s.turn, text });
          setState(root, sid, s);
        }

        if (tool.toLowerCase().includes('skill')) {
          const name = String(input?.name ?? input?.skill ?? input?.id ?? '').toLowerCase();
          if (name.includes('continuous-learning') || name.includes('memory-audit')) {
            s.skills.push({ turn: s.turn, name });
            setState(root, sid, s);
          }
        }

        if (isGetTool(tool)) {
          const files: string[] = [];
          if (typeof input?.file === 'string') files.push(input.file);
          if (typeof input?.pattern === 'string') files.push(...input.pattern.split(','));
          for (const f of files) recordUsage(root, f.trim());
        }
        if (tool.toLowerCase() === 'read' && typeof input?.filePath === 'string') {
          recordUsage(root, input.filePath);
        }
      } catch {
        /* fail open */
      }
    });

    // --- before: sub-agent brief + edit notes (never blocks here) ---
    await ctx.tool.hook('execute.before', async (event: any) => {
      try {
        const sid = String(event?.sessionID ?? 'default');
        const s = state(sid);
        const tool = String(event?.tool ?? '').toLowerCase();
        const input: any = event?.input ?? {};

        // Sub-agent spawn: prepend the KB brief (parity with SubagentStart).
        if ((tool === 'task' || tool === 'background_task') && typeof input?.prompt === 'string') {
          const brief =
            'KB context: before reading or searching this codebase, query the memory-loop MCP ' +
            '(typed lex+vec, rerank:false) and open with "KB context: <findings>" or ' +
            '"KB context: none relevant."\n\n';
          if (!input.prompt.startsWith('KB context:')) input.prompt = brief + input.prompt;
        }
      } catch {
        /* fail open */
      }
    });

    // --- gate: deny via permission evaluation ---
    await ctx.permission.hook('evaluate', async (event: any) => {
      try {
        if (MODE === 'off') return;
        const sid = String(event?.sessionID ?? 'default');
        const s = state(sid);
        const action = String(event?.action ?? '').toLowerCase();
        const resources: string[] = (event?.resources ?? []).map((r: unknown) => String(r));

        // Memory writes require an active memory skill.
        if ((action.includes('write') || action.includes('edit')) && resources.some((r) => isMemoryPath(root, r))) {
          if (!memorySkillActive(s, sid)) {
            deny(event, s, 'Memory files are written only through the continuous-learning or memory-audit skill.');
            return;
          }
        }

        // Bash touching memories: deny unless it is a plain read.
        if ((action.includes('bash') || action.includes('shell')) && resources.some((r) => r.includes(MEM_REL) || r.includes('memories/'))) {
          const cmd = resources.join(' ');
          const isRead = /^\s*(cat|head|tail|less|grep|egrep|rg|ls|tree|wc|stat|file|diff|sed -n|find|jq)\b/.test(cmd) && !/[>|]/.test(cmd);
          if (!isRead || /(^|\s)(rm|unlink|mv|git\s+rm)(\s|$)/.test(cmd)) {
            deny(event, s, 'Memory files are changed only via edit/write under a memory skill; bash writes are denied.');
            return;
          }
        }

        // Delegation requires a KB search this turn.
        if (action.includes('task') || action.includes('agent') || action.includes('spawn')) {
          if (!kbSearchedThisTurn(s)) {
            deny(event, s, 'Search the memory-loop KB before delegating discovery (KB context is required).');
            return;
          }
        }
      } catch {
        /* fail open */
      }
    });

    function deny(event: any, s: State, message: string) {
      if (MODE === 'observe') {
        log(ctx, `observe: would deny — ${message}`);
        return;
      }
      if (MODE === 'warn') {
        log(ctx, `warn: ${message}`);
        return;
      }
      // enforce
      if (s.denialsThisTurn >= 8) {
        log(ctx, `denial budget exhausted: ${message}`);
        return;
      }
      s.denialsThisTurn += 1;
      event.effect = 'deny';
      event.message = message;
    }

    log(ctx, `memory-loop ready (mode=${MODE}, root=${root})`);
    return () => {
      /* registrations auto-dispose on unload */
    };
  },
};

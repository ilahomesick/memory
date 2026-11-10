/**
 * The Memory Loop — OpenCode V2 port (full parity, global store).
 *
 * Global design (works from any session location, including `/`):
 *   memories: ~/.memory-loop/memories/*.md
 *   index:    ~/.memory-loop/.kb-index/  (qmd named index `memory-loop`)
 *   state:    ~/.memory-loop/.kb-gate/
 *   usage:    ~/.memory-loop/memories/.usage.tsv
 *
 * Retrieval is exposed as plugin tools (`memory_query` / `memory_get` /
 * `memory_multi_get`) rather than an MCP, because OpenCode spawns MCP servers
 * service-scoped with the launch directory as cwd and no project env — an MCP
 * cannot reach a global index reliably. Plugin tools run in the service and
 * shell out to qmd against the global index.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE = join(homedir(), '.memory-loop');
const MEM_DIR = join(BASE, 'memories');
const KB_DIR = join(BASE, '.kb-index');
const GATE_DIR = join(BASE, '.kb-gate');
const USAGE = join(MEM_DIR, '.usage.tsv');
const INDEX = 'memory-loop';
const DB = join(KB_DIR, `${INDEX}.sqlite`);
const MODEL = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
const MODE = (process.env.MEMORY_LOOP_MODE ?? 'enforce').toLowerCase() as
  | 'enforce'
  | 'warn'
  | 'observe'
  | 'off';

type Search = { turn: number; text: string };
type SkillUse = { turn: number; name: string };
type State = { turn: number; searches: Search[]; skills: SkillUse[]; denialsThisTurn: number };

function ensureDirs() {
  for (const d of [BASE, MEM_DIR, KB_DIR, GATE_DIR]) {
    try {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

function log(msg: string) {
  try {
    ensureDirs();
    appendFileSync(join(GATE_DIR, 'debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function statePath(sid: string): string {
  ensureDirs();
  return join(GATE_DIR, `state-${safe(sid || 'default')}.json`);
}

function getState(sid: string): State {
  try {
    return JSON.parse(readFileSync(statePath(sid), 'utf8')) as State;
  } catch {
    return { turn: 0, searches: [], skills: [], denialsThisTurn: 0 };
  }
}

function setState(sid: string, s: State) {
  try {
    if (s.searches.length > 500) s.searches = s.searches.slice(-500);
    if (s.skills.length > 500) s.skills = s.skills.slice(-500);
    writeFileSync(statePath(sid), JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function memorySkillActive(s: State): boolean {
  return s.skills.some(
    (k) => (k.name === 'continuous-learning' && k.turn === s.turn) || k.name === 'memory-audit',
  );
}

function kbSearchedThisTurn(s: State): boolean {
  return s.searches.some((q) => q.turn === s.turn);
}

function isMemoryPath(p: string): boolean {
  try {
    const abs = p.startsWith('/') ? p : join(process.cwd(), p);
    return abs === MEM_DIR || abs.startsWith(`${MEM_DIR}/`);
  } catch {
    return false;
  }
}

function detectSkill(text: string): string | null {
  const m = text.match(/(?:^|\s)\/?(continuous-learning|memory-audit)\b/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function qmdEnv() {
  return {
    ...process.env,
    QMD_CONFIG_DIR: KB_DIR,
    INDEX_PATH: DB,
    PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`,
  };
}

function runQmd(args: string[]): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    try {
      const p = spawn('qmd', ['--index', INDEX, ...args], { env: qmdEnv() });
      let out = '';
      let err = '';
      p.stdout?.on('data', (d) => (out += d));
      p.stderr?.on('data', (d) => (err += d));
      p.on('exit', (code) => resolve({ out, err, code: code ?? 0 }));
      p.on('error', (e) => resolve({ out, err: String(e), code: 1 }));
    } catch (e) {
      resolve({ out: '', err: String(e), code: 1 });
    }
  });
}

function writeIndexConfig() {
  try {
    ensureDirs();
    const cfg = join(KB_DIR, `${INDEX}.yml`);
    const yml = `collections:\n  memories:\n    path: '${MEM_DIR.replaceAll("'", "''")}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${MODEL}\n  generate: ${MODEL}\n  rerank: ${MODEL}\nglobal_context: |\n  Project memory KB: this project's own past learnings, decisions and debugging\n  discoveries — not external documentation.\n`;
    if (!existsSync(cfg) || readFileSync(cfg, 'utf8') !== yml) writeFileSync(cfg, yml);
  } catch {
    /* ignore */
  }
}

async function reindex() {
  try {
    writeIndexConfig();
    if (!existsSync(MEM_DIR)) return;
    for (const cmd of ['update', 'embed']) {
      await runQmd([cmd]);
    }
  } catch {
    /* fail open */
  }
}

function recordUsage(file: string) {
  try {
    const abs = file.startsWith('/') ? file : join(process.cwd(), file);
    if (!isMemoryPath(abs) || !abs.endsWith('.md')) return;
    const rel = abs.slice(MEM_DIR.length + 1);
    const today = new Date().toISOString().slice(0, 10);
    const prior = existsSync(USAGE) ? readFileSync(USAGE, 'utf8') : `# since: ${today}\n`;
    for (const line of prior.split('\n')) {
      const [f, d] = line.split('\t');
      if (f === rel && d === today) return;
    }
    ensureDirs();
    appendFileSync(USAGE, `${rel}\t${today}\n`);
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
  return n.includes('memory') && (n.includes('multi_get') || n.endsWith('get'));
}

function queryArgs(input: any): string[] {
  const lines: string[] = [];
  if (input?.intent) lines.push(`intent: ${input.intent}`);
  for (const s of input?.searches ?? []) {
    if (!s?.type || !s?.query) continue;
    lines.push(`${s.type}: ${s.query}`);
  }
  const doc = lines.length ? lines.join('\n') : String(input?.query ?? '');
  const args = ['query', doc, '-n', String(input?.limit ?? 6)];
  if (input?.rerank === false) args.push('--no-rerank');
  return args;
}

export default {
  id: 'memory-loop',
  async setup(ctx: any) {
    ensureDirs();
    writeIndexConfig();
    log(`memory-loop ready (mode=${MODE})`);

    // --- retrieval tools (replace the impossible per-project MCP) ---
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: 'memory_query',
        description:
          "Search the global memory-loop KB (qmd hybrid BM25 + vector). Pass 1-10 typed searches (lex for exact tokens, vec for prose) plus an intent. Returns ranked memory documents.",
        input: {
          type: 'object',
          properties: {
            searches: {
              type: 'array',
              items: {
                type: 'object',
                properties: { type: { type: 'string' }, query: { type: 'string' } },
                required: ['type', 'query'],
              },
            },
            intent: { type: 'string' },
            rerank: { type: 'boolean' },
            limit: { type: 'number' },
          },
          required: ['searches'],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          writeIndexConfig();
          const r = await runQmd(queryArgs(input));
          return { content: (r.out || r.err || '(no results)').slice(0, 60000) };
        },
      });

      editor.add({
        name: 'memory_get',
        description: 'Fetch one memory document from the memory-loop KB by path (#docid or relative path).',
        input: {
          type: 'object',
          properties: { file: { type: 'string' }, fromLine: { type: 'number' }, maxLines: { type: 'number' } },
          required: ['file'],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          writeIndexConfig();
          const args = ['get', String(input?.file ?? '')];
          const r = await runQmd(args);
          return { content: (r.out || r.err || '(not found)').slice(0, 60000) };
        },
      });

      editor.add({
        name: 'memory_multi_get',
        description: 'Batch-fetch memory documents by glob, comma-separated paths, or docids.',
        input: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern'],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          writeIndexConfig();
          const r = await runQmd(['multi-get', String(input?.pattern ?? '')]);
          return { content: (r.out || r.err || '(not found)').slice(0, 60000) };
        },
      });
    });

    // --- session start / turn completion: index ---
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe()) {
          if (ev?.type === 'session.created' || ev?.type === 'session.execution.succeeded') {
            void reindex();
          }
        }
      } catch {
        /* ignore */
      }
    })();

    // --- prompt: turn stamp, skill scan, reindex ---
    await ctx.session.hook('prompt', async (event: any) => {
      try {
        const sid = String(event?.sessionID ?? 'default');
        const s = getState(sid);
        s.turn += 1;
        s.denialsThisTurn = 0;
        const skill = detectSkill(String(event?.prompt?.text ?? ''));
        if (skill) s.skills.push({ turn: s.turn, name: skill });
        setState(sid, s);
        void reindex();
      } catch {
        /* fail open */
      }
    });

    // --- record searches, skill invocations, retrievals ---
    await ctx.tool.hook('execute.after', async (event: any) => {
      try {
        const sid = String(event?.sessionID ?? 'default');
        const s = getState(sid);
        const tool = String(event?.tool ?? '');
        const input: any = event?.input ?? {};

        if (isQueryTool(tool)) {
          const text =
            typeof input?.query === 'string'
              ? input.query
              : JSON.stringify(input?.searches ?? input ?? '').slice(0, 2000);
          s.searches.push({ turn: s.turn, text });
          setState(sid, s);
        }
        if (tool.toLowerCase().includes('skill')) {
          const name = String(input?.name ?? input?.skill ?? input?.id ?? '').toLowerCase();
          if (name.includes('continuous-learning') || name.includes('memory-audit')) {
            s.skills.push({ turn: s.turn, name });
            setState(sid, s);
          }
        }
        if (isGetTool(tool)) {
          const files: string[] = [];
          if (typeof input?.file === 'string') files.push(input.file);
          if (typeof input?.pattern === 'string') files.push(...input.pattern.split(','));
          for (const f of files) recordUsage(f.trim());
        }
        if (tool.toLowerCase() === 'read' && typeof input?.filePath === 'string') {
          recordUsage(input.filePath);
        }
      } catch {
        /* fail open */
      }
    });

    // --- before: sub-agent KB brief ---
    await ctx.tool.hook('execute.before', async (event: any) => {
      try {
        const tool = String(event?.tool ?? '').toLowerCase();
        const input: any = event?.input ?? {};
        if ((tool === 'task' || tool === 'background_task') && typeof input?.prompt === 'string') {
          const brief =
            'KB context: before reading or searching this codebase, call memory_query (typed lex+vec) ' +
            'and open with "KB context: <findings>" or "KB context: none relevant."\n\n';
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
        const s = getState(sid);
        const action = String(event?.action ?? '').toLowerCase();
        const resources: string[] = (event?.resources ?? []).map((r: unknown) => String(r));

        if ((action.includes('write') || action.includes('edit')) && resources.some(isMemoryPath)) {
          if (!memorySkillActive(s)) {
            deny(s, event, 'Memory files are written only through the continuous-learning or memory-audit skill.');
            return;
          }
        }

        if (
          (action.includes('bash') || action.includes('shell')) &&
          resources.some((r) => r.includes(MEM_DIR) || r.includes('memories/'))
        ) {
          const cmd = resources.join(' ');
          const isRead =
            /^\s*(cat|head|tail|less|grep|egrep|rg|ls|tree|wc|stat|file|diff|sed -n|find|jq)\b/.test(cmd) &&
            !/[>|]/.test(cmd);
          if (!isRead || /(^|\s)(rm|unlink|mv|git\s+rm)(\s|$)/.test(cmd)) {
            deny(s, event, 'Memory files are changed only via edit/write under a memory skill; bash writes are denied.');
            return;
          }
        }

        if (action.includes('task') || action.includes('agent') || action.includes('spawn')) {
          if (!kbSearchedThisTurn(s)) {
            deny(s, event, 'Search the memory-loop KB (memory_query) before delegating discovery.');
            return;
          }
        }
      } catch {
        /* fail open */
      }
    });

    function deny(s: State, event: any, message: string) {
      if (MODE === 'observe') {
        log(`observe: would deny — ${message}`);
        return;
      }
      if (MODE === 'warn') {
        log(`warn: ${message}`);
        return;
      }
      if (s.denialsThisTurn >= 8) {
        log(`denial budget exhausted: ${message}`);
        return;
      }
      s.denialsThisTurn += 1;
      event.effect = 'deny';
      event.message = message;
      log(`deny: ${message}`);
    }

    return () => {
      /* registrations dispose on unload */
    };
  },
};

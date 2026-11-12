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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
} from 'node:fs';
import { join, basename } from 'node:path';
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
/**
 * Gate mode. `MEMORY_LOOP_MODE` wins; otherwise the presence of
 * `~/.memory-loop/.gate-off` disables the gate — the maintenance escape hatch
 * for bulk imports/archiving, so routine upkeep never requires a code edit.
 */
const MODE = (
  process.env.MEMORY_LOOP_MODE ?? (existsSync(join(homedir(), '.memory-loop', '.gate-off')) ? 'off' : 'enforce')
).toLowerCase() as 'enforce' | 'warn' | 'observe' | 'off';

/**
 * Recall policy:
 *   kb-first (default) — inject nothing; the first productive tool call of a
 *     turn is denied until `memory_query` has run, so the model searches before
 *     acting instead of being fed guessed context.
 *   inject — the older behaviour: BM25 top-3 appended to every prompt.
 *   off — neither.
 */
const RECALL = (
  process.env.MEMORY_LOOP_RECALL ?? (existsSync(join(homedir(), '.memory-loop', '.recall-inject')) ? 'inject' : 'kb-first')
).toLowerCase();

type Search = { turn: number; text: string };
type SkillUse = { turn: number; name: string };
type State = {
  turn: number;
  searches: Search[];
  skills: SkillUse[];
  denialsThisTurn: number;
  injected?: string[];
  kbGateTurn?: number;
  capturePass?: boolean;
};

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

/** Normalise ~ / $HOME, then test whether the command can touch the memory store. */
function touchesMemoryPath(cmd: string): boolean {
  const norm = cmd
    .replace(/\$\{HOME\}|\$HOME/g, homedir())
    .replace(/~\//g, `${homedir()}/`)
    .replace(/['"]/g, '');
  return norm.includes(MEM_DIR) || norm.includes(`${MEM_DIR}/`) || norm.includes('memories/');
}

const READ_CMDS =
  /^\s*(echo|printf|cd|pwd|true|:)?\s*(cat|head|tail|less|grep|egrep|rg|ls|tree|wc|stat|file|diff|sed|find|jq|sort|uniq|cut|awk|which|type|basename|dirname|realpath|shasum|md5|du|date)\b/;

const EXEC_VERBS = /^\s*(sh|bash|zsh|dash|ksh|python3?|node|bun|deno|perl|ruby|eval|exec|source|xargs)\b/;

function isReadOnlySegment(seg: string): boolean {
  const bare = seg
    .trim()
    .replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '')
    .trim();
  if (!bare) return true;
  if (EXEC_VERBS.test(bare)) return false;
  if (!READ_CMDS.test(bare)) return false;
  if (/\bfind\b.*\s(-delete|-exec|-execdir|-ok|-okdir)\b/.test(bare)) return false;
  if (/\bsed\b.*(\s-i\b|\s--in-place)/.test(bare)) return false;
  if (/\btree\b.*(\s-o\b|\s--output)/.test(bare)) return false;
  if (/\bawk\b.*(system|print\s*>)/.test(bare)) return false;
  const stripped = bare.replace(/\d*>>?\s*&\s*\d+/g, ' ').replace(/\d*>>?\s*\/dev\/null/g, ' ');
  if (/>>?/.test(stripped)) return false;
  return true;
}

/**
 * True only if nothing in the command can write to the memory store.
 * Only the statements that actually reference the store are constrained —
 * an unrelated `sleep` or `export` in the same line is not a memory write —
 * but no statement may hand content to an interpreter (`cat x | sh`).
 */
function isReadOnlyShell(cmd: string): boolean {
  const segments = cmd.split(/;|&&|\|\||\n|\|/);
  const touching = segments.filter((s) => touchesMemoryPath(s));
  if (touching.length === 0) return true;
  for (const s of segments) {
    const bare = s
      .trim()
      .replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '')
      .trim();
    if (EXEC_VERBS.test(bare)) return false;
  }
  for (const s of touching) if (!isReadOnlySegment(s)) return false;
  return true;
}

const NON_PRODUCTIVE = new Set([
  'skill',
  'todowrite',
  'todo_write',
  'question',
  'task_status',
  'task_reply',
  'task_cancel',
]);

/** Tools that do real work on the user's machine; the KB check runs before these. */
function isProductiveTool(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('memory')) return false;
  return !NON_PRODUCTIVE.has(n);
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

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    try {
      const p = spawn('opencode', args, {
        env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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

// ---------------------------------------------------------------- automation

/**
 * Fast prompt-time recall. BM25 (`qmd search`) returns in ~400ms and needs no
 * LLM expansion; `qmd vsearch` costs ~9s, so it is not used here — the agent can
 * still call `memory_query` for semantic search when it matters.
 *
 * Raw prompts make poor BM25 queries (instruction words swamp the FTS terms),
 * so the query is reduced to keywords, with one relaxed retry.
 */
const STOPWORDS = new Set(
  ('the and for with that this what which from your you are was were how why when does did can could should would ' +
    'about into than then them they there here not but all any exact answer only call calls tool tools given matter ' +
    'matters please need want know tell show give use using get got make made just like also more most some such ' +
    'very will have has had been being its it is a an of to in on at by or if so do we i my me our us ' +
    'context sequence values value notes note recall memory retrieve explain describe list step steps detail details').split(
    ' ',
  ),
);

function keywords(text: string, max: number): string {
  const toks = text.replace(/[^A-Za-z0-9_./-]+/g, ' ').split(/\s+/);
  const keep: string[] = [];
  for (const raw of toks) {
    const t = raw.replace(/^[./-]+|[./-]+$/g, '');
    if (t.length < 3 || STOPWORDS.has(t.toLowerCase())) continue;
    keep.push(t);
    if (keep.length >= max) break;
  }
  return keep.join(' ');
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Split qmd result blocks and return their doc paths. */
function splitResults(out: string): string[] {
  return out
    .split(/\n(?=qmd:\/\/)/g)
    .filter((p) => p.startsWith('qmd://'));
}

function docId(block: string): string {
  return (block.match(/^qmd:\/\/[^\s?#]+/) ?? [''])[0];
}

async function autoContext(prompt: string, seen: Set<string>): Promise<string | null> {
  const text = prompt.replace(/\s+/g, ' ').trim();
  if (text.length < 16) return null;
  if (/^[/!]/.test(text)) return null; // slash commands
  if (text.includes('<memory-loop-context')) return null;
  // BM25 behaves close to AND: more terms means more misses. Try the full
  // keyword set, then progressively tighter slices.
  const full = keywords(text, 10);
  const words = full ? full.split(' ') : [];
  const attempts = [full, words.slice(-5).join(' '), words.slice(-3).join(' ')];
  for (const q of new Set(attempts)) {
    if (!q) continue;
    const r = await runQmd(['search', q, '-n', '3']);
    const clean = stripAnsi(r.out).trim();
    if (!clean || /^no results/i.test(clean)) {
      log(`autorecall miss q="${q}" code=${r.code} err=${r.err.slice(0, 120)}`);
      continue;
    }
    // Never repeat a document already injected in this session.
    const fresh = splitResults(clean).filter((b) => !seen.has(docId(b)));
    if (fresh.length === 0) {
      log(`autorecall all-known q="${q}"`);
      continue;
    }
    const payload = fresh.join('\n').trim().slice(0, 1600);
    log(`autorecall hit q="${q}" docs=${fresh.length} bytes=${payload.length}`);
    return payload;
  }
  return null;
}

/** Flatten a session export into a compact transcript for the capture pass. */
function digestFrom(exp: any): string {
  const msgs = Array.isArray(exp?.messages) ? exp.messages : [];
  const lines: string[] = [];
  for (const m of msgs) {
    if (m?.type === 'user' && m.text) {
      lines.push(`USER: ${String(m.text).replace(/\s+/g, ' ').slice(0, 1500)}`);
    } else if (m?.type === 'assistant' && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type === 'text' && p.text) lines.push(`ASSISTANT: ${String(p.text).slice(0, 1200)}`);
        else if (p?.type === 'tool' && p.name) lines.push(`[tool: ${p.name}]`);
      }
    }
  }
  const joined = lines.join('\n');
  return joined.length > 12000 ? joined.slice(-12000) : joined;
}

const CAPTURE_SENTINEL = '[memory-loop:capture-pass]';

const CAPTURE_PROMPT = `${CAPTURE_SENTINEL}
You are the automatic memory-capture pass for a finished session. Do not modify project files.

1. Load the continuous-learning skill.
2. From the transcript, extract only durable, non-obvious knowledge: decisions, constraints, gotchas, machine facts, user preferences, exact identifiers.
3. Skip anything obvious from the code itself, or already stored (search the KB first).
4. Write at most 3 memory files with that skill, then reply with the file names, or "nothing durable".

TRANSCRIPT:
`;

/** Idle capture: one guarded headless pass per session, never recursive. */
async function autoCapture(sid: string) {
  try {
    if ((process.env.MEMORY_LOOP_AUTOCAPTURE ?? '').toLowerCase() === 'off') return;
    const mark = join(GATE_DIR, `captured-${safe(sid)}.json`);
    if (existsSync(mark)) {
      log(`autocapture skip ${sid}: already captured`);
      return;
    }
    const exp = await runCli(['session', 'export', sid]);
    if (exp.code !== 0 || !exp.out.trim()) {
      log(`autocapture skip ${sid}: export code=${exp.code} ${exp.err.slice(0, 120)}`);
      return;
    }
    let digest = '';
    try {
      digest = digestFrom(JSON.parse(exp.out));
    } catch {
      log(`autocapture skip ${sid}: unparseable export`);
      return;
    }
    log(`autocapture digest ${sid}: chars=${digest.length}`);
    if (digest.includes(CAPTURE_SENTINEL)) {
      log(`autocapture skip ${sid}: capture pass`);
      return;
    }
    if (digest.length < 200) return; // nothing worth capturing
    try {
      // atomic claim: five plugin instances subscribe to the same event
      writeFileSync(mark, JSON.stringify({ at: new Date().toISOString(), chars: digest.length }), { flag: 'wx' });
    } catch {
      log(`autocapture skip ${sid}: another instance claimed it`);
      return;
    }
    const r = await runCli(['run', '--archived', '--auto', '--title', 'memory capture', CAPTURE_PROMPT + digest]);
    log(`autocapture ${sid}: exit=${r.code} ${r.code === 0 ? 'ok' : r.err.slice(0, 200)}`);
  } catch (e) {
    log(`autocapture failed: ${String(e)}`);
  }
}

const captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
let promptKeysLogged = false;
let execEventLogged = false;

function scheduleCapture(sid: string) {
  const prev = captureTimers.get(sid);
  if (prev) clearTimeout(prev);
  const delay = Number(process.env.MEMORY_LOOP_CAPTURE_DELAY_MS ?? 4 * 60 * 1000);
  log(`capture scheduled ${sid} in ${delay}ms`);
  captureTimers.set(
    sid,
    setTimeout(() => {
      captureTimers.delete(sid);
      log(`capture timer fired ${sid}`);
      void autoCapture(sid);
    }, delay),
  );
}

type CollectionCfg = { path?: string; pattern?: string; mirror?: Array<{ from: string; to: string }> };

function readCollections(): Record<string, CollectionCfg> {
  try {
    const raw = JSON.parse(readFileSync(join(BASE, 'collections.json'), 'utf8'));
    return (raw?.collections ?? {}) as Record<string, CollectionCfg>;
  } catch {
    return {};
  }
}

function resolveHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Materialise mirrored sources into real files inside the collection dir.
 * qmd's glob does not follow symlinks, so a symlink farm indexes as zero files.
 * Each reindex copies the current content, so the sources stay canonical and
 * writable in place.
 */
function syncMirrors() {
  for (const [, c] of Object.entries(readCollections())) {
    if (!c?.path || !Array.isArray(c.mirror) || c.mirror.length === 0) continue;
    const dir = resolveHome(c.path);
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      continue;
    }
    const wanted = new Set<string>();
    for (const m of c.mirror) {
      if (!m?.from || !m?.to) continue;
      const name = basename(m.to);
      const src = resolveHome(m.from);
      wanted.add(name);
      try {
        if (!existsSync(src)) {
          log(`mirror source missing: ${src}`);
          continue;
        }
        copyFileSync(src, join(dir, name));
      } catch (e) {
        log(`mirror copy failed ${src}: ${String(e)}`);
      }
    }
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('.') || wanted.has(f)) continue;
        const p = join(dir, f);
        if (statSync(p).isFile()) unlinkSync(p);
      }
    } catch {
      /* ignore */
    }
  }
}

function writeIndexConfig() {
  try {
    ensureDirs();
    const cfg = join(KB_DIR, `${INDEX}.yml`);
    const lines: string[] = [
      'collections:',
      '  memories:',
      `    path: '${MEM_DIR.replaceAll("'", "''")}'`,
      '    pattern: "**/*.md"',
    ];
    // Extra collections (second brain, runbooks, ...) declared in
    // ~/.memory-loop/collections.json: { collections: { name: { path, pattern, mirror? } } }
    for (const [name, c] of Object.entries(readCollections())) {
      if (!c?.path) continue;
      const p = resolveHome(c.path);
      lines.push(
        `  ${name}:`,
        `    path: '${p.replaceAll("'", "''")}'`,
        `    pattern: ${JSON.stringify(c.pattern ?? '**/*.md')}`,
      );
    }
    const yml = `${lines.join('\n')}\nmodels:\n  embed: ${MODEL}\n  generate: ${MODEL}\n  rerank: ${MODEL}\nglobal_context: |\n  Project memory KB: this project's own past learnings, decisions and debugging\n  discoveries — not external documentation.\n`;
    if (!existsSync(cfg) || readFileSync(cfg, 'utf8') !== yml) writeFileSync(cfg, yml);
  } catch {
    /* ignore */
  }
}

/** Cheap content fingerprint (path:size:mtimeMs) so unchanged prompts skip embedding. */
function indexFingerprint(): string {
  const roots = [MEM_DIR, ...Object.values(readCollections()).map((c) => resolveHome(c?.path ?? ''))];
  const parts: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    try {
      for (const f of readdirSync(root, { recursive: true }) as string[]) {
        if (!String(f).endsWith('.md')) continue;
        try {
          const st = statSync(join(root, String(f)));
          parts.push(`${root}/${String(f)}:${st.size}:${st.mtimeMs}`);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  parts.sort();
  const s = parts.join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${parts.length}:${h}`;
}

let reindexing = false;
let reindexPending = false;
let lastFingerprint = '';

async function reindex(force = false) {
  if (reindexing) {
    reindexPending = true;
    return;
  }
  reindexing = true;
  try {
    writeIndexConfig();
    syncMirrors();
    const fp = indexFingerprint();
    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;
    for (const cmd of ['update', 'embed']) await runQmd([cmd]);
    log(`reindexed ${fp}`);
  } catch {
    /* fail open */
  } finally {
    reindexing = false;
    if (reindexPending) {
      reindexPending = false;
      void reindex();
    }
  }
}

/**
 * Debounced watcher over the memory store and every indexed collection, so an
 * edit to a handbook, runbook or memory is searchable shortly after saving —
 * not only at the next prompt. 30s debounce keeps embedding off the hot path.
 */
function startWatcher() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void reindex();
    }, 30000);
  };
  for (const root of [MEM_DIR, ...Object.values(readCollections()).map((c) => resolveHome(c?.path ?? ''))]) {
    if (!root || !existsSync(root)) continue;
    try {
      watch(root, { recursive: true }, (_e, file) => {
        if (!file || String(file).endsWith('.md')) bump();
      });
    } catch {
      /* ignore */
    }
  }
  try {
    watch(BASE, (_e, file) => {
      if (String(file) === 'collections.json' || String(file) === '.gate-off') bump();
    });
  } catch {
    /* ignore */
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
    void reindex();
    startWatcher();
    log('watcher started');

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

    // --- session start / turn completion: index, and schedule idle capture ---
    void (async () => {
      try {
        let seenEvents = 0;
        for await (const ev of ctx.event.subscribe()) {
          if (seenEvents < 40) {
            seenEvents += 1;
            log(`event ${String(ev?.type ?? '?')}`);
          }
          if (ev?.type === 'session.created') {
            void reindex();
            continue;
          }
          if (ev?.type === 'session.execution.succeeded') {
            void reindex();
            let sid = String(ev?.sessionID ?? ev?.session?.id ?? ev?.sessionId ?? ev?.id ?? '');
            if (!sid.startsWith('ses')) {
              if (!execEventLogged) {
                execEventLogged = true;
                log(`execution event shape: ${JSON.stringify(ev).slice(0, 700)}`);
              }
              const s = String(
                ev?.session?.sessionID ?? ev?.data?.sessionID ?? ev?.data?.session?.id ?? ev?.properties?.sessionID ?? '',
              );
              sid = s;
            }
            if (sid) scheduleCapture(sid);
          }
        }
      } catch {
        /* ignore */
      }
    })();

    // --- prompt: turn stamp, skill scan, automatic recall, reindex ---
    await ctx.session.hook('prompt', async (event: any) => {
      try {
        const sid = String(event?.sessionID ?? 'default');
        const s = getState(sid);
        s.turn += 1;
        s.denialsThisTurn = 0;
        const text = String(event?.prompt?.text ?? '');
        if (!promptKeysLogged) {
          promptKeysLogged = true;
          log(`prompt event keys: ${Object.keys(event ?? {}).join(',')}`);
        }
        const skill = detectSkill(text);
        if (skill) s.skills.push({ turn: s.turn, name: skill });
        s.capturePass = text.startsWith(CAPTURE_SENTINEL);

        // Recall policy. `kb-first` (default) injects nothing and instead makes
        // the first productive tool call of the turn require a KB search — the
        // same shape as Claude Code, where the model searches before acting.
        // `inject` keeps the older BM25 pre-injection for experimentation.
        if (RECALL === 'inject' && !text.startsWith(CAPTURE_SENTINEL)) {
          const seen = new Set(s.injected ?? []);
          const recall = await autoContext(text, seen);
          if (recall) {
            event.prompt.text =
              `${text}\n\n<memory-loop-context source="auto-retrieved from ~/.memory-loop + ~/second-brain (BM25)" trust="local notes">\n` +
              `${recall}\n\n(hits are excerpts; call memory_query for semantic search, memory_get for full text)\n</memory-loop-context>`;
            s.injected = [...seen, ...splitResults(recall).map(docId)].filter(Boolean).slice(-200);
            s.searches.push({ turn: s.turn, text: `(auto) ${text.slice(0, 200)}` });
          }
        }
        setState(sid, s);

        const pending = captureTimers.get(sid);
        if (pending) {
          clearTimeout(pending);
          captureTimers.delete(sid);
        }
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
          resources.some(touchesMemoryPath)
        ) {
          const cmd = resources.join(' ');
          if (
            !isReadOnlyShell(cmd) ||
            /(^|\s)(rm|unlink|mv|git\s+rm)(\s|$)/.test(cmd)
          ) {
            deny(s, event, 'Memory files are changed only via edit/write under a memory skill; bash writes are denied.');
            return;
          }
        }

        // KB-first: search before acting, the way a careful agent does on its
        // own. One denial per turn, so a deliberate retry is still possible.
        if (
          RECALL === 'kb-first' &&
          !s.capturePass &&
          isProductiveTool(action) &&
          !kbSearchedThisTurn(s) &&
          s.kbGateTurn !== s.turn
        ) {
          s.kbGateTurn = s.turn;
          setState(sid, s);
          deny(
            s,
            event,
            'KB first: call memory_query (1-3 typed searches — lex for exact tokens, vec for the question) before other tools. If nothing applies, say so and continue.',
          );
          return;
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

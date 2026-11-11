// Reading Claude Code and Codex session files for the ticket ledger.
//
// A marker is the mark command's own tool call in the session file, from either kit:
// `bollplank ledger mark <TICKET>` or `aw-ledger mark <TICKET>`. It names its session and takes
// effect from the start of the response that ran it. A response starts at the last input before it:
// a prompt, a tool result or the start of a Codex turn.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// A mark is the command itself, not a mention of it: it must start a word, path or quoted string.
const MARK = /(?:^|[\s;&|(`'"/])(aw-ledger|bollplank\s+ledger)\s+mark\s+([A-Za-z][A-Za-z0-9_]*-\d+)\b/g;

// Each mark found in a string, as { ticket, kit } with kit 'bollplank' or 'agent-workflow'.
export function marksIn(s) {
  if (typeof s !== 'string') return [];
  return [...s.matchAll(MARK)].map((m) => ({ ticket: m[2].toUpperCase(), kit: m[1] === 'aw-ledger' ? 'agent-workflow' : 'bollplank' }));
}

export function readClaude(file, text, lead) {
  const s = { tool: 'claude', file, session: basename(file, '.jsonl'), lead, start: null, responses: [], marks: [] };
  const index = new Map();
  let input = null;
  for (const rec of lines(text)) {
    const at = Date.parse(rec.timestamp);
    if (!at) continue;
    s.start ??= at;
    if (rec.type === 'user') {
      input = at;
      continue;
    }
    const m = rec.message;
    if (rec.type !== 'assistant' || !m?.id) continue;
    let r = index.get(m.id);
    if (!r) {
      r = { id: `claude:${m.id}`, start: input ?? at, model: m.model, usage: null };
      index.set(m.id, r);
      s.responses.push(r);
    }
    // Repeated records of one response carry its usage again. The last one is final.
    if (m.usage) r.usage = claudeUsage(m.usage);
    for (const c of m.content ?? []) {
      if (c?.type === 'tool_use' && c.name === 'Bash') for (const mark of marksIn(c.input?.command)) s.marks.push({ ...mark, at: r.start });
    }
  }
  s.responses = s.responses.filter((r) => r.usage && r.model !== '<synthetic>');
  return s;
}

export function readCodex(file, text) {
  const fromName = basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1] ?? basename(file);
  const s = { tool: 'codex', file, session: fromName, lead: null, start: null, responses: [], marks: [] };
  const records = [];
  const counts = [];
  let model = null;
  let input = null;
  let pending = null; // start of the response being built, reset by either kind of usage record
  let total = null;
  for (const rec of lines(text)) {
    const at = Date.parse(rec.timestamp);
    if (!at) continue;
    s.start ??= at;
    const p = rec.payload ?? {};
    if (rec.type === 'session_meta') {
      s.session = p.id ?? s.session;
      s.lead = p.source?.subagent?.thread_spawn?.parent_thread_id ?? null;
    } else if (rec.type === 'turn_context') model = p.model ?? model;
    else if (rec.type === 'event_msg' && p.type === 'task_started') {
      // A new turn starts a new response, even when the last one never reported usage.
      input = at;
      pending = null;
    } else if (rec.type === 'response_item') {
      const kind = String(p.type ?? '');
      if (kind.endsWith('_call_output') || (kind === 'message' && p.role !== 'assistant')) input = at;
      else if (kind === 'reasoning' || kind === 'message' || kind.endsWith('_call')) {
        pending ??= input ?? at;
        if (kind.endsWith('_call') && p.name !== 'apply_patch') {
          for (const mark of strings(p.arguments ?? p.input ?? p.action).flatMap(marksIn)) s.marks.push({ ...mark, at: pending });
        }
      }
    } else if (rec.type === 'token_usage_record' && p.usage) {
      records.push({ id: `codex:${p.response_id ?? `${file}:${records.length}`}`, start: pending ?? input ?? at, model, usage: codexUsage(p.usage) });
      pending = null;
    } else if (rec.type === 'event_msg' && p.type === 'token_count' && p.info) {
      // Running totals: each response's share is the step from the previous total. Without one, it
      // is the response's own last usage, never a running total. A share is keyed by session and
      // running total, so a copy of the same records in another file counts once.
      const now = p.info.total_token_usage;
      const share = now && total && now.total_tokens >= total.total_tokens ? diff(now, total) : (p.info.last_token_usage ?? null);
      if (now) total = now;
      const id = now ? `codex:${s.session}:total:${now.total_tokens}` : `codex:${file}:count:${counts.length}`;
      if (share && share.total_tokens > 0) counts.push({ id, start: pending ?? input ?? at, model, usage: codexUsage(share) });
      pending = null;
    }
  }
  s.responses = records.length ? records : counts;
  return s;
}

// Claude session files, each with its lead and its group. A lead and its subagents form one group.
export function* claudeFiles(root) {
  for (const project of dirs(root)) {
    const dir = join(root, project);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name.endsWith('.jsonl')) yield { file: p, lead: null, group: p.slice(0, -'.jsonl'.length) };
      else if (existsSync(join(p, 'subagents'))) for (const f of walk(join(p, 'subagents'))) yield { file: f, lead: name, group: p };
    }
  }
}

export function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function dirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

export function lines(text) {
  return text.split('\n').flatMap((l) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

// Every string inside a call's arguments, which Codex often stores as a JSON string.
function strings(v) {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') return [v, ...strings(parsed)];
    } catch {}
    return [v];
  }
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

// One accounting rule for both tools: new input, cached input and output add up to the total.
function claudeUsage(u) {
  const fresh = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const cached = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return { newInput: fresh, cachedInput: cached, output, total: fresh + cached + output };
}

function codexUsage(u) {
  const cached = u.cached_input_tokens ?? 0;
  const fresh = Math.max(0, (u.input_tokens ?? 0) - cached);
  const output = u.output_tokens ?? 0;
  return { newInput: fresh, cachedInput: cached, output, total: fresh + cached + output };
}

function diff(a, b) {
  return Object.fromEntries(Object.keys(a).map((k) => [k, (a[k] ?? 0) - (b[k] ?? 0)]));
}

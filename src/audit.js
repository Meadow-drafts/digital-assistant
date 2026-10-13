import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CARD, PLACEHOLDER, shield } from './shield.js';
import { maskText } from './mask.js';

// Append-only JSONL log, used for the audit and the failed-question log. Records are only ever added, with the append
// flag; there is no update and no delete by id. The one way records leave is `purge`, the retention job: it drops
// everything older than a cutoff and nothing else. Operations are queued so a purge never loses a record appended
// while it runs.
export function createFileAudit(path) {
  let ready;
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const prepare = () => (ready ??= mkdir(dirname(path), { recursive: true }));
  const parse = (text) => text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const load = () => readFile(path, 'utf8').then(parse, (e) => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
  return {
    append: (record) => exclusive(async () => {
      await prepare();
      await appendFile(path, `${JSON.stringify(record)}\n`, { flag: 'a' });
    }),
    // Every record, oldest first.
    all: () => exclusive(load),
    // Drops records whose time is before `beforeMs` (a record with no readable time is kept). Returns how many went.
    purge: (beforeMs) => exclusive(async () => {
      const records = await load();
      const keep = records.filter((r) => !(Date.parse(r.time) < beforeMs));
      if (keep.length === records.length) return 0;
      await prepare();
      await writeFile(`${path}.tmp`, keep.map((r) => `${JSON.stringify(r)}\n`).join(''));
      await rename(`${path}.tmp`, path);
      return records.length - keep.length;
    }),
  };
}

// Defence in depth at the one place audit records are written. The sources already keep secrets out (the shield,
// masking at the tool layer); this makes the log itself unable to hold the shapes that must never be stored.
const JWT = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;
const BEARER = /\bBearer\s+\S+/gi;
const LONG_HEX = /\b[0-9a-f]{40,}\b/gi; // a PIN hash (SHA-512) or any digest
const scrubString = (s) => s.replace(JWT, PLACEHOLDER).replace(BEARER, `Bearer ${PLACEHOLDER}`).replace(LONG_HEX, PLACEHOLDER).replace(CARD, PLACEHOLDER);
const scrub = (value) => {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
};

// What the service writes through. Every record leaves with a time, a pseudonymous user, a tenant and a conversation
// id (null where there is none), customer text that has been through the shield again and masked, and no secret-shaped value.
export function createAuditTrail({ sink, clock }) {
  const tenantOf = (t) => (typeof t === 'string' && t ? t.slice(0, 40) : null);
  return {
    append({ time, user, tenant, conversationId, ...rest }) {
      // What the customer typed and what was answered are stored masked: account and phone numbers show their last four.
      const texts = {
        ...(typeof rest.userText === 'string' ? { userText: maskText(shield(rest.userText).text) } : {}),
        ...(typeof rest.replyText === 'string' ? { replyText: maskText(rest.replyText) } : {}),
      };
      const fixed = scrub({ ...rest, ...texts });
      return sink.append({
        time: time ?? new Date(clock.now()).toISOString(),
        user: user ?? 'anonymous',
        tenant: tenantOf(scrub(tenant)),
        conversationId: conversationId ?? null,
        ...fixed,
      });
    },
    // Newest first. Filters are exact matches; `fromMs` and `toMs` bound the record time (inclusive); `limit` caps the number returned.
    async read({ conversationId, outcome, fromMs = -Infinity, toMs = Infinity, limit = 200 } = {}) {
      const inRange = (r) => { const at = Date.parse(r.time); return at >= fromMs && at <= toMs; };
      const records = (await sink.all()).filter((r) => (!conversationId || r.conversationId === conversationId) && (!outcome || r.outcome === outcome) && inRange(r));
      return records.reverse().slice(0, limit);
    },
    purge: (beforeMs) => sink.purge(beforeMs),
  };
}

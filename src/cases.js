import { transaction } from './database.js';

// Support cases: the handoff state machine.
// States: waiting (for an agent) -> with_agent -> resolved. A cancelled case is a
// resolved variant: closeReason says how it ended. A conversation with no open
// case is "bot".
//
// Without a database this is a plain in-memory store (tests, quick demos). With one (ticket 62) every case is also kept
// in SQLite: the store loads them all at start, writes each change through (batched in one transaction per tick), and
// the claim is one conditional UPDATE, so the database, not this process, decides who got a case first.

// The last moment anything happened on a case, for retention: opening, resolution or any transcript entry.
export const lastActivity = (c) => Math.max(c.openedAt, c.resolvedAt ?? 0, ...c.transcript.map((m) => m.at));

const REF = /^C-(\d+)$/;

export function createCaseStore({ clock, database = null, agentById = () => null }) {
  const cases = new Map();
  let counter = 1000;
  const db = database;

  // ---- durable side ----
  let sql = null;
  const dirty = new Set();
  let flushQueued = false;

  // The agent is stored as an id (the object in memory holds a login); an agent no longer on the roster stays as a bare id.
  const agentFor = (id) => (id ? (agentById(id) ?? { id, name: id, email: null }) : null);
  const saveCounter = () => db.prepare("INSERT INTO meta (key, value) VALUES ('ref_counter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(counter));

  function upsert(c) {
    // Left out of the stored copy: the transcript (its own table), the agent (an id column) and an in-flight promise.
    const { transcript, agent, summaryPending, ...rest } = c; // eslint-disable-line no-unused-vars
    sql.upsert.run(c.ref, c.conversationId, c.owner, c.state, c.agent?.id ?? null, c.closeReason ?? null, c.openedAt, c.resolvedAt ?? null, c.openToPool ? 1 : 0, JSON.stringify(rest));
  }
  function flush() {
    flushQueued = false;
    if (dirty.size === 0) return;
    try {
      transaction(db, () => { for (const c of dirty) if (cases.get(c.ref) === c) upsert(c); });
      dirty.clear();
    } catch (e) {
      // Never throws into a request or a timer. The cases stay dirty and are written again on the next change.
      console.error(`case store: could not save (${e?.code ?? e?.name ?? 'error'})`);
    }
  }
  // Every change to a case's own fields is saved without each caller having to say so. (The transcript is appended through
  // the store; nested changes always go with a change to a field of the case itself.)
  const track = (target) => new Proxy(target, {
    set(t, key, value, receiver) {
      t[key] = value;
      if (key !== 'transcript' && key !== 'summaryPending') {
        dirty.add(receiver);
        if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
      }
      return true;
    },
  });

  function rehydrate(row, messages) {
    const c = JSON.parse(row.data);
    c.ref = row.ref;
    c.conversationId = row.conversation_id;
    c.owner = row.owner;
    // The columns decide these: the claim updates them before the rest of the case is written.
    c.state = row.state;
    c.closeReason = row.close_reason;
    c.openedAt = row.opened_at;
    if (row.resolved_at !== null) c.resolvedAt = row.resolved_at; else delete c.resolvedAt;
    c.openToPool = row.open_to_pool === 1;
    c.agent = agentFor(row.agent_id);
    c.transcript = messages.map((m) => ({ seq: m.seq, from: m.sender, text: m.text, at: m.at, ...(m.public ? { public: true } : {}) }));
    c.transfers ??= [];
    c.notes ??= [];
    // A summary that was still being written when the process stopped is gone; let the claim try once more.
    if ((c.state === 'waiting' || c.state === 'with_agent') && !c.summary) c.summaryFailed = true;
    return c;
  }

  if (db) {
    sql = {
      upsert: db.prepare(`INSERT INTO cases (ref, conversation_id, owner, state, agent_id, close_reason, opened_at, resolved_at, open_to_pool, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ref) DO UPDATE SET conversation_id = excluded.conversation_id, owner = excluded.owner, state = excluded.state, agent_id = excluded.agent_id,
          close_reason = excluded.close_reason, opened_at = excluded.opened_at, resolved_at = excluded.resolved_at, open_to_pool = excluded.open_to_pool, data = excluded.data`),
      message: db.prepare('INSERT INTO case_messages (case_ref, seq, sender, text, at, public) VALUES (?, ?, ?, ?, ?, ?)'),
      claim: db.prepare("UPDATE cases SET state = 'with_agent', agent_id = ? WHERE ref = ? AND state = 'waiting' AND agent_id IS NULL"),
      takeOver: db.prepare("UPDATE cases SET agent_id = ?, open_to_pool = 0 WHERE ref = ? AND state = 'with_agent' AND open_to_pool = 1 AND agent_id <> ?"),
      row: db.prepare('SELECT * FROM cases WHERE ref = ?'),
      remove: db.prepare('DELETE FROM cases WHERE ref = ?'),
    };
    const byCase = new Map();
    for (const m of db.prepare('SELECT * FROM case_messages ORDER BY case_ref, seq').all()) {
      if (!byCase.has(m.case_ref)) byCase.set(m.case_ref, []);
      byCase.get(m.case_ref).push(m);
    }
    for (const row of db.prepare('SELECT * FROM cases ORDER BY rowid').all()) cases.set(row.ref, track(rehydrate(row, byCase.get(row.ref) ?? [])));
    // References never go backwards: past the highest stored one and past every reference ever handed out.
    const stored = Number(db.prepare("SELECT value FROM meta WHERE key = 'ref_counter'").get()?.value ?? 0);
    counter = Math.max(counter, stored, ...[...cases.keys()].map((ref) => Number(REF.exec(ref)?.[1] ?? 0)));
  }

  // The database's answer for a case this process thought it knew, after a conditional update said no.
  function refresh(c) {
    const row = sql.row.get(c.ref);
    if (!row) return;
    c.state = row.state;
    c.agent = agentFor(row.agent_id);
    c.openToPool = row.open_to_pool === 1;
  }

  return {
    // A reference can be reserved before its case exists, so a drafted message can show it in the email subject.
    reserveRef() {
      counter += 1;
      if (db) saveCounter();
      return `C-${counter}`;
    },
    open({ conversationId, owner, tenant, language, ref, state = 'waiting' }) {
      if (ref === undefined) { counter += 1; if (db) saveCounter(); ref = `C-${counter}`; }
      const found = { ref, conversationId, owner, tenant: tenant ?? null, language, state, openedAt: clock.now(), agent: null, closeReason: null, solved: null, transcript: [], transfers: [], linkedTo: null };
      if (!db) { cases.set(ref, found); return found; }
      const c = track(found);
      cases.set(ref, c);
      upsert(c); // written now: its messages refer to it
      return c;
    },
    // The atomic claim: of any number of simultaneous claims exactly one sees "waiting and unclaimed". In memory that is one
    // check and one write with no await between them. With a database it is a single conditional UPDATE
    // (... WHERE state = 'waiting' AND agent_id IS NULL), so it also holds against another process on the same file.
    claim(ref, agent) {
      const c = cases.get(ref);
      if (!c) return { ok: false, reason: 'not_found' };
      if (db) {
        flush(); // the row must say what this process knows before the database decides
        if (sql.claim.run(agent.id, ref).changes !== 1) { refresh(c); return { ok: false, reason: c.agent ? 'already_claimed' : 'not_waiting' }; }
      } else {
        if (c.agent) return { ok: false, reason: 'already_claimed' };
        if (c.state !== 'waiting') return { ok: false, reason: 'not_waiting' };
      }
      c.state = 'with_agent';
      c.agent = agent;
      c.claimedAt = clock.now();
      return { ok: true, case: c };
    },
    // After the 30-minute re-broadcast a held case is open to the pool (c.openToPool). The first colleague to take it wins:
    // one check and one write with no await between them (a conditional UPDATE with a database), and the write closes the
    // open state, so a second take-over sees a case that is no longer open. The history, draft, summary, records and
    // priority stay on the case.
    takeOver(ref, agent) {
      const c = cases.get(ref);
      if (!c) return { ok: false, reason: 'not_found' };
      const from = c.agent;
      if (db) {
        flush();
        if (!from || sql.takeOver.run(agent.id, ref, agent.id).changes !== 1) { refresh(c); return { ok: false, reason: 'already_claimed' }; }
      } else if (c.state !== 'with_agent' || !c.openToPool || c.agent.id === agent.id) return { ok: false, reason: 'already_claimed' };
      c.transfers.push({ from: from.id, to: agent.id, at: clock.now() });
      c.agent = agent;
      c.openToPool = false;
      c.claimedAt = clock.now();
      return { ok: true, case: c, from };
    },
    // A customer who asks again inside the window gets the same case back, with the agent who had it.
    reopen(c) {
      c.state = 'with_agent';
      c.closeReason = null;
      c.resolvedAt = null;
      c.solved = null;
      c.reopenedAt = clock.now();
    },
    // Hands the case to a colleague. The case itself (transcript, draft, summary, records, priority) does not move.
    transfer(c, agent) {
      c.transfers.push({ from: c.agent.id, to: agent.id, at: clock.now() });
      c.agent = agent;
    },
    // An internal note: kept on the case itself (not in the transcript), so it travels with the case on a transfer. The array is
    // replaced, not pushed to, so the durable store sees the change.
    addNote(c, agent, text) {
      const notes = c.notes ?? [];
      const note = { id: `N-${notes.length + 1}`, agentId: agent.id, agent: agent.name, text, at: clock.now() };
      c.notes = [...notes, note];
      return note;
    },
    resolve(c, reason = 'resolved_by_agent') {
      c.state = 'resolved';
      c.closeReason = reason;
      c.resolvedAt = clock.now();
    },
    // One message on the case. seq counts every entry, so a reader keeps a cursor and asks for what is newer.
    // `extra` marks an entry the customer is allowed to see even though it is not an agent's (public: true).
    append(c, from, text, extra = {}) {
      const entry = { seq: c.transcript.length + 1, from, text, at: clock.now(), ...extra };
      c.transcript.push(entry);
      if (db) {
        flush(); // the case row first, then its message
        try { sql.message.run(c.ref, entry.seq, from, text, entry.at, entry.public ? 1 : 0); } catch (e) { console.error(`case store: could not save a message (${e?.code ?? e?.name ?? 'error'})`); }
      }
      return entry;
    },
    get: (ref) => cases.get(ref) ?? null,
    // The case that currently matters for a conversation: the newest one.
    latestFor: (conversationId) => [...cases.values()].filter((c) => c.conversationId === conversationId).at(-1) ?? null,
    all: () => [...cases.values()],
    // Retention: forgets closed cases (resolved, cancelled or only emailed) whose last activity is older than the cutoff.
    // A case still waiting or with an agent is live work and stays. Returns how many went. Their messages go with them.
    purge(cutoff) {
      let removed = 0;
      for (const [ref, c] of cases) {
        if (c.state === 'waiting' || c.state === 'with_agent') continue;
        if (lastActivity(c) < cutoff) {
          cases.delete(ref);
          if (db) { dirty.delete(c); sql.remove.run(ref); }
          removed += 1;
        }
      }
      return removed;
    },
    // Writes anything not yet written (also done on its own at the end of each tick).
    flush: () => { if (db) flush(); },
  };
}

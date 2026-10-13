// Support cases: the handoff state machine. Pure in-memory store, no HTTP.
// States: waiting (for an agent) -> with_agent -> resolved. A cancelled case is a
// resolved variant: closeReason says how it ended. A conversation with no open
// case is "bot".
export function createCaseStore({ clock }) {
  const cases = new Map();
  let counter = 1000;

  return {
    // A reference can be reserved before its case exists, so a drafted message can show it in the email subject.
    reserveRef: () => `C-${++counter}`,
    open({ conversationId, owner, tenant, language, ref = `C-${++counter}`, state = 'waiting' }) {
      const found = { ref, conversationId, owner, tenant: tenant ?? null, language, state, openedAt: clock.now(), agent: null, closeReason: null, solved: null, transcript: [], transfers: [], linkedTo: null };
      cases.set(ref, found);
      return found;
    },
    // The atomic claim: one conditional update with no await between the check and the write, so of any number
    // of simultaneous claims exactly one sees "waiting and unclaimed". (A database build does the same with a
    // single conditional UPDATE ... WHERE state = 'waiting' AND claimed_by IS NULL.)
    claim(ref, agent) {
      const c = cases.get(ref);
      if (!c) return { ok: false, reason: 'not_found' };
      if (c.agent) return { ok: false, reason: 'already_claimed' };
      if (c.state !== 'waiting') return { ok: false, reason: 'not_waiting' };
      c.state = 'with_agent';
      c.agent = agent;
      c.claimedAt = clock.now();
      return { ok: true, case: c };
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
      return entry;
    },
    get: (ref) => cases.get(ref) ?? null,
    // The case that currently matters for a conversation: the newest one.
    latestFor: (conversationId) => [...cases.values()].filter((c) => c.conversationId === conversationId).at(-1) ?? null,
    all: () => [...cases.values()],
    // Retention: forgets closed cases (resolved, cancelled or only emailed) whose last activity is older than the cutoff.
    // A case still waiting or with an agent is live work and stays. Returns how many went.
    purge(cutoff) {
      let removed = 0;
      for (const [ref, c] of cases) {
        if (c.state === 'waiting' || c.state === 'with_agent') continue;
        const last = Math.max(c.openedAt, c.resolvedAt ?? 0, ...c.transcript.map((m) => m.at));
        if (last < cutoff) { cases.delete(ref); removed += 1; }
      }
      return removed;
    },
  };
}

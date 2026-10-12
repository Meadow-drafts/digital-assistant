// Support cases: the handoff state machine. Pure in-memory store, no HTTP.
// States: waiting (for an agent) -> with_agent -> resolved. A cancelled case is a
// resolved variant: closeReason says how it ended. A conversation with no open
// case is "bot".
export function createCaseStore({ clock }) {
  const cases = new Map();
  let counter = 1000;

  return {
    open({ conversationId, owner, tenant, language }) {
      const ref = `C-${++counter}`;
      const found = { ref, conversationId, owner, tenant: tenant ?? null, language, state: 'waiting', openedAt: clock.now(), agent: null, closeReason: null, solved: null, transcript: [] };
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
    resolve(c, reason = 'resolved_by_agent') {
      c.state = 'resolved';
      c.closeReason = reason;
      c.resolvedAt = clock.now();
    },
    // One message on the case. seq counts every entry, so a reader keeps a cursor and asks for what is newer.
    append(c, from, text) {
      const entry = { seq: c.transcript.length + 1, from, text, at: clock.now() };
      c.transcript.push(entry);
      return entry;
    },
    get: (ref) => cases.get(ref) ?? null,
    // The case that currently matters for a conversation: the newest one.
    latestFor: (conversationId) => [...cases.values()].filter((c) => c.conversationId === conversationId).at(-1) ?? null,
    all: () => [...cases.values()],
  };
}

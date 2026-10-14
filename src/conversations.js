import { transaction } from './database.js';
import { maskText } from './mask.js';

// Chat conversations, keyed by conversation id. Map-like (get, set, delete, has, iteration) so the rest of the service
// does not care; with a database (ticket 62) they are also kept in SQLite and loaded at start.
//
// What is stored: the owner, the history (each message masked again on the way in: runs of 9+ digits become ****NNNN),
// the language, the questions already asked (for the "same question twice" chip, masked the same way), the last
// transaction reference looked at, and when the conversation was last active. NOT stored: the session (customer id,
// wallet, account numbers, email, entitlements) and the balance unlock. They need the gateway and the customer's token,
// so after a restart the customer's next session start fills them again.
export function createConversationStore({ database = null } = {}) {
  const map = new Map();
  const db = database;
  const dirty = new Set();
  let flushQueued = false;
  let upsert = null;

  const data = (conversation) => JSON.stringify({
    history: conversation.history.map((m) => ({ role: m.role, content: maskText(m.content), ...(m.id ? { id: m.id } : {}) })),
    language: conversation.language,
    asked: [...conversation.asked].map(maskText),
    feedback: (conversation.feedback ?? []).map(({ answerId, rating, at }) => ({ answerId, rating, at })),
    ...(conversation.pendingClarification ? { pendingClarification: conversation.pendingClarification } : {}),
    ...(conversation.lastReference === undefined ? {} : { lastReference: conversation.lastReference }),
  });

  function flush() {
    flushQueued = false;
    if (!db || dirty.size === 0) return;
    try {
      transaction(db, () => {
        for (const id of dirty) {
          const conversation = map.get(id);
          if (conversation) upsert.run(id, conversation.owner, conversation.lastActiveAt ?? 0, data(conversation));
        }
      });
      dirty.clear();
    } catch (e) {
      console.error(`conversation store: could not save (${e?.code ?? e?.name ?? 'error'})`);
    }
  }
  const markDirty = (id) => {
    if (!db) return;
    dirty.add(id);
    if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
  };

  if (db) {
    upsert = db.prepare(`INSERT INTO conversations (id, owner, last_active_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, last_active_at = excluded.last_active_at, data = excluded.data`);
    for (const row of db.prepare('SELECT * FROM conversations ORDER BY rowid').all()) {
      const stored = JSON.parse(row.data);
      map.set(row.id, {
        owner: row.owner, history: stored.history, language: stored.language, asked: new Set(stored.asked), feedback: stored.feedback ?? [], session: null,
        lastActiveAt: row.last_active_at, ...(stored.lastReference === undefined ? {} : { lastReference: stored.lastReference }),
        ...(stored.pendingClarification ? { pendingClarification: stored.pendingClarification } : {}),
      });
    }
  }

  return {
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    set(id, conversation) { map.set(id, conversation); markDirty(id); return this; },
    // Call after changing a conversation that is already stored (a new turn, a language change).
    save: (id) => { if (map.has(id)) markDirty(id); },
    delete(id) {
      dirty.delete(id);
      if (db) db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      return map.delete(id);
    },
    [Symbol.iterator]: () => map[Symbol.iterator](),
    get size() { return map.size; },
    flush,
  };
}

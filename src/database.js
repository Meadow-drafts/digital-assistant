import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// Durable storage for support cases and chat conversations (ticket 62). SQLite through Node's built-in `node:sqlite`
// (Node 22.13 or later), so there is no dependency. One file, normally under data/ (git-ignored).
//
// Only what the service already keeps masked is written here: case transcripts and notes, the drafted message, the
// summary, masked records, conversation history (masked again on the way in), and the owner digest. Never the
// session (ids, account numbers, wallet), the balance unlock, a token, an agent's password or the session secret.
const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cases (
    ref TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    state TEXT NOT NULL,
    agent_id TEXT,
    close_reason TEXT,
    opened_at INTEGER NOT NULL,
    resolved_at INTEGER,
    open_to_pool INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cases_by_conversation ON cases (conversation_id);
  CREATE INDEX IF NOT EXISTS cases_by_owner ON cases (owner);
  CREATE TABLE IF NOT EXISTS case_messages (
    case_ref TEXT NOT NULL REFERENCES cases (ref) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    public INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (case_ref, seq)
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    last_active_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
`;

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const found = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!found) db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  else if (Number(found.value) > SCHEMA_VERSION) {
    db.close();
    throw new Error(`database: ${path} was written by a newer version of the service (schema ${found.value})`);
  }
  return db;
}

// Several writes, all or nothing.
export function transaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

// The key that signs customer session ids (see identity.js). SESSION_SECRET wins; otherwise it is read from `path`, or made
// once and kept there (owner-only), so sessions survive a restart. It is deliberately not in the database.
export function loadSessionSecret(path, env = process.env) {
  if (env.SESSION_SECRET !== undefined) {
    if (env.SESSION_SECRET.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');
    return env.SESSION_SECRET;
  }
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf8').trim();
    if (secret.length >= 16) return secret;
  }
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

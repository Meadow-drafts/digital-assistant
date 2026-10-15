import { readFileSync } from 'node:fs';

// Retention: how long customer words are kept. ONE value covers the conversation transcripts, the case transcripts, the
// audit log and the failed-question log, so compliance sets a single number. Placeholder 30 days (config/retention.json);
// RETENTION_DAYS in the environment overrides the file.
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

export function loadRetention(path, env = process.env) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`retention config: cannot read ${path}: ${e.message}`); }
  const days = env.RETENTION_DAYS !== undefined ? Number(env.RETENTION_DAYS) : raw.retentionDays;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) throw new Error('retention config: retentionDays (or RETENTION_DAYS) must be a positive number of days');
  return { days, ms: days * DAY };
}

// The purge job. `run` removes everything older than the retention value, measured from last activity, and returns how
// much went from each store. `start` repeats it on the clock (hourly, or sooner for a very short retention). A case that
// is still open is live work and is never purged, nor is the conversation it belongs to.
export function createRetention({ clock, ms, audit, failedQuestions, conversations, handoff, drafts }) {
  async function run() {
    const cutoff = clock.now() - ms;
    const forgotten = [];
    for (const [id, conversation] of conversations) {
      if (conversation.lastActiveAt < cutoff && !handoff.openCaseFor(id)) forgotten.push(id);
    }
    for (const id of forgotten) { conversations.delete(id); drafts.forget(id); }
    return {
      audit: await audit.purge(cutoff),
      failedQuestions: (await failedQuestions?.purge?.(cutoff)) ?? 0,
      conversations: forgotten.length,
      cases: handoff.purge(cutoff),
    };
  }

  let timer;
  let stopped = false;
  const every = Math.min(HOUR, ms);
  const tick = () => {
    if (stopped) return;
    timer = clock.setTimeout(async () => {
      try { await run(); } catch (e) { console.warn(`retention purge failed: ${e?.code ?? e?.name ?? 'error'}`); }
      tick();
    }, every);
    timer?.unref?.();
  };
  return {
    run,
    start: tick,
    stop() { stopped = true; if (timer !== undefined) clock.clearTimeout(timer); },
  };
}

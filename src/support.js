import { readFileSync } from 'node:fs';

// Support configuration: the agent roster, who is on call, every timer, opening hours and how mail is sent.
// Nothing here has a default in code; the bank edits config/support.json (placeholder values from ticket 07).
const ADDRESS = /^[^\s<>,;"@]+@[^\s<>,;"@]+$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const fail = (what) => { throw new Error(`support config: ${what}`); };
// Every timer the support flow reads. Placeholder values from ticket 07; the bank replaces them.
const TIMER_KEYS = ['broadcastMs', 'queuedNoticeMs', 'absentMs', 'agentSilenceMs', 'agentFollowUpMs', 'autoResolveMs', 'reopenWindowMs'];
const positive = (v) => Number.isFinite(v) && v > 0;

export function loadSupport(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`support config: cannot read ${path}: ${e.message}`); }

  const list = raw.agents?.list;
  if (!Array.isArray(list) || !list.every((a) => a && ['id', 'name', 'email', 'password'].every((k) => typeof a[k] === 'string' && a[k]))) {
    fail('agents.list must be an array of {id, name, email, password}');
  }
  const onCall = raw.agents?.onCall;
  if (!Array.isArray(onCall) || !onCall.every((id) => list.some((a) => a.id === id))) fail('agents.onCall must list ids from agents.list');
  const sessionMs = raw.agents?.sessionMs ?? 8 * 60 * 60_000;
  if (!positive(sessionMs)) fail('agents.sessionMs must be a positive number');

  const timers = raw.timers ?? {};
  for (const k of TIMER_KEYS) if (!positive(timers[k])) fail(`timers.${k} must be a positive number`);
  if (timers.agentFollowUpMs <= timers.agentSilenceMs) fail('timers.agentFollowUpMs must be later than timers.agentSilenceMs');

  const h = raw.hours ?? {};
  if (!Number.isInteger(h.utcOffsetMinutes) || Math.abs(h.utcOffsetMinutes) > 14 * 60) fail('hours.utcOffsetMinutes must be whole minutes from UTC');
  if (!Array.isArray(h.days) || !h.days.length || !h.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) fail('hours.days must be weekday numbers 0 (Sunday) to 6');
  if (!HHMM.test(h.open ?? '') || !HHMM.test(h.close ?? '') || h.open >= h.close) fail('hours.open and hours.close must be HH:MM with open before close');

  const mail = raw.mail ?? {};
  if (!['log', 'smtp'].includes(mail.mode)) fail('mail.mode must be "log" or "smtp"');
  if (typeof mail.supportAddress !== 'string' || !ADDRESS.test(mail.supportAddress)) fail('mail.supportAddress must be the support team\'s email address');

  return {
    agents: { list, onCall, sessionMs },
    timers: Object.fromEntries(TIMER_KEYS.map((k) => [k, timers[k]])),
    hours: { utcOffsetMinutes: h.utcOffsetMinutes, days: h.days, open: h.open, close: h.close },
    mail,
  };
}

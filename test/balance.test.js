import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, bob, begin, say, start, toolModel, wire, TENANT } from './harness/t1-helpers.js';
import { sha512 } from './harness/bank-fixtures.js';

const BALANCE = '[[tool:balance {}]]';
const unlock = async (svc, c, conversationId, payload, token = c.token) => {
  const res = await fetch(`${svc.baseUrl}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ conversationId, tenant: TENANT, ...payload }),
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
};
const flag = (c, over = {}) => ({ portalFlag: { verified: '1', tel: c.sub, ...over } });
const calls = (svc, suffix) => svc.gateway.calls.filter((c) => c.path.endsWith(suffix));
const blocked = (events) => events.find((e) => e.type === 'tool_blocked')?.code;

async function session(opts = {}) {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel(BALANCE), ...opts.start });
  const id = await begin(svc, a, opts.gating ? { gating: opts.gating } : undefined);
  return { a, svc, id };
}

test('portal flag set for this phone: the balance is shown with no PIN prompt and no PIN check', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);

  const claim = await unlock(svc, a, id, flag(a));
  const { events } = await say(svc, a, 'what is my balance?', id);

  assert.equal(claim.status, 200);
  const result = events.find((e) => e.type === 'tool').result;
  assert.deepEqual(result.balances, [{ account: '****8901', kind: 'available', amount: 845678, currency: 'XAF' }]);
  assert.equal(calls(svc, 'checkPin').length, 0, 'the portal flag replaces the PIN box');
  assert.equal(calls(svc, 'getSolde')[0].body.cpt, a.accountNo, 'the account comes from the session, not the model or the browser');
  assert.doesNotMatch(wire(events), /12345678901/);
});

test('portal flag missing or not "1": the balance is not read and the widget is asked for a PIN', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);

  for (const payload of [{}, { portalFlag: null }, flag(a, { verified: '0' }), flag(a, { verified: undefined }), flag(a, { verified: 1 })]) {
    assert.equal((await unlock(svc, a, id, payload)).status, 403, JSON.stringify(payload));
  }
  const { events } = await say(svc, a, 'what is my balance?', id);

  assert.equal(blocked(events), 'pin_required');
  assert.equal(calls(svc, 'getSolde').length, 0);
});

test('portal flag for a different phone does not unlock', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);
  const other = bob();

  const claim = await unlock(svc, a, id, flag(a, { tel: other.sub }));
  const { events } = await say(svc, a, 'my balance', id);

  assert.equal(claim.status, 403);
  assert.equal(blocked(events), 'pin_required');
  assert.equal(calls(svc, 'getSolde').length, 0);
});

test('the PIN box fallback: the hash goes straight to the PIN check for the session\'s own phone, a pass unlocks, and no PIN or hash reaches the model, UI, audit or logs', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  for (const m of methods) console[m] = (...args) => logged.push(args.map(String).join(' '));
  let events;
  let pass;
  try {
    pass = await unlock(svc, a, id, { pinHash: sha512('1234'), tel: '237000000000' });
    ({ events } = await say(svc, a, 'what is my balance?', id));
  } finally {
    for (const m of methods) console[m] = originals[m];
  }

  assert.equal(pass.status, 200);
  const [check] = calls(svc, 'checkPin');
  assert.deepEqual(check.body, { pin: sha512('1234'), tel: a.sub }, 'the phone is the session\'s, never the browser\'s');
  assert.equal(check.token, a.token);
  assert.ok(events.some((e) => e.type === 'tool' && e.result.balances));
  const secret = new RegExp(`${sha512('1234')}|1234`);
  for (const [surface, text] of [['model', JSON.stringify(svc.model.calls)], ['ui', wire(events)], ['audit', JSON.stringify(svc.audit.records)], ['logs', logged.join('\n')], ['response', JSON.stringify(pass)]]) {
    assert.doesNotMatch(text, secret, `${surface} holds the PIN or its hash`);
  }
  assert.ok(svc.audit.records.some((r) => r.outcome === 'balance_unlocked_pin'));
});

test('a wrong PIN says how many attempts are left, a blocked PIN stays locked, and neither unlocks', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);

  const wrong = await unlock(svc, a, id, { pinHash: sha512('0000') });
  assert.deepEqual([wrong.status, wrong.error, wrong.attemptsLeft], [403, 'pin_wrong', 2]);
  await unlock(svc, a, id, { pinHash: sha512('0000') });
  const lock = await unlock(svc, a, id, { pinHash: sha512('0000') });
  assert.deepEqual([lock.status, lock.error], [423, 'pin_blocked']);
  const right = await unlock(svc, a, id, { pinHash: sha512('1234') });
  assert.equal(right.status, 423, 'even the right PIN does not pass once blocked');

  const { events } = await say(svc, a, 'my balance', id);
  assert.equal(blocked(events), 'pin_required');
  assert.equal(calls(svc, 'getSolde').length, 0);
});

test('only a well-formed hash is forwarded: a plain PIN typed into the field never reaches the gateway', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);

  for (const pinHash of ['1234', 'abc', '', 1234, null, 'g'.repeat(128), sha512('1234').toUpperCase().slice(0, 127)]) {
    assert.equal((await unlock(svc, a, id, { pinHash })).status, 400, String(pinHash));
  }
  assert.equal(calls(svc, 'checkPin').length, 0);
});

test('the unlock lasts 5 minutes and then re-prompts', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);
  await unlock(svc, a, id, { pinHash: sha512('1234') });

  await svc.clock.advance(4 * 60_000 + 59_000);
  assert.ok((await say(svc, a, 'balance', id)).events.some((e) => e.type === 'tool'));

  await svc.clock.advance(2_000);
  const later = await say(svc, a, 'balance again', id);
  assert.equal(blocked(later.events), 'pin_required');
  assert.equal(calls(svc, 'getSolde').length, 1, 'no second read after the window');
});

test('the unlock ends early when the session expires', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);
  await unlock(svc, a, id, { pinHash: sha512('1234') });
  svc.gateway.failWith(401);
  assert.equal(blocked((await say(svc, a, 'balance', id)).events), 'session_expired');
  svc.gateway.recover();

  // a fresh session on the same conversation starts locked
  assert.equal((await begin(svc, a, { conversationId: id })), id);
  const { events } = await say(svc, a, 'balance', id);

  assert.equal(blocked(events), 'pin_required');
});

test('unlocking needs a verified session, and one customer cannot unlock another\'s conversation', async (t) => {
  const a = alice();
  const b = bob();
  const svc = await start({ customers: [a, b], model: toolModel(BALANCE) });
  t.after(svc.close);
  const id = await begin(svc, a);

  const intruder = await unlock(svc, b, id, { pinHash: sha512('1234') });
  assert.equal(intruder.status, 404);
  assert.equal(calls(svc, 'checkPin').length, 0);

  const noSession = await unlock(svc, a, 'not-a-conversation', flag(a));
  assert.equal(noSession.status, 404);
});

test('a package without balance: the balance is never read, whatever the unlock, and the customer is told why', async (t) => {
  const { a, svc, id } = await session({ gating: { usePackages: true, pack: { natureCodes: ['HIST', 'TRINC'] } } });
  t.after(svc.close);
  await unlock(svc, a, id, { pinHash: sha512('1234') });

  const { events } = await say(svc, a, 'my balance', id);

  assert.equal(blocked(events), 'not_in_package');
  assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /not included in your package/);
  assert.equal(calls(svc, 'getSolde').length, 0);
});

test('either balance nature opens the balance: SOLDE or BALA', async (t) => {
  for (const code of ['SOLDE', 'BALA']) {
    const { a, svc, id } = await session({ gating: { usePackages: true, pack: { natureCodes: [code] } } });
    try {
      await unlock(svc, a, id, { pinHash: sha512('1234') });
      assert.ok((await say(svc, a, 'my balance', id)).events.some((e) => e.type === 'tool'), code);
    } finally {
      await svc.close();
    }
  }
});

test('the model picks only an enumerated account index and kind: ids and out-of-range choices are rejected', async (t) => {
  for (const tag of ['[[tool:balance {"account":5}]]', '[[tool:balance {"cpt":"55566677788"}]]', '[[tool:balance {"kind":"everything"}]]', '[[tool:balance {"account":-1}]]']) {
    const a = alice();
    const svc = await start({ customers: [a], model: toolModel(tag) });
    try {
      const id = await begin(svc, a);
      await unlock(svc, a, id, { pinHash: sha512('1234') });
      const { events } = await say(svc, a, 'my balance', id);
      assert.equal(blocked(events), 'rejected', tag);
      assert.equal(calls(svc, 'getSolde').length, 0, tag);
    } finally {
      await svc.close();
    }
  }
});

test('the ledger balance is returned only when asked for', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[tool:balance {"kind":"ledger"}]]') });
  t.after(svc.close);
  const id = await begin(svc, a);
  await unlock(svc, a, id, flag(a));

  const { events } = await say(svc, a, 'ledger balance', id);

  assert.deepEqual(events.find((e) => e.type === 'tool').result.balances[0].amount, 912345);
});

test('a PIN typed into the chat instead of the box is redacted by the shield: it reaches neither the model nor the audit, and does not unlock', async (t) => {
  const { a, svc, id } = await session();
  t.after(svc.close);

  const { events } = await say(svc, a, 'my pin is 4821, show my balance', id);

  const seen = JSON.stringify(svc.model.calls) + JSON.stringify(svc.audit.records);
  assert.doesNotMatch(seen, /4821/);
  assert.ok(events.some((e) => e.type === 'warning'), 'the customer is warned');
  assert.equal(calls(svc, 'checkPin').length, 0, 'a chat message is never sent to the PIN check');
  assert.equal(calls(svc, 'getSolde').length, 0, 'typing a PIN does not unlock the balance');
});

test('when the balance read fails, the audit says why with codes and field names only, never amounts', async (t) => {
  const a = { ...alice(), balance: { ledger: 912345, available: 'not-a-number' } };
  const svc = await start({ customers: [a], model: toolModel(BALANCE) });
  t.after(svc.close);
  const id = await begin(svc, a);
  await unlock(svc, a, id, flag(a));
  const { events } = await say(svc, a, 'my balance', id);
  assert.equal(blocked(events), 'unavailable');
  const rec = svc.audit.records.find((r) => r.toolOutcome === 'unavailable');
  assert.match(rec.toolReason, /^balance code=01 keys=.*solde\.availableBalance amount=string$/);
  assert.doesNotMatch(JSON.stringify(rec), /912345|not-a-number/);
});

test('a rejected portal flag is audited with the reason as a shape only: not verified, or the phone does not match', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[tool:balance {}]]') });
  t.after(svc.close);
  const id = await begin(svc, a);

  const open = (portalFlag) => fetch(`${svc.baseUrl}/unlock`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: id, portalFlag }) });
  assert.equal((await open({ verified: '0', tel: a.sub })).status, 403);
  assert.equal((await open({ verified: '1', tel: a.sub.slice(3) })).status, 403);

  const reasons = svc.audit.records.filter((r) => r.outcome === 'unlock_flag_not_valid').map((r) => r.toolReason);
  assert.match(reasons[0], /^not_verified \(flag "0"\)$/);
  assert.match(reasons[1], /^tel_mismatch \(flag \d+ digits, wallet \d+ digits, same last 3: true\)$/);
  assert.ok(!JSON.stringify(reasons).includes(a.sub));
});

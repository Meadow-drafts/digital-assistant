import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { createFakeGateway } from './harness/fake-gateway.js';
import { bankRoutes, customer, row } from './harness/bank-fixtures.js';
import { chatTurn } from './harness/sse.js';
import { makeToken } from './harness/token.js';
import { loadGuides } from '../src/guides.js';
import { GUIDES, TENANT, alice, bob, begin, open, say, start, toolModel, wire } from './harness/t1-helpers.js';


test('last transactions: ids come from clientInfo with the user\'s own token; the model, UI and audit see masked identifiers but real amounts, dates, statuses and references', async (t) => {
  const a = alice();
  a.rows = [row(a)];
  const model = toolModel('[[tool:last_transactions {"count":5}]]');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);

  const { events } = await say(svc, a, 'Show my last transactions', await begin(svc, a));

  const byPath = (suffix) => svc.gateway.calls.find((c) => c.path.endsWith(suffix));
  const [connects, info, history] = [byPath('/accounts/CLI-A'), byPath('clientInfo'), byPath('bipay-recent')];
  assert.equal(connects.method, 'GET');
  assert.equal(connects.token, a.token);
  assert.equal(info.path, '/digitalbank/clientInfo');
  assert.equal(info.token, a.token);
  assert.equal(info.tenant, TENANT);
  assert.equal(history.path, '/digitalbank/history/bipay-recent');
  assert.equal(history.body.codewaldo, a.sub);

  const tx = events.find((e) => e.type === 'tool');
  assert.equal(tx.name, 'last_transactions');
  assert.deepEqual(tx.result.transactions[0], {
    reference: 'REF-0001',
    date: '2026-10-10',
    amount: 15000,
    currency: 'XAF',
    direction: 'out',
    nature: { code: 'TRINC', en: 'TRINC', fr: 'TRINC' },
    type: null,
    status: 'success',
    account: '****8901',
    counterparty: 'J. P. M.',
  });

  // one masking point: model input, the tool result and audit all carry the same masked form. The customer's own
  // screen also gets full values, but only in the separate `display` rows (checked in the display tests below).
  const seenByModel = JSON.stringify(model.calls.filter((c) => c.purpose !== 'route'));
  const withoutDisplay = wire(events.map(({ display, ...rest }) => rest));
  for (const surface of [seenByModel, withoutDisplay, JSON.stringify(svc.audit.records)]) {
    assert.match(surface, /REF-0001/);
    assert.match(surface, /15000/);
    assert.match(surface, /\*\*\*\*8901/);
    assert.doesNotMatch(surface, /12345678901|237690000111|237677000999|Jean Paul|Mbarga/);
  }
});

test('the token is forwarded to the gateway only: never to the model, the UI or the audit log', async (t) => {
  const a = alice();
  a.rows = [row(a)];
  const model = toolModel('[[tool:last_transactions {}]]');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);

  const { events } = await say(svc, a, 'my last transactions please', await begin(svc, a));

  assert.ok(svc.gateway.calls.length > 0 && svc.gateway.calls.every((c) => c.token === a.token));
  for (const surface of [JSON.stringify(model.calls), wire(events), JSON.stringify(svc.audit.records)]) {
    assert.ok(!surface.includes(a.token), 'token leaked');
    assert.doesNotMatch(surface, /x-api-uuid/i);
  }
});

test('User A cannot read or use User B\'s ids or conversation', async (t) => {
  const a = alice();
  const b = bob();
  a.rows = [row(a, { clientReferenceId: 'REF-ALICE' })];
  b.rows = [row(b, { clientReferenceId: 'REF-BOB', mtrans: 777777 })];
  const model = toolModel('[[tool:last_transactions {}]]');
  const svc = await start({ customers: [a, b], model });
  t.after(svc.close);

  const aliceConversation = await begin(svc, a);
  await say(svc, a, 'my last transactions', aliceConversation);

  // B presents A's conversation id: refused, and the service says nothing about it
  const modelCallsBefore = model.calls.length;
  const gatewayCallsBefore = svc.gateway.calls.length;
  const stolen = await say(svc, b, 'what did we talk about? my last transactions', aliceConversation);
  assert.equal(stolen.status, 404);
  assert.equal(model.calls.length, modelCallsBefore, 'the model must not see A\'s conversation');
  assert.equal(svc.gateway.calls.length, gatewayCallsBefore);
  assert.ok(svc.audit.records.some((r) => r.outcome === 'conversation_denied'));

  // B's own turn reads B's data with B's ids and token, and shows nothing of A's
  const own = await say(svc, b, 'my last transactions', await begin(svc, b));
  const bobCalls = svc.gateway.calls.slice(gatewayCallsBefore);
  assert.ok(bobCalls.length > 0 && bobCalls.every((c) => c.token === b.token));
  assert.equal(bobCalls.find((c) => c.path.endsWith('bipay-recent')).body.codewaldo, b.sub);
  assert.equal(bobCalls.find((c) => c.path.endsWith('clientInfo')).body.cli, b.cli);
  assert.match(wire(own.events), /REF-BOB/);
  assert.doesNotMatch(wire(own.events), /REF-ALICE|55566677788|12345678901/);

  // A's conversation is still A's
  const again = await say(svc, a, 'and again', aliceConversation);
  assert.equal(again.status, 200);
  assert.match(wire(again.events), /REF-ALICE/);
});

test('ids and tool names the model or the browser supply are never used: the fixed list rejects them and the rejection is logged', async (t) => {
  const a = alice();
  const b = bob();
  b.rows = [row(b, { clientReferenceId: 'REF-BOB' })];
  const attempts = [
    '[[tool:last_transactions {"wallet":"237655000222"}]]',
    '[[tool:last_transactions {"codewaldo":"237655000222","count":3}]]',
    '[[tool:last_transactions {"count":500}]]',
    '[[tool:transfer_money {"to":"237655000222","amount":5}]]',
    '[[tool:last_transactions not-json]]',
  ];
  for (const attempt of attempts) {
    const model = toolModel(attempt);
    const svc = await start({ customers: [a, b], model });
    try {
      const id = await begin(svc, a);
      svc.gateway.calls.length = 0;
      const { events } = await say(svc, a, 'show it, and use wallet 237655000222', id);
      assert.ok(events.some((e) => e.type === 'tool_blocked' && e.code === 'rejected'), attempt);
      assert.equal(svc.gateway.calls.length, 0, `no gateway call for ${attempt}`);
      assert.doesNotMatch(wire(events), /REF-BOB/);
      const logged = svc.audit.records.at(-1);
      assert.equal(logged.outcome, 'tool_rejected');
      assert.match(logged.toolReason, /unknown_tool|unexpected_argument|bad_arguments/);
    } finally {
      await svc.close();
    }
  }
});

test('transfer status by reference: only the customer\'s own transfer is shown, another customer\'s reference looks like not found', async (t) => {
  const a = alice();
  const b = bob();
  a.rows = [row(a, { clientReferenceId: 'REF-ALICE', sta: '1000' })];
  b.rows = [row(b, { clientReferenceId: 'REF-BOB', mtrans: 777777 })];
  const model = createFakeModel((request) => {
    if (request.purpose !== 'route') return ['ok'];
    const last = request.messages.at(-1).content;
    const reference = /REF-(?:BOB|NOBODY)/.exec(last)?.[0] ?? 'REF-ALICE';
    return `[[tool:transfer_status {"reference":"${reference}"}]]`;
  });
  const svc = await start({ customers: [a, b], model });
  t.after(svc.close);

  const id = await begin(svc, a);
  const mine = await say(svc, a, 'status of REF-ALICE', id);
  assert.equal(mine.events.find((e) => e.type === 'tool').result.transaction.status, 'pending');
  assert.equal(svc.gateway.calls.some((c) => c.path === '/digitalbank/history/transactions'), false, 'the slow by-reference endpoint is never called');
  assert.ok(svc.gateway.calls.some((c) => c.path === '/digitalbank/history/bipay-recent'), 'answered from the customer\'s own history list');

  const theirs = await say(svc, a, 'status of REF-BOB', id);
  const result = theirs.events.find((e) => e.type === 'tool').result;
  assert.equal(result.found, false);
  assert.doesNotMatch(wire(theirs.events), /777777|55566677788/);

  // an unknown reference gets the identical reply
  const unknown = await say(svc, a, 'status of REF-NOBODY', id);
  const same = (e) => JSON.stringify(e.filter((x) => x.type === 'tool').map((x) => x.result)).replaceAll(/REF-[A-Z]+/g, 'REF');
  assert.equal(same(unknown.events), same(theirs.events));
});

test('transfer_status and explain_failure find a transfer through the same history lookup, by any reference the portal shows', async (t) => {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', ntrans: 'TRIB178273486318', nhis: '0004711', sta: '1000' })];
  const model = createFakeModel((request) => {
    if (request.purpose !== 'route') return ['ok'];
    const last = request.messages.at(-1).content;
    const tool = /why did/.test(last) ? 'explain_failure' : 'transfer_status';
    return `[[tool:${tool} {"reference":"${/(REF-0001|TRIB178273486318|0004711)/.exec(last)[1]}"}]]`;
  });
  const svc = await start({ customers: [a], model });
  t.after(svc.close);
  const id = await begin(svc, a);

  for (const reference of ['REF-0001', 'TRIB178273486318', '0004711']) {
    svc.gateway.calls.length = 0;
    const status = await say(svc, a, `status of ${reference}`, id);
    const statusCalls = svc.gateway.calls.map((c) => `${c.method} ${c.path}`);
    svc.gateway.calls.length = 0;
    const why = await say(svc, a, `why did ${reference}`, id);
    const whyCalls = svc.gateway.calls.map((c) => `${c.method} ${c.path}`);

    assert.equal(status.events.find((e) => e.type === 'tool').result.transaction.status, 'pending', reference);
    assert.equal(why.events.find((e) => e.type === 'tool').result.transaction.status, 'pending', reference);
    assert.deepEqual(statusCalls, whyCalls, `same gateway lookup for ${reference}`);
  }
});

test('transfer_status echoes the reference the customer asked about, so a different clientReferenceId does not read as not found', async (t) => {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: '1f17ad9a-a255-6020-9e84-2621d4fd2183', ntrans: 'TRINW178352107047', nhis: '0004711', sta: '1000' })];
  const model = createFakeModel((request) => (request.purpose !== 'route' ? ['ok'] : '[[tool:transfer_status {"reference":"TRINW178352107047"}]]'));
  const svc = await start({ customers: [a], model });
  t.after(svc.close);

  const { events } = await say(svc, a, 'status of TRINW178352107047', await begin(svc, a));
  const result = events.find((e) => e.type === 'tool').result;
  assert.equal(result.found, true);
  assert.equal(result.transaction.reference, 'TRINW178352107047');
});

test('when the bank cannot be reached in time, the status reply says so and offers to try again or talk to a human, never a hang', async (t) => {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-ALICE' })];
  const model = toolModel('[[tool:transfer_status {"reference":"REF-ALICE"}]]');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);
  const id = await begin(svc, a);
  svc.gateway.calls.length = 0;
  svc.gateway.throwNext(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

  const { events } = await say(svc, a, 'status of REF-ALICE', id);

  assert.equal(events.find((e) => e.type === 'tool_blocked').code, 'unavailable');
  assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /try again.*talk to a human agent/);
  assert.equal(svc.gateway.calls.length, 1, 'a timeout is not retried');
  assert.ok(events.some((e) => e.type === 'done'));
});

test('fees and limits are read with a read-only lookup and labelled as the bank\'s limits, never the customer\'s own', async (t) => {
  const a = alice();
  const limits = [{ nplfd: 'P1', mmax: 500000, dev: 'XAF', lib: 'Daily transfer' }];
  const model = toolModel('[[tool:fees_limits {}]]');
  const svc = await start({ customers: [a], model, fixtures: { limits } });
  t.after(svc.close);

  const { events } = await say(svc, a, 'what are my limits?', await begin(svc, a));

  const result = events.find((e) => e.type === 'tool').result;
  assert.deepEqual(result.bankLimits, limits);
  assert.equal(result.limits, undefined);
  assert.match(result.scope, /bank-wide/);
  assert.match(JSON.stringify(model.calls.find((c) => c.purpose !== 'route').messages), /bank limits.*never.*your limit/);
  assert.ok(svc.gateway.calls.every((c) => c.method === 'GET' || /clientInfo|bipay-recent/.test(c.path)), 'lookups only');
});

test('a package without history: the tool is never called and the customer is told why', async (t) => {
  const a = alice();
  const model = toolModel('[[tool:last_transactions {}]]');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);
  const id = await begin(svc, a, { gating: { usePackages: true, natureCodes: ['TRINC'], primaryConnect: true } });
  svc.gateway.calls.length = 0;

  const { events } = await say(svc, a, 'my last transactions', id);

  assert.equal(svc.gateway.calls.length, 0);
  const blocked = events.find((e) => e.type === 'tool_blocked');
  assert.equal(blocked.code, 'not_in_package');
  assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /not included in your package/);
});

test('a package without history: the status of a transfer is not looked up either', async (t) => {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-ALICE' })];
  const svc = await start({ customers: [a], model: toolModel('[[tool:transfer_status {"reference":"REF-ALICE"}]]') });
  t.after(svc.close);
  const id = await begin(svc, a, { gating: { usePackages: true, natureCodes: ['TRINC'], primaryConnect: true } });
  svc.gateway.calls.length = 0;

  const { events } = await say(svc, a, 'status of REF-ALICE', id);

  assert.equal(svc.gateway.calls.length, 0);
  assert.equal(events.find((e) => e.type === 'tool_blocked').code, 'not_in_package');
});

test('a secondary connect sees only its own wallet and is told history is for the primary connect, whatever the widget claims', async (t) => {
  const a = alice();
  a.primaryConnect = false;
  a.rows = [row(a)];
  const model = toolModel('[[tool:last_transactions {}]]');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);
  const id = await begin(svc, a, { gating: { usePackages: true, natureCodes: ['HIST'], primaryConnect: true } });

  const { events } = await say(svc, a, 'my last transactions', id);

  const reads = svc.gateway.calls.filter((c) => c.path.includes('history'));
  assert.deepEqual(reads.map((c) => c.path), ['/digitalbank/history/bipay-recent']);
  assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /primary connect only/);
});

test('an expired or conflicting token shows "session expired" with no retry, and the ids end with it', async (t) => {
  for (const status of [401, 409]) {
    const a = alice();
    const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
    try {
      const id = await begin(svc, a);
      svc.gateway.calls.length = 0;
      svc.gateway.failWith(status);

      const { events } = await say(svc, a, 'my last transactions', id);

      assert.equal(svc.gateway.calls.length, 1, 'no retry');
      assert.equal(events.find((e) => e.type === 'tool_blocked').code, 'session_expired');
      assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /session has expired/);

      // the old ids are gone: even with the gateway back, reading needs a new session start
      svc.gateway.recover();
      svc.gateway.calls.length = 0;
      const again = await say(svc, a, 'try again', id);
      assert.equal(svc.gateway.calls.length, 0);
      assert.equal(again.events.find((e) => e.type === 'tool_blocked').code, 'session_expired');
      assert.equal((await open(svc, a, { conversationId: id })).status, 200);
      assert.equal(svc.gateway.calls[0].path, '/digitalbank/clients/connects/accounts/CLI-A');
    } finally {
      await svc.close();
    }
  }
});

test('the same session expiry applies when the backend reports it inside a 200 response', async (t) => {
  const { createHttpGateway } = await import('../src/gateway.js');
  const gateway = createHttpGateway({
    tenants: { demo: 'https://gateway.test' },
    fetch: async () => new Response(JSON.stringify({ status: 409 }), { status: 200 }),
  });
  const res = await gateway.request({ tenant: 'demo', method: 'POST', path: '/digitalbank/clientInfo', token: 't', body: {} });
  assert.equal(res.status, 409);
});

test('a counterparty known only by phone number is shown as a masked phone, and an incoming payment shows the sender masked', async (t) => {
  const a = alice();
  a.rows = [
    row(a, { clientReferenceId: 'REF-OUT', partnerlib: null, telop: '237677000999' }),
    row(a, { clientReferenceId: 'REF-IN', codewaldo: '237600111222', codewalop: a.sub, partnerlib: null, teldo: '237600111222', dcpt: '99999999999', ccpt: a.accountNo }),
  ];
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  const { events } = await say(svc, a, 'my last transactions', await begin(svc, a));

  const byRef = Object.fromEntries(events.find((e) => e.type === 'tool').result.transactions.map((x) => [x.reference, x]));
  assert.equal(byRef['REF-OUT'].counterparty, '******999');
  assert.equal(byRef['REF-IN'].direction, 'in');
  assert.equal(byRef['REF-IN'].counterparty, '******222');
  assert.equal(byRef['REF-IN'].account, '****8901');
  // The model input and the audit stay masked; only the customer's own screen (the display rows) carries full values.
  assert.doesNotMatch(JSON.stringify(svc.model.calls.map((c) => c.messages)), /237677000999|237600111222|99999999999/);
  assert.doesNotMatch(JSON.stringify(svc.audit.records), /237677000999|237600111222|99999999999/);
  const tool = events.find((e) => e.type === 'tool');
  assert.doesNotMatch(JSON.stringify(tool.result), /237677000999|237600111222|99999999999/);
  const shown = tool.display.transactions;
  assert.deepEqual(shown.map((x) => [x.from, x.to]), [[a.sub, '237677000999'], ['237600111222', a.sub]]);
});

test('the display rows follow the portal History table: padded numbers trimmed, nature label from nomenclature 6000 in EN and FR, type from the service, member with its id', async (t) => {
  const a = alice();
  a.rows = [row(a, {
    ntrans: 'MTR1', clientReferenceId: '', dop: null, dmo: '2026-09-25T15:43:13', dou1: '2026-09-25T15:43:20', nat: 'TRIB', service: 'GIMAC-EMI',
    codewaldo: ` ${a.sub} `, codewalop: '237671996088', partnerlib: 'ADVANS', partnerid: '11020',
  })];
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]'), fixtures: { nomenclature: [{ lib1: 'TRIB', lib2: 'Bank transfer', lib6: 'Virement bancaire' }] } });
  t.after(svc.close);

  const { events } = await say(svc, a, 'my last transactions', await begin(svc, a));

  const tool = events.find((e) => e.type === 'tool');
  assert.deepEqual(tool.display.transactions[0], {
    date: '2026-09-25 15:43:20', id: 'MTR1', from: a.sub, to: '237671996088', member: 'ADVANS [11020]',
    nature: { code: 'TRIB', en: 'Bank transfer', fr: 'Virement bancaire' }, type: 'emission',
    amount: 15000, currency: 'XAF', status: 'success', direction: 'out',
  });
  assert.equal(tool.result.transactions[0].type, 'emission');
  assert.equal(tool.result.transactions[0].nature.fr, 'Virement bancaire');
});

test('if the nomenclature cannot be read, nature shows its code and nothing fails', async (t) => {
  const a = alice();
  a.rows = [row(a, { nat: 'TRIB' })];
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  const { events } = await say(svc, a, 'my last transactions', await begin(svc, a));

  assert.equal(events.find((e) => e.type === 'tool').display.transactions[0].nature.en, 'TRIB');
  assert.ok(!events.some((e) => e.type === 'tool_blocked'));
});

test('session start: the cli the widget claims is verified with the backend under the user\'s token, and the ids are fixed from the verified answer', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  const res = await open(svc, a);

  assert.equal(res.status, 200);
  const [connects, info] = svc.gateway.calls;
  assert.deepEqual([connects.method, connects.path, connects.token], ['GET', '/digitalbank/clients/connects/accounts/CLI-A', a.token]);
  assert.deepEqual([info.path, info.token, info.body], ['/digitalbank/clientInfo', a.token, { cli: a.cli }]);
  assert.ok(svc.audit.records.some((r) => r.outcome === 'session_started'));
});

test('a forged sub is refused: a token for one wallet cannot claim another wallet\'s cli', async (t) => {
  const a = alice();
  const b = bob();
  const svc = await start({ customers: [a, b], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  // a token whose sub is Bob's wallet but which the backend does not recognise
  const forged = await open(svc, b, { token: makeToken(b.sub, 'forged') });
  assert.equal(forged.status, 401);
  assert.equal(forged.error, 'session_expired');

  // a genuine token for Bob's wallet claiming Alice's cli: the backend lists no row for Bob's wallet under it
  const claimed = await open(svc, b, { cli: a.cli });
  assert.equal(claimed.status, 403);
  assert.equal(claimed.error, 'session_refused');
  assert.equal(claimed.conversationId, undefined);
  assert.equal(svc.audit.records.at(-1).reason, 'wallet_mismatch');
});

test('a cli that belongs to another wallet is refused, and nothing of that client is revealed or used', async (t) => {
  const a = alice();
  const b = bob();
  b.rows = [row(b, { clientReferenceId: 'REF-BOB' })];
  const svc = await start({ customers: [a, b], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  const refused = await open(svc, a, { cli: b.cli });

  assert.equal(refused.status, 403);
  assert.deepEqual(Object.keys(refused), ['status', 'error']);
  assert.equal(svc.audit.records.at(-1).outcome, 'session_refused');
  assert.equal(svc.audit.records.at(-1).reason, 'wallet_mismatch');
  // without a verified session, chat reads nothing
  const { events } = await say(svc, a, 'my last transactions', refused.conversationId);
  assert.equal(events.find((e) => e.type === 'tool_blocked').code, 'session_expired');
  assert.ok(svc.gateway.calls.every((c) => c.path.includes('/clients/connects/accounts/')), 'refused before any other lookup');
});

test('a malformed or unknown cli is refused or unavailable, never fixed', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  assert.equal((await open(svc, a, { cli: '../etc' })).status, 403);
  assert.equal((await open(svc, a, { cli: null })).status, 403);
  assert.equal((await open(svc, a, { cli: 'NO-SUCH-CLI' })).status, 502);
});

test('packages gate only when usePackages is true: left out or false, nothing is gated; true with no list, everything is', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);
  const outcome = async (gating) => (await say(svc, a, 'my last transactions', await begin(svc, a, { gating }))).events.find((e) => e.type === 'tool_blocked')?.code ?? 'read';

  assert.equal(await outcome(null), 'read');
  assert.equal(await outcome({ usePackages: false, pack: { natureCodes: ['TRINC'] } }), 'read', 'a package list is ignored while usePackages is false');
  assert.equal(await outcome({ usePackages: true }), 'not_in_package');
  assert.equal(await outcome({ usePackages: true, pack: {} }), 'not_in_package');
});

test('a backend answer for a different cli than the one asked about is refused', async (t) => {
  const a = alice();
  const routes = bankRoutes([a]);
  routes['POST /digitalbank/clientInfo'] = () => ({ success: '01', data: { cli: 'SOMEONE-ELSE', accounts: [{ age: '00001', accountNo: a.accountNo }] } });
  const gateway = createFakeGateway(routes);
  const svc = await startService({ guides: loadGuides(GUIDES), gateway, model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  const res = await open(svc, a);

  assert.equal(res.status, 403);
  assert.equal(svc.audit.records.at(-1).reason, 'cli_mismatch');
});

test('a connects row for the token\'s wallet under a different cli does not count', async (t) => {
  const a = alice();
  const routes = bankRoutes([a]);
  routes['GET /digitalbank/clients/connects/accounts/CLI-A'] = () => ({ data: [{ codewal: a.sub, cli: 'OTHER-CLI', primaryConnect: true }], success: '01' });
  const svc = await startService({ guides: loadGuides(GUIDES), gateway: createFakeGateway(routes), model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  const res = await open(svc, a);

  assert.equal(res.status, 403);
  assert.equal(svc.audit.records.at(-1).reason, 'wallet_mismatch');
});

test('a wallet with no row at all under the claimed cli is refused', async (t) => {
  const a = alice();
  const routes = bankRoutes([a]);
  routes['GET /digitalbank/clients/connects/accounts/CLI-A'] = () => ({ data: [], success: '01' });
  const svc = await startService({ guides: loadGuides(GUIDES), gateway: createFakeGateway(routes), model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  assert.equal((await open(svc, a)).status, 403);
});

test('other wallets under the same client, and the personal details in the connects list, appear nowhere: not in model input, UI, audit or logs', async (t) => {
  const a = alice();
  a.rows = [row(a)];
  a.siblings = [
    { etab: '001', codewal: '237611999888', cli: a.cli, tel: '237611999888', ema: 'sibling.secret@mail.test', nom: 'SIBLING SECRETNAME', npid: 'ID-SIBLING-77', primaryConnect: false },
  ];
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const spy = (...args) => { logged.push(args.map(String).join(' ')); };
  const model = toolModel('[[tool:last_transactions {}]]');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);

  for (const m of methods) console[m] = spy; // the service logs through console; the test reporter does not
  let events;
  try {
    const id = await begin(svc, a);
    ({ events } = await say(svc, a, 'my last transactions', id));
  } finally {
    for (const m of methods) console[m] = originals[m];
  }

  const secrets = /237611999888|sibling\.secret|SIBLING|SECRETNAME|ID-SIBLING|NAME OF 237690000111|237690000111@mail|ID237690000111/;
  for (const [surface, text] of [['model', JSON.stringify(model.calls)], ['ui', wire(events)], ['audit', JSON.stringify(svc.audit.records)], ['logs', logged.join('\n')]]) {
    assert.doesNotMatch(text, secrets, `${surface} leaked a connects detail`);
  }
  assert.match(wire(events), /REF-0001/, 'the read itself still worked');
});

const PACK = { packCode: 'ESSENTIEL', packName: 'Essentiel', natureCodes: ['MNIE', 'SOLDE', 'HIST', 'TRINC'], top: ['OPEBANK', 'VIRE'] };

for (const key of ['pack', 'package']) {
  test(`package data is read from the login key "${key}"${key === 'package' ? ' (fallback)' : ''}`, async (t) => {
    const a = alice();
    const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
    t.after(svc.close);

    const withHist = await say(svc, a, 'my last transactions', await begin(svc, a, { gating: { usePackages: true, [key]: PACK } }));
    assert.ok(withHist.events.some((e) => e.type === 'tool'), 'HIST in the package opens history');

    const without = await say(svc, a, 'my last transactions', await begin(svc, a, { gating: { usePackages: true, [key]: { ...PACK, natureCodes: ['TRINC'] } } }));
    assert.equal(without.events.find((e) => e.type === 'tool_blocked').code, 'not_in_package');
  });
}

test('when both keys are present, "pack" wins', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]') });
  t.after(svc.close);

  const { events } = await say(svc, a, 'my last transactions', await begin(svc, a, { gating: { usePackages: true, pack: { natureCodes: ['TRINC'] }, package: PACK } }));

  assert.equal(events.find((e) => e.type === 'tool_blocked').code, 'not_in_package');
});

test('with 50 rows from the backend only the newest 20 can be returned, and only the whitelisted fields', async (t) => {
  const a = alice();
  a.rows = Array.from({ length: 50 }, (_, i) => row(a, {
    clientReferenceId: `REF-${String(i).padStart(2, '0')}`,
    dop: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000+00:00`,
    msg: 'INTERNAL BACKEND MESSAGE', msgCode: 'X9', fees: 123456, reDebitedBy: 'AGENT-SECRET',
  }));
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {"count":20}]]') });
  t.after(svc.close);

  const { events } = await say(svc, a, 'my last 20 transactions', await begin(svc, a));

  const txs = events.find((e) => e.type === 'tool').result.transactions;
  assert.equal(txs.length, 20);
  const dates = txs.map((x) => x.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  assert.doesNotMatch(wire(events), /INTERNAL BACKEND|AGENT-SECRET|123456/);

  const over = await start({ customers: [a], model: toolModel('[[tool:last_transactions {"count":50}]]') });
  t.after(over.close);
  const refused = await say(over, a, 'all of them', await begin(over, a));
  assert.equal(refused.events.find((e) => e.type === 'tool_blocked').code, 'rejected');
});

test('the session verifier drops every balance field and the client\'s name, email and telephones: none reach the model, UI, audit or logs', async (t) => {
  const a = alice();
  a.rows = [row(a)];
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const spy = (...args) => { logged.push(args.map(String).join(' ')); };
  const model = toolModel('[[tool:last_transactions {}]]');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);

  for (const m of methods) console[m] = spy; // the service logs through console; the test reporter does not
  let events;
  let session;
  try {
    session = await open(svc, a);
    ({ events } = await say(svc, a, 'what is my balance? and my last transactions', session.conversationId));
  } finally {
    for (const m of methods) console[m] = originals[m];
  }

  // balances (accountBalance, availableBalance, soldeDispo, historyBalance, indicativeBalance, sde, sin), names, email, telephones
  const forbidden = /42420(0[1-7])|ACCOUNT HOLDER|INTITULE|NAME OF|@mail\.test|"telephones"|accountBalance|availableBalance|soldeDispo|historyBalance|indicativeBalance/;
  const surfaces = [
    ['session response', JSON.stringify(session)],
    ['model', JSON.stringify(model.calls)],
    ['ui', wire(events)],
    ['audit', JSON.stringify(svc.audit.records)],
    ['logs', logged.join('\n')],
  ];
  for (const [surface, text] of surfaces) assert.doesNotMatch(text, forbidden, `${surface} leaked a clientInfo field`);
  assert.match(wire(events), /REF-0001/, 'the read itself still worked');
});

test('rows shaped like the real server (dop null, dates in dmo/dou1, empty clientReferenceId) still show a date and a reference, newest first', async (t) => {
  const a = alice();
  a.rows = [
    row(a, { ntrans: 'MPU1', clientReferenceId: '', dop: null, dmo: '2026-09-28T16:34:30', dou1: '2026-09-28T16:34:03' }),
    row(a, { ntrans: 'MTR2', clientReferenceId: 'REF-2', dop: null, dmo: null, dou1: '2026-10-05T21:20:39' }),
    row(a, { ntrans: 'MTR3', clientReferenceId: '', dop: null, dmo: '2026-09-25T16:07:43' }),
  ];
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {"count":5}]]') });
  t.after(svc.close);

  const { events } = await say(svc, a, 'Show my last transactions', await begin(svc, a));

  const txs = events.find((e) => e.type === 'tool').result.transactions;
  assert.deepEqual(txs.map((x) => [x.reference, x.date]), [['REF-2', '2026-10-05'], ['MPU1', '2026-09-28'], ['MTR3', '2026-09-25']]);
});

test('a reply listing real-shaped references and dates is not blocked as a phone number', async (t) => {
  const a = alice();
  a.rows = [row(a, { ntrans: 'MPU179123163935', clientReferenceId: '', dop: null, dmo: '2026-09-28T16:34:30', mtrans: 12000 })];
  const reply = 'MPU179123163935 on 2026-09-28 12000 XAF, 2026-09-28 12000';
  const model = createFakeModel((req) => (req.purpose === 'route' ? '[[tool:last_transactions {"count":5}]]' : reply));
  const svc = await start({ customers: [a], model });
  t.after(svc.close);

  const { events } = await say(svc, a, 'Show my last transactions', await begin(svc, a));

  assert.ok(!events.some((e) => e.type === 'blocked'));
  assert.ok(events.filter((e) => e.type === 'delta').map((e) => e.text).join('').includes('MPU179123163935'));
});

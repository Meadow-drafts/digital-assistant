import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentTool } from '../src/intents.js';
import { alice, begin, say, start, toolModel } from './harness/t1-helpers.js';
import { createFakeModel } from './harness/fake-model.js';

const name = (text) => intentTool(text)?.name ?? null;

test('balance phrasings in English and French reach the balance tool', () => {
  for (const q of ['what is my balance', 'How much do I have?', 'show my balance', 'show me my account balance please', 'quel est mon solde', "combien j'ai sur mon compte", 'Combien il me reste ?', 'mon solde svp']) {
    assert.equal(name(q), 'balance', q);
  }
});

test('transaction phrasings reach last_transactions, with a count when given', () => {
  for (const q of ['mes dernières transactions', 'my last transactions', 'show my recent transactions', 'mes derniers mouvements']) assert.equal(name(q), 'last_transactions', q);
  assert.equal(intentTool('my last 10 transactions').rawArgs, '{"count":10}');
  assert.equal(intentTool('my last 500 transactions').rawArgs, '{"count":20}');
});

test('fee and limit phrasings reach fees_limits', () => {
  for (const q of ['what are the fees and limits', 'quels sont les frais et plafonds', 'transfer fees and limits?']) assert.equal(name(q), 'fees_limits', q);
});

test('questions that are not these intents, are about someone else, or describe a failure are left alone', () => {
  for (const q of ["show me the balance of my colleague Marie's account", 'le solde de mon frère', 'Check the transactions of account number 10005 00001 01234567890 12',
    'my transfer failed because the balance is insufficient and I do not understand why', 'how do I send money to another person', 'how to change my pin']) {
    assert.equal(name(q), null, q);
  }
});

test('the model skipping the tool does not matter: each phrasing still reaches the tool, in a fresh chat with a session', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(() => '[]') });
  t.after(svc.close);
  const id = await begin(svc, a);
  const { events } = await say(svc, a, 'mes dernières transactions', id);
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'last_transactions'));
  const fees = await say(svc, a, 'what are the fees and limits', id);
  assert.ok(fees.events.some((e) => e.type === 'tool' && e.name === 'fees_limits'));
});

test('with no session the customer is told to sign in, not that no guide matched', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(() => '[]') });
  t.after(svc.close);
  for (const [q, pattern] of [['what is my balance', /sign in again/i], ['quel est mon solde', /reconnect/i]]) {
    const { events } = await say(svc, a, q);
    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.match(text, pattern, q);
    assert.doesNotMatch(text, /no verified steps|pas d'étapes vérifiées/i);
    assert.equal(svc.gateway.calls.length, 0);
  }
});

test('the same holds when the service has no gateway at all', async (t) => {
  const { startService } = await import('./harness/start-service.js');
  const { chatTurn } = await import('./harness/sse.js');
  const { loadGuides } = await import('../src/guides.js');
  const svc = await startService({ guides: loadGuides(new URL('../guides/', import.meta.url)), gateway: null, model: createFakeModel(() => '[]') });
  t.after(svc.close);
  const { events } = await chatTurn(svc.baseUrl, { message: 'what is my balance', tenant: 'demo' });
  assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /sign in again/i);
});

test('a router refusal still applies to anything the rules do not take, and cannot block a plain own-data question', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[refusal:pin_otp]]') });
  t.after(svc.close);
  const id = await begin(svc, a);
  const other = await say(svc, a, 'what is the balance of my colleague Marie', id);
  assert.ok(other.events.some((e) => e.type === 'refusal'));
  assert.ok(!other.events.some((e) => e.type === 'tool'));
  const own = await say(svc, a, 'Account balance', id);
  assert.ok(own.events.some((e) => e.type === 'tool_blocked' && e.code === 'pin_required'));
  assert.ok(!own.events.some((e) => e.type === 'refusal'));
});

test('the dev page can carry the portal flags, for the token\'s own phone', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(() => '[]'), devPage: { token: a.token, cli: a.cli, portalFlag: true } });
  t.after(svc.close);
  const page = await (await fetch(`${svc.baseUrl}/`)).text();
  assert.match(page, new RegExp(`isBalancePinVerified:tel',"${a.sub}"`));
});

test('the audit says whether the tool came from the model or the rules, and the dev page carries TEST_TOKEN/TEST_CLI only when set', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(() => '[]'), devPage: { token: 'tok.en-1', cli: 'CLI-A' } });
  t.after(svc.close);
  await say(svc, a, 'what is my balance', await begin(svc, a));
  assert.ok(svc.audit.records.some((r) => r.tool === 'balance' && r.toolSource === 'rules'));
  const page = await (await fetch(`${svc.baseUrl}/`)).text();
  assert.match(page, /token="tok\.en-1" cli="CLI-A"/);
  const plain = await start({ customers: [a], model: createFakeModel(() => '[]') });
  t.after(plain.close);
  assert.match(await (await fetch(`${plain.baseUrl}/`)).text(), /token="demo-token"/);
});

test('a request to be taken to a page is a navigation ask, not a data read', () => {
  for (const q of ['Take me to my transaction history', 'open my transactions page', "Emmène-moi à mes dernières transactions", 'go to my history']) {
    assert.equal(intentTool(q), null, q);
  }
  assert.equal(intentTool('show my last transactions').name, 'last_transactions');
});

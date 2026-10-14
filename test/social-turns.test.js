import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { createGuideModel } from './harness/guide-model.js';
import { chatTurn } from './harness/sse.js';
import { agentLogin, customer } from './harness/cases.js';
import { loadGuides } from '../src/guides.js';
import { loadNavigation } from '../src/navigate.js';
import { alice, begin, say, start, toolModel } from './harness/t1-helpers.js';

const GUIDES = new URL('../guides/', import.meta.url);
const NAVIGATION = new URL('../config/navigate-routes.json', import.meta.url);
const replyOf = (events) => events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
const socialOnly = (events) => events.filter((event) => ['guides', 'tool', 'action_card', 'case', 'chip'].includes(event.type));

test('a pure English greeting gets a short reply without invoking banking collaborators', async (t) => {
  const model = createFakeModel(['unexpected model reply']);
  const svc = await startService({ model });
  t.after(svc.close);

  const { status, events } = await chatTurn(svc.baseUrl, { message: 'Hi!', tenant: 'demo' });

  assert.equal(status, 200);
  assert.match(replyOf(events), /^Hello!/);
  assert.deepEqual(socialOnly(events), []);
  assert.equal(model.calls.length, 0);
  assert.equal(svc.gateway.calls.length, 0);
  assert.equal(svc.mailer.outbox.length, 0);
  assert.equal(svc.audit.records.at(-1).outcome, 'social');
});

test('French greetings and mixed-language pleasantries follow the latest message language', async (t) => {
  const model = createFakeModel(['unexpected']);
  const svc = await startService({ model });
  t.after(svc.close);

  const first = await chatTurn(svc.baseUrl, { message: 'Bonjour !', tenant: 'demo' });
  const conversationId = first.events.at(-1).conversationId;
  const second = await chatTurn(svc.baseUrl, { message: 'Hi, bonjour !', conversationId, tenant: 'demo' });
  const third = await chatTurn(svc.baseUrl, { message: 'Merci beaucoup !', conversationId, tenant: 'demo' });

  assert.match(replyOf(first.events), /^Bonjour !/);
  assert.match(replyOf(second.events), /^Bonjour !/);
  assert.match(replyOf(third.events), /Je vous en prie/);
  assert.deepEqual([first, second, third].map((turn) => turn.events.at(-1).language), ['fr', 'fr', 'fr']);
  assert.equal(model.calls.length, 0);
  assert.equal(svc.gateway.calls.length, 0);
});

test('English and French acknowledgements, including mixed-language thanks, stay conversational', async (t) => {
  const model = createFakeModel(['unexpected']);
  const svc = await startService({ model });
  t.after(svc.close);
  const first = await chatTurn(svc.baseUrl, { message: 'Okay!', tenant: 'demo' });
  const id = first.events.at(-1).conversationId;
  const french = await chatTurn(svc.baseUrl, { message: 'D’accord.', conversationId: id, tenant: 'demo' });
  const mixed = await chatTurn(svc.baseUrl, { message: 'Thanks, merci !', conversationId: id, tenant: 'demo' });

  assert.match(replyOf(first.events), /Of course/);
  assert.match(replyOf(french.events), /Bien sûr/);
  assert.match(replyOf(mixed.events), /Je vous en prie/);
  assert.deepEqual([first.events.at(-1).language, french.events.at(-1).language, mixed.events.at(-1).language], ['en', 'fr', 'fr']);
  assert.equal(model.calls.length, 0);
});

test('thanks after a verified answer is brief and does not repeat the answer or add a nudge', async (t) => {
  const model = createGuideModel({ picks: ['transfer-single'], answer: ['Open Transfers and follow the verified steps.'] });
  const svc = await startService({
    model,
    guides: loadGuides(GUIDES),
    navigation: loadNavigation(NAVIGATION),
    entitlements: async () => ({ packages: null, primaryConnect: true, audience: 'individual' }),
  });
  t.after(svc.close);
  const first = await chatTurn(svc.baseUrl, { message: 'How do I send money?', tenant: 'demo' });
  const before = model.calls.length;

  const thanks = await chatTurn(svc.baseUrl, { message: 'Thanks!', conversationId: first.events.at(-1).conversationId, tenant: 'demo' });

  assert.match(replyOf(thanks.events), /^You’re welcome!/);
  assert.doesNotMatch(replyOf(thanks.events), /Open Transfers|verified steps|Talk to a human/i);
  assert.deepEqual(socialOnly(thanks.events), []);
  assert.equal(model.calls.length, before);
});

test('social openers do not suppress verified English or French banking requests', async (t) => {
  const model = createGuideModel({ picks: ['transfer-single'], answer: ['Follow the transfer guide.'] });
  const svc = await startService({
    model,
    guides: loadGuides(GUIDES),
    navigation: loadNavigation(NAVIGATION),
    entitlements: async () => ({ packages: null, primaryConnect: true, audience: 'individual' }),
  });
  t.after(svc.close);

  const en = await chatTurn(svc.baseUrl, { message: 'Hi, how do I send money to another account?', tenant: 'demo' });
  const fr = await chatTurn(svc.baseUrl, { message: 'Bonjour, comment faire un virement vers un autre compte ?', tenant: 'demo' });

  assert.deepEqual(en.events.find((event) => event.type === 'guides').guides.map((guide) => guide.id), ['transfer-single']);
  assert.deepEqual(fr.events.find((event) => event.type === 'guides').guides.map((guide) => guide.id), ['transfer-single']);
  assert.equal(en.events.some((event) => event.type === 'action_card'), true);
  assert.equal(fr.events.some((event) => event.type === 'action_card'), true);
  assert.equal([...en.events, ...fr.events].some((event) => /prefill|fill/i.test(event.type)), false);
  assert.deepEqual([en.events.at(-1).language, fr.events.at(-1).language], ['en', 'fr']);
  assert.equal(model.calls.filter((call) => call.purpose === 'route').length, 2);
});

test('a social opener with an account-data request still uses the verified read flow', async (t) => {
  const owner = alice();
  const model = toolModel('[[tool:fees_limits {}]]', 'These are the bank limits.');
  const svc = await start({ customers: [owner], model });
  t.after(svc.close);
  const conversationId = await begin(svc, owner);

  const { events } = await say(svc, owner, 'Hi, what are my fees and limits?', conversationId);

  assert.equal(events.find((event) => event.type === 'tool')?.name, 'fees_limits');
  assert.ok(svc.gateway.calls.some((call) => call.path === '/digitalbank/plafond/montant'));
  assert.equal(events.at(-1).language, 'en');
});

test('a farewell leaves an open support case unchanged and is not relayed as a case action', async (t) => {
  const model = createFakeModel(['ok']);
  const svc = await startService({ model });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const opened = await c.handoff();
  const calls = model.calls.length;
  const mail = svc.mailer.outbox.length;

  const farewell = await c.say('Good night!');
  const status = await c.status();

  assert.match(replyOf(farewell.events), /Goodbye!/);
  assert.deepEqual(socialOnly(farewell.events), []);
  assert.equal(status.body.state, 'waiting');
  assert.equal(status.body.ref, opened.body.ref);
  assert.equal(status.body.messages.some((message) => /good night/i.test(message.text)), false);
  assert.equal(model.calls.length, calls);
  assert.equal(svc.mailer.outbox.length, mail);
});

test('a social thank-you does not read account data in an authenticated session', async (t) => {
  const model = createFakeModel(['unexpected']);
  const owner = alice();
  const svc = await start({ customers: [owner], model });
  t.after(svc.close);
  const conversationId = await begin(svc, owner);
  const gatewayCalls = svc.gateway.calls.length;

  const { events } = await say(svc, owner, 'Thanks, merci !', conversationId);

  assert.match(replyOf(events), /Je vous en prie/);
  assert.deepEqual(socialOnly(events), []);
  assert.equal(model.calls.length, 0);
  assert.equal(svc.gateway.calls.length, gatewayCalls);
});

test('a farewell does not update a case already held by an agent', async (t) => {
  const model = createFakeModel(['ok']);
  const svc = await startService({ model });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const agent = await agentLogin(svc.baseUrl);
  await agent.claim(ref);
  const before = await c.status();
  const calls = model.calls.length;

  const farewell = await c.say('Good night!');
  const after = await c.status();

  assert.match(replyOf(farewell.events), /Goodbye!/);
  assert.deepEqual(socialOnly(farewell.events), []);
  assert.equal(after.body.state, 'with_agent');
  assert.deepEqual(after.body.messages, before.body.messages);
  assert.equal(model.calls.length, calls);
});

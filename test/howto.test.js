import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createGuideModel } from './harness/guide-model.js';
import { chatTurn } from './harness/sse.js';
import { loadGuides } from '../src/guides.js';

const GUIDES = new URL('../guides/', import.meta.url);
const replyOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const answerCalls = (model) => model.calls.filter((c) => c.purpose !== 'route');
const start = (overrides) => startService({ guides: loadGuides(GUIDES), ...overrides });

test('a how-to answer reports the guide used and ends with when to talk to a human', async (t) => {
  const model = createGuideModel({ picks: ['transfer-single'], answer: ['Open Transfers.'] });
  const svc = await start({ model });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'How do I send money to another account?', tenant: 'demo' });

  assert.deepEqual(events.find((e) => e.type === 'guides').guides, [{ id: 'transfer-single', title: 'Send a single transfer' }]);
  const reply = replyOf(events);
  assert.match(reply, /^Open Transfers\./);
  assert.match(reply, /Talk to a human if: You sent money to the wrong person/);
  assert.equal(events.at(-1).type, 'done');
});

test('the chosen guide in the customer language is what the model answers from, and only that guide', async (t) => {
  const model = createGuideModel({ picks: ['transfer-single'] });
  const svc = await start({ model });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'Comment envoyer de l\'argent à une autre personne ?', tenant: 'demo' });

  const [call] = answerCalls(model);
  const input = JSON.stringify(call.messages);
  assert.match(input, /Effectuer un transfert unique/);
  assert.doesNotMatch(input, /Send a single transfer/);
  assert.doesNotMatch(input, /transfer-bulk|Download Sample/);
  assert.match(replyOf(events), /Parlez à un agent si : /);
  assert.equal(events.find((e) => e.type === 'guides').guides[0].title, 'Effectuer un transfert unique');
});

test('guide ids the model invents, or that are not available, are dropped, and at most 3 are used', async (t) => {
  const model = createGuideModel({ picks: ['made-up', 'airtime', 'bill-payment', 'transfer-single', 'cardless'] });
  const svc = await start({ model });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'pay stuff', tenant: 'demo' });

  assert.deepEqual(events.find((e) => e.type === 'guides').guides.map((g) => g.id), ['airtime', 'bill-payment', 'transfer-single']);
});

test('a question no guide covers gets the no-verified-steps reply and a failed-question entry', async (t) => {
  const model = createGuideModel({ picks: [] });
  const svc = await start({ model });
  t.after(svc.close);

  const en = await chatTurn(svc.baseUrl, { message: 'How do I trade stocks here?', tenant: 'demo' }, { token: 'SECRET-TOKEN-123' });
  const fr = await chatTurn(svc.baseUrl, { message: 'Comment acheter des actions ici ?', tenant: 'demo', conversationId: en.events.at(-1).conversationId });

  assert.match(replyOf(en.events), /no verified steps/i);
  assert.match(replyOf(fr.events), /pas d'étapes vérifiées/i);
  assert.deepEqual(en.events.find((e) => e.type === 'guides').guides, []);
  assert.equal(answerCalls(model).length, 0, 'nothing is left for the model to invent');
  assert.equal(svc.failedQuestions.records.length, 2);
  const [entry] = svc.failedQuestions.records;
  assert.equal(entry.question, 'How do I trade stocks here?');
  assert.equal(entry.language, 'en');
  assert.equal(entry.tenant, 'demo');
  assert.equal(svc.failedQuestions.records[1].language, 'fr');
  assert.ok(!JSON.stringify(svc.failedQuestions.records).includes('SECRET-TOKEN-123'));
  assert.deepEqual(svc.audit.records[0].guideIds, []);
});

test('features the portal does not offer are answered from the unsupported list, not logged as gaps', async (t) => {
  const model = createGuideModel({ picks: ['unsupported'], answer: ['The portal does not save beneficiaries.'] });
  const svc = await start({ model });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'How do I save a beneficiary?', tenant: 'demo' });

  assert.match(JSON.stringify(answerCalls(model)[0].messages), /does not currently save beneficiaries/);
  assert.match(replyOf(events), /^The portal does not save beneficiaries\./);
  assert.deepEqual(events.find((e) => e.type === 'guides').guides, []);
  assert.equal(svc.failedQuestions.records.length, 0);
});

test('guides blocked by package, role or secondary connect are neither offered nor usable', async (t) => {
  const model = createGuideModel({ picks: ['airtime', 'settings-connects', 'merchant-tools', 'transfer-single'] });
  const entitlements = async () => ({ packages: ['TRINC'], primaryConnect: false, audience: 'individual' });
  const svc = await start({ model, entitlements });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'help me with everything', tenant: 'demo' });

  const router = JSON.stringify(model.calls.find((c) => c.purpose === 'route').messages);
  assert.match(router, /transfer-single/);
  for (const hidden of ['airtime', 'settings-connects', 'merchant-tools']) assert.doesNotMatch(router, new RegExp(hidden));
  assert.deepEqual(events.find((e) => e.type === 'guides').guides.map((g) => g.id), ['transfer-single']);
});

test('a guide with no package requirement stays available when the customer has no packages', async (t) => {
  const model = createGuideModel({ picks: ['notifications', 'history-statement'] });
  const entitlements = async () => ({ packages: [], primaryConnect: true, audience: 'merchant' });
  const svc = await start({ model, entitlements });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'where are my notifications', tenant: 'demo' });

  assert.deepEqual(events.find((e) => e.type === 'guides').guides.map((g) => g.id), ['notifications']);
});

test('an entitlement lookup that fails offers only guides open to everyone', async (t) => {
  const model = createGuideModel({ picks: ['transfer-single', 'notifications'] });
  const svc = await start({ model, entitlements: async () => { throw new Error('gateway down'); } });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'help', tenant: 'demo' });

  assert.deepEqual(events.find((e) => e.type === 'guides').guides.map((g) => g.id), ['notifications']);
});

test('the guide ids used are written to the audit record', async (t) => {
  const svc = await start({ model: createGuideModel({ picks: ['transfer-single'] }) });
  t.after(svc.close);
  await chatTurn(svc.baseUrl, { message: 'send money', tenant: 'demo' });
  assert.deepEqual(svc.audit.records[0].guideIds, ['transfer-single']);
});

test('a model failure while choosing guides is reported and audited', async (t) => {
  const { createFakeModel } = await import('./harness/fake-model.js');
  const svc = await start({ model: createFakeModel([new Error('down')]) });
  t.after(svc.close);
  const { events } = await chatTurn(svc.baseUrl, { message: 'send money', tenant: 'demo' });
  assert.equal(events.at(-1).type, 'error');
  assert.equal(svc.audit.records[0].outcome, 'error');
});

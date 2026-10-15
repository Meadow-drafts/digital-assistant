import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { chatTurn } from './harness/sse.js';
import { createGuideModel } from './harness/guide-model.js';
import { loadGuides } from '../src/guides.js';

const everythingTheModelSaw = (model) => JSON.stringify(model.calls.map((c) => c.messages));
const warningOf = (events) => events.find((e) => e.type === 'warning');

test('a PIN typed near a cue word never reaches the model or the audit record, and the customer is warned', async (t) => {
  const svc = await startService({ model: createFakeModel([['Noted.']]) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'my pin is 4821, why was my transfer declined?', tenant: 'demo' });

  assert.ok(!everythingTheModelSaw(svc.model).includes('4821'));
  assert.ok(!JSON.stringify(svc.audit.records).includes('4821'));
  assert.ok(everythingTheModelSaw(svc.model).includes('why was my transfer declined'));
  assert.match(warningOf(events).text, /never share your PIN, not even with the bank/i);
  assert.equal(events.at(-1).type, 'done');
});

test('French input gets the French warning and the secret is removed', async (t) => {
  const svc = await startService({ model: createFakeModel([['Bien reçu.']]) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: "mon code pin est 135790 et je n'arrive pas à faire un virement", tenant: 'demo' });

  assert.ok(!everythingTheModelSaw(svc.model).includes('135790'));
  assert.ok(!JSON.stringify(svc.audit.records).includes('135790'));
  assert.match(warningOf(events).text, /Ne partagez jamais votre PIN, pas même avec la banque/);
});

test('a 16-digit card number, spaced or not, is removed without any cue word', async (t) => {
  const svc = await startService();
  t.after(svc.close);

  const spaced = await chatTurn(svc.baseUrl, { message: 'my card 4111 1111 1111 1111 was declined', tenant: 'demo' });
  const dashed = await chatTurn(svc.baseUrl, { message: 'card 5500-0000-0000-0004 declined', tenant: 'demo' });
  const plain = await chatTurn(svc.baseUrl, { message: '4000056655665556', tenant: 'demo' });

  const seen = everythingTheModelSaw(svc.model) + JSON.stringify(svc.audit.records);
  for (const digits of ['4111', '5500', '0004', '4000056655665556']) assert.ok(!seen.includes(digits), digits);
  for (const r of [spaced, dashed, plain]) assert.ok(warningOf(r.events));
});

test('secrets after a cue word are removed even when they are not digits', async (t) => {
  const svc = await startService();
  t.after(svc.close);

  await chatTurn(svc.baseUrl, { message: 'mon mot de passe est Soleil2024! pourquoi ça échoue ?', tenant: 'demo' });
  await chatTurn(svc.baseUrl, { message: 'the otp: 98 76 54 did not work', tenant: 'demo' });

  const seen = everythingTheModelSaw(svc.model) + JSON.stringify(svc.audit.records);
  for (const secret of ['Soleil2024', '98 76 54', '987654']) assert.ok(!seen.includes(secret), secret);
});

test('a bare cue word warns even with no secret present (false positives are accepted)', async (t) => {
  const svc = await startService();
  t.after(svc.close);

  const pin = await chatTurn(svc.baseUrl, { message: 'How do I change my PIN?', tenant: 'demo' });
  const otp = await chatTurn(svc.baseUrl, { message: "je n'ai pas reçu mon OTP", tenant: 'demo' });
  const mdp = await chatTurn(svc.baseUrl, { message: "j'ai oublié mon mot de passe", tenant: 'demo' });

  for (const r of [pin, otp, mdp]) assert.ok(warningOf(r.events));
  assert.match(warningOf(otp.events).text, /Ne partagez jamais/);
  assert.ok(everythingTheModelSaw(svc.model).includes('change my PIN'));
});

test('ordinary numbers and ordinary messages draw no warning', async (t) => {
  const svc = await startService();
  t.after(svc.close);

  for (const message of [
    'Send 5000 XAF to account 0123456789 on 2026-10-12',
    'transfer 12000 to my sister, reference 482916',
    'How do I pay a bill?',
  ]) {
    const { events } = await chatTurn(svc.baseUrl, { message, tenant: 'demo' });
    assert.equal(warningOf(events), undefined, message);
  }
  assert.ok(everythingTheModelSaw(svc.model).includes('5000'));
});

test('the redacted text, not the raw one, is what later turns replay to the model', async (t) => {
  const svc = await startService();
  t.after(svc.close);

  const first = await chatTurn(svc.baseUrl, { message: 'otp 246810 please help', tenant: 'demo' });
  await chatTurn(svc.baseUrl, { message: 'and now?', conversationId: first.events.at(-1).conversationId, tenant: 'demo' });

  assert.equal(svc.model.calls.length, 2);
  assert.ok(!everythingTheModelSaw(svc.model).includes('246810'));
  assert.ok(!JSON.stringify(svc.audit.records).includes('246810'));
});

test('the failed-question log and the router model also get only redacted text', async (t) => {
  const model = createGuideModel({ picks: [] });
  const svc = await startService({ model, guides: loadGuides(new URL('../guides/', import.meta.url)) });
  t.after(svc.close);

  await chatTurn(svc.baseUrl, { message: 'my pin 7391 how do I trade stocks here?', tenant: 'demo' });

  assert.ok(!JSON.stringify(svc.failedQuestions.records).includes('7391'));
  assert.ok(!everythingTheModelSaw(model).includes('7391'));
  assert.ok(svc.failedQuestions.records.length === 1);
});

test('a session token pasted into the chat (a JWT, "Bearer ...", or after the word token) never reaches the model or the audit', async (t) => {
  const svc = await startService({ model: createFakeModel([['Noted.']]) });
  t.after(svc.close);
  const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIyMzc2OTAwMDAxMTEifQ.signature123';

  for (const message of [`it says ${jwt} on my screen`, 'my header is Bearer opaqueValue987 help', 'mon jeton est abc123def456 aidez-moi', 'token: opaqueValue987']) {
    const { events } = await chatTurn(svc.baseUrl, { message, tenant: 'demo' });
    assert.ok(warningOf(events), `no warning for: ${message.slice(0, 30)}`);
  }

  const seen = everythingTheModelSaw(svc.model) + JSON.stringify(svc.audit.records);
  for (const secret of [jwt, 'opaqueValue987', 'abc123def456']) assert.ok(!seen.includes(secret), `${secret} reached the model or the audit`);
});

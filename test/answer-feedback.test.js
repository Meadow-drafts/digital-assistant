import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { customer, call } from './harness/cases.js';
import { openWidget } from './harness/open-widget.js';

test('answer feedback is tied to its answer and conversation, stores no answer or secret text, and is private to its owner', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const owner = await customer(svc.baseUrl, 'feedback-owner', 'My PIN is 123456, please help');
  const answerId = (await owner.say('Can you explain this?')).events.at(-1).answerId;
  assert.ok(answerId, 'the answer has a stable public id');

  const saved = await call(svc.baseUrl, 'POST', '/feedback', {
    token: owner.token,
    body: { conversationId: owner.conversationId, answerId, rating: 'down', note: 'PIN 987654 is wrong' },
  });
  const intruder = await call(svc.baseUrl, 'POST', '/feedback', {
    token: 'feedback-intruder',
    body: { conversationId: owner.conversationId, answerId, rating: 'up' },
  });

  assert.equal(saved.status, 200);
  assert.equal(intruder.status, 404);
  const records = svc.audit.records.filter((entry) => entry.outcome === 'answer_feedback');
  assert.equal(records.length, 1);
  assert.deepEqual(
    { user: records[0].user, conversationId: records[0].conversationId, answerId: records[0].answerId, rating: records[0].rating },
    { user: records[0].user, conversationId: owner.conversationId, answerId, rating: 'down' },
  );
  assert.doesNotMatch(JSON.stringify(records), /987654|123456|wrong/i);
});

test('feedback cannot target an answer from another conversation or an unknown answer', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const first = await customer(svc.baseUrl, 'feedback-owner-a');
  const answerId = (await first.say('More help')).events.at(-1).answerId;
  const second = await customer(svc.baseUrl, 'feedback-owner-b');
  const wrongConversation = await call(svc.baseUrl, 'POST', '/feedback', {
    token: second.token,
    body: { conversationId: second.conversationId, answerId, rating: 'up' },
  });
  const unknown = await call(svc.baseUrl, 'POST', '/feedback', {
    token: second.token,
    body: { conversationId: second.conversationId, answerId: 'missing-answer', rating: 'up' },
  });
  assert.deepEqual([wrongConversation.status, unknown.status], [404, 404]);
});

test('each answer offers bilingual thumbs feedback and sends only the rating and answer reference', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const widget = await openWidget(svc.baseUrl);
  t.after(() => widget.dom.window.close());

  await widget.send('Comment faire un virement vers un autre compte ?');
  await widget.until(() => widget.qa('thumbs-up').length === 1);

  const answer = widget.qa('message').find((message) => message.dataset.answerId);
  assert.ok(answer);
  assert.match(answer.nextElementSibling.textContent, /Évaluer cette réponse/);
  assert.equal(widget.q('thumbs-down').getAttribute('aria-label'), 'Pas utile');
  widget.q('thumbs-down').click();
  await widget.until(() => /Merci pour votre avis/.test(answer.nextElementSibling.textContent));

  await widget.send('Thanks. How do I pay a bill?');
  await widget.until(() => widget.qa('thumbs-up').length === 2);
  const englishAnswer = widget.qa('message').find((message) => message.dataset.answerId && message !== answer);
  assert.match(englishAnswer.nextElementSibling.textContent, /Rate this answer/);
  widget.qa('thumbs-up')[1].click();
  await widget.until(() => /Thank you for your feedback/.test(englishAnswer.nextElementSibling.textContent));

  const records = svc.audit.records.filter((entry) => entry.outcome === 'answer_feedback');
  assert.deepEqual(records.map(({ conversationId, answerId, rating }) => ({ conversationId, answerId, rating })), [
    { conversationId: records[0].conversationId, answerId: answer.dataset.answerId, rating: 'down' },
    { conversationId: records[0].conversationId, answerId: englishAnswer.dataset.answerId, rating: 'up' },
  ]);
  assert.match(records[0].conversationId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(records), /123456|secret|answer text/i);
});

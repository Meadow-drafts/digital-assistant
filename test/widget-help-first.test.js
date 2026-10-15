import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { openWidget } from './harness/open-widget.js';
import { alice, bob, open as openSession, start } from './harness/t1-helpers.js';
import { createGuideModel } from './harness/guide-model.js';
import { GUIDES } from './harness/t1-helpers.js';
import { loadGuides } from '../src/guides.js';
import { chatTurn } from './harness/sse.js';
import { rawFetch } from './harness/session-fetch.js';
import { agentLogin } from './harness/cases.js';

async function signedWidget(t, { gating = { usePackages: false }, path = '/', customerCatalogue = [], contextRoutes = {} } = {}) {
  const customer = alice();
  const guides = loadGuides(GUIDES);
  for (const key of customerCatalogue) guides.get(key).customerCatalogue = true;
  for (const [key, route] of Object.entries(contextRoutes)) guides.get(key).route = route;
  const svc = await start({ customers: [customer], guides, model: createGuideModel({ picks: ['dashboard'], answer: ['Here are the verified steps.'] }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl, path);
  t.after(() => w.dom.window.close());
  const el = w.document.querySelector('bank-assistant');
  el.setAttribute('token', customer.token);
  el.setAttribute('cli', customer.cli);
  el.setAttribute('tenant', 'demo');
  el.setAttribute('gating', JSON.stringify(gating));
  w.q('launcher').click();
  await w.until(() => w.q('topics').getAttribute('aria-busy') === 'false');
  return { svc, customer, w };
}

test('the public widget starts as a floating launcher and opens a labelled panel on request', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close());
  const el = w.document.querySelector('bank-assistant');

  assert.equal(w.q('launcher').hidden, false);
  assert.equal(w.q('shell').hidden, true);
  assert.equal(w.q('launcher').getAttribute('aria-label'), 'Open BPay assistant');

  w.q('launcher').click();

  assert.equal(w.q('launcher').hidden, true);
  assert.equal(w.q('shell').hidden, false);
  assert.equal(w.q('root').getAttribute('aria-label'), 'BIPAY');
  assert.ok(el);
});

test('the welcome greets the host supplied customer and the conversation keeps cases in More only', async (t) => {
  const { w } = await signedWidget(t);
  const el = w.document.querySelector('bank-assistant');
  el.getCustomerName = () => 'Amina';
  el.setAttribute('customer-name', 'host supplied');
  assert.equal(w.q('welcome-name').textContent, 'Welcome, Amina');
  assert.equal(w.q('my-cases-button'), null);
  assert.ok([...w.q('menu').querySelectorAll('button')].some((button) => button.dataset.role === 'menu-cases'));
});

test('the search focus uses a soft focus treatment and contextual help describes the current route', async (t) => {
  const { w } = await signedWidget(t, { customerCatalogue: ['dashboard', 'transfer-single'], contextRoutes: { dashboard: '/history' } });
  w.dom.window.history.pushState({}, '', '/history');
  await w.until(() => w.q('topics').getAttribute('aria-busy') === 'false');
  assert.equal(w.q('context-title').textContent, 'Quick help for History');
  assert.equal(w.q('context-copy').textContent, 'Find and review your transactions');
  const styles = w.document.querySelector('bank-assistant style').textContent;
  assert.match(styles, /\.ba-search:focus-within[^}]*box-shadow/);
  assert.match(styles, /\.ba-compose form:focus-within[^}]*box-shadow/);
  assert.match(styles, /\.ba-transactions-scroll[^}]*scrollbar-width:thin/);
  assert.match(styles, /\.ba-chips[^}]*scrollbar-width:thin/);
  assert.doesNotMatch(styles, /input:focus-visible\s*\{\s*outline:3px solid #e7a563/);
});

test('a known page without a published guide still shows a generic, editable contextual prompt', async (t) => {
  const { w } = await signedWidget(t);
  w.dom.window.history.pushState({}, '', '/overview');
  await w.until(() => w.q('topics').getAttribute('aria-busy') === 'false');
  assert.equal(w.q('context-card').hidden, false);
  assert.equal(w.q('context-title').textContent, 'Quick help for Overview');
  assert.equal(w.q('context-copy').textContent, 'Ask a question about this page');
  assert.ok(w.q('context-card').querySelector('[data-role="context-icon"]'));
  assert.ok(w.q('context-card').querySelector('[data-role="context-arrow"]'));
  w.q('context-button').click();
  assert.equal(w.q('input').value, 'How can I use the Overview page?');
  assert.equal(w.net.requests.some((request) => request.message === w.q('input').value), false, 'the prompt is not sent automatically');
});

test('eligible catalogue filtering happens before search, and route context refreshes after navigation', async (t) => {
  const { w } = await signedWidget(t, {
    gating: { usePackages: true, pack: { natureCodes: ['HIST'] } },
    customerCatalogue: ['dashboard', 'transfer-single'],
  });
  assert.deepEqual(w.qa('topic').map((topic) => topic.dataset.topicKey).sort(), ['dashboard', 'my-cases'], 'the package-locked transfer title is filtered before display');

  w.dom.window.history.pushState({}, '', '/overview');
  await w.until(() => w.q('topics').getAttribute('aria-busy') === 'false');
  assert.equal(w.q('context-card').hidden, false);
  assert.match(w.q('context-title').textContent, /Overview/);
  assert.equal(w.q('context-copy').textContent, 'See balance and recent activity guidance');

  w.dom.window.history.pushState({}, '', '/transfer');
  await w.until(() => w.q('topics').getAttribute('aria-busy') === 'false');
  assert.equal(w.q('context-card').hidden, false);
  assert.match(w.q('context-title').textContent, /Transfer/);
  assert.equal(w.q('context-copy').textContent, 'Ask a question about this page', 'the package-locked guide is replaced by generic page help');

  w.q('topic-search').value = 'single transfer';
  w.q('topic-search').dispatchEvent(new w.dom.window.Event('input'));
  assert.equal(w.qa('topic').length, 0);
  assert.equal(w.q('topics-empty').hidden, false);
  assert.equal(w.q('input').disabled, false);
});

test('selecting an eligible topic uses its stable key through the verified chat path', async (t) => {
  const { svc, w } = await signedWidget(t);
  const topic = w.qa('topic').find((item) => item.dataset.topicKey === 'my-cases');
  assert.ok(topic, `catalogue keys: ${w.qa('topic').map((item) => item.dataset.topicKey).join(', ')}`);
  topic.click();
  await w.until(() => w.q('thinking').hidden && w.qa('message').some((item) => item.dataset.from === 'assistant'));

  const sent = w.net.requests.at(-1);
  assert.equal(sent.guideKey, 'my-cases');
  assert.equal(sent.message, 'Follow your cases');
  assert.match(w.qa('message').filter((item) => item.dataset.from === 'assistant').at(-1).textContent, /verified steps/);
  assert.equal(svc.gateway.calls.some((call) => /getSolde|history\/bipay-recent/.test(call.path)), false);
});

test('ordinary suggestions fill the composer, the agent chip directly hands off, and minimize keeps the conversation', async (t) => {
  const { w } = await signedWidget(t);
  await w.send("I sent money, but my sister hasn't received it.");
  await w.until(() => w.q('thinking').hidden && /When did you send/.test(w.qa('message').at(-1)?.textContent ?? ''));
  await w.send('This morning.');
  await w.until(() => w.q('thinking').hidden && w.qa('quick-reply').length === 3);
  const currentId = w.document.querySelector('bank-assistant').conversationId;
  const turns = w.qa('message').filter((item) => item.dataset.from === 'user').length;
  w.qa('quick-reply')[0].click();
  assert.equal(w.q('input').value, 'Where do I find the reference?');
  assert.equal(w.qa('message').filter((item) => item.dataset.from === 'user').length, turns);

  const human = w.q('human-chip');
  assert.match(human.getAttribute('aria-label'), /agent/i);
  const beforeHandoff = w.net.requests.length;
  human.click();
  await w.until(() => !w.q('case-banner').hidden);
  assert.equal(w.net.requests.slice(beforeHandoff).some((request) => request.message), false);

  w.q('minimize').click();
  assert.equal(w.q('shell').hidden, true);
  assert.equal(w.document.querySelector('bank-assistant').conversationId, currentId);
  w.q('launcher').click();
  assert.equal(w.q('case-banner').hidden, false);
});

test('New chat starts a separate conversation while the prior case remains discoverable from More', async (t) => {
  const { w } = await signedWidget(t);
  await w.send('How do I see my balance?');
  await w.until(() => w.q('thinking').hidden && w.qa('message').some((item) => item.dataset.from === 'assistant'));
  w.q('human-chip').click();
  await w.until(() => !w.q('case-banner').hidden);
  const oldId = w.document.querySelector('bank-assistant').conversationId;
  w.q('new-chat').click();
  await w.until(() => w.document.querySelector('bank-assistant').conversationId && w.document.querySelector('bank-assistant').conversationId !== oldId);
  const newId = w.document.querySelector('bank-assistant').conversationId;
  assert.equal(w.qa('message').length, 0);

  w.q('more').click();
  assert.equal(w.q('more').getAttribute('aria-expanded'), 'true');
  w.q('menu-cases').click();
  await w.until(() => !w.q('my-cases-panel').hidden && !w.q('my-cases-loading').textContent);
  assert.ok(newId);
  assert.deepEqual([...w.q('menu').querySelectorAll('button')].map((button) => button.textContent), ['My cases', 'Chat history', 'Help topics']);
  assert.equal(w.qa('my-case').length, 1);
});

test('chat history lists past conversations by recent activity and resumes the selected thread', async (t) => {
  const { svc, w } = await signedWidget(t);
  await w.send('How do I check my account balance?');
  await w.until(() => w.q('thinking').hidden && w.qa('message').some((message) => message.dataset.from === 'assistant'));
  const firstId = w.document.querySelector('bank-assistant').conversationId;
  w.q('new-chat').click();
  await svc.clock.advance(1000);
  await w.send('How do I find a transfer?');
  await w.until(() => w.q('thinking').hidden && w.qa('message').some((message) => message.dataset.from === 'assistant'));
  const secondId = w.document.querySelector('bank-assistant').conversationId;

  w.q('more').click();
  w.q('menu-history').click();
  await w.until(() => !w.q('history-loading').textContent);
  const rows = w.qa('conversation-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.conversationId, secondId, 'most recently active appears first');
  assert.match(rows[0].textContent, /How do I find a transfer/);
  assert.match(rows[0].textContent, /2026/);

  rows.find((row) => row.dataset.conversationId === firstId).click();
  await w.until(() => w.document.querySelector('bank-assistant').conversationId === firstId && w.q('history-panel').hidden);
  assert.match(w.qa('message').find((message) => message.dataset.from === 'user').textContent, /check my account balance/);
  await w.send('And can I see recent transactions?');
  await w.until(() => w.q('thinking').hidden && w.net.requests.at(-1)?.message === 'And can I see recent transactions?');
  assert.equal(w.net.requests.at(-1).conversationId, firstId, 'a follow-up continues the selected conversation');
});

test('chat history marks an agent reply unread and clears it when the customer resumes the thread', async (t) => {
  const { svc, w } = await signedWidget(t);
  await w.send('I need help with a transfer.');
  await w.until(() => w.q('thinking').hidden && w.qa('message').some((message) => message.dataset.from === 'assistant'));
  w.document.querySelector('bank-assistant').setAttribute('poll-ms', '60000');
  w.q('human-chip').click();
  await w.until(() => !w.q('case-banner').hidden);
  const conversationId = w.document.querySelector('bank-assistant').conversationId;
  const ref = /C-\d+/.exec(w.q('case-ref').textContent)[0];
  w.q('new-chat').click();
  await w.until(() => w.document.querySelector('bank-assistant').conversationId && w.document.querySelector('bank-assistant').conversationId !== conversationId);
  const aline = await agentLogin(svc.baseUrl);
  await aline.claim(ref);
  await aline.reply(ref, 'I checked the transfer. You can continue here if you need more help.');

  w.q('more').click();
  w.q('menu-history').click();
  await w.until(() => !w.q('history-loading').textContent);
  const row = w.qa('conversation-row').find((item) => item.dataset.conversationId === conversationId);
  assert.match(row.textContent, /Agent replied/);
  assert.match(row.textContent, /2026/);
  assert.match(w.q('menu-history').textContent, /1 new reply/);
  assert.match(w.q('menu-cases').textContent, /1 new reply/);

  row.click();
  await w.until(() => w.q('history-panel').hidden && w.qa('message').some((message) => message.dataset.from === 'agent'));
  assert.match(w.qa('message').find((message) => message.dataset.from === 'agent').textContent, /I checked the transfer/);

  w.q('more').click();
  w.q('menu-history').click();
  await w.until(() => !w.q('history-loading').textContent);
  const resumed = w.qa('conversation-row').find((item) => item.dataset.conversationId === conversationId);
  assert.doesNotMatch(resumed.textContent, /Agent replied/);
  await w.until(() => !/new reply/.test(w.q('menu-history').textContent));
});

test('French welcome controls have labels, and the panel uses mobile safe-area sizing', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl, '/', { attrs: 'lang="fr" brand-name="BPay"' });
  t.after(() => w.dom.window.close());
  w.q('launcher').click();
  assert.equal(w.q('welcome').textContent, 'Comment puis-je vous aider avec BPay ?');
  assert.equal(w.q('new-chat').getAttribute('aria-label'), 'Nouvelle discussion');
  assert.equal(w.q('more').getAttribute('aria-label'), 'Plus d’options');
  assert.equal(w.q('minimize').getAttribute('aria-label'), 'Réduire l’assistant');
  assert.equal(w.q('input').getAttribute('aria-label'), 'Posez une question sur BPay');
  assert.equal(w.q('disclaimer').hidden, false, 'the safety line stays visible on the welcome screen');
  assert.match(w.document.querySelector('bank-assistant style').textContent, /safe-area-inset-bottom/);
  assert.match(w.document.querySelector('bank-assistant style').textContent, /max-width:600px/);
});

test('the read-only catalogue requires an owned signed session and returns only eligible localized titles and keys', async (t) => {
  const customer = alice();
  const stranger = bob();
  const svc = await start({ customers: [customer, stranger] });
  t.after(svc.close);
  const session = await openSession(svc, customer, { gating: { usePackages: false, audience: 'individual' } });
  const query = `language=fr&path=%2Foverview&conversationId=${encodeURIComponent(session.conversationId)}`;

  const unauthenticated = await fetch(`${svc.baseUrl}/help/topics?${query}`);
  assert.equal(unauthenticated.status, 401);

  const response = await fetch(`${svc.baseUrl}/help/topics?${query}`, {
    headers: { authorization: `Bearer ${customer.token}`, 'x-assistant-session': session.sessionId },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.topics.map((topic) => topic.key), ['my-cases']);
  assert.deepEqual(Object.keys(body.topics[0]).sort(), ['key', 'title']);
  assert.equal(body.topics[0].title, 'Suivre vos dossiers');
  assert.deepEqual(body.context.topics, [], 'draft Overview guide is not disclosed in contextual help');
  assert.equal(body.context.description, 'Posez une question sur cette page');

  const strangerSession = await openSession(svc, stranger, { gating: { usePackages: false, audience: 'individual' } });
  const denied = await fetch(`${svc.baseUrl}/help/topics?language=en&conversationId=${session.conversationId}`, {
    headers: { authorization: `Bearer ${stranger.token}`, 'x-assistant-session': strangerSession.sessionId },
  });
  assert.equal(denied.status, 404, 'another signed-in customer cannot enumerate this conversation’s topics');

  const merchantSession = await openSession(svc, customer, { gating: { usePackages: false, audience: 'merchant' } });
  const merchantResponse = await fetch(`${svc.baseUrl}/help/topics?language=en&conversationId=${merchantSession.conversationId}`, {
    headers: { authorization: `Bearer ${customer.token}`, 'x-assistant-session': merchantSession.sessionId },
  });
  assert.deepEqual((await merchantResponse.json()).topics, [], 'individual-only verified topics are hidden from merchant users');
});

test('conversation history requires a verified owner and returns only masked transcript text', async (t) => {
  const customer = alice();
  const stranger = bob();
  const svc = await start({ customers: [customer, stranger] });
  t.after(svc.close);
  const ownerSession = await openSession(svc, customer);
  const id = ownerSession.conversationId;
  const turn = await chatTurn(svc.baseUrl, { message: 'My account is 12345678901. How do I check it?', conversationId: id, tenant: 'demo' }, {
    token: customer.token, headers: { 'x-assistant-session': ownerSession.sessionId },
  });
  assert.equal(turn.status, 200);

  const noSession = await rawFetch(`${svc.baseUrl}/conversations`, { headers: { authorization: `Bearer ${customer.token}` } });
  assert.equal(noSession.status, 401);
  const listed = await rawFetch(`${svc.baseUrl}/conversations`, {
    headers: { authorization: `Bearer ${customer.token}`, 'x-assistant-session': ownerSession.sessionId },
  });
  const list = await listed.json();
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].id, id);
  assert.match(list.conversations[0].preview, /\*\*\*\*8901/);
  assert.doesNotMatch(JSON.stringify(list), /12345678901/);

  const detail = await rawFetch(`${svc.baseUrl}/conversations/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${customer.token}`, 'x-assistant-session': ownerSession.sessionId },
  });
  const transcript = await detail.json();
  assert.equal(transcript.messages[0].role, 'user');
  assert.match(transcript.messages[0].text, /\*\*\*\*8901/);
  assert.doesNotMatch(JSON.stringify(transcript), /12345678901/);

  const strangerSession = await openSession(svc, stranger);
  const strangerHeaders = { authorization: `Bearer ${stranger.token}`, 'x-assistant-session': strangerSession.sessionId };
  const strangerList = await rawFetch(`${svc.baseUrl}/conversations`, { headers: strangerHeaders });
  assert.deepEqual((await strangerList.json()).conversations, []);
  const denied = await rawFetch(`${svc.baseUrl}/conversations/${encodeURIComponent(id)}`, { headers: strangerHeaders });
  assert.equal(denied.status, 404);
});

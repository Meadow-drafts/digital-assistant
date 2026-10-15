import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAgencyProfile } from '../src/profile.js';
import { startService } from './harness/start-service.js';
import { createFakeGateway } from './harness/fake-gateway.js';
import { createFakeModel } from './harness/fake-model.js';
import { makeToken } from './harness/token.js';
import { openWidget } from './harness/open-widget.js';
import { loadGuides } from '../src/guides.js';

test('the BICEC agency profile is a single tenant with its own agency API prefix and stores', () => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  assert.equal(profile.id, 'bicec-agency');
  assert.deepEqual(profile.tenants, {
    'bicec-agency': { baseUrl: 'https://agency-gateway.example.invalid', apiPrefix: '/agencybank' },
  });
  assert.equal(profile.dataDirectory, 'data/agency-bicec');
  assert.equal(profile.guidesDirectory, 'guides-agency-bicec');
});

test('an agency profile cannot accidentally configure multiple tenants or consumer APIs', () => {
  assert.throws(() => loadAgencyProfile({
    id: 'bicec-agency',
    tenants: { one: { baseUrl: 'https://one.example', apiPrefix: '/agencybank' }, two: { baseUrl: 'https://two.example', apiPrefix: '/mosa' } },
    dataDirectory: 'data/agency-bicec', guidesDirectory: 'guides-agency-bicec',
  }), /exactly one tenant/);
  assert.throws(() => loadAgencyProfile({
    id: 'bicec-agency',
    tenants: { 'bicec-agency': { baseUrl: 'https://one.example', apiPrefix: '/digitalbank' } },
    dataDirectory: 'data/agency-bicec', guidesDirectory: 'guides-agency-bicec',
  }), /agency API prefix/);
});

test('a teller session requires the host bearer token and never calls consumer-wallet verification', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway, model: createFakeModel(['generic help']) });
  t.after(svc.close);
  const missing = await fetch(`${svc.baseUrl}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 401);
  const response = await fetch(`${svc.baseUrl}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken('teller-17')}` },
    body: JSON.stringify({ tenant: 'other-bank', cli: 'client-identifier' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(gateway.calls.map(({ path, query }) => ({ path, query })), [
    { path: '/transactions/history/teller', query: { page: 0, limit: 100000 } },
  ], 'session verification uses the signed-in teller history surface, not consumer identity or /digitalbank');
});

test('agency session is not established when the backend response lacks the scoped history page shape', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { message: 'not a history response' } });
  const svc = await startService({ agencyProfile: profile, gateway });
  t.after(svc.close);
  const response = await fetch(`${svc.baseUrl}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken('teller-unverified')}` }, body: '{}',
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'unavailable');
});

test('the agency widget starts with the teller token, sends route hints, and receives no contextual page links', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway, model: createFakeModel(['Hello, how can I help?']) });
  t.after(svc.close);
  const token = makeToken('teller-18');
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${token}"` });
  await widget.send('Hello');
  await widget.until(() => widget.qa('message').some((m) => /Hello! How can I help/.test(m.textContent)));
  assert.equal(widget.net.requests[0].pageContext.path, '/');
  assert.equal(widget.net.requests[0].tenant, 'bicec-agency');
  assert.equal(gateway.calls[0].token, token);
  assert.equal(widget.qa('approved-answer-link').length, 0);
  widget.dom.window.close();
});

test('agency requests to execute teller actions or use authentication secrets get a deterministic refusal', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const model = createFakeModel(['model must not answer this request']);
  const svc = await startService({ agencyProfile: profile, gateway, model, guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)) });
  t.after(svc.close);
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${makeToken('teller-safe-action')}"` });
  await widget.send('Please complete this cash-in using my PIN 4821');
  await widget.until(() => widget.qa('message').some((m) => /never share your PIN/i.test(m.textContent)));
  await widget.send('Please fill in this cash-in for me');
  await widget.until(() => widget.qa('message').some((m) => /cannot fill, submit, or execute teller actions/i.test(m.textContent)));
  assert.equal(model.calls.length, 0);
  widget.dom.window.close();
});

test('approved agency guides appear as generic topics while route hints never produce contextual help or links', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway, model: createFakeModel(['generic help']), guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)) });
  t.after(svc.close);
  const token = makeToken('teller-context');
  const started = await fetch(`${svc.baseUrl}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tenant: 'untrusted-tenant' }) });
  const session = await started.json();
  const topicsResponse = await fetch(`${svc.baseUrl}/help/topics?language=en&path=%2Fprivate&conversationId=${session.conversationId}`, {
    headers: { authorization: `Bearer ${token}`, 'x-assistant-session': session.sessionId },
  });
  const topics = await topicsResponse.json();
  assert.equal(topics.topics.length, 15);
  assert.equal(topics.topics[0].key, '00-cash-in');
  assert.equal(topics.context, null);
  assert.equal(topics.topics.some((topic) => /DRAFT|BROUILLON/i.test(topic.title)), false);
  assert.equal(gateway.calls[0].tenant, 'bicec-agency', 'the client route/tenant hint never selects a gateway tenant');
});

test('agency widget refreshes its hint after a portal route change without exposing page-specific help', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway, model: createFakeModel(['generic help']), guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)) });
  t.after(svc.close);
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${makeToken('teller-route')}"` });
  await widget.until(() => widget.net.topicRequests.length >= 1);
  widget.dom.window.history.pushState({}, '', '/private');
  widget.dom.window.dispatchEvent(new widget.dom.window.PopStateEvent('popstate'));
  await widget.until(() => widget.net.topicRequests.length >= 2);
  assert.match(widget.net.topicRequests.at(-1), /path=%2Fprivate/);
  assert.equal(widget.q('context-card').hidden, true);
  const replacementToken = makeToken('teller-route-new-session');
  const agencyWidget = widget.document.querySelector('bank-assistant');
  agencyWidget.getToken = () => replacementToken;
  agencyWidget.dispatchEvent(new widget.dom.window.CustomEvent('bank-assistant:session-change'));
  await widget.until(() => gateway.calls.some((call) => call.token === replacementToken));
  widget.dom.window.close();
});

test('agency handoff begins with an editable case summary and preserves the conversation', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway, model: createFakeModel(['generic answer']), guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)) });
  t.after(svc.close);
  const token = makeToken('teller-handoff');
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${token}"` });
  await widget.send('How do I handle a cash-in question?');
  await widget.until(() => widget.qa('message').some((m) => m.dataset.from === 'assistant'));
  widget.q('human-chip').click();
  await widget.until(() => !widget.q('draft-panel').hidden);
  const draft = widget.q('draft-text');
  assert.match(draft.value, /cash-in question/i);
  assert.equal(widget.q('draft-skip').hidden, true);
  assert.equal(widget.q('dest-email').closest('label').hidden, true);
  draft.value += '\nPlease review this wording.';
  widget.q('draft-review').click();
  await widget.until(() => !widget.q('draft-confirm-screen').hidden);
  assert.match(widget.q('preview-chat').textContent, /Please review this wording/);
  assert.equal(widget.q('preview-email-box').hidden, true);
  widget.q('draft-send').click();
  await widget.until(() => widget.q('case-banner').dataset.state === 'waiting');
  assert.equal(widget.net.requests[0].conversationId, widget.net.requests.at(-1).conversationId);
  widget.dom.window.close();
});

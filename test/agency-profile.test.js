import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAgencyProfile } from '../src/profile.js';
import { startService } from './harness/start-service.js';
import { createFakeGateway } from './harness/fake-gateway.js';
import { createFakeModel } from './harness/fake-model.js';
import { makeToken } from './harness/token.js';
import { openWidget } from './harness/open-widget.js';
import { loadGuides } from '../src/guides.js';
import { loadNavigation } from '../src/navigate.js';
import { loadSupport } from '../src/support.js';

test('the agency deployment selects one tenant with separate storage and support but shared guides', () => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  assert.equal(profile.id, 'agency-banking');
  assert.equal(profile.defaultTenant, 'bicec-agency');
  assert.deepEqual(profile.tenants, {
    'bicec-agency': { baseUrl: 'https://m.bipay-test.bicec.com', apiPrefix: '/agencybank' },
  });
  assert.equal(profile.dataDirectory, 'data/agency-bicec');
  assert.equal(profile.supportConfig, 'config/agency-bicec/support.json');
  assert.equal(profile.guidesDirectory, 'guides-agency-bicec');
  const iwomi = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url), { tenantId: 'iwomi-agency' });
  assert.deepEqual(iwomi.tenants, {
    'iwomi-agency': { baseUrl: 'http://148.113.191.174:8765', apiPrefix: '/agencybank' },
  });
  assert.equal(iwomi.dataDirectory, 'data/agency-iwomi');
  assert.equal(iwomi.supportConfig, 'config/agency-iwomi/support.json');
  assert.equal(iwomi.guidesDirectory, profile.guidesDirectory);
  const bicecSupport = loadSupport(new URL(`../${profile.supportConfig}`, import.meta.url));
  const iwomiSupport = loadSupport(new URL(`../${iwomi.supportConfig}`, import.meta.url));
  assert.notEqual(bicecSupport.agents.list[0].id, iwomiSupport.agents.list[0].id);
});

test('agency profiles reject consumer API prefixes and overrides outside the allowlist', () => {
  assert.throws(() => loadAgencyProfile({
    id: 'bicec-agency',
    tenants: { 'bicec-agency': { baseUrl: 'https://one.example', apiPrefix: '/digitalbank' } },
    dataDirectory: 'data/agency-bicec', guidesDirectory: 'guides-agency-bicec',
  }), /agency API prefix/);
  assert.throws(() => loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url), {
    tenantOverrides: { 'unknown-bank': 'https://gateway.example' },
  }), /unknown agency tenant/);
  assert.throws(() => loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url), {
    tenantId: 'unknown-bank',
  }), /ASSISTANT_TENANT_ID/);
  const overridden = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url), {
    tenantId: 'iwomi-agency',
    tenantOverrides: { 'iwomi-agency': 'https://iwomi-gateway.example' },
  });
  assert.equal(overridden.tenants['iwomi-agency'].baseUrl, 'https://iwomi-gateway.example');
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
  assert.equal(response.status, 403);
  const accepted = await fetch(`${svc.baseUrl}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken('teller-17')}` },
    body: JSON.stringify({ tenant: 'bicec-agency', cli: 'client-identifier' }),
  });
  assert.equal(accepted.status, 200);
  const session = await accepted.json();
  assert.deepEqual(gateway.calls.map(({ path, query }) => ({ path, query })), [
    { path: '/transactions/history/teller', query: { page: 0, limit: 100000 } },
  ], 'the selected agency tenant uses the signed-in teller history surface, not consumer identity or /digitalbank');
  assert.equal(gateway.calls[0].tenant, 'bicec-agency');
  const switched = await fetch(`${svc.baseUrl}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken('teller-17')}`, 'x-assistant-session': session.sessionId },
    body: JSON.stringify({ conversationId: session.conversationId, tenant: 'iwomi-agency', message: 'Hello' }),
  });
  assert.equal(switched.status, 401, 'a conversation cannot switch to a different allowlisted tenant');
  assert.equal(gateway.calls.length, 1);
});

test('an IWOMI assistant deployment can call only the IWOMI agency gateway', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url), { tenantId: 'iwomi-agency' });
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway });
  t.after(svc.close);
  const response = await fetch(`${svc.baseUrl}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken('iwomi-teller')}` },
    body: JSON.stringify({ tenant: 'bicec-agency' }),
  });
  assert.equal(response.status, 403);
  const accepted = await fetch(`${svc.baseUrl}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken('iwomi-teller')}` },
    body: JSON.stringify({ tenant: 'iwomi-agency' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].tenant, 'iwomi-agency');
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

test('a signed-in BICEC teller sees page-specific approved guidance from the fixed workflow allowlist', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway, model: createFakeModel(['generic help']), guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)), navigation: loadNavigation(new URL('../config/agency-bicec/navigate-routes.json', import.meta.url)) });
  t.after(svc.close);
  const token = makeToken('teller-context');
  const started = await fetch(`${svc.baseUrl}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tenant: 'bicec-agency' }) });
  const session = await started.json();
  const topicsResponse = await fetch(`${svc.baseUrl}/help/topics?language=en&path=%2Fprivate&conversationId=${session.conversationId}`, {
    headers: { authorization: `Bearer ${token}`, 'x-assistant-session': session.sessionId },
  });
  const topics = await topicsResponse.json();
  assert.equal(topics.topics.length, 17);
  assert.equal(topics.topics[0].key, '00-cash-in');
  assert.equal(topics.context.label, 'Private Cash-in (Internal)');
  assert.deepEqual(topics.context.topics.map((topic) => topic.key), ['02-private-cashin', '03-private-cashout']);
  assert.equal(topics.topics.some((topic) => /DRAFT|BROUILLON/i.test(topic.title)), false);
  assert.equal(gateway.calls[0].tenant, 'bicec-agency', 'the client route/tenant hint never selects a gateway tenant');
  const unlisted = await fetch(`${svc.baseUrl}/help/topics?language=en&path=%2Fpretend-route&conversationId=${session.conversationId}`, {
    headers: { authorization: `Bearer ${token}`, 'x-assistant-session': session.sessionId },
  });
  assert.equal((await unlisted.json()).context, null, 'an arbitrary host path does not create a workflow or grant access');
});

test('a teller can open an allowlisted workflow link, and arbitrary host paths do not create links', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const navigation = loadNavigation(new URL('../config/agency-bicec/navigate-routes.json', import.meta.url));
  const svc = await startService({ agencyProfile: profile, gateway, navigation, guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)), model: createFakeModel(['[[navigate:private_cashin]]Open Private Cash-in.']) });
  t.after(svc.close);
  const token = makeToken('teller-workflow-link');
  const sessionResponse = await fetch(`${svc.baseUrl}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  const session = await sessionResponse.json();
  const response = await fetch(`${svc.baseUrl}/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-assistant-session': session.sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: session.conversationId, message: 'Explain private cash services', guideKey: '02-private-cashin', language: 'en' }),
  });
  const body = await response.text();
  assert.match(body, /event: action_card/);
  assert.match(body, /"path":"\/private"/);
  assert.equal(gateway.calls.every((call) => call.tenant === 'bicec-agency'), true);
});

test('agency widget refreshes its hint after a portal route change and shows allowlisted page-specific help', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const svc = await startService({ agencyProfile: profile, gateway, model: createFakeModel(['generic help']), guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)), navigation: loadNavigation(new URL('../config/agency-bicec/navigate-routes.json', import.meta.url)) });
  t.after(svc.close);
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${makeToken('teller-route')}"` });
  await widget.until(() => widget.net.topicRequests.length >= 1);
  widget.dom.window.history.pushState({}, '', '/private');
  widget.dom.window.dispatchEvent(new widget.dom.window.PopStateEvent('popstate'));
  await widget.until(() => widget.net.topicRequests.length >= 2);
  await widget.until(() => widget.q('context-card').hidden === false);
  assert.match(widget.net.topicRequests.at(-1), /path=%2Fprivate/);
  assert.equal(widget.q('context-card').hidden, false);
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

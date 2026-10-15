import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgencyHistoryQuestion, createAgencyHistory, maskAgencyReferenceText } from '../src/agency-history.js';
import { createFakeGateway } from './harness/fake-gateway.js';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { loadGuides } from '../src/guides.js';
import { loadAgencyProfile } from '../src/profile.js';
import { openWidget } from './harness/open-widget.js';
import { makeToken } from './harness/token.js';

test('history lookup calls only the approved backend-scoped teller endpoint and matches an exact reference', async () => {
  const gateway = createFakeGateway({
    'GET /transactions/history/teller': { data: { content: [
      { ntrans: 'TX-20481', cli: 'customer-private', amount: 900000, status: 'FAILED' },
      { ntrans: 'TX-20482', cli: 'other-customer', amount: 12000, status: 'SUCCESS' },
    ] } },
  });
  const history = createAgencyHistory({ gateway });
  const result = await history.findExact({ tenant: 'bicec-agency', token: 'teller-token', reference: 'TX-20481' });
  assert.deepEqual(gateway.calls, [{ tenant: 'bicec-agency', method: 'GET', path: '/transactions/history/teller', query: { page: 0, limit: 100000 }, token: 'teller-token', body: undefined }]);
  assert.deepEqual(result, { kind: 'matched' });
});

test('history lookup rejects non-exact identifiers, treats failures as unavailable, and never returns transaction fields', async () => {
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [{ ntrans: 'TX-20481', phone: '237690000111' }] } } });
  const history = createAgencyHistory({ gateway });
  assert.deepEqual(await history.findExact({ tenant: 'bicec-agency', token: 't', reference: 'TX' }), { kind: 'invalid_reference' });
  assert.equal(gateway.calls.length, 0);
  assert.deepEqual(await history.findExact({ tenant: 'bicec-agency', token: 't', reference: '237690000111' }), { kind: 'invalid_reference' });
  assert.deepEqual(await history.findExact({ tenant: 'bicec-agency', token: 't', reference: 'TX-20481' }), { kind: 'matched' });
  gateway.failWith(503);
  assert.deepEqual(await history.findExact({ tenant: 'bicec-agency', token: 't', reference: 'TX-20481' }), { kind: 'unavailable' });
});

test('history question classification requires an exact reference and rejects detail or status requests', () => {
  assert.deepEqual(classifyAgencyHistoryQuestion('Find transaction reference: TX-20481 in history'), { kind: 'lookup', reference: 'TX-20481' });
  assert.deepEqual(classifyAgencyHistoryQuestion('Show my transaction history'), { kind: 'lookup', reference: null });
  assert.deepEqual(classifyAgencyHistoryQuestion('What is the status of transaction TX-20481?'), { kind: 'prohibited_detail' });
  assert.equal(classifyAgencyHistoryQuestion('How do I cash in?'), null);
});

test('transaction references are removed before model, conversation and audit storage see the question', () => {
  assert.equal(maskAgencyReferenceText('Find transaction reference: TX-20481 in history'), 'Find transaction reference: [REFERENCE] in history');
});

test('a teller exact-reference question uses backend scope, while details and broad searches do not broaden access', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [{ ntrans: 'TX-20481', status: 'FAILED', amount: 99000 }] } } });
  const model = createFakeModel(['should never route this history lookup']);
  const svc = await startService({ agencyProfile: profile, gateway, model, guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)) });
  t.after(svc.close);
  const token = makeToken('teller-history');
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${token}"` });
  await widget.send('Find transaction reference TX-20481 in history');
  await widget.until(() => widget.qa('message').some((m) => /matching entry appears/.test(m.textContent)));
  assert.doesNotMatch(widget.qa('message').filter((m) => m.dataset.from === 'assistant').map((m) => m.textContent).join(' '), /TX-20481|99000|FAILED/);
  assert.equal(gateway.calls.length, 2, 'session check and exact-reference search only');
  assert.ok(gateway.calls.every((call) => call.path === '/transactions/history/teller' && call.query.page === 0 && call.query.limit === 100000));
  assert.equal(model.calls.length, 0, 'the model sees no transaction reference or record');
  assert.doesNotMatch(JSON.stringify(svc.audit.records), /TX-20481/);

  await widget.send('Show transaction history');
  await widget.until(() => widget.qa('message').some((m) => /exact transaction reference/.test(m.textContent)));
  await widget.send('What is the status of transaction TX-20481?');
  await widget.until(() => widget.qa('message').some((m) => /cannot provide transaction details or status/.test(m.textContent)));
  assert.equal(gateway.calls.length, 2, 'ambiguous and prohibited questions make no search');
  widget.dom.window.close();
});

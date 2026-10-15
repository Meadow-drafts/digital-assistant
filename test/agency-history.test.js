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
      {
        transId: 'TX-20481', ntrans: 'TX-20481', cli: 'customer-private', createdAt: '2026-10-15T09:00:00Z',
        issuerAcc: '123456789012', receiverAcc: '987654321098', partnerlib: 'Merchant', partnerid: '4567890123',
        top: 'MARCHAND', operationType: 'BANK', amount: 900000, qoutePart: { feesResponse: { fees: 100, tva: 19 } },
        reason: 'Invoice 123456789012', status: 'FAILED', msgCode: 'E42', msg: 'Account 987654321098 rejected',
      },
      { ntrans: 'TX-20482', cli: 'other-customer', amount: 12000, status: 'SUCCESS' },
    ] } },
  });
  const history = createAgencyHistory({ gateway });
  const result = await history.findExact({ tenant: 'bicec-agency', token: 'teller-token', reference: 'TX-20481' });
  assert.deepEqual(gateway.calls, [{ tenant: 'bicec-agency', method: 'GET', path: '/transactions/history/teller', query: { page: 0, limit: 100000 }, token: 'teller-token', body: undefined }]);
  assert.deepEqual(result, { kind: 'matched', transaction: {
    date: '2026-10-15T09:00:00Z', id: '****0481', from: '****9012', to: '****1098', member: 'Merchant [****0123]',
    service: 'MARCHAND', type: 'BANK', amount: 900000, fees: 119, reason: 'Invoice ****9012', status: 'FAILED',
    failureReason: 'CODE: E42. Account ****1098 rejected',
  } });
  assert.doesNotMatch(JSON.stringify(result), /customer-private|TX-20481|987654321098|123456789012|4567890123/);
});

test('history lookup rejects non-exact identifiers, treats failures as unavailable, and exposes only approved history fields', async () => {
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [{ ntrans: 'TX-20481', phone: '237690000111', amount: 99000, status: 'FAILED' }] } } });
  const history = createAgencyHistory({ gateway });
  assert.deepEqual(await history.findExact({ tenant: 'bicec-agency', token: 't', reference: 'TX' }), { kind: 'invalid_reference' });
  assert.equal(gateway.calls.length, 0);
  assert.deepEqual(await history.findExact({ tenant: 'bicec-agency', token: 't', reference: '237690000111' }), { kind: 'invalid_reference' });
  const result = await history.findExact({ tenant: 'bicec-agency', token: 't', reference: 'TX-20481' });
  assert.deepEqual(result, { kind: 'matched', transaction: {
    date: null, id: '****0481', from: null, to: null, member: null, service: null, type: null, amount: 99000,
    fees: null, reason: null, status: 'FAILED', failureReason: null,
  } });
  gateway.failWith(503);
  assert.deepEqual(await history.findExact({ tenant: 'bicec-agency', token: 't', reference: 'TX-20481' }), { kind: 'unavailable' });
});

test('history question classification requires an exact reference for data and rejects broad searches', () => {
  assert.deepEqual(classifyAgencyHistoryQuestion('Find transaction reference: TX-20481 in history'), { kind: 'lookup', reference: 'TX-20481' });
  assert.deepEqual(classifyAgencyHistoryQuestion('Show my transaction history'), { kind: 'lookup', reference: null });
  assert.deepEqual(classifyAgencyHistoryQuestion('What is the status of transaction TX-20481?'), { kind: 'lookup', reference: 'TX-20481' });
  assert.equal(classifyAgencyHistoryQuestion('How do I cash in?'), null);
});

test('transaction references are removed before model, conversation and audit storage see the question', () => {
  assert.equal(maskAgencyReferenceText('Find transaction reference: TX-20481 in history'), 'Find transaction reference: [REFERENCE] in history');
});

test('a teller exact-reference question renders the masked history row; broad searches stay blocked', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [{ transId: 'TX-20481', ntrans: 'TX-20481', createdAt: '2026-10-15', issuerAcc: '123456789012', receiverAcc: '987654321098', amount: 99000, status: 'FAILED' }] } } });
  const model = createFakeModel(['should never route this history lookup']);
  const svc = await startService({ agencyProfile: profile, gateway, model, guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)) });
  t.after(svc.close);
  const token = makeToken('teller-history');
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${token}"` });
  await widget.send('Find transaction reference TX-20481 in history');
  await widget.until(() => widget.qa('agency-history').length === 1);
  assert.match(widget.qa('agency-history')[0].textContent, /2026-10-15/);
  assert.match(widget.qa('agency-history')[0].textContent, /\*\*\*\*9012/);
  assert.match(widget.qa('agency-history')[0].textContent, /\*\*\*\*1098/);
  assert.match(widget.qa('agency-history')[0].textContent, /99,000/);
  assert.match(widget.qa('agency-history')[0].textContent, /FAILED/);
  assert.doesNotMatch(widget.qa('agency-history')[0].textContent, /TX-20481|123456789012|987654321098/);
  assert.equal(gateway.calls.length, 2, 'session check and exact-reference search only');
  assert.ok(gateway.calls.every((call) => call.path === '/transactions/history/teller' && call.query.page === 0 && call.query.limit === 100000));
  assert.equal(model.calls.length, 0, 'the model sees no transaction reference or record');
  assert.doesNotMatch(JSON.stringify(svc.audit.records), /TX-20481/);

  await widget.send('Show transaction history');
  await widget.until(() => widget.qa('message').some((m) => /exact transaction reference/.test(m.textContent)));
  await widget.send('Quel est le statut de la transaction TX-20481 ?');
  await widget.until(() => widget.qa('agency-history').length === 2);
  assert.match(widget.qa('agency-history')[1].textContent, /Montant.*Frais.*Motif/);
  assert.equal(gateway.calls.length, 3, 'each exact reference uses the same backend-scoped endpoint');
  widget.dom.window.close();
});

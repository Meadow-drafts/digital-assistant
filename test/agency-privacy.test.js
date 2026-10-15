import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAgencyProfile } from '../src/profile.js';
import { loadGuides } from '../src/guides.js';
import { startService } from './harness/start-service.js';
import { createFakeGateway } from './harness/fake-gateway.js';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';
import { makeToken } from './harness/token.js';

test('agency model, failed-question and audit records do not retain a PIN or transaction reference', async (t) => {
  const profile = loadAgencyProfile(new URL('../config/agency-bicec/profile.json', import.meta.url));
  const gateway = createFakeGateway({ 'GET /transactions/history/teller': { data: { content: [] } } });
  const model = createFakeModel((request) => request.purpose === 'route' ? '[]' : 'generic reply');
  const svc = await startService({ agencyProfile: profile, gateway, model, guides: loadGuides(new URL('../guides-agency-bicec/', import.meta.url)) });
  t.after(svc.close);
  const widget = await openWidget(svc.baseUrl, '/', { attrs: `tenant="bicec-agency" data-mode="agency" token="${makeToken('teller-privacy')}"` });
  await widget.send('Can I cash in? My PIN is 4821, reference TX-20481');
  await widget.until(() => widget.qa('message').some((message) => /never share your PIN/i.test(message.textContent)));
  await widget.send('Can I cash in? reference TX-20481');
  await widget.until(() => widget.qa('message').filter((message) => message.dataset.from === 'assistant').length === 2);
  assert.equal(svc.failedQuestions.records.length, 0, 'a deterministic cash workflow clarification is not sent to the model or failed-question log');
  await widget.until(() => svc.audit.records.some((record) => record.outcome === 'ok' || record.outcome === 'no_guide'));
  const stored = JSON.stringify({ audit: svc.audit.records, failed: svc.failedQuestions.records, model: model.calls });
  assert.doesNotMatch(stored, /4821|TX-20481/);
  assert.equal(model.calls.length, 0, 'cash workflow clarification does not need model calls');
  widget.dom.window.close();
});

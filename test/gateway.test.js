import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpGateway, loadTenants } from '../src/gateway.js';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { loadGuides } from '../src/guides.js';
import { makeToken } from './harness/token.js';

// Fake transport only: the real test server is never called from automated tests.
function recordingFetch() {
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); };
  return { sent, fetch };
}

test('the gateway base URL comes from the tenant allowlist, with the test server as the demo entry', () => {
  const tenants = loadTenants(new URL('../config/tenants.json', import.meta.url));
  assert.equal(tenants.demo, 'https://m.bipay-test.bicec.com');
});

test('a tenant id outside the allowlist is never contacted, whatever shape it takes', async () => {
  const { sent, fetch } = recordingFetch();
  const gateway = createHttpGateway({ tenants: { demo: 'https://gateway.test' }, fetch });
  for (const tenant of ['https://evil.example', 'evil', '', undefined, '__proto__', 'constructor']) {
    await assert.rejects(gateway.request({ tenant, method: 'GET', path: '/x', token: 't' }), /allowlist/);
  }
  assert.equal(sent.length, 0);
});

test('requests go to the tenant\'s gateway with the user\'s own token and no service key', async () => {
  const { sent, fetch } = recordingFetch();
  const gateway = createHttpGateway({ tenants: { demo: 'https://gateway.test' }, fetch });
  await gateway.request({ tenant: 'demo', method: 'GET', path: '/digitalbank/history/transactions', query: { wallet: 'w1' }, token: 'user-token' });
  const [call] = sent;
  assert.equal(call.url, 'https://gateway.test/digitalbank/history/transactions?wallet=w1');
  assert.equal(call.init.headers.authorization, 'user-token');
  assert.deepEqual(Object.keys(call.init.headers).filter((h) => /api-uuid|key/i.test(h)), []);
});

test('agency requests use the selected tenant API prefix and signed-in teller token', async () => {
  const { sent, fetch } = recordingFetch();
  const gateway = createHttpGateway({ tenants: { 'bicec-agency': { baseUrl: 'https://agency.test', apiPrefix: '/agencybank' } }, fetch });
  await gateway.request({ tenant: 'bicec-agency', method: 'GET', path: '/transactions/history/teller', token: 'teller-token' });
  assert.equal(sent[0].url, 'https://agency.test/agencybank/transactions/history/teller');
  assert.equal(sent[0].init.headers.authorization, 'teller-token');
});

test('through the service, a session for a tenant outside the allowlist is unavailable and nothing is contacted', async (t) => {
  const { sent, fetch } = recordingFetch();
  const gateway = createHttpGateway({ tenants: { demo: 'https://gateway.test' }, fetch });
  const svc = await startService({ guides: loadGuides(new URL('../guides/', import.meta.url)), gateway, model: createFakeModel(['ok']) });
  t.after(svc.close);

  const res = await fetch_(svc.baseUrl, 'https://evil.example');

  assert.equal(res.status, 502);
  assert.equal(sent.length, 0);
});

const fetch_ = (baseUrl, tenant) => fetch(`${baseUrl}/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken('237690000111')}` },
  body: JSON.stringify({ cli: 'CLI-A', tenant }),
});

const answering = (status, body) => createHttpGateway({
  tenants: { demo: 'https://gateway.test' },
  fetch: async () => new Response(body, { status }),
});
const ask = (gateway) => gateway.request({ tenant: 'demo', method: 'GET', path: '/x', token: 't' });

test('what the test server really answers to a bad token: a bare 400 (tampered or expired) or a bare 406 (no Authorization) is a 401', async () => {
  assert.equal((await ask(answering(400, ''))).status, 401);
  assert.equal((await ask(answering(400, 'Bad Request'))).status, 401);
  assert.equal((await ask(answering(400, '{}'))).status, 401);
  assert.equal((await ask(answering(406, ''))).status, 401);
});

test('a 400 that carries a result code is a real error, not an expired session', async () => {
  assert.equal((await ask(answering(400, JSON.stringify({ status: '02', message: 'bad request' })))).status, 400);
  assert.equal((await ask(answering(500, ''))).status, 500);
});

test('through the service, a bare 400 at session start shows session expired, and nothing else is contacted', async (t) => {
  let calls = 0;
  const gateway = createHttpGateway({ tenants: { demo: 'https://gateway.test' }, fetch: async () => { calls += 1; return new Response('', { status: 400 }); } });
  const svc = await startService({ gateway, model: createFakeModel(['ok']) });
  t.after(svc.close);

  const res = await fetch_(svc.baseUrl, 'demo');

  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'session_expired');
  assert.equal(calls, 1, 'no retry');
});

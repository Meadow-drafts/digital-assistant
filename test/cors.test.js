import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';

const PORTAL = 'http://localhost:3001';

test('an allowed origin passes the preflight and gets CORS headers on the real call', async (t) => {
  const svc = await startService({ allowedOrigins: [PORTAL] });
  t.after(svc.close);

  const pre = await fetch(`${svc.baseUrl}/chat`, { method: 'OPTIONS', headers: { origin: PORTAL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), PORTAL);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);

  const res = await fetch(`${svc.baseUrl}/chat`, { method: 'POST', headers: { origin: PORTAL, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hi', tenant: 'demo' }) });
  assert.equal(res.headers.get('access-control-allow-origin'), PORTAL);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  await res.text();
});

test('any other origin, and a service with no list at all, get no CORS headers and a refused preflight', async (t) => {
  const listed = await startService({ allowedOrigins: [PORTAL] });
  const unset = await startService();
  t.after(listed.close);
  t.after(unset.close);

  for (const [svc, origin] of [[listed, 'http://evil.example'], [listed, 'http://localhost:3001.evil.example'], [unset, PORTAL]]) {
    const pre = await fetch(`${svc.baseUrl}/chat`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403, origin);
    assert.equal(pre.headers.get('access-control-allow-origin'), null, origin);
    const res = await fetch(`${svc.baseUrl}/chat`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hi', tenant: 'demo' }) });
    assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
    await res.text();
  }
});

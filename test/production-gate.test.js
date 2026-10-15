import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStartup, StartupError } from '../src/startup.js';
import { loadModelConfig } from '../src/model.js';
import { loadSupport } from '../src/support.js';
import { hashPassword } from '../src/password.js';
import { startService } from './harness/start-service.js';
import { call } from './harness/cases.js';

const ENTRY = new URL('../src/index.js', import.meta.url).pathname;
const DEMO_SUPPORT = new URL('../config/support.json', import.meta.url);

// A production configuration with every prerequisite met. Each test spoils one thing.
const goodSupport = () => ({
  agents: { list: [{ id: 'k1', name: 'Real Agent', email: 'agent@bank.example.org', password: hashPassword('a-long-real-secret-1') }], onCall: ['k1'], auditReaders: ['k1'], sessionMs: 1 },
  mail: { mode: 'smtp', from: 'assistant@bank.example.org', supportAddress: 'support@bank.example.org', smtp: { host: 'smtp.bank.example.org', port: 587 } },
});
const goodEnv = () => ({
  ASSISTANT_MODE: 'production',
  COMPLIANCE_AGREEMENT_CONFIRMED: 'true',
  MODEL_PRIMARY_BASE_URL: 'https://llm.bank.example.org/v1',
  MODEL_PRIMARY_NAME: 'bank-chosen-model',
  MODEL_PRIMARY_API_KEY: 'k',
  TOKEN_SCOPE: 'assistant:read',
  RETENTION_DAYS: '90',
});
const goodTenants = () => ({ bank: 'https://api.bank.example.org' });
const start = ({ env = goodEnv(), support = goodSupport(), tenants = goodTenants() } = {}) => assertStartup({ env, support, tenants, modelConfig: loadModelConfig(env) });

test('production with every prerequisite met starts', () => {
  assert.equal(start(), 'production');
});

const MISSING = [
  ['the compliance agreement flag', /compliance/i, (e) => { delete e.COMPLIANCE_AGREEMENT_CONFIRMED; }],
  ['the compliance flag set to anything but true', /compliance/i, (e) => { e.COMPLIANCE_AGREEMENT_CONFIRMED = 'yes please'; }],
  ['a model', /model/i, (e) => { for (const k of Object.keys(e)) if (k.startsWith('MODEL_')) delete e[k]; }],
  ['a model that is the demo model', /demo model/i, (e) => { e.MODEL_PRIMARY_NAME = 'qwen/qwen3.8-27b'; }],
  ['a fallback that is the demo model', /demo model/i, (e) => { Object.assign(e, { MODEL_FALLBACK_BASE_URL: 'https://x.test/v1', MODEL_FALLBACK_NAME: 'openai/gpt-oss-120b' }); }],
  ['a local offline model', /offline/i, (e) => { Object.assign(e, { MODEL_OFFLINE_BASE_URL: 'http://localhost:11434/v1', MODEL_OFFLINE_NAME: 'qwen2.5:7b' }); }],
  ['the scoped token setting', /scoped token/i, (e) => { delete e.TOKEN_SCOPE; }],
  ['a real retention value', /retention/i, (e) => { delete e.RETENTION_DAYS; }],
  ['a retention value that is not a positive number', /retention/i, (e) => { e.RETENTION_DAYS = '0'; }],
  ['a dev TEST_TOKEN', /TEST_TOKEN/, (e) => { e.TEST_TOKEN = 'eyJ.x.y'; }],
  ['a dev TEST_CLI', /TEST_CLI/, (e) => { e.TEST_CLI = '12345'; }],
  ['an X-API-UUID service key', /X-API-UUID/, (e) => { e.X_API_UUID = 'abc'; }],
];
for (const [what, message, spoil] of MISSING) {
  test(`production refuses to start with ${what}`, () => {
    const env = goodEnv();
    spoil(env);
    assert.throws(() => start({ env }), (err) => err instanceof StartupError && message.test(err.message) && /production/i.test(err.message));
  });
}

const SUPPORT_SPOILS = [
  ['demo agent logins', /agent/i, (s) => { s.agents.list.push({ id: 'aline', name: 'Aline', email: 'aline@example.test', password: 'change-me-aline' }); }],
  ['a plain-text agent password', /plain-text|hashed/i, (s) => { s.agents.list[0].password = 'a-long-real-secret-1'; }],
  ['a placeholder agent password', /agent/i, (s) => { s.agents.list[0].password = 'change-me-k1'; }],
  ['no support email', /support email/i, (s) => { s.mail.supportAddress = 'support@example.test'; }],
  ['the log-only mailer', /mailer/i, (s) => { s.mail.mode = 'log'; }],
  ['a local mail catcher', /mailer/i, (s) => { s.mail.smtp.host = 'localhost'; }],
  ['a placeholder sender', /mailer/i, (s) => { s.mail.from = 'assistant@example.test'; }],
];
for (const [what, message, spoil] of SUPPORT_SPOILS) {
  test(`production refuses to start with ${what}`, () => {
    const support = goodSupport();
    spoil(support);
    assert.throws(() => start({ support }), (err) => err instanceof StartupError && message.test(err.message));
  });
}

for (const [what, url] of [['the test server', 'https://m.bipay-test.bicec.com'], ['the test server in another case', 'https://M.BIPAY-TEST.bicec.com']]) {
  test(`production refuses a gateway URL that is ${what}`, () => {
    assert.throws(
      () => start({ tenants: { bank: 'https://api.bank.example.org', demo: url } }),
      (err) => err instanceof StartupError && /gateway/i.test(err.message) && /bipay-test/.test(err.message) && /demo/.test(err.message),
    );
  });
}

test('production refuses an agency gateway that forwards teller tokens over HTTP', () => {
  assert.throws(
    () => start({ tenants: { iwomi: { baseUrl: 'http://gateway.iwomi.example', apiPrefix: '/agencybank' } } }),
    (err) => err instanceof StartupError && /HTTPS gateway origins/i.test(err.message) && /iwomi/.test(err.message),
  );
});

test('a hashed agent password logs in; the wrong password does not; the hash is not accepted as the password', async (t) => {
  const hash = hashPassword('a-long-real-secret-1');
  assert.notEqual(hash, hashPassword('a-long-real-secret-1'), 'each hash has its own salt');
  const support = goodSupport();
  const svc = await startService({ agents: { ...support.agents, list: [{ ...support.agents.list[0], password: hash }] } });
  t.after(svc.close);
  const login = (password) => call(svc.baseUrl, 'POST', '/agent/login', { body: { id: 'k1', password } });
  assert.equal((await login('a-long-real-secret-1')).status, 200);
  assert.equal((await login('a-long-real-secret-2')).status, 401);
  assert.equal((await login(hash)).status, 401);
});

test('with several prerequisites missing, one message names every one of them', () => {
  const env = { ASSISTANT_MODE: 'production', TEST_TOKEN: 't' };
  const support = loadSupport(DEMO_SUPPORT);
  let message = '';
  try { assertStartup({ env, support, tenants: { demo: 'https://m.bipay-test.bicec.com' }, modelConfig: null }); } catch (e) { message = e.message; }
  for (const part of [/gateway/i, /compliance/i, /model/i, /scoped token/i, /retention/i, /agent/i, /support email|mailer/i, /TEST_TOKEN/]) assert.match(message, part);
});

test('demo mode starts with none of the prerequisites, on the demo configuration', () => {
  const env = {};
  assert.equal(assertStartup({ env, support: loadSupport(DEMO_SUPPORT), modelConfig: null }), 'demo');
  assert.equal(assertStartup({ env: { ASSISTANT_MODE: 'demo', TEST_TOKEN: 't', TEST_CLI: 'c' }, support: loadSupport(DEMO_SUPPORT), modelConfig: null }), 'demo');
});

test('a mode that is neither demo nor production is refused, so a typo cannot fall back to demo', () => {
  assert.throws(() => assertStartup({ env: { ASSISTANT_MODE: 'prod' }, support: loadSupport(DEMO_SUPPORT), modelConfig: null }), /ASSISTANT_MODE/);
});

// ---- the real entry point ----

function run(env, { until }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    const onData = (d) => { out += d; if (until.test(out)) child.kill(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('the entry point in production with nothing configured exits non-zero before listening, naming what is missing', async () => {
  const { code, out } = await run({ ASSISTANT_MODE: 'production', PORT: '0' }, { until: /\$^/ });
  assert.notEqual(code, 0);
  assert.match(out, /compliance/i);
  assert.match(out, /scoped token/i);
  assert.doesNotMatch(out, /assistant demo host/);
});

test('the entry point in demo mode with no environment starts', async () => {
  const { out } = await run({ PORT: '0' }, { until: /assistant demo host/ });
  assert.match(out, /assistant demo host/);
});

test('the entry point in production with every prerequisite met starts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(DEMO_SUPPORT, 'utf8'));
  raw.agents.list = [{ id: 'k1', name: 'Real Agent', email: 'agent@bank.example.org', password: hashPassword('a-long-real-secret-1') }];
  raw.agents.onCall = ['k1'];
  raw.agents.auditReaders = ['k1'];
  raw.mail = { mode: 'smtp', from: 'assistant@bank.example.org', supportAddress: 'support@bank.example.org', smtp: { host: 'smtp.bank.example.org', port: 587 } };
  const supportFile = join(dir, 'support.json');
  await writeFile(supportFile, JSON.stringify(raw));
  const tenantsFile = join(dir, 'tenants.json');
  await writeFile(tenantsFile, JSON.stringify(goodTenants()));
  const { out } = await run({ ...goodEnv(), PORT: '0', SUPPORT_CONFIG: supportFile, GATEWAY_TENANTS: tenantsFile, AUDIT_LOG: join(dir, 'a.jsonl'), FAILED_QUESTIONS_LOG: join(dir, 'f.jsonl') }, { until: /assistant demo host|production/i });
  assert.match(out, /mode: production/);
});

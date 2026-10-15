import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeModel } from './harness/fake-model.js';
import { startService } from './harness/start-service.js';
import { AGENTS, agentLogin, call } from './harness/cases.js';
import { openWidget } from './harness/open-widget.js';
import { chatTurn } from './harness/sse.js';
import { alice, begin, say, start } from './harness/t1-helpers.js';

const DAY = 24 * 60 * 60_000;

// Raw download: the export is a file, not a JSON API answer.
const download = async (svc, agent, query = '', method = 'GET') => {
  const res = await fetch(`${svc.baseUrl}/agent/audit/export${query}`, { method, headers: agent?.token ? { authorization: `Bearer ${agent.token}` } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const exported = async (svc, agent, query) => JSON.parse((await download(svc, agent, `?format=json${query ?? ''}`)).text);

// Two conversations on two different days, so date and conversation filters have something to separate.
async function scenario(t) {
  const a = alice();
  const model = createFakeModel(() => 'Here is what I found.');
  const svc = await start({ customers: [a], model });
  t.after(svc.close);
  const first = await begin(svc, a);
  await say(svc, a, 'How do I send money to another account? my account is 12345678901', first);
  await svc.clock.advance(3 * DAY);
  const second = await begin(svc, a);
  await say(svc, a, 'What are the fees?', second);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  return { a, svc, first, second, aline };
}

test('only an audit reader can export: no login 401, a customer token 401, an ordinary agent 403, other verbs refused', async (t) => {
  const { a, svc, aline } = await scenario(t);
  const paul = await agentLogin(svc.baseUrl, 'paul');

  assert.equal((await download(svc, null, '?format=json')).status, 401);
  assert.equal((await download(svc, { token: a.token }, '?format=json')).status, 401);
  assert.equal((await download(svc, paul, '?format=json')).status, 403);
  assert.equal((await download(svc, aline, '?format=json')).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await download(svc, aline, '?format=json', method)).status, 405, method);
});

test('the JSON export holds exactly the records the reader shows, as a download', async (t) => {
  const { svc, aline } = await scenario(t);
  const shown = (await call(svc.baseUrl, 'GET', '/agent/audit?limit=500', { token: aline.token })).body.records;

  const res = await download(svc, aline, '?format=json');
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="audit-.*\.json"$/);
  assert.deepEqual(JSON.parse(res.text), shown);
});

test('the export filters by date range, conversation id and outcome, like the reader', async (t) => {
  const { svc, first, second } = await scenario(t);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const all = await exported(svc, aline);
  const days = [...new Set(all.map((r) => r.time.slice(0, 10)))].sort();
  assert.equal(days.length, 2, 'the scenario spans two days');

  const byConversation = await exported(svc, aline, `&conversationId=${first}`);
  assert.ok(byConversation.length > 0 && byConversation.every((r) => r.conversationId === first));
  assert.ok(all.some((r) => r.conversationId === second));

  const byOutcome = await exported(svc, aline, '&outcome=session_started');
  assert.equal(byOutcome.length, 2);
  assert.ok(byOutcome.every((r) => r.outcome === 'session_started'));

  const firstDay = await exported(svc, aline, `&from=${days[0]}&to=${days[0]}`);
  assert.ok(firstDay.length > 0 && firstDay.every((r) => r.time.startsWith(days[0])), 'a bare "to" date includes that whole day');
  const lastDay = await exported(svc, aline, `&from=${days[1]}`);
  assert.ok(lastDay.length > 0 && lastDay.every((r) => r.time.startsWith(days[1])));
  const exact = await exported(svc, aline, `&from=${encodeURIComponent(all.at(-1).time)}&to=${encodeURIComponent(all.at(-1).time)}`);
  assert.ok(exact.length >= 1 && exact.every((r) => r.time === all.at(-1).time), 'date-times are inclusive at both ends');

  const reader = (await call(svc.baseUrl, 'GET', `/agent/audit?conversationId=${first}&from=${days[0]}&to=${days[0]}`, { token: aline.token })).body.records;
  assert.deepEqual(await exported(svc, aline, `&conversationId=${first}&from=${days[0]}&to=${days[0]}`), reader, 'reader and export agree on the same filter');

  assert.equal((await download(svc, aline, '?format=json&from=yesterday-ish')).status, 400);
  assert.equal((await download(svc, aline, '?format=xml')).status, 400);
});

test('the CSV export has a header row, one row per record, and escapes commas, quotes and line breaks', async (t) => {
  const { svc, aline } = await scenario(t);
  const records = await exported(svc, aline);

  const res = await download(svc, aline, '?format=csv');
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="audit-.*\.csv"$/);
  const rows = parseCsv(res.text);
  assert.deepEqual(rows[0].slice(0, 5), ['time', 'user', 'tenant', 'conversationId', 'outcome']);
  // The JSON export above and this download each added an audit_exported record, so compare against what the file itself must hold.
  assert.equal(rows.length - 1, records.length + 1);
  const column = rows[0].indexOf('userText');
  const typed = rows.slice(1).map((r) => r[column]).find((text) => /How do I send money/.test(text));
  assert.ok(typed && /8901/.test(typed) && !/12345678901/.test(typed), 'customer text is there, masked');
  assert.ok(rows.slice(1).every((r) => r.length === rows[0].length), 'every row has every column');
});

test('a CSV cell that a spreadsheet would run as a formula is neutralised', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(() => 'ok') });
  t.after(svc.close);
  const id = await begin(svc, a);
  await say(svc, a, '=HYPERLINK("http://evil.example","click")', id);
  const aline = await agentLogin(svc.baseUrl, 'aline');

  const { text } = await download(svc, aline, '?format=csv');
  assert.ok(!parseCsv(text).some((r) => r.some((cell) => cell.startsWith('='))), 'no cell starts with =');
  assert.match(text, /'=HYPERLINK/, 'the text is still there for the reviewer');
});

test('every export is itself in the audit log: who, when, the filter used and how many records', async (t) => {
  const { svc, first, aline } = await scenario(t);
  await svc.clock.advance(60_000);
  const before = svc.audit.records.length;

  const records = await exported(svc, aline, `&conversationId=${first}&outcome=ok`);
  const csv = await download(svc, aline, '?format=csv');

  assert.equal(svc.audit.records.length, before + 2);
  const [one, two] = svc.audit.records.slice(before);
  assert.equal(one.outcome, 'audit_exported');
  assert.equal(one.agent, 'aline');
  assert.equal(one.time, new Date(svc.clock.now()).toISOString());
  assert.equal(one.format, 'json');
  assert.deepEqual(one.filter, { from: null, to: null, conversationId: first, outcome: 'ok' });
  assert.equal(one.records, records.length);
  assert.equal(two.format, 'csv');
  assert.deepEqual(two.filter, { from: null, to: null, conversationId: null, outcome: null });
  assert.equal(two.records, before + 1, 'the count is of the records in the file: the earlier export is in it, this one is not');
  assert.equal(csv.status, 200);

  const inLog = (await exported(svc, aline)).filter((r) => r.outcome === 'audit_exported');
  assert.equal(inLog.length, 2, 'the later export contains the two earlier ones, not itself');
});

test('a refused or invalid export writes nothing to the audit log', async (t) => {
  const { svc, aline } = await scenario(t);
  const paul = await agentLogin(svc.baseUrl, 'paul');
  const before = svc.audit.records.length;

  await download(svc, paul, '?format=json');
  await download(svc, null, '?format=json');
  await download(svc, aline, '?format=xml');
  assert.equal(svc.audit.records.length, before);
});

test('the export respects retention: records the retention job has purged are not in it', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(() => 'ok'), retention: { ms: 30 * DAY } });
  t.after(svc.close);
  const old = await begin(svc, a);
  await say(svc, a, 'an old question', old);
  await svc.clock.advance(31 * DAY);
  const fresh = await begin(svc, a);
  await say(svc, a, 'a new question', fresh);
  const aline = await agentLogin(svc.baseUrl, 'aline');

  await svc.server.retention.run();
  const records = await exported(svc, aline);

  assert.ok(records.length > 0);
  assert.ok(records.every((r) => r.conversationId === fresh), 'nothing older than the retention period');
  assert.ok(!JSON.stringify(records).includes('an old question'));
});

// Minimal RFC 4180 reader, enough to check what the service wrote.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; } else cell += ch;
  }
  return rows;
}

// ---- the download buttons in the console's audit view ----

test('the console audit view downloads the CSV and the JSON export for the filters on screen', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  await chatTurn(svc.baseUrl, { message: 'my account is 12345678901, hello', tenant: 'demo' });
  await svc.clock.advance(2 * DAY);
  await chatTurn(svc.baseUrl, { message: 'a second one', tenant: 'demo' });
  const today = new Date(svc.clock.now()).toISOString().slice(0, 10);

  const w = await openWidget(svc.baseUrl, '/console');
  t.after(() => w.dom.window.close());
  w.document.body.dataset.pollMs = '20';
  // jsdom has no object URLs or navigation: capture what the page would have handed to the browser as a download.
  const saved = [];
  const win = w.dom.window;
  win.URL.createObjectURL = (blob) => { saved.push({ blob }); return `blob:test-${saved.length}`; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function click() { saved.at(-1).name = this.download; };
  const textOf = (blob) => new Promise((resolve) => { const r = new win.FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });

  w.q('agent-id').value = 'aline';
  w.q('agent-password').value = AGENTS.list.find((a) => a.id === 'aline').password;
  w.q('login-form').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => !w.q('console').hidden);
  w.q('audit-open').click();
  await w.until(() => w.qa('audit-row').length === 2);

  w.q('audit-from').value = today;
  w.q('audit-to').value = today;
  w.q('audit-export-csv').click();
  await w.until(() => saved.length === 1 && saved[0].name);
  assert.match(saved[0].name, /^audit-.*\.csv$/);
  assert.equal(saved[0].blob.type, 'text/csv;charset=utf-8');
  const csv = await textOf(saved[0].blob);
  assert.match(csv, /a second one/);
  assert.doesNotMatch(csv, /hello/, 'the date range on screen limits the file');
  assert.doesNotMatch(csv, /12345678901/);

  w.q('audit-from').value = '';
  w.q('audit-to').value = '';
  w.q('audit-outcome').value = 'ok';
  w.q('audit-export-json').click();
  await w.until(() => saved.length === 2 && saved[1].name);
  assert.match(saved[1].name, /^audit-.*\.json$/);
  const records = JSON.parse(await textOf(saved[1].blob));
  assert.ok(records.length === 2 && records.every((r) => r.outcome === 'ok'));
});

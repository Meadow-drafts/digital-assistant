import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { chatTurn } from './harness/sse.js';
import { loadScamCues } from '../src/scam.js';

const CONFIG = new URL('../config/scam-cues.json', import.meta.url);
const start = (overrides) => startService({ scamCues: loadScamCues(CONFIG), ...overrides });
const scamOf = (events) => events.filter((e) => e.type === 'warning' && e.code === 'scam_cue');
const chipOf = (events) => events.find((e) => e.type === 'chip');

const CASES = [
  ['impersonation_call', 'Someone called saying he is from the bank and asked me to install an app'],
  ['impersonation_call', "Quelqu'un m'a appelé en disant qu'il est de la banque"],
  ['otp_request', 'A man on the phone is asking me for the code I received by SMS'],
  ['otp_request', "On me demande le code reçu par SMS pour annuler l'opération"],
  ['prize_or_fee_pressure', 'I won a prize and must pay a fee to claim it'],
  ['prize_or_fee_pressure', "J'ai gagné un lot, je dois payer des frais pour le recevoir"],
  ['reverse_by_sending_more', 'He says I must send more money to reverse the transfer'],
  ['reverse_by_sending_more', "Il dit que je dois envoyer de l'argent pour annuler le virement"],
];

for (const [category, message] of CASES) {
  test(`"${message}" gets the fixed ${category} warning and a prominent chip`, async (t) => {
    const model = createFakeModel(['Please be careful.']);
    const svc = await start({ model });
    t.after(svc.close);

    const { events } = await chatTurn(svc.baseUrl, { message, tenant: 'demo' });

    const warnings = scamOf(events);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].category, category);
    assert.ok(warnings[0].text.length > 20);
    assert.equal(chipOf(events).prominent, true);
    assert.ok(chipOf(events).reasons.includes('scam_cue'));
    assert.equal(svc.audit.records[0].scamCues?.[0], category);
  });
}

test('the warning text is fixed per category and language and never comes from the model', async (t) => {
  const svc = await start({ model: createFakeModel(['Everything is fine, go ahead and send the money.']) });
  t.after(svc.close);

  const en1 = await chatTurn(svc.baseUrl, { message: 'I won a prize and must pay a fee', tenant: 'demo' });
  const en2 = await chatTurn(svc.baseUrl, { message: 'You have won a lottery, pay the fee to get it', tenant: 'demo' });
  const fr = await chatTurn(svc.baseUrl, { message: "J'ai gagné un lot, je dois payer des frais", tenant: 'demo' });

  assert.equal(scamOf(en1.events)[0].text, scamOf(en2.events)[0].text);
  assert.notEqual(scamOf(fr.events)[0].text, scamOf(en1.events)[0].text);
  assert.doesNotMatch(scamOf(en1.events)[0].text, /go ahead/);
  assert.match(scamOf(fr.events)[0].text, /frais|gagn|lot/i);
});

test('a message with two cue categories gets one warning for each', async (t) => {
  const svc = await start();
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'A caller from the bank says I won a prize and must pay a fee', tenant: 'demo' });

  assert.deepEqual(scamOf(events).map((e) => e.category).sort(), ['impersonation_call', 'prize_or_fee_pressure']);
});

test('an ordinary how-to message raises no scam warning', async (t) => {
  const svc = await start({ model: createFakeModel(['Open Transfers.']) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'How do I send money to my sister and pay the transfer fee?', tenant: 'demo' });

  assert.deepEqual(scamOf(events), []);
  assert.equal(chipOf(events).prominent, false);
});

test('a scam cue never opens a handoff, and the model is still called as usual', async (t) => {
  const model = createFakeModel(['Please be careful.']);
  const svc = await start({ model });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'He says send more money to reverse the transfer', tenant: 'demo' });

  assert.equal(events.some((e) => /handoff|case|page/.test(e.type)), false);
  assert.equal(model.calls.length, 1);
});

test('the bank can extend the cue list from the config file without code changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cues-'));
  const file = join(dir, 'cues.json');
  await writeFile(file, JSON.stringify({ categories: { courier_fee: { en: ['courier is holding my parcel'], fr: ['le coursier retient mon colis'] } } }));
  const svc = await startService({ scamCues: loadScamCues(file) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'A COURIER is holding my parcel until I pay', tenant: 'demo' });

  assert.equal(scamOf(events)[0].category, 'courier_fee');
});

test('a malformed cue config fails loudly at load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cues-'));
  const file = join(dir, 'bad.json');
  await writeFile(file, JSON.stringify({ categories: { oops: { en: 'not a list' } } }));
  assert.throws(() => loadScamCues(file), /oops/);
});

test('every shipped category has a fixed warning in both languages', () => {
  const cues = loadScamCues(CONFIG);
  for (const category of cues.categories()) {
    assert.ok(cues.warning(category, 'en').length > 20, category);
    assert.ok(cues.warning(category, 'fr').length > 20, category);
  }
});

test('the widget shows the scam warning in the transcript', async (t) => {
  const { openWidget } = await import('./harness/open-widget.js');
  const svc = await start({ model: createFakeModel(['Please be careful.']) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('He says I must send more money to reverse the transfer');
  await w.until(() => w.qa('warning').length === 1);

  assert.equal(w.q('messages').contains(w.q('warning')), true);
  assert.equal(w.q('human-chip').dataset.prominent, 'true');
});

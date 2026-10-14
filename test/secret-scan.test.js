import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, LEAK, drive } from './harness/secret-scan.js';
import { alice } from './harness/t1-helpers.js';

test('no PIN, OTP, card number, token or PIN hash appears in the audit, the logs, the model input or any email, through every feature', async (t) => {
  const { surfaces, svc } = await drive(t);

  for (const [surface, text] of Object.entries(surfaces)) {
    for (const [name, pattern] of LEAK) assert.doesNotMatch(text, pattern, `${name} is in ${surface}`);
  }
  // the forwarded token and the full account number never get into what is stored or sent either
  const stored = ['the audit log', 'the audit reader', 'the audit export (JSON)', 'the audit export (CSV)', 'the logs', 'the failed-question log', 'the email bodies', 'the agent console'];
  const a = alice();
  for (const surface of stored) {
    assert.ok(!surfaces[surface].includes(a.token), `the session token is in ${surface}`);
    assert.doesNotMatch(surfaces[surface], new RegExp(ACCOUNT), `the full account number is in ${surface}`);
  }

  // the scan is only worth something if the conversation really went through each feature
  const outcomes = new Set(svc.audit.records.map((r) => r.outcome));
  for (const wanted of ['ok', 'session_started', 'balance_unlocked_pin', 'handoff_opened', 'case_claimed', 'case_paged', 'draft_sent', 'case_still_working', 'case_rebroadcast', 'relayed_to_agent', 'customer_emailed']) {
    assert.ok(outcomes.has(wanted), `the conversation never reached ${wanted}`);
  }
  const used = svc.audit.records;
  assert.ok(used.some((r) => r.refusalCategory === 'execute'), 'refusal');
  assert.ok(used.some((r) => r.scamCues?.length), 'scam cue');
  assert.ok(used.some((r) => r.navigate?.outcome === 'offered'), 'navigate card');
  assert.ok(used.some((r) => r.prefill?.outcome === 'offered'), 'pre-fill card');
  assert.deepEqual(['last_transactions', 'transfer_status', 'explain_failure', 'fees_limits', 'balance'].filter((n) => !used.some((r) => r.tool === n)), [], 'every read tool');
  assert.ok(svc.failedQuestions.records.length >= 1, 'failed question');
  assert.ok(svc.model.calls.some((c) => c.purpose === 'summary'), 'summary');
  assert.ok(svc.mailer.outbox.length >= 3, 'paging and customer emails were sent');
});

test('the audit export files from the scan conversation are real, carry the reader\'s records, and hold none of the secrets', async (t) => {
  const { audited, exportedJson, exportedCsv } = await drive(t);

  const records = JSON.parse(exportedJson);
  assert.ok(records.length > 20, 'the export is not an empty file that trivially passes the search');
  assert.ok(records.length <= 500, 'small enough for the reader to show it all');
  assert.deepEqual(records, audited.body.records, 'same masked records as the reader');
  assert.match(exportedCsv.split('\r\n')[0], /^time,user,tenant,conversationId,outcome,/);
  assert.ok(exportedCsv.split('\r\n').length > records.length, 'one CSV row per record');
  for (const [name, pattern] of LEAK) {
    assert.doesNotMatch(exportedJson, pattern, `${name} is in the JSON export`);
    assert.doesNotMatch(exportedCsv, pattern, `${name} is in the CSV export`);
  }
});

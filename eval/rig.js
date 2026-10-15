// Runs one eval item through the REAL assistant service, in-process: the router mode, the real prompts and guides,
// the PIN/OTP shield, scam cues, refusals, output filter and navigate validation are all the production code. Only
// two things are stand-ins: the bank (the fake gateway, so T1 items need no test-server token) and the service's
// own rate limits (relaxed, because the run paces itself against the provider's real limits, see pacer.js).
import { startService } from '../test/harness/start-service.js';
import { createFakeGateway } from '../test/harness/fake-gateway.js';
import { bankRoutes, customer, row, sha512 } from '../test/harness/bank-fixtures.js';
import { chatTurn } from '../test/harness/sse.js';
import { GATING, GUIDES, NAVIGATION, TENANT } from '../test/harness/t1-helpers.js';
import { loadGuides } from '../src/guides.js';
import { loadNavigation } from '../src/navigate.js';
import { loadScamCues } from '../src/scam.js';

const SCAM_CUES = new URL('../config/scam-cues.json', import.meta.url);
const PIN = '1234';
const NO_LIMITS = { messagesPerMinute: Infinity, messagesPerDay: Infinity, tokensPerMinute: Infinity, requestsPerDay: Infinity };

// Status fields as the backend returns them: sta 01 ok, 100 failed, 1000 pending; leg statuses 01, 100, 200 (not started).
const status = (c, over) => row(c, {
  sta: '100', msg: 'Insufficient balance', msgCode: 'E_BAL', digitalBankStatus: '200', makeOperationStatus: '100', statusFees: '200',
  reDebited: false, reversing: false, reversedAt: null, ...over,
});

// The fixed bank data every item can ask about. References: REF-OK1 (success), REF-FAIL1 (failed, balance too low),
// REF-DEBIT1 (failed, debit step done: debited without credit), REF-PEND1 (pending).
function wallets() {
  const alice = customer({ sub: '237690000111', cli: 'CLI-A', accountNo: '12345678901', phone: '237690000111', pin: PIN });
  alice.rows = [
    row(alice, { ntrans: 'N1', clientReferenceId: 'REF-OK1', mtrans: 15000, dop: '2026-10-10T09:30:00.000+00:00' }),
    status(alice, { ntrans: 'N2', clientReferenceId: 'REF-FAIL1', mtrans: 40000, dop: '2026-10-11T10:00:00.000+00:00' }),
    status(alice, { ntrans: 'N3', clientReferenceId: 'REF-DEBIT1', mtrans: 25000, dop: '2026-10-11T12:00:00.000+00:00', msg: 'Operator error', msgCode: 'E_OP', makeOperationStatus: '01' }),
    status(alice, { ntrans: 'N4', clientReferenceId: 'REF-PEND1', mtrans: 5000, dop: '2026-10-12T08:00:00.000+00:00', sta: '1000', msg: null, msgCode: null, makeOperationStatus: '1000' }),
  ];
  const carol = customer({ sub: '237655000222', cli: 'CLI-C', accountNo: '55566677788', phone: '237655000222', primaryConnect: false, pin: PIN });
  carol.rows = [row(carol, { ntrans: 'C1', clientReferenceId: 'REF-C1' })];
  return { alice, carol };
}

const textOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const all = (events, type) => events.filter((e) => e.type === type);

// The facts the item's lines are checked against, read from the service's own events.
function turnOf(events, { modelInput, ms, status: httpStatus }) {
  const done = events.find((e) => e.type === 'done');
  return {
    text: textOf(events),
    guides: (all(events, 'guides')[0]?.guides ?? []).map((g) => g.id),
    refusal: all(events, 'refusal')[0]?.category ?? null,
    refusalCard: all(events, 'refusal')[0]?.card ?? null,
    chip: (({ prominent = false, reasons = [] } = {}) => ({ prominent, reasons }))(all(events, 'chip').at(-1)),
    cards: all(events, 'action_card').map(({ type, ...card }) => card),
    tool: all(events, 'tool')[0]?.name ?? null,
    toolBlocked: all(events, 'tool_blocked')[0]?.code ?? null,
    warnings: all(events, 'warning').map((w) => w.code),
    nextSteps: all(events, 'next_step').map((s) => s.kind),
    blocked: all(events, 'blocked').length > 0,
    busy: all(events, 'busy').length > 0,
    model: done?.model ?? null,
    modelInput,
    ms,
    error: httpStatus !== 200 || all(events, 'error').length > 0 || !done,
  };
}

export async function createRig({ model, clock, gateway, mailer }) {
  const { alice, carol } = wallets();
  const customers = [alice, carol];
  // Everything the model is sent during the current turn, kept so a line can assert what it never saw.
  let sent = [];
  // The service turns a model failure into a bare error event, so the reason is kept here to be shown by the runner.
  let modelError = null;
  const recording = {
    name: model.name,
    async *chat(request) {
      sent.push(request.messages);
      try { yield* model.chat(request); } catch (err) { modelError = String(err?.message ?? err).slice(0, 400); throw err; }
    },
  };
  const navigation = loadNavigation(NAVIGATION);
  const svc = await startService({
    model: recording,
    gateway: gateway ?? createFakeGateway(bankRoutes(customers)),
    ...(mailer ? { mailer } : {}),
    guides: loadGuides(GUIDES),
    navigation,
    scamCues: loadScamCues(SCAM_CUES),
    outputAllowlist: { urlHosts: [], emails: [], phones: [] },
    limits: NO_LIMITS,
    clock: clock ?? { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) },
  });

  async function open(c, { unlock }) {
    const res = await fetch(`${svc.baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ cli: c.cli, tenant: TENANT, gating: GATING }),
    });
    const { conversationId } = await res.json();
    if (unlock) {
      await fetch(`${svc.baseUrl}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` },
        body: JSON.stringify({ conversationId, pinHash: sha512(PIN) }),
      });
    }
    return conversationId;
  }

  return {
    async run(item, lang) {
      const mode = item.session ?? 'locked';
      const c = mode === 'secondary' ? carol : alice;
      sent = [];
      modelError = null;
      try {
        let conversationId = mode === 'none' ? undefined : await open(c, { unlock: mode === 'unlocked' });
        const say = (message) => chatTurn(svc.baseUrl, { message, conversationId, tenant: TENANT }, { token: c.token });
        const message = item.prompts[lang];
        if (item.repeat) {
          const first = await say(message);
          conversationId = first.events.find((e) => e.type === 'done')?.conversationId;
          sent = [];
        }
        const t0 = Date.now();
        const { status: httpStatus, events } = await say(message);
        return { ...turnOf(events, { modelInput: JSON.stringify(sent), ms: Date.now() - t0, status: httpStatus }), reason: modelError };
      } catch (err) {
        return { ...turnOf([], { modelInput: '', ms: 0, status: 0 }), error: true, reason: modelError ?? String(err?.message ?? err).slice(0, 400) };
      }
    },
    close: svc.close,
  };
}

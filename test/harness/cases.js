import { chatTurn } from './sse.js';

// Demo support agents for tests (the real list comes from config). Aline is on call.
export const AGENTS = {
  list: [
    { id: 'aline', name: 'Aline Mbarga', email: 'aline@bank.test', password: 'aline-pass' },
    { id: 'paul', name: 'Paul Etoga', email: 'paul@bank.test', password: 'paul-pass' },
  ],
  onCall: ['aline'],
  // Staff allowed to read the audit log; Paul is an ordinary agent.
  auditReaders: ['aline'],
};
export const CONSOLE_URL = 'https://support.bank.test/console';

export async function call(baseUrl, method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A customer's started conversation (one chat turn) and the customer-side calls on its case.
export async function customer(baseUrl, token = 'test-token', first = 'How do I send money?') {
  const { events } = await chatTurn(baseUrl, { message: first, tenant: 'demo' }, { token });
  const conversationId = events.at(-1).conversationId;
  return {
    conversationId,
    token,
    handoff: () => call(baseUrl, 'POST', '/handoff', { token, body: { conversationId } }),
    status: (after = 0) => call(baseUrl, 'GET', `/case?conversationId=${conversationId}&after=${after}`, { token }),
    cancel: () => call(baseUrl, 'POST', '/case/cancel', { token, body: { conversationId } }),
    feedback: (solved) => call(baseUrl, 'POST', '/case/feedback', { token, body: { conversationId, solved } }),
    say: (message) => chatTurn(baseUrl, { message, tenant: 'demo', conversationId }, { token }),
  };
}

export async function agentLogin(baseUrl, id = 'aline') {
  const agent = AGENTS.list.find((a) => a.id === id);
  const res = await call(baseUrl, 'POST', '/agent/login', { body: { id, password: agent.password } });
  const token = res.body.token;
  return {
    token,
    list: () => call(baseUrl, 'GET', '/agent/cases', { token }),
    open: (ref) => call(baseUrl, 'GET', `/agent/cases/${ref}`, { token }),
    claim: (ref) => call(baseUrl, 'POST', `/agent/cases/${ref}/claim`, { token }),
    reply: (ref, text) => call(baseUrl, 'POST', `/agent/cases/${ref}/messages`, { token, body: { text } }),
    resolve: (ref) => call(baseUrl, 'POST', `/agent/cases/${ref}/resolve`, { token }),
    transfer: (ref, to) => call(baseUrl, 'POST', `/agent/cases/${ref}/transfer`, { token, body: { to } }),
  };
}

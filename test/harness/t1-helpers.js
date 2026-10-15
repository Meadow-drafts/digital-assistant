import { startService } from './start-service.js';
import { createFakeModel } from './fake-model.js';
import { createFakeGateway } from './fake-gateway.js';
import { bankRoutes, customer } from './bank-fixtures.js';
import { chatTurn } from './sse.js';
import { loadGuides } from '../../src/guides.js';
import { loadNavigation } from '../../src/navigate.js';

export const GUIDES = new URL('../../guides/', import.meta.url);
export const NAVIGATION = new URL('../../config/navigate-routes.json', import.meta.url);
export const TENANT = 'demo';

// The router call picks a tool; every other call answers from the data it was given.
export const toolModel = (tool, answer = ['Here is what I found.']) =>
  createFakeModel((request) => (request.purpose === 'route' ? tool : answer));

export const alice = () => customer({ sub: '237690000111', cli: 'CLI-A', accountNo: '12345678901', phone: '237690000111' });
export const bob = () => customer({ sub: '237655000222', cli: 'CLI-B', accountNo: '55566677788', phone: '237655000222' });

export async function start({ customers, model, ...rest }) {
  const gateway = createFakeGateway(bankRoutes(customers, rest.fixtures));
  const navigation = loadNavigation(NAVIGATION);
  const svc = await startService({ guides: loadGuides(GUIDES), navigation, gateway, model, ...rest });
  return svc;
}
export const GATING = { usePackages: false, primaryConnect: true };
export const say = (svc, c, message, conversationId) => chatTurn(svc.baseUrl, { message, conversationId, tenant: TENANT }, { token: c.token });
// Session start: the widget sends the customer's cli once, with the token; chat then carries only the token and the id.
export async function open(svc, c, { cli = c.cli, gating = GATING, token = c.token, conversationId } = {}) {
  const res = await fetch(`${svc.baseUrl}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ cli, tenant: TENANT, gating, conversationId }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, ...body };
}
export const begin = async (svc, c, opts) => (await open(svc, c, opts)).conversationId;
export const wire = (events) => JSON.stringify(events);

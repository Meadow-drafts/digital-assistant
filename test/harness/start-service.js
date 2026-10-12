import { createService } from '../../src/service.js';
import { createFakeModel } from './fake-model.js';
import { createFakeGateway } from './fake-gateway.js';
import { createFakeMailer } from './fake-mailer.js';
import { createFakeClock } from './fake-clock.js';
import { createMemoryAudit } from './memory-audit.js';

// Boots the real service on an ephemeral port with all collaborators faked.
// Any fake can be overridden; later tickets add their own via `overrides`.
export async function startService(overrides = {}) {
  const deps = {
    model: createFakeModel(),
    gateway: createFakeGateway(),
    mailer: createFakeMailer(),
    clock: createFakeClock(),
    audit: createMemoryAudit(),
    ...overrides,
  };
  const server = createService(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { ...deps, server, baseUrl, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

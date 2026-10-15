import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(value) {
  return typeof value === 'string' || value instanceof URL
    ? JSON.parse(readFileSync(value instanceof URL ? fileURLToPath(value) : value, 'utf8'))
    : structuredClone(value);
}

// The pilot is deliberately one BICEC deployment. Keeping this profile strict
// prevents a tenant id from turning this process into a shared bank runtime.
export function loadAgencyProfile(source, { baseUrl = process.env.AGENCY_GATEWAY_BASE_URL } = {}) {
  const config = read(source);
  if (config?.id !== 'bicec-agency' || !config.tenants || Object.keys(config.tenants).length !== 1) {
    throw new Error('agency profile must configure exactly one tenant');
  }
  const [tenantId, tenant] = Object.entries(config.tenants)[0];
  const origin = baseUrl || tenant.baseUrl;
  if (!/^https?:\/\/[^/\s]+$/.test(origin ?? '')) throw new Error('agency gateway base URL must be an origin');
  if (tenantId !== 'bicec-agency' || tenant.apiPrefix !== '/agencybank') throw new Error('BICEC must use the /agencybank agency API prefix');
  if (!config.dataDirectory || !config.guidesDirectory) throw new Error('agency profile must isolate its stores and guides');
  return Object.freeze({
    ...config,
    tenants: Object.freeze({ [tenantId]: Object.freeze({ baseUrl: origin, apiPrefix: tenant.apiPrefix }) }),
  });
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(value) {
  return typeof value === 'string' || value instanceof URL
    ? JSON.parse(readFileSync(value instanceof URL ? fileURLToPath(value) : value, 'utf8'))
    : structuredClone(value);
}

// Agency tenant ids select only an entry from this server-side allowlist. The
// browser never supplies a gateway URL.
export function loadAgencyProfile(source, {
  tenantId = process.env.ASSISTANT_TENANT_ID,
  tenantOverrides = {},
  baseUrl = process.env.AGENCY_GATEWAY_BASE_URL,
} = {}) {
  const config = read(source);
  if (!['agency-banking', 'bicec-agency'].includes(config?.id) || !config.tenants || !Object.keys(config.tenants).length) {
    throw new Error('agency profile must configure at least one tenant');
  }
  for (const tenantId of Object.keys(tenantOverrides)) {
    if (!Object.hasOwn(config.tenants, tenantId)) throw new Error(`gateway override references an unknown agency tenant: ${tenantId}`);
  }
  if (config.defaultTenant && !Object.hasOwn(config.tenants, config.defaultTenant)) throw new Error('agency profile defaultTenant must be in its tenant allowlist');
  const selectedTenantId = tenantId ?? config.defaultTenant ?? (Object.keys(config.tenants).length === 1 ? Object.keys(config.tenants)[0] : null);
  if (!selectedTenantId || !Object.hasOwn(config.tenants, selectedTenantId)) throw new Error('ASSISTANT_TENANT_ID must name a configured agency tenant');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(selectedTenantId)) throw new Error(`agency tenant id is invalid: ${selectedTenantId}`);
  const tenant = config.tenants[selectedTenantId];
  const override = tenantOverrides[selectedTenantId];
  const origin = (typeof override === 'string' ? override : override?.baseUrl) ?? baseUrl ?? tenant.baseUrl;
  if (!/^https?:\/\/[^/\s]+$/.test(origin ?? '')) throw new Error(`agency tenant ${selectedTenantId}: gateway base URL must be an origin`);
  if (tenant.apiPrefix !== '/agencybank') throw new Error(`agency tenant ${selectedTenantId} must use the /agencybank agency API prefix`);
  const dataDirectory = tenant.dataDirectory ?? config.dataDirectory;
  const supportConfig = tenant.supportConfig ?? config.supportConfig;
  const navigationConfig = tenant.navigationConfig ?? config.navigationConfig;
  if (!dataDirectory || !supportConfig || !config.guidesDirectory) throw new Error('agency tenant must configure isolated storage, support, and shared guides');
  return Object.freeze({
    ...config,
    tenantId: selectedTenantId,
    defaultTenant: selectedTenantId,
    dataDirectory,
    supportConfig,
    navigationConfig,
    tenants: Object.freeze({ [selectedTenantId]: Object.freeze({ baseUrl: origin, apiPrefix: tenant.apiPrefix }) }),
  });
}

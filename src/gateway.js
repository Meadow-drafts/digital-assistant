import { readFileSync } from 'node:fs';

export class UnknownTenantError extends Error {}

// Tenant id -> gateway base URL. The only place a gateway URL can come from:
// the widget sends a tenant id, never a URL.
export function loadTenants(pathOrUrl) {
  const tenants = JSON.parse(readFileSync(pathOrUrl, 'utf8'));
  for (const [id, url] of Object.entries(tenants)) {
    if (!/^https?:\/\/[^/\s]+$/.test(url)) throw new Error(`tenant ${id}: base URL must be an origin without a path`);
  }
  return tenants;
}

// HTTP gateway client. Sends the user's own token as the Authorization header
// (the raw token, as the portal does) and nothing else: no service key. The
// backend reports an expired or unauthorised token as HTTP 200 with a
// 401/409 `status` in the body, or as a bare 400; both are normalised to
// 401/409 here.
export function createHttpGateway({ tenants, fetch: doFetch = globalThis.fetch, timeoutMs = 15000 }) {
  return {
    async request({ tenant, method, path, query, token, body }) {
      if (!Object.hasOwn(tenants, tenant ?? '')) throw new UnknownTenantError('tenant is not in the allowlist');
      const url = new URL(path, tenants[tenant]);
      for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
      const res = await doFetch(url, {
        method,
        headers: { authorization: token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const parsed = await res.json().catch(() => null);
      const inBody = Number(parsed?.status);
      if (res.status === 200 && (inBody === 401 || inBody === 409)) return { status: inBody, body: parsed };
      // The test server answers an invalid, tampered or expired token with a bare 400 (no status or
      // success code in the body), and a missing Authorization header with a bare 406. Both mean the
      // token is no good, so they are reported as 401. A 400 that carries a result code stays a 400.
      const hasCode = parsed && typeof parsed === 'object' && ['status', 'statut', 'success'].some((k) => k in parsed);
      if ((res.status === 400 || res.status === 406) && !hasCode) return { status: 401, body: null };
      return { status: res.status, body: parsed };
    },
  };
}

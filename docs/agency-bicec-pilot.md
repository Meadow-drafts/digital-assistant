# Multi-tenant agency assistant

Run each teller assistant as a separate process from the BPay customer assistant and from the other agency tenant. Each process selects exactly one tenant, support roster, and data directory. Both deployments load the shared agency guides. The widget sends a tenant id, but the backend accepts only the tenant configured for that process.

```sh
ASSISTANT_PROFILE=agency-banking \
ASSISTANT_TENANT_ID=iwomi-agency \
AGENCY_GATEWAY_BASE_URL=https://<iwomi-agency-gateway-origin> \
ALLOWED_ORIGINS=https://<iwomi-agency-origin> \
PORT=3011 npm start
```

For BICEC, set `ASSISTANT_TENANT_ID=bicec-agency` and its matching `AGENCY_GATEWAY_BASE_URL` on a separate process and port. The origin must match the tenant's deployed front-office API config and must not include `/agencybank`; the assistant adds the prefix and approved endpoint path. The checked-in profile has development defaults based on the front-office tenant config. Production must override them with the production HTTPS origin. Do not use a consumer-wallet or `/digitalbank` origin.

The BICEC process writes its session secret, SQLite conversations/cases, audit log and failed-question log under `data/agency-bicec/`; IWOMI uses `data/agency-iwomi/`. Their support rosters are `config/agency-bicec/support.json` and `config/agency-iwomi/support.json`. Replace each roster's demo identity/contact details before enabling staff access. Do not point either database or log path at the BPay service's stores or at the other tenant's stores.

In the front-office build, set `REACT_APP_ASSISTANT_URL_BICEC` and `REACT_APP_ASSISTANT_URL_IWOMI` to the corresponding isolated assistant origins. (`REACT_APP_ASSISTANT_URL` remains a BICEC fallback.) The widget maps the active front-office tenant to its assistant tenant and URL, and reads the current bearer token through the portal storage service. The host sends a route path as a context hint; it cannot enable a route that is absent from the assistant's navigation allowlist. Backend workflow-entitlement verification is still missing a concrete check contract, so page-specific links remain disabled.

The shared English and French agency workflow guides are in `guides-agency-bicec/`. Confirm that every shared procedure applies to both tenants before production. Fees, limits, eligibility, corridors, exceptions, and other unprovided policy remain omitted or deferred.

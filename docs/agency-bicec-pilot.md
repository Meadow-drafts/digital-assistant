# Isolated BICEC agency pilot

Run the teller assistant as a separate process from the BPay customer assistant. The profile permits one tenant only (`bicec-agency`) and fixes its API prefix to `/agencybank`. Set the gateway origin from the active BICEC front-office tenant configuration; the widget never supplies a gateway URL.

```sh
ASSISTANT_PROFILE=bicec-agency \
AGENCY_GATEWAY_BASE_URL=https://m.bipay-test.bicec.com \
ALLOWED_ORIGINS=https://<agency-front-office-origin> \
PORT=3010 npm start
```

`AGENCY_GATEWAY_BASE_URL` is the API origin used by the signed-in BICEC agency front office, without the `/agencybank` path. The current BICEC tenant config sets it to `https://m.bipay-test.bicec.com`; the assistant appends `/agencybank` and then the approved endpoint path. Use the matching origin from the deployed front-office tenant config in each environment. Do not use a consumer-wallet or `/digitalbank` origin.

The process writes its session secret, SQLite conversations/cases, audit log and failed-question log under `data/agency-bicec/`. Its support roster is `config/agency-bicec/support.json`. Replace the demo support identity/contact details before enabling staff access. Do not point its database or log paths at the BPay service's stores.

In the front-office build, set `REACT_APP_ASSISTANT_URL` to the isolated assistant origin. The widget is mounted only for a signed-in BICEC teller and reads the current bearer token through the portal storage service. The host sends a route path as a context hint; it cannot enable contextual page suggestions or navigation. Backend workflow-entitlement verification is still missing a concrete check contract, so the agency service returns no page-specific context or links.

The bank-approved English and French workflow guides are in `guides-agency-bicec/`. They intentionally do not carry navigation routes while workflow entitlements cannot be verified. Fees, limits, eligibility, corridors, exceptions, and other unprovided policy remain omitted or deferred.

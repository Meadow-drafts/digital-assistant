# Isolated BICEC agency pilot

Run the teller assistant as a separate process from the BPay customer assistant. The profile permits one tenant only (`bicec-agency`) and fixes its API prefix to `/agencybank`. Set the gateway origin from the active BICEC front-office tenant configuration; the widget never supplies a gateway URL.

```sh
ASSISTANT_PROFILE=bicec-agency \
AGENCY_GATEWAY_BASE_URL=https://<configured-bicec-api-origin> \
ALLOWED_ORIGINS=https://<agency-front-office-origin> \
PORT=3010 npm start
```

The process writes its session secret, SQLite conversations/cases, audit log and failed-question log under `data/agency-bicec/`. Its support roster is `config/agency-bicec/support.json`. Replace the demo support identity/contact details before enabling staff access. Do not point its database or log paths at the BPay service's stores.

In the front-office build, set `REACT_APP_ASSISTANT_URL` to the isolated assistant origin. The widget is mounted only for a signed-in BICEC teller and reads the current bearer token through the portal storage service. The host sends a route path as a context hint; it cannot enable contextual page suggestions or navigation. Backend workflow-entitlement verification is unresolved, so the agency service returns no page-specific context or links.

All teller guide files in `guides-agency-bicec/` are bilingual implementation-derived drafts, not approved procedures. They intentionally do not carry navigation routes. A bank reviewer must approve the procedure text before the pilot presents it as approved guidance.

# 44: Page-aware help

**What to build:** The assistant knows which page the customer is on and tailors help without asking. (Story 103)

**Blocked by:** 36 Core complete: end-to-end demo verification, 26 Navigate action cards

**Phase:** stretch/deferred (after core)

**Status:** done

- [x] Page context never includes form values or secrets
- [x] Behaviour without context is unchanged

## Implementation notes (2026-10-14)

- The widget sends only the current pathname and an ISO capture time. It excludes the query string, form fields and form values.
- The service accepts context only when it contains exactly those two fields, the path exactly matches a configured navigation route, the timestamp is within two minutes (with 30 seconds of clock skew), and an available verified guide belongs to that path. Unsupported, malformed, stale and unavailable-page hints are ignored.
- The service derives page labels and guide titles from navigation config and paired guide files. Context is used only for questions referring to "here" / "this page" (or French equivalents); context is not stored in conversation history or audit records. Context-free prompt and event behavior remains unchanged.
- Navigation cards continue through the existing entitlement-aware validator. The model is told the browser reported an allowlisted page hint and must not claim an action was completed or a location is certain.
- `test/page-context.test.js` covers the `/chat` API with local fake models/gateway, EN/FR guidance and links, secret/value omission, invalid/stale/unsupported context, context-free parity, and the widget request boundary.

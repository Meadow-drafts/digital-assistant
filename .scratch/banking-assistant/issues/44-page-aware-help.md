# 44: Page-aware help

**What to build:** The assistant knows which page the customer is on and tailors help without asking. (Story 103)

**Blocked by:** 36 Core complete: end-to-end demo verification, 26 Navigate action cards

**Phase:** stretch/deferred (after core)

**Status:** done

- [x] Page context never includes form values or secrets
- [x] Behaviour without context is unchanged

## Implementation notes (2026-10-14)

- The widget sends only the current pathname and an ISO capture time, or the fixed `my-cases` surface id and capture time while that assistant panel is open. It excludes the query string, form fields and form values.
- The service accepts portal context only when its path exactly matches a configured navigation route, or assistant-surface context only for the fixed `my-cases` id. Both require an exact field set, a timestamp within two minutes (with 30 seconds of clock skew), and an available verified guide. Unsupported, malformed, stale and unavailable-page hints are ignored.
- The service derives page labels and guide titles from navigation config and paired guide files. Context is used only for questions referring to "here" / "this page" (or French equivalents); context is not stored in conversation history or audit records. Context-free prompt and event behavior remains unchanged.
- My cases is an assistant panel rather than a portal route, so it has a fixed `surface: "my-cases"` context and a paired EN/FR guide based on the widget's labels and case-list behavior. It does not receive a portal navigation card.
- Navigation cards continue through the existing entitlement-aware validator. The model is told the browser reported an allowlisted page hint and must not claim an action was completed or a location is certain.
- `test/page-context.test.js` and `test/widget-my-cases.test.js` cover the `/chat` API with local fake models/gateway, EN/FR guidance and eligible links, secret/value omission, invalid/stale/unsupported context, context-free parity, and the widget request boundary including My cases.

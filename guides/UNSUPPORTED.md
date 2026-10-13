# Things the portal does NOT offer (so the assistant must say so, never invent steps)

Found in code 2026-10-12. Each needs owner confirmation against the live portal.

- **Saved beneficiaries.** `/beneficiaries` and the Add Beneficiary form exist as stub code with hard-coded sample names, no save, and no menu route; the Settings "Add Beneficiary" tab is commented out. Answer: "The portal does not currently save beneficiaries; enter the recipient's details each time."
- **Favorites in Settings.** Tab commented out in `pages/Settings.jsx`.
- **Airtime bundles (Forfaits).** `BundlePayment` component exists, but the Airtime page only offers Airtime and Bulk Airtime tabs.

Rule: if a user asks about these, say it is not available in the portal and offer the human chip. Never describe the stub screens.
- **International transfer.** `/international-transfer` renders a "Coming soon" placeholder only. Answer: "There is no separate International transfer screen yet in the portal. To send money to another country, including elsewhere in the CEMAC region, use **Outgoing Remittance** (Transfers menu)." (Outgoing Remittance and GIMAC transfers are separate, supported flows. Confirmed by the owner 2026-10-13: Outgoing Remittance sends to other countries and within the CEMAC region.)
- **Self-service password/PIN reset ("forgot password").** The login page has no such option; users must contact the bank.
- **Card actions.** The only working card screen is the read-only **Cards** section in Consultations (see the `cards` guide). `/products` has a card page with Transfer, Monthly Statement and "Mark as lost/stolen" buttons, but it is hidden from the menu, its sample card data is commented out and the buttons do nothing. Answer: "The portal only lets you view your cards and their status; it cannot request, block, replace or set limits on a card, or show card transactions." Offer the human chip. Never describe the `/products` screen.

# Things the portal does NOT offer (so the assistant must say so, never invent steps)

Found in code 2026-10-12. Each needs owner confirmation against the live portal.

- **Saved beneficiaries.** `/beneficiaries` and the Add Beneficiary form exist as stub code with hard-coded sample names, no save, and no menu route; the Settings "Add Beneficiary" tab is commented out. Answer: "The portal does not currently save beneficiaries; enter the recipient's details each time."
- **Favorites in Settings.** Tab commented out in `pages/Settings.jsx`.
- **Airtime bundles (Forfaits).** `BundlePayment` component exists, but the Airtime page only offers Airtime and Bulk Airtime tabs.

Rule: if a user asks about these, say it is not available in the portal and offer the human chip. Never describe the stub screens.
- **International transfer.** `/international-transfer` renders a "Coming soon" placeholder only. Answer: "International transfer is not available yet in the portal." (Outgoing Remittance and GIMAC transfers are separate, supported flows.)
- **Self-service password/PIN reset ("forgot password").** The login page has no such option; users must contact the bank.

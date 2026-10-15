---
id: validations
audience: individual with a validation profile (principal wallet sees all tabs)
route: /validations
package: none
verified-on: 2026-10-14, bank approval confirmed by user
---
# Approve, deny or view a validation

## When to use
The bank's back office configures which actions need validation for each user. Use this when you are expected to validate an action that needs or concerns you, or when you want to view the validation of such an action.

## Steps
1. Open **Validations**. Tabs: **All validations** (principal wallet only), **My validations**, **My pending validations**.
2. In **My pending validations**, each row shows the service, description, wallet, who created it, the level (for example 1/2), the status and the date.
3. Use the eye icon ("see detail") or the transaction icon ("see transaction") to review what you are approving.
4. Approve or deny: a window asks "Are you sure you want to approve the validation?" with **Approve** and **Deny**. For a bulk payment, open its detail page and use the **Approve** or **Deny** button there.
5. The result shows "Validation has been approved" or "denied". When the last level approves, the operation is executed.

## Common errors
- "Cannot Approve validation !": the status must be PENDING for a validator, or CONTROLLER for a controller. You can only act at your own level.
- The request is not in your list: it is waiting at another level or for another person.

## Talk to a human if
A validation is stuck at a level for too long, you approved by mistake, or you do not have the validator or controller profile you need.

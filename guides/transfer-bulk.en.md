---
id: transfer-bulk
audience: individual
route: /transfer (Bulk Transfer tab)
package: TRINC, TRINW, TRIB (any one)
verified-on: 2026-10-14, bank approval confirmed by user
---
# Send a bulk transfer from an Excel file

## When to use
You want to pay many recipients at once from one account.

## Steps
1. Open **Transfers**, tab **Bulk Transfer**.
2. Click **Download Sample** and fill the Excel file. Columns: MEMBER, MEMBERCODE, TYPE, ACCOUNT, AMOUNT, REFERENCE. The sample's second sheet lists the valid operators, banks and codes.
3. Upload your **.xlsx** file by dragging it or clicking to upload (maximum 10 MB). The rows are displayed so you can check them. Use **Upload new file** to replace it.
4. Choose the account to debit and enter the **Motive**.
5. Click **Proceed**. The window "TransactionDetails" shows fees, VAT and the total. Enter your PIN (and the OTP if your profile requires it).
6. You are taken to the transfer status page, with one line per transfer and its status. You can also find it later under **History**.

## Common errors
- File rejected: only .xlsx, under 10 MB, with the sample's columns.
- "Lacks initiator profile to initiate transaction": your profile cannot start bulk transfers; contact your administrator.
- Some lines fail: check the status column line by line.
- Pending lines: do not resend the file; check status first.

## Talk to a human if
You were debited for lines marked failed, or the whole batch stays pending.

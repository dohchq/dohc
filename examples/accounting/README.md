# Accounting

This example is double-entry books for one person, kept in a workspace app.
The owner posts journal entries, imports bank statements, attaches receipts, and issues invoices.
Their accountant reads the reports through a read-only share link.
No runtime code knows about accounts, entries, or invoices. The rules live in this folder.

## The books

[schema.sql](schema.sql) defines one Collection with eleven tables: `accounts`, `fiscal_periods`, `journal_entries`, `journal_lines`, `bank_imports`, `reconciliations`, `business`, `clients`, `invoices`, `invoice_lines`, and `invoice_payments`.
Amounts are integers in the currency's smallest unit: cents for USD, yen for JPY, fils for KWD. Each line has a currency, and every report runs per currency.
[operations.js](operations.js) holds every operation. [dataset.json](dataset.json) declares them and who may call them.

The books keep these rules, in SQL triggers and in the operations:

- Each entry balances. Debits equal credits in every currency.
- A posted entry never changes. Correct it with `reverseJournalEntry`, which posts the opposite entry and links the two.
- An entry needs an open fiscal period and a date of today or earlier. Periods lock in order, only after the month ends and every bank row dated in them is posted, skipped, or a confirmed duplicate, and a locked period refuses new entries.
- Fiscal years can start in any month, chosen when you open the first one, and follow one another without gaps. **Periods** offers the year before the first one until a month is closed, and then no earlier year can be added. A fiscal year is named by the year it ends in. Year-to-date figures, Periods, and the balance sheet's retained earnings use the fiscal year, not the calendar year.
- Invoice actions are dated today or earlier: issuing, paying, voiding, and reversing a payment. A later date would show an invoice settled before it is.
- Issuing an invoice posts its entry in the same transaction. Paying or voiding it does the same.
- An invoice's paid amount always equals the sum of its payments, and it is paid exactly when nothing is due. Reversing a payment reopens the invoice.
- Archived accounts take no new lines. An account with a balance or bank rows to review can't be archived.
- The balance sheet shows retained earnings from earlier fiscal years and current earnings for the year of the report date.

## Bank statements

**Import statement** in Bank reads a CSV file in the browser. You choose the date, description, and amount columns, or separate money-in and money-out columns.
The app sends rows to `stageBankRows` in calls under 60 KiB. With the owner-only bulk profile, one call takes up to 5,000 rows.
Each row is stored with a SHA-256 hash of its bank account, date, amount, currency, and description, with case and spacing ignored.
The hash also counts the identical rows before it in the same file, so two real charges for the same amount on the same day both stay.
A row whose hash is already in the books lands in **Duplicates**, and so does a row from another file with the same bank account, date, and amount, because banks often change the description between exports. Each earlier row holds back one new row, and an exact repeat claims its own earlier row first, so a second real charge for the same amount that day lands in Review whatever order the file lists them in. Importing the same or an overlapping file again adds nothing twice. Rows dated in a closed month land in **Skipped**, and stay there, except an exact repeat of a row already imported, which lands in **Duplicates** already confirmed.
A duplicate stays out of the books. Its inspector shows the row imported before and whether it is in the books. `Enter` or **Confirm duplicate** keeps it on record and takes it off the to-do list, and **Undo** or **Unconfirm** brings it back. If they are two separate purchases, choose **Keep as new** to give the second row a fresh identity. A month can't be locked while a duplicate dated in it is unconfirmed, and a duplicate in a closed month can only be confirmed.

The bank workbench has five queues: Review, Suggested, Duplicates, Posted, and Skipped. A new row is in Suggested when the app is confident what it is, and in Review otherwise, so the counts add up.

- A new row suggests the other account last used for the same payee from the same bank account and currency, when that entry had one other line and wasn't reversed.
- Money in shows as **Suggested** when its description names the client of exactly one open invoice in the same currency, issued on or before the row's date, that it pays in full or in part. **Record payment** pays the invoice from that row in one entry.
- Any other money in offers up to five open invoices it could pay, exact amounts first, when the amount is exact, the description names the client, or it covers at least half of what is due. Choose one to record a partial or full payment from the row, including on a **Suggested** row when another invoice is the one it pays. Money beyond what a named invoice owes goes to an account you choose.
- A transfer between two of your bank accounts is one entry. The statement row from each account matches it once, and shows as **Suggested** when its description names the other account.
- An entry already in the books that moves the same bank account by the same net amount, and that no other row claims, can match the row. Within 7 days it is a possible match. Within 90 days it is a match only when the description and the entry share the payee and the entry isn't older than the account's first imported row, and then the row shows as **Suggested**: the description's first word, after bank words like POS or ACH, is in the entry's memo, the memo's first word is in the description, or a payment's client is named. A possible match stays in Review, and you pick it before **Match** or `Enter` links it. Linking never posts again. **Undo** sends the row back to Review.
- **Find entry** (`F`) lists the entries within 90 days that move the same bank account by the same net amount and no other row claims, nearest date first, for a check that clears weeks after it was written. `linkBankRow` accepts the same entries.
- `postBankRows` and `recordPayment` refuse a row that may be the same money as an entry already in the books, sure or possible, including one posted earlier in the same batch, unless the row lists those entries in `notMatched`, the IDs from its `candidates`. An entry that appears after the check isn't on that list, so the row is refused and has to be reviewed again. The workbench sends the list after you choose **Not this entry** (or **None of these**), **Not this one, post it instead**, **Split**, or an invoice to pay on such a row, and asks again when a new entry appears.
- Rows in a closed month stay as they are: they can't be matched, unmatched, restored, or kept as new, and a reversal never sends them back to Review.
- Reversing an entry sends its bank rows back to Review when the reversal is dated on the entry's date or on or before the row's date. A later reversal keeps the row posted, so posting it again can't count the money twice.
- A row matched to an entry can't also pay an invoice, so the same money is never recorded twice.
- **Split** spreads one row across two or more accounts. Posting refuses splits that don't add up to the row.
- Neither a bank row nor a manual journal entry can be posted to Accounts receivable (`control_account` for journal entries). Money from a client goes through **Record payment**, so the invoices and the receivable balance agree.
- Posting hides the row at once and sends posts in batches. **Undo** in the toast reverses the whole batch and sends the rows back to Review.
- A posted entry lists the bank side first for money in and last for money out, so debits come before credits.

**Reconcile** compares a statement's ending balance for one bank account on one date with what has cleared the bank by then. An entry matched to a statement row clears on the row's date, so a check written on January 28 that the bank paid on February 10 counts in February. An entry with no statement row clears on its own date if it is older than the account's first imported row (skipped rows don't count), and otherwise waits as not cleared until a row matches it. The sheet shows what the statement should show, up to 200 of the entries that make the difference (an entry and its reversal that both wait cancel out and are left off), and the books' balance. It opens on the last month-end before the first row still waiting, when that date isn't reconciled yet. It refuses while rows dated on or before that date wait in Review or Duplicates, refuses a balance that differs from what has cleared, and refuses a date that is already reconciled or in a closed month.
The dialog offers each currency the account holds.
The bank top bar shows the latest reconciliation, or the earliest one that no longer holds. It warns when entries posted or matched later changed what had cleared by that date, or when a statement row dated on or before it arrived later and waits in Review or Duplicates. Choose the warning to open that date, where **Remove** deletes the reconciliation so you can reconcile again. **Undo** in the toast removes a new reconciliation. A month can't be locked while a reconciliation dated in it or earlier no longer holds, and a reconciliation in a closed month can't be removed or changed.

## Receipts

An entry can carry one receipt: a PDF, or a PNG, JPEG, WebP, GIF, or HEIC image. Other file types are refused.
Attaching, replacing, or removing a receipt works in any period, including locked ones, because a receipt is evidence and not part of the amounts. Each change has **Undo** in its toast.
`receiptAccess` returns the file to the owner only.
An entry counts as missing a receipt when it was posted by hand or from the bank, has an expense line, and is not a reversal or reversed.

## Invoices

The first invoice asks for your business name, email, and address, which every invoice then shows under **From**. Edit them from any invoice editor.
Saving a draft saves a new client and your business details in the same step, so a failed save changes nothing.
Issuing an invoice copies your business and the client's details onto it, so renaming either later doesn't change an invoice already sent.
**Record payment** takes the full balance or any part of it. A part-paid invoice shows **Part paid** and what is still due. A payment can't be dated where it would overpay the invoice on any later day, for example before an earlier payment's reversal. An invoice with payments can't be voided until they are reversed, and the void is dated no earlier than the last payment or reversal.
The invoice inspector links to its sale, each payment, and its void entry by number.
**Overdue** lists every issued invoice past its due date, across all pages. Invoice numbers continue from the highest number issued.

## Keys

| Key | Action |
| --- | --- |
| `N` | New journal entry |
| `C` | New invoice on Invoices, new account on Accounts |
| `G` then `O`, `R`, `B`, `I`, `A`, `F`, `P` | Overview, Register, Bank, Invoices, Accounts, Reports, Periods |
| `J`, `K`, `Enter`, `Esc` | Move, open, and close in the register, bank, and invoice lists |
| `/` | Search |
| `Enter` on a bank row | Post it, match it to the chosen entry, record the chosen invoice payment, or confirm a duplicate |
| `A`, `S`, `I`, `F` | Choose the account for, split, skip, or find an older entry for a bank row |
| `=` | Fill the difference on an amount field in the composer |
| `Enter` | Move from an amount to the next line in the composer, adding one after the last |
| `Ctrl+Enter` (`⌘+Enter` on macOS) | Post the entry or save the invoice |
| `?` | Show every shortcut |

## Publishing

Copy this folder into a workspace as `accounting`. Approve its descriptor, schema, and operations.

- Publish `accounting` for the owner's books, from [app.publish.json](app.publish.json).
- Publish `accounting/portal` for the accountant, from [portal/app.publish.json](portal/app.publish.json), on a link share whose path selector includes `accounting` (because the portal reads `../portal.tsx`, `../shared.tsx`, `../books.css`, and `accounting/dataset.json`).

The portal's grant lists only `booksInfo`, `trialBalance`, `incomeStatement`, `balanceSheet`, and `accountLedger`.
These are the only operations that allow link callers, and all five are read-only.
A link caller who sends any other operation is refused. Revoking the link ends access.

Reports are read-only operations, not SQL views, because the runtime refuses `CREATE VIEW`.
Every report and invoice has a **Download printable HTML** button that exports a standalone file with a print stylesheet (dohc's app iframe sandbox omits `allow-modals`, so `window.print()` inside the frame is blocked).

## Limits

These limits come from dohc, not from this example. The example works inside them.

| Limit | Value | Effect here |
| --- | --- | --- |
| Operation input | 64 KiB of JSON, or 1 MiB for the owner-only bulk profile | `postJournalEntries` and `stageBankRows` use the bulk profile and take up to 5,000 items. The app's own calls stay under 60 KiB. |
| JSON structure | 16,384 nodes, or 131,072 with the bulk profile | Bulk batches stay under it. |
| One query result | 1,000 rows, 256 KiB | Bank review pages hold up to 100 rows and end early once the rows reach 240 KiB, so a page of long descriptions with five candidate entries each stays under the limit; the register pages at 100 entries and the accountant ledger at 100 lines (max 500). |
| SQL parameters | 128 per statement, each under 64 KiB | Bulk inserts send rows as one JSON parameter, in chunks. |
| `json_each` | Refused | Operations read JSON arrays with a recursive query instead. |
| App backend calls | 30 at once, then 1 every 2 seconds, per app session | Bank posting batches rows into one call, and undo reverses up to 100 entries in one call. |

## Tests

- `packages/app-backend-runtime/src/accounting-example.test.ts` checks the rules above.
- `packages/app-backend-runtime/src/accounting-benchmark.test.ts` posts 10,000 journal lines and imports 2,500 bank rows, then times the reports.
- `services/share-web/e2e/accounting-books.spec.ts` drives the owner app in a browser.
- `services/share-web/e2e/accounting-portal.spec.ts` opens the accountant link, tries writes, and revokes it.

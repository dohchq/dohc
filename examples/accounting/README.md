# Accounting

This example is double-entry books for one person, kept in a workspace app.
The owner posts journal entries, imports bank statements, attaches receipts, and issues invoices.
Their accountant reads the reports through a read-only share link.
No runtime code knows about accounts, entries, or invoices. The rules live in this folder.

## The books

[schema.sql](schema.sql) defines one Collection with eight tables: `accounts`, `fiscal_periods`, `journal_entries`, `journal_lines`, `bank_imports`, `clients`, `invoices`, and `invoice_lines`.
Amounts are whole cents in integer columns. Each line has a currency, and every report runs per currency.
[operations.js](operations.js) holds every operation. [dataset.json](dataset.json) declares them and who may call them.

The books keep these rules, in SQL triggers and in the operations:

- Each entry balances. Debits equal credits in every currency.
- A posted entry never changes. Correct it with `reverseJournalEntry`, which posts the opposite entry and links the two.
- An entry needs an open fiscal period. Periods lock in order, and a locked period refuses new entries.
- Issuing an invoice posts its entry in the same transaction. Paying or voiding it does the same.
- Archived accounts take no new lines.

## Bank statements

The Bank tab reads a CSV file in the browser. You choose the date, description, and amount columns, or separate money-in and money-out columns.
`stageBankRows` takes up to 500 rows per call, and the app keeps each call under 60 KiB.
Each row is stored with a SHA-256 hash of its bank account, date, amount, currency, and description, with case and spacing ignored.
The hash also counts the identical rows before it in the same file, so two real charges for the same amount on the same day both stay.
A row whose hash is already in the books is counted as a duplicate and skipped. Importing the same or an overlapping file again adds nothing twice.
If two separate purchases with the same date, amount, and description arrive in different files, open the Duplicate filter in Bank rows and choose **Keep as new** to assign the second row a fresh identity and post it.
Each new row then becomes one balanced entry when you choose its other account and post it.

## Receipts

An entry can carry one receipt: a PDF, or a PNG, JPEG, WebP, GIF, or HEIC image. Other file types are refused.
`receiptAccess` returns the file to the owner only.

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
| Operation input | 64 KiB of JSON | Posting batches and bank batches stay under 60 KiB. |
| JSON structure | 16,384 nodes | Bank batches stop at 500 rows, well under it. |
| One query result | 1,000 rows, 256 KiB | Bank review pages at 100 rows so worst-case 300-character JSON-escaped descriptions fit; ledgers page at 50 in the UI (max 500). |
| SQL parameters | 128 per statement, each under 64 KiB | Bulk inserts send rows as one JSON parameter, in chunks. |
| `json_each` | Refused | Operations read JSON arrays with a recursive query instead. |
| App backend calls | 30 at once, then 1 every 2 seconds, per app session | Quick clicking can run out. The app then says to wait a few seconds. |

## Tests

- `packages/app-backend-runtime/src/accounting-example.test.ts` checks the rules above.
- `packages/app-backend-runtime/src/accounting-benchmark.test.ts` posts 10,000 journal lines and imports 2,500 bank rows, then times the reports.
- `services/share-web/e2e/accounting-books.spec.ts` drives the owner app in a browser.
- `services/share-web/e2e/accounting-portal.spec.ts` opens the accountant link, tries writes, and revokes it.

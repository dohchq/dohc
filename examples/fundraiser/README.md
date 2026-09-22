# Fundraiser app

This example is for an owner and their agent preparing a fundraiser on a configured dohc host.
It uses synthetic event details. It contains no real payment account, participant record, or receipt.

Copy this folder into a workspace as `fundraiser`. The declaration uses workspace-relative paths under that name.
Approve `dataset.json` and its captured schema and operations through dohc's dataset flow first.
Then publish the frontend using `app.publish.json`, which references that approved revision.
The app and Collection use the same records and rules. Publishing the app cannot replace those rules.
An online transaction host is required for shared registrations.

## Registration and management

Participants choose one or both sessions and enter the names of players and spectators.
Each session allows 36 players. A player costs PHP 1,000 per session; a spectator costs PHP 150.
The backend calculates the total. Spectators do not consume player slots.

The participant pays outside dohc and uploads a JPG, PNG, or PDF receipt, up to 5 MB.
Submitting the form reserves the slots. Payment alone does not reserve them.
If the slots fill before submission, the organizer must arrange another session or refund outside the app.

Successful submission returns a private status token. Copy it or download its text file to check status in another browser.
The original browser can reopen the app and retry its saved response to recover the same confirmation and token.
Paste the token into **My registration**. This example does not create a portable status URL.
Anyone holding that token can inspect that registration's status and attendee names.
The lookup omits contact information and receipts. There is no mobile-number lookup or automatic lost-link recovery.

The frontend also generates a submission ID and a random retry secret before uploading.
After uploading the receipt, the app saves the exact registration input and retry key through dohc before submitting.
The host scopes that saved response to the workspace, dataset, app, operation, and browser participant.
If a response is lost, use **Retry same registration**, including after reopening the app in the same browser profile.
The app retains the saved response after success. **Register another group** clears it before accepting another draft.
No recovery download is required for normal submission. The retry screen offers one as an optional separate copy.
That file preserves the entered details, receipt bytes, submission ID, and private retry secret.
If the browser blocks downloads, the retry screen offers selectable recovery text to save manually.
Before the upload and retry save finish, keep the page open or save a recovery file from its retry screen.
The sandbox cannot retain receipt bytes across a page close before that save.
After a reload, the retained response uses its uploaded receipt reference; it does not download the receipt into browser storage.
To resume in another browser profile, import a recovery file saved before the reload.
The backend recognizes that submission after a browser profile changes and returns its existing confirmation.
A wrong secret or changed details refuse. Receipt identity is bound to its bytes, so reuploading the same receipt does not reserve slots twice.
Organizer lists omit these recovery secrets.

Organizers can search registrations, inspect receipts, update payment status, and enter manual or ReClub registrations.
ReClub is an entry label, not an integration. Manual entries may omit a phone number and receipt.
The attendee list has a ReClub checklist for each player in each session.
Organizers mark players after adding them to ReClub outside dohc. They can undo each mark.
Marks remain separate across players and sessions, and survive rejection and restoration of a registration.
The checklist excludes spectators and rejected registrations. Private participant status lookups omit it.
Pay-at-venue entries reserve slots and require cash as their planned payment method.
An organizer must select the actual payment method when marking those entries verified.

Pending, verified, and pay-at-venue registrations reserve capacity. Rejected registrations release it.
Restoring a rejected registration requires enough capacity in every requested session.
A stale status update refuses until the organizer reloads the registration.
Collection status edits invoke `editRegistrationStatus`, which calls the same status rule and returns an undo receipt.
Undo also checks capacity and the current record version. It cannot bypass those rules.

## Operation contract

[types.ts](types.ts) describes the frontend inputs and results. Amounts in this example are whole Philippine pesos.
`register` and `lookupStatus` are public operations. Management operations require verified organizer or owner authority.
The host supplies caller identity, transaction time, request identity, and an unpredictable private status token.
Request input cannot provide those capabilities.

[backend.ts](backend.ts) contains ordinary JavaScript in a TypeScript source file.
The host supplies `ctx.db.query`, `ctx.db.execute`, `ctx.files.attach`, and `ctx.refuse` inside one bounded transaction.
The app needs no backend imports, external database account, or storage bucket configuration.
[schema.sql](schema.sql) declares the tables. [dataset.json](dataset.json) names their stable fields, relations, and approved operations.
[app.publish.json](app.publish.json) binds the frontend to a specific approved revision. Its inputs contain only frontend source.
Changing the descriptor, schema, or backend requires a new approval and an updated binding hash.
Collection reads return `{ rows: [{ id, version, values }], nextCursor }`, with values keyed by field ID.
They support bounded SQL pagination, search, sorting, and field filters. Recovery secrets are absent from these reads and field metadata.

## Verification

The example tests execute the source in the actual isolated runtime with SQLite.
They cover both-session rollback, capacity release and restoration, stale edits, private lookup, receipt attachment,
manual entries, organizer checks, server-calculated totals, the ReClub checklist, and the maximum 272-attendee roster.

From the repository root, run:

```sh
pnpm --filter @dohc/app-backend-runtime test src/examples.test.ts src/dataset-examples.test.ts
```

The dataset-host acceptance suite uses the actual compiled source, worker, SQLite journal, app bindings, and data grants.
It proves shared Collection/app records, durable request replay, transactional receipt references, rule-preserving status edits, helper permissions, and revocation.
The fixture supplies receipt metadata; browser upload transport and desktop publication require their own integration tests.

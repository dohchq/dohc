# Fundraiser app

This example is for an owner and their agent preparing a fundraiser on a configured dohc host.
It uses synthetic event details. It contains no real payment account, participant record, or receipt.

Copy this folder into a workspace as `fundraiser`. The declaration uses workspace-relative paths under that name.
The frontend and backend publish together. The owner approves the backend operations and data access through dohc's publication flow.
An online transaction host is required for shared registrations.

## Registration and management

Participants choose one or both sessions and enter the names of players and spectators.
Each session allows 36 players. A player costs PHP 1,000 per session; a spectator costs PHP 150.
The backend calculates the total. Spectators do not consume player slots.

The participant pays outside dohc and uploads a JPG, PNG, or PDF receipt, up to 5 MB.
Submitting the form reserves the slots. Payment alone does not reserve them.
If the slots fill before submission, the organizer must arrange another session or refund outside the app.

Successful submission returns a private status token. Copy it or download its text file from the confirmation.
Reopen the app and paste that token into **My registration**. This example does not create a portable status URL.
Anyone holding that token can inspect that registration's status and attendee names.
The lookup omits contact information and receipts. There is no mobile-number lookup or automatic lost-link recovery.

The frontend also generates a submission ID and a random retry secret before uploading.
A saved recovery file preserves both, the entered details, and the receipt hash.
Sending starts a recovery-file download before the request. Keep that private file until registration is confirmed.
If a response is lost, use **Retry same registration**. After closing the page, import the saved recovery file.
If the browser blocks downloads, the retry screen offers selectable recovery text to save manually.
The app does not persist drafts in browser storage. Closing it without a recovery file loses the retry identity.
The backend recognizes that submission after a browser profile changes and returns its existing confirmation.
A wrong secret or changed details refuse. Receipt identity is bound to its bytes, so reuploading the same receipt does not reserve slots twice.
Organizer lists omit these recovery secrets.

Organizers can search registrations, inspect receipts, update payment status, and enter manual or ReClub registrations.
ReClub is an entry label, not an integration. Manual entries may omit a phone number and receipt.
Pay-at-venue entries reserve slots and require cash as their planned payment method.
An organizer must select the actual payment method when marking those entries verified.

Pending, verified, and pay-at-venue registrations reserve capacity. Rejected registrations release it.
Restoring a rejected registration requires enough capacity in every requested session.
A stale status update refuses until the organizer reloads the registration.
Owner table edits invoke `updateRegistration`; they cannot write raw fields around these rules.

## Operation contract

[types.ts](types.ts) describes the frontend inputs and results. Amounts in this example are whole Philippine pesos.
`register` and `lookupStatus` are public operations. Management operations require verified organizer or owner authority.
The host supplies caller identity, transaction time, request identity, and an unpredictable private status token.
Request input cannot provide those capabilities.

[backend.ts](backend.ts) contains ordinary JavaScript in a TypeScript source file.
The host supplies `ctx.db.query`, `ctx.db.execute`, `ctx.files.attach`, and `ctx.refuse` inside one bounded transaction.
The app needs no backend imports, external database account, or storage bucket configuration.
[schema.sql](schema.sql) declares the app tables. [app.publish.json](app.publish.json) declares the allowed operations and table actions.

## Verification

The example tests execute the source in the actual isolated runtime with SQLite.
They cover both-session rollback, capacity release and restoration, stale edits, private lookup, receipt attachment,
manual entries, organizer checks, server-calculated totals, and the maximum 272-attendee roster.

From the repository root, run:

```sh
pnpm --filter @dohc/app-backend-runtime test src/examples.test.ts
```

These runtime tests do not prove browser publication, durable retry receipts, host commit ordering, or access revocation.
Those require the host and browser integration tests. A successful runtime operation is only a candidate until the host commits it.

# Fundraiser as a test of dohc's direction

Reader: Ice and the people implementing and verifying the fundraiser example.

The target is the complete participant and organizer flow from `C:/Users/ice/dev/mom-fundraiser`. A form that only collects responses does not prove this use case. The [example](../../examples/fundraiser/README.md) now expresses its rules through the [general app backend](app-backend.md), with synthetic event details and no real participant data or payment accounts.

## Agreed product target

An owner already has an agent connected. They ask it to build an app, share it, and manage its data through dohc or an admin app. They need no separate per-app database, storage bucket, or hosting account. Their agent controls the schema and workflow; dohc core contains no fundraiser-specific rules.

A prepared self-hosted server is the first proof. Keeping the owner's computer or server online is acceptable. Drive should eventually make hosting accessible to a nontechnical owner, and mobile should add another management client. Neither is required to prove the current backend. Technical self-host setup is still required; it is not evidence of the eventual managed experience.

## Implemented example behavior

- Group registration selects one or both sessions. Each session has 36 player slots; spectators consume none. The backend computes PHP 1,000 per player and PHP 150 per spectator, per session.
- One transaction reserves both requested sessions. Pending, verified, and pay-at-venue registrations consume capacity. Rejection releases it; restoration must reacquire capacity in every session.
- Participants pay outside the app, then upload a private JPEG, PNG, or PDF receipt before submission. Payment alone does not reserve a slot. If capacity fills first, the organizer handles the refund or another arrangement outside dohc.
- A private status code retrieves a registration's status and attendee names without exposing its phone number or receipt. There is no lookup by phone number alone.
- Before submission, the frontend saves an attempt containing a submission ID, retry secret, entered details, and receipt hash. The app can recover a committed registration in another browser profile, including after reuploading the same receipt bytes. Changed details or a wrong secret refuse without revealing the registration.
- Organizers search registrations, inspect receipts, change payment status, inspect totals and attendees, and add manual or ReClub entries. ReClub is a source label, not an integration. Manual entries can omit phone and receipt. Verifying a pay-at-venue entry requires the actual payment method.
- Organizer access requires a named Edit grant and an owner-assigned helper designation. The owner can revoke either. Owner table edits and agent operations enforce the same status and capacity rules, including optimistic versions that refuse stale updates.

The SQL tables are app data, not Markdown Collections. The desktop App data panel provides table reads and declared edits over the same operations used by the custom admin interface.

## Acceptance and evidence

Focused tests exercise the actual isolated runtime and the real HTTP host with synthetic databases. They cover capacity contention, both-session rollback, backend totals, status transitions, manual entries, private receipt access, retry recovery, and organizer authority. The second [stock-order example](../../examples/stock-orders/README.md) exercises different rules without a new core API.

These checks do not substitute for a complete browser run of this fundraiser. Final acceptance must demonstrate:

| Scenario | Required result |
| --- | --- |
| Owner creates and publishes the example | App source, operations, and private data are approved through dohc on a prepared host |
| Participant registers one or both sessions | The displayed total matches the committed backend total and the receipt remains private |
| Two participants claim the last capacity | Only a transaction with enough remaining capacity commits |
| Submission response is lost | Saved-attempt recovery returns one registration, including in a fresh browser profile |
| Participant looks up status | Their private code works; a phone number or guessed record/file ID does not expose private data |
| Organizer verifies, rejects, restores, or enters a walk-in | Status, totals, and capacity remain consistent; stale edits refuse |
| Owner edits through the table or agent | The same operations and rules apply |
| Organizer access or publication is revoked | Subsequent protected requests refuse, including file reads and receipt replay |
| Host is unavailable or restarts | Unconfirmed work does not appear accepted; committed state survives restart |
| Owner exports and restores into an empty store | Data, files, history, and retry identities remain usable |

The current status UI uses a private code and downloadable recovery file. A portable status URL is a later interface improvement. Lost recovery secrets have no automatic identity-based recovery. The backend supplies no payment processing, temporary prepayment hold, email notification, or automated refund.

The architecture now supports this class of app. Declaring the complete example ready still requires the browser, desktop, and deployment acceptance evidence above. Drive, mobile, and a smoother managed setup are separate work; they do not change the transaction or permission boundary.

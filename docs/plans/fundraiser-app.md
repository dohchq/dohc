# Fundraiser as a test of dohc's direction

Reader: Ice and the people implementing and verifying dohc apps, sharing, and collections.

Status: product direction discussed with Ice. Architecture and implementation remain undecided. Source inspection does not establish that the current product meets this target.

The [app backend proposal](app-backend.md) develops the next design step. It separates agreed product requirements from proposed storage, execution, and permission changes.

## Agreed target

- Provide a general-purpose backend that nontechnical owners can use through their agents and dohc's interfaces. Ice's comparison is Supabase's flexibility with the accessibility of a Notion database. The fundraiser tests that capability; it does not define a fixed set of supported app types.
- Support app-defined data, queries, relationships, permissions, files, and trusted operations. Fundraiser rules belong in the owner's app, not in dohc core. The concrete backend contracts remain to be designed.
- Treat receipt uploads as ordinary file uploads with scoped access. Images and PDFs are examples; dohc does not need a receipt-specific storage feature. Storage may use local files or an object store, but owners should not need to configure a separate storage product for each app.
- Use the complete flow from `C:/Users/ice/dev/mom-fundraiser` to assess dohc's direction. A form that only collects responses is not sufficient evidence for the whole use case. This is not an instruction to port the fundraiser now.
- Start with an external agent already connected to dohc.
- Support an owner who keeps their computer online or operates a self-hosted server. Availability while the owner's computer is off is not required for the initial computer-hosted setup.
- Keep eventual dohc Drive hosting in scope for the product direction, without making its launch a prerequisite for this proof.
- Prove the capabilities on a prepared self-hosted server first. Technical hosting setup is acceptable for that proof.
- The eventual nontechnical experience assumes dohc Drive handles hosting. Owners should create, share, and manage the app through dohc and their agent without configuring a separate database or hosting provider.
- Browser administration through a shared dohc app is an acceptable direction. Native mobile workspace management can follow later; it is not a prerequisite for assessing the architecture.
- The collection, admin app, and agent must manage the same records under the same business rules. A direct collection edit must not bypass capacity or payment rules.
- Prefer private participant status links over lookup by mobile number alone. Preserve payment before reservation for the initial example. Recovery and temporary reservation details are deferred.

## Source inspection

Inspected September 21, 2026. These are source findings, not results from a running fundraiser in dohc.

The existing fundraiser supports anonymous group registrations, players and spectators, two sessions, external payment, and private receipt uploads. Organizers can review receipts, record payments, reject or restore registrations, add walk-ins, and inspect totals and attendees. Owners can invite and revoke organizers.

The backend calculates prices and reserves up to 36 player slots per session. Every non-rejected registration consumes player capacity, including pending and pay-at-venue registrations. Rejection releases capacity; restoration checks availability. A registration covering both sessions reserves both in one transaction. Retry credentials let participants recover a submission after a lost response without duplicating it.

Payments happen outside the app through GCash or bank transfer. The current app reserves slots after payment, at submission time. A participant who pays after capacity runs out must contact the organizer. Status lookup currently accepts a mobile number without verification and returns attendee names and registration details. The agreed direction above preserves the payment sequence and changes status access.

The current dohc browser app transport exposes collection listing and creation in `services/share-web/src/appCollectionBroker.ts` and `appCollectionProxy.ts`. This does not establish support for private receipt uploads, atomic capacity rules, or organizer updates. Existing collection views and app publication are useful foundations, but the complete fundraiser remains unproven.

## What this establishes

The use case fits dohc's product commitments: source-backed apps, owner-controlled data, human and agent management, and browser sharing. Implemented publications, collection submissions, collection views, and local agent tools provide part of that foundation.

Drive would provide managed availability and setup. Mobile would provide another management client. Neither alone supplies private uploads, authenticated browser administration, or trusted transactions that enforce app-specific rules. Those capabilities need explicit backend design and implementation.

The current browser-only app execution model and narrow create-only data contract do not express the fundraiser's backend behavior. ADR 0004 limits anonymous writes, and ADR 0006 separates app execution from the trusted sharing service. Supporting richer operations requires a deliberate design within those boundaries or a reviewed revision of them. It does not authorize running arbitrary app code inside the sharing service.

Collections also need a resolved relationship with application rules. Their current validation model preserves invalid values and flags them; it is not a transaction boundary for capacity reservations. Safe owner and agent edits therefore need more than a new form over the existing fields.

No new glossary term or ADR is needed yet. The product example is clear, but the backend alternatives and their trade-offs have not been decided.

## Architectural questions for later work

- How does an agent define trusted app operations that enforce rules across records?
- How do collection edits and agent writes preserve those rules, including during offline work?
- How can a public app accept private data without granting participants access to the response files?
- How do authenticated organizers get scoped app operations and private attachment access?
- Which services run those operations in self-hosted deployments and, later, dohc Drive?

## Verification still required

The eventual proof must cover the complete participant and organizer flows, retry recovery, concurrent capacity claims, private receipt access, and owner management of the same data. Explicitly test whether the form's share link can read response files outside the app's filtered data API. No running-app test has been performed in this interview.

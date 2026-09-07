# Collections implementation plan

Reader: the agent or person implementing the collections program, one phase at a time. Each phase names what it builds, what it must settle first, and the gate that ends it. Do not start a phase before its predecessor's gate passes.

The vocabulary is in `CONTEXT.md` (Collections section) and the load-bearing decision is `docs/adr/0007`. Design summary in one paragraph: a collection is a folder whose `collection.yaml` schema file types its md-file records; each record's properties live in the frontmatter Y.Map of its live document and its body is the document itself, so sync, merge, and attribution ride the existing `ydoc.update` path; the engine validates against the schema, indexes frontmatter into engine.db for queries, and derives per-field history and events by diffing the map at apply; views (table, board, calendar) ship built into the desktop app and through the SDK as the same components; automations are event-triggered plugins and arrive last.

## Product bar

Every collection operation has two first-class sides, and each phase gates on both.

The human side: a Notion user must be able to run their existing workflow without learning ours. Every operation has a UI path: create a collection, add a field, create a record, drag a card, edit a cell, pick a relation, add a select option. No path requires seeing YAML, a schema file, or frontmatter. The files underneath stay inspectable and exportable, and the UI never mentions them. Copy and controls follow the `dohc-interface` skill.

The agent side: every one of those operations is equally direct for an agent, through a plain file write or a tool call, with no UI in the loop. Write `collection.yaml` and the folder is a collection; write an md file and it becomes a record; edit frontmatter and the field changes; call the query and edit tools for anything structured. Both sides land in the same op stream with their own attribution, so a human drag and an agent edit are indistinguishable downstream except for who made them.

## Settled decisions

Recorded here so no phase re-litigates them.

- Membership is the folder: records are the md files directly inside; subfolders and non-md files are inert.
- The engine mints a stable record id and writes it into frontmatter once; the filename is a renameable label.
- Field types in v1: text, number, checkbox, date, select, multi-select, person, relation (single and multi), url. No formulas or rollups; an agent-written view computes what a formula would.
- A person field stores a dohc user id. Link holders cannot be assignees in v1.
- A relation stores record ids. Deleting a referenced record drops the links through attributed ops; history holds the reverse path.
- Conflict rule is per-field last-writer-wins everywhere, including multi-select.
- Validation is a lens, not a gate: an invalid value stays in the file and views flag it. A broken schema file degrades the collection; nothing locks and no data drops.
- The schema file syncs as a plain file; concurrent schema edits go through the existing file-conflict machinery.
- Relay treatment matches documents and chat: plaintext ops, opaque by convention. No collection-specific encryption.
- View definitions live under `views:` in `collection.yaml`, shared and synced. Which view a person has open is local state.
- Events fire on every device as its engine applies ops, local or synced.
- Library-first: prefer a maintained, license-compatible library over hand-rolling, for views and everywhere else in this program.
- Out of scope: share-web work, the Notion importer, and cloud operations. Publications and the app-data lane stay with the share-links program; the reconciliation is below.

## The word "collection" in ADR 0004

ADR 0004's "one typed create-only collection" and this program's collection are now the same object. The app-data lane becomes a dohc collection under a create-only grant policy, so the share-links program targets the contract this plan builds instead of naming an authoritative store of its own. That closes the open question in ADR 0004's second paragraph. The lane's other properties (idempotency keys, server-set principal fields, quotas, bulk undo) remain that program's work.

## Phase 1: engine collections

**Status: DONE.**

The data layer, no UI. A schema'd folder that validates, indexes, and syncs is the shippable result.

- Define the collection schema contract in `packages/workspace-contracts` with a Rust twin held equal by shared vectors: field types, relation targets, select options, view definitions. `collection.yaml` is the one reserved filename.
- The engine detects collection folders through the existing watcher, parses the schema fail-soft, and adopts records: an md file without an id gets one minted and written back as an engine-authored moment.
- Index frontmatter into engine.db tables (records, field values, relation edges) at apply time, for local queries only; nothing new crosses the wire.
- Diff the frontmatter map at apply time to produce per-field history rows and, in Phase 3, events. Record author and timestamp from the op.
- Validate values against the schema on index; store the flag with the indexed value so views can render the problem.
- Expose query requests through the engine protocol and `workspace-engine-client`: list, filter, sort, group by field, and resolve relations.

Settled (2026-08-27): a record id is engine-minted and opaque, `rec_` plus 128 bits of randomness in lowercase base32; adoption re-mints on the improbable collision. While a record's file sits in an open file conflict, the index keeps the last applied state and flags the record; adoption and id write-back wait for resolution. When adoption finds an id already bound to another record (a copied file), the existing binding keeps the id and the engine mints a fresh one for the newcomer: a copy is a new record.

Gate: the rust-gate skill passes, read from its summary block. Tests prove: adoption mints and writes back ids exactly once; two devices editing different fields of one record converge with both writes; two devices editing the same field converge on the later write with the earlier one in history; invalid values index flagged and survive round-trips; a broken schema degrades and recovers without data loss; deleting a referenced record drops relation edges through attributed ops.

## Phase 2: views

**Status: DONE.**

Everything a Notion user touches. All three views ship in this phase.

- View libraries, pinned 2026-08-27 after a license and maintenance check against React 19 and the electron-vite renderer. Table: @tanstack/react-table v9 with @tanstack/react-virtual, both MIT; v9 is a fresh major, so pin the v8 line if it misbehaves. Board: @dnd-kit/react, MIT, keyboard sensor on by default; its 0.x churn is the accepted risk and @atlaskit/pragmatic-drag-and-drop (Apache-2.0) is the fallback. Calendar: react-big-calendar with a date-fns localizer, MIT; restyle its stylesheet for Tailwind 4; FullCalendar's standard MIT packages are the fallback and its premium Scheduler packages (AGPL or commercial) never qualify. Frontmatter adds no YAML dependency; js-yaml is already in the repo. Disqualified on the maintenance or peer-range rules: Glide Data Grid, legacy @dnd-kit/core, @hello-pangea/dnd. A library that fails a future license check is replaced, not vendored.
- Create `packages/collection-views`: table, board, and calendar components bound to the Phase 1 query API. The desktop renderer and the SDK consume the same package, so built-in views and app views cannot drift.
- Desktop: opening a collection folder opens its views, not a file listing. New collection, new record, field add and edit, select-option creation, relation picking, board drag, calendar drag, and inline cell editing all work from the UI. The record page composes the existing PropertiesPanel and live-document editor.
- Board drag writes the grouped field through the frontmatter map; calendar drag writes the date field the view is keyed to; the view re-renders from the index, live, on every device.
- View management: create, rename, and delete named views; each view stores its grouping, sort, and visible fields under `views:`; the open view is per-user local state.

Settle first: the empty states and first-run flow (a new collection with no records must explain itself); how a flagged invalid value renders in each view.

Settled (2026-08-31): A collection with no records shows one line of explanation and the New record action, nothing else. A folder becomes a collection only through the New collection flow (name plus first fields) or an agent writing `collection.yaml`; the UI never shows the file. A flagged invalid value renders its raw text with the warning treatment and the validation reason on hover, and stays editable everywhere. On a board, a flagged record's card carries a warning dot and groups under its raw value when the grouped field is flagged, else under No value. On the calendar, a record whose keyed date is invalid or missing does not render on the grid; whether those records need a visible tray stays open until the desktop lane proves the need.

Gate: `pnpm typecheck` and `pnpm test:desktop` pass, plus an e2e walkthrough in `test:desktop:e2e`: create a collection from the UI, add fields of every v1 type, create records, drag a card and watch the field change land in the file, rekey the calendar to a second date field, and complete the whole walkthrough without the schema file ever on screen. Two-instance tests prove a drag on one device updates the other's open board.

## Phase 3: events and the SDK

**Status: DONE.**

- Add record.created, record.updated, and record.field.changed to the workspace event vocabulary. Payload: collection path, record id, field, previous value, next value, author, timestamp. The engine emits on apply; the desktop forwards over the same SDK channel as `files.watch`, with the same per-owner subscription cap.
- Serve the `collections.read` SDK capability from the real index, path-scoped like file capabilities; it covers list, get, query, and record reads. Add `collections.edit` for writes through the frontmatter map, attributed as agent-authored writes with `onBehalfOf`.
- Add collection tools to `packages/mcp` beside the existing database and chat tools: query a collection, read a record, set fields, create a record. External agents get the same reach as plugins, path-scoped the same way.
- Hand the share-links program its contract: a collection with a create-only grant policy is the ADR 0004 lane. No implementation here; the contract and a written pointer are the deliverable.

Settled (2026-09-02): an event payload carries each previous and next value whole up to 8 KiB of JSON; a larger value is replaced by `{ "truncated": true, "bytes": N }` and the subscriber reads the record for the whole value. Record history keeps every value whole; truncation bounds the event transport, not the data. Ordering: events from one applied update arrive together, `record.created` first, then `record.field.changed` in field-name order, then one `record.updated`; across records the order is the receiving device's apply order, which is not the authoring device's edit order. The timestamp is the author's clock as journaled on the replication wire, the same clock record history has always carried; a subscriber orders by the device's history row id, never by timestamp. Delivery is at most once: the engine drops events under backpressure and a subscription closes on overflow, so every `record.field.changed` carries the device's history row id and a subscriber that misses events reads history past its last seen id instead of expecting a replay.

Gate: a plugin subscribed on device B receives the field-change event for an edit made on device A, through sync, in the e2e suite. Capability tests prove path scoping: a plugin granted one collection cannot read or write another. An agent-side walkthrough mirrors the Phase 2 human walkthrough: an agent creates a collection and its records through file writes, sets fields through MCP tools, and queries the result, while an open desktop view reflects every step live; record history attributes each change to the agent.

The gate also requires one cross-program conformance test with the share-links program: share a collection, converge a named-user edit across devices, prove a link holder sees the converged state, revoke the share, and prove collection operations over the share stop. The two programs are compatible by construction — collections ride `ydoc.update`, shares select paths, and ADR 0004's lane is a collection under a create-only grant — but this test is the first thing that proves it.

## Phase 4: automations

**Status: DONE.**

Settled (2026-09-03): An automation is one entry in a plugin manifest's `automations` list, subscribed to record events on a collection path; the origin device's desktop runs it (ADR 0008). The trigger key is the change's replication coordinate (origin id and origin seq), which the engine threads into the apply facts; a change on a never-synced lineage keys on the device's history row id, since no other device can see it. The origin device claims the key in a durable claim table shaped like the chat dispatch ledger before it starts the handler, and a claim that exists is never taken again; the executor starts the plugin if it is not running. History rows, facts, and events carry the actor kind, the `onBehalfOf` principal, and a chain depth beside the author origin; the wire and the history table change together in the phase's first commit. The handler's writes take the collection write seam with the claim row id as their idempotency key, so a retried handler does not write twice. An automation's own writes carry depth one greater than their trigger and never re-trigger the same automation; a chain stops at depth 4 and the stop is reported. A throwing handler records a terminal failure in the claim row and surfaces it like a share refusal: durable, in the notice center, until the owner acknowledges it; external effects are never retried. The two-device race proves that the origin device's claim table has exactly one row for the change and the other device's has none, and that record history on both devices shows one automation write attributed to the automation on behalf of its owner.

- An automation is a source-visible plugin subscribed to Phase 3 events, installed like any plugin, its file in the workspace where any collaborator's agent can read and change it.
- Automation writes carry agent authorship with the automation as `onBehalfOf` context, visible in record history next to human edits.
- Loop guard: an automation's own writes do not re-trigger it, and a chain of automations stops at a fixed depth with the stop surfaced to the owner.
- Failures surface: a throwing automation reports where the owner will see it, and keeps failing visibly rather than silently disarming.

Gate: a two-device race proves an automation fires exactly once per triggering change; the loop guard test passes; record history shows the automation's writes attributed as its own actor on behalf of its owner.

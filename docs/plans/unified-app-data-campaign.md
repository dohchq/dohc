# One data system for owners, apps, and agents

Reader: Ice, the implementation lead, and reviewers approving and delivering this campaign.

Status: implementation in progress, September 22, 2026. Ice approved the campaign. This document defines the work and its acceptance gates; it does not claim that the target already ships.

## The result we will deliver

An owner creates a Collection, adds fields, and creates a form connected to it. A friend opens the shared app and submits. The response appears in that same Collection. The owner can edit it there, through an admin app, or with an agent. Every route observes the same permissions and data rules.

The owner can do the basic setup without an agent, SQL, terminal commands, or a database account. An already connected agent can add custom logic and interfaces. A prepared self-hosted server supplies sharing for this campaign. Hosting setup remains an operator task until dohc Drive supplies it.

The fundraiser is the complete acceptance case. A stock-and-orders example checks that the solution is general. Fundraiser prices, payment rules, roster rules, and capacity limits stay in workspace-owned source for its dataset operations, outside dohc core.

The campaign completes when this experience passes on the real desktop and self-hosted browser paths, with recoverable data and measured performance. Drive and native mobile are subsequent delivery projects. They are not prerequisites or substitutes for missing backend behavior.

## Flexibility is an acceptance condition

The default form and table are starting points. They must not define the user's only workflow. An owner or agent can add tables, fields, indexes, relationships, constraints, protected actions, custom queries, uploads, and app interfaces without changing dohc core for each new domain. Generated source stays visible and editable. A second app can present the same dataset for a different job, subject to the dataset's rules and its granted operations.

The product keeps a strict authority and safety model. It does not let a caller bypass ownership, isolation, permissions, transactions, resource limits, or recovery rules. Those limits protect the user's data; they do not prescribe the user's domain workflow. When the default UI cannot express a workflow, the escape hatch is authored app source and agent assistance, backed by the same governed data. It is not a fundraiser-specific core feature or a hidden exception.

Authored source still runs within the supported runtime. It does not remove this campaign's limits on backend networking, dependencies, scale, or cross-dataset transactions. Keep those limits distinct from permanent product principles. Owners may use external services through explicitly supported integrations; broader server-side effects require a separate capability design. This campaign does not claim Supabase feature parity.

Every stage asks whether it added a real capability or only another preset. A feature fails this campaign if it requires a fixed set of columns, a prescribed status flow, a custom dohc route for each app type, a second database for a new interface, or a manual developer patch to support an ordinary schema. Unsupported operations must state the limit and point to the supported extension path. They must not silently discard data or force an unrelated workflow.

## Start from the work that exists

These are source-inspection findings, not fresh runtime verification. Stage 0 reconciles them with the implementation baseline.

| Baseline | What exists | What remains |
| --- | --- | --- |
| `main` at `f6babbe194a61e7cece2f7731dad4ae9357d0337` | Document Collections, field and view editors, virtualized table, board, calendar, relations, history, human and agent edits; SQLite file editing and CSV import | Transactional app records do not appear as the same Collection records |
| `feat/app-form-generator` at `e10c28d5283cfb636467954b0ebf6973ad1f9f83` | Private local/shared backends, isolated operations, receipt uploads, helper access, publication, local-to-server transfer, recovery exports, App data editor, fundraiser and stock examples | Not on this inspected main; source integration and evidence audit are required |
| Same feature branch | Forms generated from Collection field definitions | Generation copies definitions once; the original Collection and response store remain separate; no native form builder |
| `prototype/app-backend-performance` at `39d365ba0046aafe6b70ffc7473007608bccea16` | Persistent-worker experiment and benchmark | No production adoption; authority, file lifecycle, recovery, resource management, and real host integration require production design |

This campaign supersedes the former app-owned backend and fundraiser plans. Git preserves their prior contents. The supported model and operator workflow are documented in the [dataset guide](../how-to/app-backend.md); the fundraiser example retains its acceptance requirements.

The benchmark supports SQLite and persistent execution. On a roughly 15 MiB dataset, pooled warm-write p95 fell from 331 ms to 6 ms. Burst writes succeeded 420/420 times versus 127/420. The machine was a Ryzen 9 desktop. The comparison changed execution and storage together, and omitted production obligations. It does not establish Supabase-equivalent capacity or latency.

## The model underneath the experience

### One identity and one authority for each record

Use Collection as the human-facing entry point for structured data. `CONTEXT.md` defines a Collection as a workspace view of transactional records or editable documents.

Internally, a transactional dataset identifies one workspace-owned transaction domain, as defined in `CONTEXT.md`. Users do not choose or configure a separate backend product. A dataset can contain related tables, each exposed through a Collection view. Several approved apps can use the same dataset through explicitly granted operations.

Dataset, table, field, and record identities survive display-name changes. App publications bind those identities and an approved operation version. Renaming a field must not create a new field or detach a form. Deleting or withdrawing an app does not delete its dataset.

Replace the current virtual `.sqlite` data path with an identity that cannot collide with an ordinary workspace SQLite file. A dataset may have a discoverable workspace descriptor, but its display path is not its storage authority. Creation without an app must not require a hidden fake web app.

The dataset owns its schema and mutation rules. Apps receive grants to invoke those rules; an app cannot weaken them by supplying another backend with unrestricted writes. Owner tables, imports, agents, and browser requests use the same enforcement module. Incompatible rules proposed by another app require an explicit schema/rule change, not another writer.

Schema plus operation source form one immutable dataset revision approved by the owner. An app publication references that revision and a granted subset of its operations. The owner approves a new dataset revision to change shared rules; approving a consumer app cannot change them. Stage 1 amends ADR 0010 and the publication contract accordingly. Source remains inspectable in the workspace, and recovery includes the approved dataset revision.

Transactional Collection grants explicitly control discovery, record reads, fields, history, relationships, and permitted actions. They are distinct from app-operation grants. A form link or parent-folder share does not implicitly expose backend records or attachments. Folder sharing may expose approved source files; transactional data access requires an explicit grant. Apply this rule to Collection views, SDK/MCP queries, exports, relation labels, and counts as well as app endpoints.

Organizer data authority must not require source Edit access. Preserve authenticated named membership and explicit owner designation, while separating data actions from permission to change app source. Only the owner can approve a dataset revision or widen its grants. Existing helper behavior is a starting implementation, not the final permission model.

Use one SQLite database per transactional dataset initially. Transactions can span its related tables. Cross-dataset transactions are unsupported and must refuse before a partial write. A cross-dataset relationship may support navigation, but must not imply atomic constraints.

### Keep document authority intact

Document Collections retain their canonical live Y.Doc, Markdown settlement, document body, and permissive field validation. Their SQLite tables are indexes, not a second writable source.

Transactional Collections read their records directly from the dataset. They do not manufacture editable Markdown copies. They enforce schema and app rules before acknowledging a change. A linked document body may remain a separate document; editing its prose does not implicitly run a transactional mutation.

Both use the same discovery, typed field controls, query vocabulary, and table components where their behavior matches. The UI explains a difference only when it matters: shared authority unavailable, protected action required, invalid document value, or an unsupported view.

Creating a new Collection defaults to transactional records, ready for forms and apps. The creation flow also offers document records for a Collection of editable Markdown documents. Describe that choice in terms of the work, without requiring a SQLite or Y.Doc decision. Existing document Collections stay documents.

Creating a transactional app from document records offers an explicit, previewed import; it does not silently attach transactional promises to live frontmatter. The app then names its actual destination Collection. The user can also bind a form directly to an existing transactional Collection without copying records or schema. There is no automatic in-place conversion or bidirectional synchronization between the two record types.

CSV and arbitrary SQLite files remain inspectable files. Import and export connect them to Collections. Import previews types, relationships, row failures, and the target. A file does not silently become a live governed backend. No generic SQL editor may bypass a transactional Collection's supported write path.

### A single host confirms shared transactions

Local datasets work offline without an account. Shared datasets have one configured transaction host. Disconnected clients may inspect a downloaded copy. Shared mutation attempts refuse with an availability notice; this campaign adds no general offline edit queue. Preserve the public form's uncertain-submission retry identity for recovery when the host returns.

Retain the existing local-to-server fencing behavior and prove it against the new store. Do not promote a replica automatically. A controlled host transfer must fence the old writer and preserve committed revisions, retry state, and attached files.

Start with the existing prepared self-hosted service topology. The already implemented local launch URL is not a remotely reachable share link. A computer-hosted deployment needs the same reachable sharing services and origin configuration. Do not claim that leaving the desktop open alone supplies internet hosting.

The local downloaded copy of a shared dataset receives committed changes without rerunning app code. It is read-only while disconnected from the authority. Revocation blocks future access and updates; it cannot erase data someone already downloaded while authorized.

### Persistent execution must preserve the security contract

Keep authored operations in a separate process with a fresh QuickJS guest per request. Retain guest SQL restrictions, input/output bounds, and no ambient filesystem, network, process, or secret access. Electron uses its utility-process launcher; self-hosting uses the packaged Node launcher.

The host commits a changeset, history, revision, retry result, and file associations together. Its checkpoint plus committed journal define the data. The worker materializes that state before accepting another operation. File bytes are durable before attachment. Recovery must never delete an attached upload as an orphan.

Authority lives outside authored code. The host verifies workspace, dataset, publication, caller, grant, operation, and schema version. Reads, refusal messages, saved retry results, file reads, and writes all require current authority.

The existing shared host rechecks authorization in the same storage transaction as its snapshot commit. Preserve that ordering when the transaction instead appends a changeset. The worker retains a speculative transaction until the host confirms the journal commit. If confirmation or worker finalization fails, recover from the journal before another operation. Reads, refusals, and saved results also require a final current-authority check.

This implementation refinement avoids an authorization fence spanning two independent writers. Revocation before the journal commit prevents the write. Revocation after commit may block disclosure without undoing accepted data. The worker database is recoverable materialization, not an independent authority. See ADR 0011 and its fault probes.

Reserve bounded worker capacity in the host and charge retained checkpoint, journal, receipt, and file bytes there. Keep attachment associations in the same host transaction as the event. No later materialization metadata write is required to recover a committed operation. This does not assume cross-database atomicity.

## Delivery stages and exit gates

Each stage produces reviewed, usable code and evidence. Keep linked changes together, and keep unrelated work out of each PR. The implementation lead owns the integrated result.

### 0. Establish the integration baseline

- Inventory the earlier branch, its review evidence, dependent commits, and overlap with current main.
- Select the smallest ordered PR stack that carries the existing backend, host, uploads, owner management, and examples intact.
- Preserve source and recovery fixtures before replacing internal contracts. No compatibility layer is required for obsolete prelaunch APIs. Shipped engine migrations remain append-only.
- Record a fundraiser behavior matrix against the current source in `C:/Users/ice/dev/mom-fundraiser`. Include its newer attendee/ReClub checklist behavior; do not freeze coverage at the older example.

Exit: an exact integration base, reusable evidence inventory, and explicit list of missing behaviors. Earlier tests count only when their tested code and dependencies still apply. No automatic merge is part of the go signal.

### 1. Set the data and commit contracts

- Record the Collection terminology change, dataset ownership, stable identities, operations, and document/transactional behavior in the glossary and relevant ADRs.
- Define the authority-fence, durable commit, attachment, quota, and recovery ordering described above.
- Define a streamed or chunked recovery/transfer format with a consistent revision manifest, bounded memory, integrity checks, and staging before activation. The existing base64 JSON export cannot carry the larger performance fixture within its 128 MiB limit.
- Define the owner replica stream: dataset identity, ordered revisions, checkpoints, catch-up cursor, gap/duplicate detection, schema version, interrupted restart, and authority fencing. It carries committed changes only. Replica access requires a data grant, not an app submission grant.
- Specify errors, queue deadlines, cancellation, backpressure, retry retention, schema revision checks, and worker resource limits.
- Define the common description/query/action interface for human and agent callers. Typed fields and permitted actions must be discoverable without SQL or guessed operation names.
- Define transactional Collection grants alongside app-operation grants. Filter discovery, fields, history, relationship resolution, and attachment metadata before returning them.
- Define one schema/rule owner per dataset and explicit consumer-app bindings. Multiple apps cannot install competing write policies.
- Define a capability test for each new contract: a non-fundraiser schema with a relationship, a multi-record operation, a custom view, an attachment, and a second app must work through the same interfaces without a dohc core change.
- Prove the riskiest ordering with focused fault-injection tests before building the owner UI on it.

Exit: reviewed contracts and passing probes for revocation during an operation, death around commit, changed retry payload, durable attachment, and interrupted ownership transfer. No unresolved double-writer or split-commit failure proceeds to Stage 2.

### 2. Replace snapshot execution in the real hosts

- Implement persistent execution behind the agreed interface in local Electron and the shared Node host.
- Reuse the production evaluator through a supported module interface. Do not ship the prototype's source-text extraction or test hooks.
- Keep fresh guest state, structured refusals, cancellation, and safe initialization cleanup. Specify retained-connection SQL restrictions explicitly.
- Bound queued bytes, queue wait, active execution, workers, worker memory, idle lifetime, and per-workspace storage. Overload returns a recoverable response without accepting a write.
- Replace the route's shared 30-token link bucket and eight-pending-request bottleneck with measured admission limits. Keep participant, link, dataset, and global abuse bounds; one busy public link must not starve organizer recovery.
- Preserve existing publication, helper access, uploads, export/restore, and local-to-server transfer as they move to the new store.
- Add indexes and bounded pagination for generated operations. Avoid full-database copy, hash, and quota scans on each ordinary write.

Exit: both real hosts pass current backend tests and the failure matrix below. Re-run the benchmark with authority, history, attachments, and quotas enabled. Record cold starts, each round's p95/p99/max, failures, and memory, not only pooled successful medians. The prototype itself remains experimental evidence.

### 3. Connect Collections to authoritative app data

- Add transactional datasets to workspace discovery and the Collection contracts with stable identity.
- Adapt the existing table/field/query components to transactional records. Retire the duplicate App data table when the replacement covers its actions, recovery export, and access checks.
- Replace schema-copy generation for transactional Collections with explicit dataset binding. A form, owner table, second approved app, and agent must refer to the same records.
- Provide typed fields, required/default rules, uniqueness, same-dataset relationships, attachments, indexed filtering/sorting, and bounded paging.
- Use named actions for protected transitions. Editing fundraiser status must run its status operation; generic cell edits and imports cannot release or consume slots around it.
- Support safe field add/rename and view changes. Type changes and destructive schema edits require validation, a recoverable checkpoint, and an explicit result for every affected value.
- Run approved schema DDL and data migration in the isolated worker against a checkpoint under owner authority. Record the resulting dataset revision and activate it atomically with compatible operations.
- Pause or refuse incompatible operation versions during schema activation. Never run an old approved operation against a silently changed schema.
- Preserve document Collection editing, body collaboration, history, and invalid-value behavior.

Exit: a public submission appears in the same transactional Collection; human and agent edits change that record; a second bound app sees the committed result. No copied response store exists. Document Collection regression checks pass. CSV import refuses invalid transactional rows without bypassing rules.

### 4. Complete setup and management without an agent

- Let the owner create a transactional Collection, choose fields, add sample data, and generate a source-backed form through dohc.
- Let the owner choose public submission fields and private fields, preview, approve local execution, and share through a configured server.
- Reuse existing publication and helper controls. Show requested access and let the owner withdraw the app or revoke a helper.
- Provide table editing, record details, protected actions, attachment preview/download, export, and history with a visible reverse path for reversible edits. Preview untrusted uploads only through a sandboxed surface, otherwise offer download.
- Provide dataset deletion with an explicit affected-app scope, irreversible-action warning, and stated recovery policy. App withdrawal alone leaves records intact.
- Expose matching discoverable operations through agent tools. Agents must not need renderer automation or undocumented SQL for supported actions.
- Generate ordinary validation and safe default operations from fields and constraints. Advanced multi-step business rules require authored source or an agent; do not promise a no-code editor for arbitrary logic.
- Verify that the generated defaults remain replaceable. The owner can inspect and edit the generated source, add tables and operations, and keep using the same data surface after those changes.
- Improve ordinary retry recovery so a refresh after a lost response does not silently produce a second submission. Do not make recovery-file handling the normal successful form journey.

Exit: a person with no connected agent creates, shares, submits, manages, and exports a simple form without developer commands. A connected agent can perform the equivalent operations. A custom fundraiser still uses authored source for its business logic; this is not a visual programming system for arbitrary code.

Inspect both themes, keyboard access, focus, loading, empty/error/retry states, reduced motion, and workspace switching. Use the existing notice system. Abort or ignore stale responses before they can repaint another workspace.

### 5. Prove the complete fundraiser and local ownership

- Integrate the existing fundraiser example with the unified data contracts. Add missing behavior from the Stage 0 matrix.
- Exercise its public participant flow, browser organizer app, owner Collection, and agent against the same self-hosted dataset.
- Complete a scoped local replica for authorized owner inspection of shared data. Apply committed history; never rerun backend logic on replicas.
- Complete repeatable backup/restore and controlled host transfer with attached bytes, schema, source references, history, and retry state. Do not silently grant restored helper access.
- Validate app/schema updates after real submissions, withdrawal, helper revocation, host outage, and reconnect.
- Run the stock-and-orders example using app schema/source changes only. Do not add fundraiser-specific core APIs.

Exit: every applicable acceptance row below passes on the actual compiled app and services. The owner can recover on a clean host with the required workspace identity and continuity state. A stopped old host cannot resume as a competing writer. Fresh self-host setup and documented recovery must work without manually repairing internal databases.

### 6. Validate scale, usability, and readiness

- Test the agreed performance envelope below on ordinary hardware and the reference machine.
- Run a sustained multi-app workload, repeated worker eviction/restart, bounded overload, and storage pressure.
- Set measured storage/query/upload limits. Replace tiny experiment limits only where the new storage and recovery design supports the larger envelope.
- Reclaim abandoned checkpoint stages at exclusive host startup, in bounded pages with atomic quota refunds. Preserve recovery-import stages.
- Retain all committed history, schema checkpoints, and retry receipts within quota. Automatic history compaction is deferred: recovery needs the complete revision chain, and receipts refer to their original events. Quota exhaustion refuses writes; export alone does not release storage. This replaces the earlier history-maintenance target and requires review as a campaign scope change. Never prune a key so that an old request can silently execute again.
- Complete a task-based usability pass with someone who did not implement the feature. Retain the task list, completion outcomes, observed help needed, and remaining friction. Fix setup dead ends and misleading success states.
- Record shipped behavior, unsupported limits, and operator instructions. Publish performance claims only for the measured workload.

Exit: selected verification gates and reviews pass, no known correctness or privacy blocker remains, and the product-level acceptance tests are complete. A code-complete worker alone does not finish the campaign.

## Acceptance matrix

Use synthetic participants, receipts, and payment details. Keep the live fundraiser and its Supabase/Vercel deployment untouched.

| Scenario | Required observation |
| --- | --- |
| Owner creates a simple backend without an agent | UI creates fields, data, source-backed form, and binding; no SQL, CLI, or per-app infrastructure account |
| Form, Collection, admin app, and agent | Same dataset and record IDs; edits visible after committed refresh/update; no duplicate records or hidden writable mirrors |
| Two apps bind one dataset | Each has only its granted operations; neither weakens the other's schema or data rules |
| Field rename and schema change | IDs survive rename; compatible changes preserve data; incompatible published operations refuse until reapproved |
| Group signup, players/spectators, both sessions | Host computes prices; both session reservations commit together or neither commits |
| Competing final-slot requests | Capacity never exceeds the configured limit; losing requests receive a business refusal |
| Payment and receipt | Public signup requires its receipt; private bytes are associated durably; payment does not itself reserve a slot |
| Lost response, refresh, reconnect, worker crash | Same intended submission is recoverable without duplication; different input under the same key refuses |
| Organizer review | Receipt access, payment verification, rejection/restoration, totals, attendee lists, manual/pay-at-venue entries, and source-matrix checklist behavior work |
| Direct table or agent edit | Protected transitions enforce the same capacity, payment, and version checks as the admin app |
| Participant status | Private status credential grants access only to that registration; no unauthenticated mobile-number lookup; secrets stay out of organizer lists and logs |
| Private upload or record guessed | Browser, file, blob, history, log, export, alternate app, and agent routes all enforce the declared access |
| Malicious receipt opened | Sandboxed preview or download cannot inherit workspace credentials, navigate the owner app, or execute content with owner authority |
| App folder shared, response Collection discovered | Submit-only callers cannot enumerate records, private fields, counts, relation labels, history, or attachments through desktop, browser, SDK, or MCP; owner/helper views follow explicit data grants |
| Helper removed or publication withdrawn | New calls, queued calls beyond the fence, receipt replay, reads, and file downloads cannot regain revoked authority |
| Organizer manages records without source Edit | Explicit data actions work; source changes, grant widening, and publication approval refuse |
| Crash before and after commit | Before: no accepted change; after: rows, history, receipt, and attachment agree and retry recovers the result |
| Shared host unavailable | Downloaded work remains inspectable; shared changes remain visibly unconfirmed; no competing writer appears |
| Export and restore | Clean target recovers records, file bytes, schema/source compatibility, history, retry behavior, and required continuity; corrupt/incompatible bundles refuse |
| Undo or reverse action | Reversible edits have a visible path; reversing a business action rechecks current constraints and records a new change |
| Dataset deletion | App withdrawal alone preserves records; destructive deletion has explicit scope, warning, and recovery policy |
| Second example | Stock limits and order creation work without modifying dohc core |
| Flexibility check | A non-fundraiser app with custom tables, relations, constraints, a multi-record operation, a custom view, and an attachment works through the same Collection, app, and agent interfaces |

A form-only proof does not satisfy the fundraiser rows. A generated UI screenshot does not establish runtime behavior.

## Performance envelope and measurement

These are proposed engineering gates for this campaign, not public service guarantees. Stage 1 locks the fixture and supported envelope before implementation is measured. Any change to a target must appear in the review record with its reason.

- Reference machines: the existing Ryzen machine and an ordinary 4-core, 8 GiB, SSD computer. Use real hardware for the second claim; a throttled developer workstation is only preliminary evidence. If ordinary hardware is unavailable, report that gate as outstanding, not passed.
- Fixtures: existing small and near-16-MiB benchmark, then 100,000 narrow records and a 100-MiB transactional dataset. Test row count and byte size separately. Seed outside measurement.
- Local warm read/write p95 target: at most 50 ms for bounded indexed operations, including authority and durable commit. Report each of three rounds; a pooled pass cannot hide a failed round.
- Owner table: first usable page within 300 ms warm; keyboard/cell interaction feedback within 100 ms. Keep work bounded by page size. Measure renderer responsiveness separately from backend latency.
- Cold first operation target: at most 1 second. Record at least 30 cold starts and report initialization separately from reopening existing data.
- Burst: all ten admitted independent submissions complete within 1 second on local and controlled-LAN tests. At 100 simultaneous callers, every request receives success, business refusal, or explicit bounded overload; none is lost or duplicated. Report admission and success counts.
- Public-link load: 100 distinct participants each complete availability read, upload, submission, and status read over five minutes through one link. Mint a distinct browser profile secret through normal enrollment for each participant. Legitimate requests must not fail merely because they share the link's bucket. Use a generic unconstrained submission fixture for host admission and a separate fundraiser run with expected capacity refusals. Include concurrent organizer reads and adverse repeated-client traffic in a separate abuse run.
- Run a one-hour mixed workload with at least ten datasets and worker churn. Provisional host worker budget: 512 MiB aggregate, with a finite configurable pool. Confirm no monotonic retained-memory growth after idle cycles.
- Record SQLite version/settings, packaging, fixture hashes, commit, antivirus status, host load, p50/p95/p99/max, failures, queue wait, commit time, database/WAL/history/blob bytes, and UI stalls. Include indexed search, broad text search, late-page navigation, upload, and export effects.

Broad arbitrary queries have explicit cost/row limits and may return a supported refusal. Do not advertise the bounded indexed-operation target for unbounded search or arbitrary SQL. Test several datasets competing for the same host and storage, not only one isolated worker.

Reassess database choice only if measured SQLite limits block this envelope after execution, indexing, and storage costs are corrected. Postgres remains an option for a later hosted scale tier, not an account requirement for local use or an unmeasured promise of unlimited scale.

## Delivery ownership and review

The lead owns contracts, integration, acceptance evidence, and scope decisions. Parallel implementation starts only after the relevant contracts stabilize.

Independent workstreams may cover the runtime, shared authority/storage, Collection contracts and agent tools, Collection/form UI, and application acceptance tests. Each write-capable agent uses an owned worktree. Shared contracts have one editor. UI and contract work can use agreed fixtures while runtime work proceeds, but fixture success does not count as integrated acceptance.

Fable reviews the campaign before kickoff and supplies the required second-family review where Codex implements non-trivial changes. An independent risk reviewer covers authorization, isolation, migration, durability, and integration changes. Keep reviewers through fix rounds and resolve verified blockers.

One verification owner runs `pnpm verify:pr --base <target-ref>` for each integrated change. Others run focused checks. Use the Rust gate skill for Rust checks and the documented desktop preparation/QA procedures. Record exact tested/reviewed commits and explain evidence reuse. Merging remains Ice's decision.

Clean task-owned worktrees, builds, profiles, and processes after preserving deliverables and required evidence. Never delete another session's resources.

## What stays outside this campaign

- Operating dohc Drive, billing, managed backups, fleet availability, or multi-region failover.
- Building the native mobile app. Participant and organizer browser flows must still work on mobile-sized screens.
- Multi-writer offline confirmation of shared transactions, automatic authority promotion, or cross-dataset atomic transactions.
- Replacing live documents with SQL rows, or making every external CSV/SQLite file a live backend.
- A full Supabase feature clone, unrestricted backend network calls, arbitrary npm execution, or a general visual programming language.
- A fixed workflow hidden behind a form generator, or a requirement that every new domain become a dohc core feature.
- Payment processing, notification delivery, external ReClub integration, or exactly-once effects outside the database.
- Moving real fundraiser records or changing its live deployment.

Drive should later operate the same tested hosting contract. Mobile should later call the same authorized data/actions interface. Neither should require another data model.

## What the go signal approves

Approve this campaign's staged implementation and verification: SQLite persistence, shared data contracts, connected Collections, human setup, and the full self-hosted fundraiser proof. The initial work is Stage 0 and the Stage 1 contract/failure probes, followed by implementation through the exit gates.

The go signal does not authorize merges, public deployment, live fundraiser migration, or changing the agreed product scope. Report a material architectural conflict when evidence requires a different contract; resolve routine implementation choices within this plan.

## Evidence and source map

- Current Collection contract: `CONTEXT.md`, `packages/workspace-contracts/src/collection.ts`.
- Collection UI and live editing: `apps/desktop/src/renderer/CollectionPage.tsx`, `packages/collection-views/src/table/TableView.tsx`, `apps/desktop/src/workspaces/collectionRecordEdits.ts`.
- Collection indexing: `crates/dohc-engine-domain/src/collections.rs`.
- Feature-branch contracts and limits: `docs/how-to/app-backend.md`, `docs/adr/0010-app-backends-own-private-transactional-data.md`, `packages/app-backend-runtime/README.md`.
- Feature-branch host ordering: `services/sync-relay/src/appBackendHost.ts`, `services/sync-relay/src/storage/appBackendData.ts`, `apps/desktop/src/workspaces/localAppBackend.ts`.
- Unified UI/generation: `apps/desktop/src/renderer/ConnectedTransactionalCollection.tsx`, `apps/desktop/src/workspaces/datasetFormGenerator.ts`.
- Existing examples and browser proof: `examples/fundraiser`, `examples/stock-orders`, `services/share-web/e2e/app-backend-fundraiser.spec.ts`, `apps/desktop/e2e/app-backend-local.spec.ts` on that branch.
- Experiment: `packages/app-backend-runtime/prototype/RESULTS.md` on the prototype branch. Local evidence is retained in `.agent-artifacts/backend-performance-39d365ba0`.

Review status: Fable reviewed the draft and the final delta on September 22, 2026. Fable found no substantive plan blockers. The remaining risks are the unproven two-store authority fence, SQLite scale envelope, and helper/source-access separation; Stage 1 and Stage 2 gates cover them.

The review resolved an ambiguous approval object by defining dataset revisions. It moved recovery and replica contracts into Stage 1 and made the Collection creation choice explicit. Smaller fixes assigned deletion, sandboxed previews, isolated migrations, and measurable usability/load evidence to their stages. An independent data audit also required explicit transactional Collection grants to prevent folder shares from exposing private responses.

Fable session: `b5c3cd8f-5947-4c79-b74d-9d1472bbea84`, model `claude-fable-5-1`. The draft review and focused fix review covered this plan; neither constitutes production verification. Local review reports are retained in `.agent-artifacts/unified-app-data-campaign-2026-09-22`.

After that review, Ice clarified that usability must not impose fixed workflows. The flexibility section and related acceptance checks record that clarification. Fable's recorded review predates this addition.

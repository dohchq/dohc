# Think Bigger WS-G2: Rich-Doc Collaboration And The Engine (Design)

Status: design accepted for lane cutting (no product code in this doc's PR)
Date: 2026-07-06
Arc: WS-G (content drivers), lane WS-G2
Basis: the flag-default-on gate list in the
[0N-3 legacy salvage audit](./2026-07-06-think-bigger-0n3-legacy-salvage-audit.md)
("live collab (Y.Doc) re-homed on the engine or explicitly decoupled so the
flip does not regress co-editing"),
[Refined Implementation Default 7](./2026-06-23-think-bigger-dohc-workspace-engine.md#refined-implementation-defaults)
(content drivers own canonical state; rich docs can use Y.Doc), the
[0P sync design](./2026-07-06-think-bigger-0p-sync-design.md)
(multi-origin log), and the
[P0A inventory's canonical-rich-docs section](./2026-06-24-think-bigger-phase-0a-current-system-inventory.md#canonical-rich-docs-and-ydoc).
All claims about current code are verified against this worktree
(branch base main `2704d018`).

## Why this document

The 0N-3 audit names live rich-doc collaboration as one of the honest gates
on defaulting `workspaceEngineAlpha` on. This note answers that gate: does
collab have to re-home onto the engine before the flip, or can it be
explicitly decoupled without regressing co-editing? The answer turns on what
the editor actually does today for one user, which this document verifies in
code rather than assumes.

## Goals

- Make the collab gate item implementable: a precise statement of what the
  flag flip requires from the collab stack, backed by code citations.
- A no-silent-loss coexistence contract: a document must never have two
  canonical sources at once, including across engine restore, agent writes,
  and the eventual driver handoff.
- A committed later shape for collab-on-engine that fits Refined Default 7
  and the 0P op model, so today's decision does not paint the team wave
  into a corner.

## Non-goals

- No product code in this lane. This is the design note only.
- No multi-user product design (presence UX, permissions, share flows) —
  that is the team wave, on the rebuilt cloud (audit Phase D, PR 18 scope).
- No rich-doc semantic merge beyond what exists (`mergeMarkdown` three-way).

## What the code actually does today (verified)

The central finding: **the engine flag and the collab stack are already
orthogonal in code.** Solo editing has no Y.Doc anywhere in it, and collab
never touches `.dohc/engine`. The details, per file:

1. **Collab only exists for shared cloud workspaces with a live session.**
   The `collabToken` IPC handler (`apps/desktop/src/main.ts:1892`) returns
   `available: false` unless `workspace.kind === "shared"` with a remote AND
   cached credentials match that remote's server (main.ts:1897-1903). Every
   failure — signed out, server mismatch, non-OK token response, unreachable
   Hocuspocus — degrades to `available: false` or a caught rejection, and
   the renderer hook sets status `"disabled"`
   (`apps/desktop/src/renderer/collab/useCollabDoc.ts:174-179, 278-280`).
2. **The solo editor never constructs a Y.Doc.** `useCollabDoc` dynamically
   imports `yjs` and `@hocuspocus/provider` only after a token is granted
   (useCollabDoc.ts:181-184). With collab disabled, `MarkdownEditor` runs
   Tiptap on plain markdown content with its local undo/redo stack
   (`LOCAL_STARTER_KIT`, `apps/desktop/src/renderer/editor/MarkdownEditor.tsx:97`)
   and only loads the Collaboration extension when `props.collab?.ydoc` is
   present (MarkdownEditor.tsx:1458-1462). Saving is a plain 800ms-settle
   autosave through `writeWorkspaceText`
   (`apps/desktop/src/renderer/FileInspector.tsx:530-562, 641-642`).
3. **What breaks without Hocuspocus: nothing, for a local workspace.**
   For a shared cloud workspace, live co-editing degrades to the same local
   autosave editor — fail-closed by design (main.ts:1915-1918: "the editor
   stays usable in local mode"). There is no code path where a missing
   Hocuspocus blocks editing.
4. **Engine capture already sees collab output.** When a session IS live,
   the CRDT materializes to disk at settle points through the same
   `writeWorkspaceText` bridge (useCollabDoc.ts:107-119), the watcher
   observes the write, and on an engine-flagged workspace
   `workspaceActivity.ts` routes it through `engineCapture` like any other
   file change. Engine moments record the settle points of a collab session
   automatically — coarser than keystrokes, exactly the coalescing Refined
   Default 5 wants.
5. **The canonical-while-open model is self-contained and already handles
   the two-sources problem for its own case.**
   `apps/desktop/src/renderer/collab/collabSession.ts` states the invariant
   (file canonical while closed; CRDT canonical while a session is live) and
   implements the edges: settle-point materialization, self-write
   suppression by sha, three-way `mergeMarkdown` for external on-disk edits
   with a visible `<path>.conflict` rescue on overlap
   (useCollabDoc.ts:136-144), and a `.recovered` rescue file on
   delete-with-live-doc (collabSession.ts:171-209). Its only engine-adjacent
   dependency is `@dohc/workspace-history/mergeMarkdown` — the salvage edge
   the audit already tracks.
6. **Hocuspocus persistence is a separate timeline outside the engine.**
   Y.Doc updates persist as sequential update rows plus snapshots in
   Postgres (`services/hocuspocus/src/persistence.ts`), with a projection
   worker writing the markdown body cache back to the atom
   (`services/hocuspocus/src/projection.ts`) — the P0A inventory's
   "separate timelines" gap, unchanged. Nothing in
   `packages/workspace-engine` references Y.Doc, Yjs, or Hocuspocus.

Consequence: the audit's gate wording offers "re-homed **or explicitly
decoupled**" — and the decoupling substantially exists in shipped code. What
is missing is the explicit decision, the pinning tests, and the handoff
rules for later.

## The three candidate architectures

### (a) Decouple-and-defer — CHOSEN

The engine flag defaults on for what the engine actually does (file
versioning, history, restore, chats, search, policy). Rich-doc live collab
stays on the legacy Hocuspocus path, reachable only from cloud-connected
shared workspaces, exactly as today. Single-machine rich-doc editing is the
existing local Tiptap autosave path plus engine settled-file capture — no
Y.Doc involved. Collab re-homes with the team wave (candidate (b) becomes
the plan of record then).

The flag gate becomes: **"the rich-doc editor works fully without
Hocuspocus, and collab sessions coexist with engine capture without a
second canonical source"** — which is verifiable today — rather than
"collab re-homed", which is a multi-lane build.

- Cost: near zero. One verification lane pins the decoupling with tests.
- Risk carried: cloud co-editing keeps a legacy dependency (Hocuspocus +
  workspace-api token minting + Postgres) until the team wave — consistent
  with the audit's KEEP-AS-IS-then-salvage classification and Phase D.

### (b) Y.Doc as an engine content driver — the committed later shape

Rich docs get a driver per Refined Default 7: the engine persists Y.Doc
updates (sequential update blobs plus periodic snapshots — the same shape
Hocuspocus's `persistence.ts` proved) in `engine.db`, and projects markdown
to disk as the settled file, which remains what agents, search, export, and
history moments see. Single-writer locally; awareness is in-process. Live
multi-user collab arrives only with sync (0P-B+): Y.Doc updates are
commutative CRDT deltas, so they replicate naturally as ops in the
multi-origin log — a new `ydoc.update` op kind carrying
`(originId, originSeq)` like every other op, with convergence guaranteed by
Yjs semantics rather than head checks. Low-latency co-editing then needs
only a faster fan-out of the same ops (relay push instead of poll), not a
different data model.

This is the right end state, and (a) explicitly preserves it. But building
it before flag flip is the wrong order:

- It creates a second canonical-state regime for solo users who currently
  have a perfectly good one (the file), taking on driver snapshot/diff/
  merge/restore/export semantics (the full Default 7 behavior matrix) with
  no user-visible payoff until multi-user exists.
- Its multi-user payoff is blocked on 0P-B (relay) regardless, so shipping
  the driver now buys latency-free nothing.
- It would rewrite the riskiest code path in the product (the editor's
  save path) at the exact moment the flag flip needs stability.

### (c) Full re-home now — rejected

An engine-native collab server replacing Hocuspocus before flag flip.
Wrong on every axis for a single-user alpha: it builds a multi-user server
for a product whose individual-first principle means co-editing may have
zero users at flip time; it duplicates 0P-B's transport work before 0P-B
exists; and it deletes a working, security-reviewed stack (token workspace
checks, ACL rechecks, payload validation — P0A inventory strengths) to
re-earn the same properties under time pressure. The audit already
classified Hocuspocus KEEP-AS-IS-then-salvage; (c) contradicts it without
new evidence.

## Decision

**(a) Decouple-and-defer**, with (b) recorded as the committed re-home
shape for the team wave. Rationale, grounded in the verified code:

- The decoupling is not aspirational — it is how the desktop already
  behaves. `collabToken` fails closed to local editing; no local workspace
  ever touches Y.Doc; engine capture already records collab settle points.
  Choosing (a) converts shipped behavior into a stated contract.
- The data-loss story does not regress. Solo rich-doc editing under the
  engine is autosave + settled-file moments — strictly better than the
  legacy `.dohc/history` path it replaces. Live sessions keep the
  canonical-while-open model's protections (three-way merge, `.conflict`
  and `.recovered` rescues) unchanged.
- The sync fit favors waiting: 0P's op log is the natural carrier for Y.Doc
  updates, and it does not exist yet. Building the driver now means either
  inventing a second replication path or sitting idle until 0P-B anyway.
- Retirement Phase D is honored: Hocuspocus stays as-is while the cloud
  stack lives, and the salvage targets are known (auth/token flow shape,
  `doc-name` encoding, `import-export`/`dohc-markdown-extensions`
  round-tripping, the update+snapshot persistence schema, suggestions and
  semantic-api surfaces) when (b) lands.

## Coexistence rules (no silent loss, one canonical source)

The invariant: **at any instant, a document has exactly one canonical
source — the settled file on disk, or a live CRDT session — and every
transition between them is a defined handoff.**

1. **Closed doc (the default): the file is canonical.** Engine moments are
   the history of the file. This is true for flagged and unflagged
   workspaces alike, and for docs that have never seen a collab session.
2. **Live session (shared cloud doc, signed in): the Y.Doc is canonical;
   the file is its projection.** The engine does NOT gain authority here —
   it records materializations as ordinary moments, the same way it records
   agent writes. Engine history of a live-session doc is therefore the
   history of settle points, not keystrokes. This is accepted and
   documented, not a bug.
3. **Engine restore into a live session is an external edit.** Restore
   writes the file through the normal bridge; the open editor's reconcile
   effect (useCollabDoc.ts:304-308) folds it into the doc via three-way
   merge, or rescues to `<path>.conflict` on overlap. The restore is never
   silently overwritten by the next settle, because the settle's
   materialization base was advanced by the merge. A pinning test for
   exactly this sequence (restore-while-open) is part of milestone G2-A.
4. **Session teardown returns authority to the file** via the
   `session-close` materialization trigger (collabSession.ts:49) — the file
   equals the final CRDT state before the session ends, so there is no
   window where both sources disagree with neither live.
5. **The future driver handoff (a) → (b) happens only at a closed-session
   boundary.** When the Y.Doc driver ships, a document migrates from
   Hocuspocus-canonical to engine-driver-canonical by: (i) admin-disconnect
   the Hocuspocus doc (the admin surface exists,
   `services/hocuspocus/src/admin.ts`) so no session is live; (ii) verify
   the settled file equals the doc's markdown projection (re-project and
   compare, don't trust the cache — the P0A "separate timelines" gap means
   `atoms.body` is not proof); (iii) seed the engine driver's initial Y.Doc
   from the settled file (markdown import), NOT from the Hocuspocus update
   log — the file is the durable artifact, per rule 1; (iv) record the
   migration as a moment. A mismatch at (ii) preserves both (file plus an
   exported `<path>.hocuspocus.md` projection) and surfaces a conflict.
   Never migrate a doc with a live session; never leave both stores
   writable for the same doc.
6. **Legacy Y.Doc update history is not migrated.** User Decision 6
   (replacement, not migration) applies: the settled file carries the
   content forward; pre-handoff keystroke granularity is not preserved.
   Anything the projection loses beyond markdown fidelity is covered by
   user question 2 below.

## Milestone cut

### G2-A — Pin the decoupling (this wave; small, flag-gate closing)

No new architecture; tests plus the gate flip. Deliverables:

- E2E: an engine-flagged personal/local workspace edits a rich doc with no
  Hocuspocus reachable and no cloud config — editor loads, autosave works,
  moments capture, restore round-trips. (Largely covered by existing
  engine-capture/history E2E; the explicit no-collab assertion is new.)
- E2E or integration: restore-while-open on a live collab session folds the
  restored text into the doc or rescues to `.conflict` (coexistence rule 3).
- Test: collab materializations on an engine-flagged shared workspace
  produce engine moments (coexistence rule 2).
- Docs: mark the audit's collab gate item satisfied-by-decoupling, citing
  this design.

Exit: the collab item on the 0N-3 gate list is checked; WS-H (flag flip)
is unblocked on this axis.

### G2-B — Y.Doc content driver in the engine (team wave; depends 0P-A)

Refined Default 7 made real: `ydoc_updates`/`ydoc_snapshots` (update blobs
content-addressed like all blobs; snapshot cadence per Hocuspocus's proven
scheme), markdown projection as the settled file through the existing
capture path, driver behavior matrix declared (snapshot, diff-as-projected-
markdown, merge/conflict via projection + P0D rows, search/export over the
projection, restore = seed-from-moment-blob). Single-machine only; the
editor binds Tiptap to the local driver doc. Includes the rule-5 handoff
tool for existing cloud docs.

### G2-C — Replicated collab (team wave; depends G2-B + 0P-B)

`ydoc.update` ops in the multi-origin log; relay fan-out push for
low-latency sessions; awareness over an ephemeral (never persisted)
channel; Hocuspocus + its Postgres persistence retire per audit Phase D,
salvaging auth shape, doc-name encoding, import-export, and the
suggestions/semantic-api surfaces.

## Risks

1. **Settle-point granularity surprises.** Engine history of a co-edited
   doc shows materializations, not keystrokes; a user comparing it to the
   (future) driver history may read gaps as loss. Mitigation: G2-A
   documents the granularity; the timeline already labels capture sources.
2. **The legacy dependency lingers.** (a) keeps Hocuspocus + workspace-api
   + Postgres alive for exactly one feature (cloud co-editing) after the
   flip, which is retirement pressure deferred, not removed. Bounded by
   the audit's Phase D framing and user question 1.
3. **`mergeMarkdown` salvage edge.** `collabSession.ts` imports
   `@dohc/workspace-history/mergeMarkdown`; audit Phase B moves it behind
   an engine-owned boundary before `workspace-history` dies. Tracked
   there; G2-A must not accidentally double-home it.
4. **Handoff verification depends on projection fidelity.** Rule 5(ii)
   compares re-projected markdown to the settled file; if
   `import-export.ts` round-tripping has lossy corners, migrations will
   surface conflicts noisily rather than lose data — correct but
   annoying. Measure round-trip fidelity early in G2-B.

## Open questions for the user

1. **At flag flip, does cloud co-editing stay available on the legacy
   stack, or ship dark?** (a) keeps Hocuspocus serving shared cloud
   workspaces until G2-C. If nobody co-edits during the alpha, disabling
   collab tokens at flip (editor already fails closed to local mode) lets
   Phase D retire the whole cloud unit sooner. Recommendation: keep it
   available — it costs nothing at flip and preserves the one shipped
   multi-user surface — but you know the real usage.
2. **Is markdown fidelity sufficient across the (b) handoff?** Rule 6
   carries content forward through the settled file, dropping any rich-doc
   state that markdown projection loses (e.g. live suggestion threads from
   `services/hocuspocus/src/suggestions.ts`, unexported marks). If some of
   that state must survive, G2-B's handoff grows a Y.Doc-level export step
   and the scope changes. Recommendation: markdown is sufficient — the
   file is the product's durable artifact everywhere else.

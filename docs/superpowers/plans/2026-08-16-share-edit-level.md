# Edit level — the recipient sends changes, the granter accepts them

Design addendum for issue #646, PR3. Extends
`docs/superpowers/plans/2026-08-14-share-access-levels.md`, whose PR3 section is
an honest sketch that defers the write-back model to this document.

Anchors are against `main` at commit `1767de7d` (PR #780 and PR #782 merged).

> **What Edit v1 is, in one sentence.** A recipient at edit level may make
> **text edits to files the share already contains**, and send them for the
> granter to accept.
>
> It is not general write access to the share view. Creating, renaming,
> deleting and importing files stay refused at every level, because those
> handlers write the share view's FOLDER — which is a projection of its engine
> store — and a raw-disk write there produces nothing the recipient could send
> and is overwritten by the next pull. The one write that is supported is
> routed to the engine at its own seam (`routeWorkspaceTextWrite`), and the
> workspace-wide write gate (`assertWritableWorkspace`) still refuses every
> share view at every level: it guards 27 handlers, and widening it for one
> would have opened all of them.
>
> Routing create, rename, delete and import through the engine as well is a
> follow-up, one handler at a time. This document describes the lane; the
> narrower v1 is what PR3a ships.

---

## Context

Ice decided the write-back model on 2026-08-15, then reversed it on 2026-08-16.
The reversal is the premise of this document.

**Decided (final): Option B — a proposal.** A recipient's edits reach the
granter as changes the granter reads and then accepts or declines. Nothing a
recipient writes lands in the granter's files without the granter's act.

**Option A — a recipient's edit landing directly — is withdrawn.** It survives
only as a possible future: "auto-accept changes from this recipient", built on
the proposal lane rather than beside it. This document keeps that door open and
builds none of it.

**Live co-editing stays out of scope.** A shared Y.Doc session across two
accounts depends on the two-real-peer work (#547/#548) and is not this PR.

### Why B is also the smaller design

B was chosen as product policy, not engineering convenience. It happens to be
cheaper too, and the reason is worth stating because it *removes* problems
rather than solving them.

Option A had to answer three questions: what happens when a recipient's edit
arrives while the granter has that file open in a live Y.Doc session; what
happens when the recipient's base is stale; and how a foreign moment's lineage
reconciles across a boundary where the two sides share no object ids and no
moment ids.

In B a human is already in the loop, so **the review step is the conflict
resolution.** Changes apply only when the granter accepts, which is never
mid-session and never automatic. Where A needed a new merge rule, B needs a
sentence in the review UI: this file changed since they sent it.

---

## Defect found while designing this — the append gate is already open

**At `1767de7d` an edit-level share recipient can already write file moments
into the granter's workspace.** That is Option A, shipped by accident. It must
be closed whether or not the rest of this document is built.

The gauntlet at `services/sync-relay/src/server.ts:489-611`, stage by stage:

1. `selectorAcceptsAppends` (`server.ts:203-210`) returns true for a path
   selector whose `access` is `comment` or `edit`. Its own comment says "chat
   ops only — the per-op filter decides which". That assumption is the bug.
2. `assertChatAuthorship` (`server.ts:1364`) skips every non-chat op —
   `if (!opKind.startsWith("chat.")) continue;` (`server.ts:1375`). A
   `moment.append` is never authorship-checked.
3. `filterOpForShare` (`server.ts:528`) routes it to the `moment.append` branch
   (`shareFilter.ts:809-863`), which admits any moment whose version matches
   and whose paths sit inside the selector — because that branch answers the
   READ question.
4. `appendLogBatch` stores it in the granter's bucket under
   `share:<shareId>:<originId>` (`server.ts:583-588`), and the owner lane
   delivers it to the granter's engine.

One brake exists and it is partial. `appendLogBatch` refuses a batch
referencing a blob the workspace does not hold (`storage.ts:1397-1408`,
`SyncRelayBlobMissingError`), and a recipient cannot upload blobs: the blob PUT
route is owner-scoped (`server.ts:862-882`) and no `share-blob` PUT route
exists (`server.ts:614-643` defines GET only).

So a recipient cannot introduce new content. A recipient **can** still:

- **delete** any file in the selector — a delete moment references no
  after-blob, so the blob check never fires;
- **rename** any file within the selector, for the same reason;
- **revert** a file to any content the granter's workspace already holds.

`workspace.init` is admitted unconditionally for path selectors
(`shareFilter.ts:803-807`), and `version.create` for a matching version share
(`shareFilter.ts:865-869`), so both can also be appended.

No test covers any of this. No relay test file constructs a selector with
`access: "edit"` at all, so the behaviour is untested rather than intended.

**This is PR3-0 below. It should not wait for the proposal lane.**

---

## Decisions

### 1. Read direction and write direction are different questions

`filterOpForShare` (`shareFilter.ts:779`) answers "may this recipient READ this
op?". The share-log POST route reuses it to answer "may this recipient WRITE
this op?" (`server.ts:528`). Those are not the same question, and treating them
as one is the root cause of the defect above.

Split them. `filterOpForShareAppend` becomes a separate function and is the
only thing that may admit an op on a write path. It is an allowlist per route,
never a fall-through.

### 2. The proposal is a hold on ops already shaped for the owner lane

> **Amended by PR3a: a proposal holds NET CHANGES, not moments.** Building it
> found that a recipient cannot state a moment the granter can use. The served
> moment drops `momentId`, `objectId` and every `before*` field
> (`shareFilter.ts`), so a recipient never learns a granter moment id, and a
> parked foreign moment would have to be rewritten so heavily at accept that
> almost nothing of it survived. So a proposal op states what the recipient
> read and what it wants — `basedOnPath`, `basedOnBlobSha256`, `operation`,
> `afterPath`, `afterBlobSha256` — and the relay MINTS the moment at accept
> from the granter's own facts (`services/sync-relay/src/shareProposals.ts`).
> Everything below stays true: accept still calls the same `appendLogBatch`
> under the same share-namespaced origin, and nothing new applies the result.

A proposal is not new content. It is the recipient's ordinary `moment.append`
ops, filtered and redacted, parked in a relay table instead of inserted into
the granter's log.

**Accept releases them into the owner lane unchanged.** Accept calls the same
`appendLogBatch` (`storage.ts:1135`) with a share-namespaced origin id, so
accepted ops reach the granter over the owner lane the relay already uses
(`server.ts:452-455`), and apply through `apply_moment_envelope_detailed`
(`crates/dohc-engine-sync/src/moment_apply.rs:216`). Nothing new applies them.

> **Amended by review round 3: accept writes its OWN origin stream,
> `share:<shareId>:proposal:<proposalId>`, dense from 0.** Releasing them
> under the recipient's own push origin — which is what "the same
> share-namespaced origin the chat path writes" meant — wedges the recipient
> permanently. A recipient numbers that stream densely from its own journal,
> so ops the relay inserted there take the sequence numbers the recipient's
> next push will claim, and `appendLogBatch` refuses a re-used sequence
> carrying different content. One accept silences the recipient's chat for the
> life of the share, with nothing either side can do about it. A fresh origin
> per proposal collides with nothing, because nothing else ever writes it.
>
> The recipient names its own origin on the wire, so `proposal:` is reserved:
> the share-log route refuses a client-supplied origin id that begins with it.
> The submit body no longer carries an origin id at all — the relay mints the
> stream from facts it already holds.

**Decline never moves them.** They stay marked declined and are swept with the
share.

This is what keeps Option A's door open: "auto-accept from this recipient" is
the accept step running at submit time instead of review time. One branch, no
second mechanism.

### 3. The recipient pushes on submit, not continuously

The recipient's edits are already durable locally in its share-view store. The
relay needs them only when the recipient decides to send them.

A continuous drain would push every settled write to the granter's relay before
the recipient chose to share it, and would produce one proposal per debounce
tick — forty proposals for one afternoon. Submit-triggered push gives the
recipient the moment that makes the shape real, and the granter one coherent
unit.

**There is no draft state at the relay.** A proposal exists only from submit.

### 4. One proposal is one submit

- *Per push batch* — the forty-proposals failure above.
- *Per file* — one intent split across several reviews.
- *Per share, permanently open* — never closes, so nothing is ever accepted.

**Per submit.** The proposal is the set of ops pending in the recipient's
share-view outbound queue when the recipient submits.

```
open  ->  accepted
      ->  declined
      ->  withdrawn    (the recipient takes it back)
```

`withdrawn` is not decoration. Submitting is a reversible state change, and the
product invariant in `AGENTS.md` requires a visible reverse path for one.

### 5. The relay rewrites each op's base to the granter's own moment

> **Amended by PR3a, three ways.**
>
> **(a) `objectId` must be rewritten too, and the document did not say so.**
> Apply looks the local file up BY OBJECT ID
> (`select_snapshot_by_object`, `moment_apply.rs:420-426`), and a recipient's
> object ids are its own. Left alone, every accepted change would look like a
> create onto a path the granter already occupies — a conflict for the wrong
> reason. The relay resolves the granter's object from `basedOnPath` and mints
> a new one only for a file the granter does not have.
>
> **(b) ONE net change per object per proposal.** Two changes to one file would
> both be given the same rewritten base and would then conflict with each
> other at accept. The recipient consolidates before it submits — it knows its
> own object ids — and the relay REFUSES a submit naming the same base path or
> the same destination path twice, so the property is server-side rather than
> client-promised. Consolidation is free because a moment's after side states
> the object's COMPLETE post-state, not a delta: a rename copies
> `before.blob_sha256` into `payload_after_blob_sha256`
> (`crates/dohc-engine-domain/src/store.rs`), and apply materializes from the
> after side whatever the `operation` says. So a rename and an edit collapse
> into one change, and the relay derives `operation` from the granter's
> current path against the change's destination — the same derivation the
> domain uses for a compensating moment (`store.rs:809-811`).
>
> **(c) An unresolvable base states NO base.** The payload carries
> `beforePresent: "null"`, which fast-forwards only onto an object the granter
> does not have. A file the granter does have therefore opens a conflict
> instead of being silently overwritten.
>
> **Amended again by review round 3: the object is resolved at the SUBMIT
> door, not at accept.** Resolving `basedOnPath` at accept follows a PATH
> across the gap between the two doors, and a path is not an identity. If the
> granter renames the file in that gap, the path resolves to a different file
> or to none; if the granter deletes it, it resolves to none — and "none"
> mints a new object id, so the accepted change lands as a CREATE that puts
> back a file the granter removed, with no conflict for the granter to see.
>
> So the relay resolves `basedOnPath` to the granter's object id while the
> recipient is standing at the door, stores it on the proposal op, and accept
> follows the STORED id. An object id does not move. A path that resolves to
> nothing at submit refuses the whole submit, atomically, with a message that
> names the file — the recipient can act on that, and the granter never meets
> a failure they did not cause.
>
> Two consequences worth stating, both now tested:
>
> - the granter **renames** the file under an open proposal → the change still
>   names the granter's own object, and lands at the path the granter moved it
>   to. There is no conflict, and that is correct: a rename changes no
>   content, so the content the recipient read is still the content the
>   granter has. Drift is a claim about content.
> - the granter **deletes** the file under an open proposal → the base is the
>   granter's own earlier moment, the head is the delete, so the engine opens a
>   conflict. The file is not resurrected as a create.
>
> **Where the change lands follows rename INTENT, not the path the recipient
> read.** Stating the same path on both sides of a change is stating no
> opinion about where the file lives, so a content-only change lands at the
> granter's CURRENT path — a deliberate rename by the granter must survive an
> accepted content edit, and naming the recipient's stale path would silently
> undo it. A change whose base and destination differ is a move the recipient
> meant, and it applies; if the granter moved the file elsewhere meanwhile,
> the review shows where it is now and the granter accepts knowing that. A
> delete lands where the granter has the file now, for the same reason.
>
> **And the base and head lookups are scoped to the share's ONE version.** A
> share exposes exactly one version; the same object can hold the same content
> in another one, and an unscoped lookup takes the latest match wherever it
> sits. That hands a main share a base its main line never held. The version
> is pinned onto the proposal row at submit — from the selector the recipient
> proved against — so a selector edited mid-flight cannot move a proposal onto
> a version its author never read.

This is the mechanism that makes accept free, and it is the most important
decision in the document.

The granter's apply decides "does this moment's base match my head?" with
`head_fast_forward` (`moment_apply.rs:443-450`), comparing the local snapshot's
`latest_moment_id` against the payload's `before_latest_moment_id`. A mismatch
is **not** an error — apply falls through to the conflict branch
(`moment_apply.rs:672-756`), stores the moment `record_only` and opens or
coalesces a durable conflict row (`open_or_coalesce`, `moment_apply.rs:1663`).

A recipient's moment carries `before_latest_moment_id` from **its own store**,
a moment id the granter has never seen. Left alone, every accepted proposal —
including a perfectly current one — would open a spurious conflict.

The recipient cannot supply the right value either: the served moment
deliberately drops `momentId` and every `before*` field
(`shareFilter.ts:836-855` builds the served payload from an allowlist), so a
recipient never learns a granter moment id.

**So the relay supplies it.** Each proposed op carries `basedOnBlobSha256` —
the after-hash of the last moment the recipient applied for that path, or null
for a new file. That hash is the one identifier both sides genuinely share. At
accept time the relay resolves it to the granter's own moment for that object
and rewrites the op's `before*` fields to describe that real moment.

One rewrite, two correct outcomes:

- the recipient was current → the rewritten base **is** the granter's head →
  `head_fast_forward` is true → clean apply, no conflict;
- the file drifted → the rewritten base is a real, older granter moment →
  `head_fast_forward` is false → the engine opens a conflict with a **correct
  three-way base**, and the granter resolves it in the conflict UI that already
  exists.

No new merge code. No new arbitration. Rewriting a payload at the accept door
is the pattern PR2 already established when it converts a recipient's
`linkedPath` into the granter's `linkedObjectId` (`server.ts:550-578`).

### 6. Attribution rides the proposal row, not the moment payload

The task framing said to mirror `assertChatAuthorship`. Mirroring it literally
would be wrong: that function *rejects* an op whose claimed author is not the
pusher (`server.ts:1390-1392`); it does not stamp one. Its own comment explains
why — "the relay never mutates replicated payloads because the author reads its
own operations back and compares those bytes" (`server.ts:1361-1363`).

There is a harder reason. A moment's author is validated on apply as
**agent-only**: `author.kind != "agent"` fails the payload outright
(`moment_apply.rs:958-963`, `MomentAuthor` at `moment_apply.rs:79-87`). A
moment cannot name a human author on the wire today. Making it able to is an
identity-model change, not a share change.

So the recipient's identity is server-derived from `actor.userId` and stamped
on the **proposal row** as `proposed_by_user_id`, where the review surface
reads it. The op carries no author. Provenance that must survive into the
granter's history rides `metadata.summary`, which the append filter may set and
apply already validates for shape only.

State this limitation in the PR: an accepted change appears in the granter's
History without a per-moment human author. The proposal record is the
provenance.

### 7. The share view is the write surface. The mount is not

A mount cannot capture local edits without weakening a security floor. Mount
files live under `shared-with-me/<label>/` (`shareMounts.ts:82-97`), and that
prefix is **reserved**: `isSharedWithMePath` (`packages/workspace-core/src/paths.ts:76-79`)
feeds `isReservedPath` (`paths.ts:81-83`), which `validateUserWritePath` refuses
(`paths.ts:163-172`). The host's raw watcher does see edits to mounted files,
but `classifyEngineFilePath` returns `ignored`, `resolveEffectivePolicy`
short-circuits to `tracked: false`
(`packages/security-contract/src/effectivePolicy.ts:283-296`), and
`captureOnePath` drops the event (`workspaceEngineCapture.ts:2840`).

Unpicking that floor to add capture would weaken a boundary for a feature. The
share view already has what a mount lacks: its own store, its own workspace id,
its own `replication_log`, a local-write path PR2 built for chat, and a push
lane that scans exactly that log.

**PR3 gives the share view a capture at edit level, and gives the mount
nothing.**

---

## The pipelines, end to end

### Pipeline 1 — recipient capture

> **Amended by PR3a: there is no recipient capture. The write goes through the
> engine.** Built and measured, a capture did not produce a moment: the editor's
> save handler wrote the FILE, and a share view's engine store — not its
> folder — is what the submit lane reads. Rather than teach a watcher to observe
> a write the app already makes, the write itself goes through the engine, and
> the moment is a consequence of it. That is the shape the share view's chat
> writes already use.
>
> So `captureForFlaggedWorkspace` keeps the #540 rule unchanged: a share view
> gets `capture: null` at EVERY level, decided before the settings read. The
> editor's save routes through `routeWorkspaceTextWrite`
> (`apps/desktop/src/workspaces/workspaceTextWrite.ts`), which asks the same
> `shareViewTakesLocalWrites` rule and, for a share view that takes local
> writes, writes the engine moment and then materializes the projection through
> `materializeSharedViewPaths`. Decisions 2 and 3 below, and the write gate and
> `readOnly` changes, are unaffected.
>
> **Stated limitation.** Edits made to a share view's files by external tools do
> not become proposable changes. The app's editor is the edit surface. The
> machinery that would observe an external edit is the capture this ruling
> removed, and reaching a mounted or externally written file would mean opening
> the effective-policy floor (`resolveEffectivePolicy`,
> `classifyEngineFilePath`), which decision 7 refuses. A future policy-input
> design can widen that deliberately.

Today a share view has **no capture at all**. `captureForFlaggedWorkspace`
returns `{ capture: null, shareView: true }` for any share view before it even
reads settings (`apps/desktop/src/workspaces/engineCaptureGate.ts:42-44`), and
the watcher reads `entry.capture` live (`workspaceActivity.ts:242`), so nothing
is ever enqueued. The capture itself is `WorkspaceEngineCapture`
(`workspaceEngineCapture.ts:369`), built by `createWorkspaceEngineCapture`
(`:1357`), whose settled-batch entry point is `captureBatch`
(declared `:376`, implemented `:3321`), fed solely by `startWorkspaceWatch`
(`workspaceWatcher.ts:82`, the one call site at `:119`).

PR3 changes three refusals, each level-aware:

1. `captureForFlaggedWorkspace` (`engineCaptureGate.ts:31-51`) returns a real
   capture for an **edit**-level share view. View and comment keep
   `capture: null`.
2. `assertWritableWorkspace` (`main.ts:758-764`) refuses on the **presence** of
   a `shareView` marker regardless of level. It gains the level test, and keeps
   refusing for view and comment.
3. The editor's `readOnly` prop is `!!shareView || isMountedSharePath(tabPath)`
   (`DesktopWorkspaceShell.tsx:5218`) — unconditional today. It becomes
   level-aware, mirroring `shareViewChatWritable` (`:4365-4367`), which already
   reads the level positively and treats absent, unreadable, and damaged as
   not-writable.

Identity is not a blocker. `resolveShareViewRelayAuthorId`
(`apps/desktop/src/workspaces/chatRelayIdentity.ts:67-76`) already returns the
signed-in `credentials.userId` for a share view, gated on a relay-URL match,
and PR2 uses it for chat writes (`main.ts:6795-6798`).

The mount stays read-only and unchanged.

### Pipeline 2 — recipient drain and submit

Local edits become ordinary moments in the share-view store's
`replication_log`. PR2's push lane already scans exactly that:
`push_share_ops` (`crates/dohc-engine-sync/src/relay.rs:1678-1796`) reads
`list_replication_ops` (`journal.rs:395-429`) filtered to the store's own
`origin_id`, so only locally-authored ops are ever considered, never anything
pulled from the granter.

Scope filtering lives in `SharePushScope` (`relay.rs:3117-3161`). Its `View`
arm, `share_view_push_path` (`relay.rs:3175-3225`), keeps only the five chat
kinds and refuses outright when `access == ShareAccess::View` (`:3189-3191`).

PR3 extends that arm to admit `moment.append` when `access == Edit`, resolving
the moment's paths and requiring every one inside the pinned grant — the same
containment rule `path_within_grant` states (`share.rs:629-639`). The dense
per-share origin sequence machinery (`shared_dense_seq_through`,
`relay.rs:3272-3303`) carries over unchanged: `dense_seq` advances only on
eligible ops, so ineligible local ops never leave gaps on the wire.

**Submit bounds the scan.** `push_share_ops` already persists `scanned_seq` in
durable push state. Submit records the store's current high-water mark and
pushes only up to it; edits made afterwards wait for the next submit. That is
the whole of decision 3 in one integer.

Blobs upload before the ops, the same ordering the owner's own drain uses.

### Pipeline 3 — relay accept into the proposal lane

The recipient POSTs to a **new route**, `POST /shares/:shareId/proposals`, not
to the existing share-log route. One route with two destinations is exactly the
conflation decision 1 rejects.

> **Amended by PR3a: the granter's routes live in the WORKSPACE namespace.**
> Accept, decline, and the review listing are `POST
> /sync/:workspaceId/proposals/:id/accept|decline` and `GET
> /sync/:workspaceId/proposals`, not the share-scoped paths sketched below.
> Ownership is then derived by the ONE line every owner route already sits
> behind (`server.ts`, `workspaceIsOwnedBy`), rather than by a new per-route
> check — and a recipient cannot even address them, because a received share
> summary deliberately omits the workspace id. The recipient's own routes stay
> share-scoped. Withdraw is `POST
> /sync/shares/:shareId/proposals/:id/withdraw`.
>
> **Amended by PR3a: the proposal filter is its own function, not an arm of
> `filterOpForShareAppend`.** `filterProposedChangeForShare`
> (`shareFilter.ts`) answers a THIRD question — "may this recipient propose
> this change?" — beside the read filter and the append filter. Nothing but
> the proposal route calls it, and the append route cannot reach it, so the
> share-log POST can never gain moment acceptance as a side effect.
>
> **Amended by PR3a: a submit carries a `submitId`.** It is idempotent per
> share, so a lost response cannot become two proposals for one intent —
> which decision 4 requires and the sketch below did not provide.

The gauntlet mirrors `server.ts:489-611` stage for stage:

1. `claimPendingShares`, then `shareForRecipient` — every failure is the same
   generic 404 (`server.ts:212-217`).
2. **Level gate** — a path selector, with paths, at `access === "edit"`. A
   comment or view share is refused with the existing `shareNotAppendable()` →
   `share_read_only`, because a level-specific refusal would fingerprint the
   level (decision C of the parent document).
3. **Per-op filter** — `filterOpForShareAppend`, admitting `moment.append` and
   nothing else. Not `workspace.init`, not `version.create`, not chat; chat
   keeps its own route and its own semantics.
4. **Redaction** — the stored op is the filter's copy, never the pusher's
   bytes, the rule `server.ts:530-534` already states.
5. **Authorship** — server-derived, stamped on the proposal row (decision 6).
6. **Transactional guard** — the full gauntlet re-runs inside the write's
   `BEGIN IMMEDIATE`, as `server.ts:598-602` does, so a revoke or a downgrade
   committed mid-flight loses the race the same way.

#### Storage shape

Two tables, matching the `sync_relay_*` convention and the `STRICT` posture the
newest table uses (`storage.ts:440-448`):

```sql
CREATE TABLE IF NOT EXISTS sync_relay_share_proposals (
  proposal_id         TEXT PRIMARY KEY,
  share_id            TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  proposed_by_user_id TEXT NOT NULL,   -- server-derived, never client-supplied
  state               TEXT NOT NULL,   -- open | accepted | declined | withdrawn
  created_at_ms       INTEGER NOT NULL,
  settled_at_ms       INTEGER,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id)
    REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS sync_relay_share_proposal_ops (
  proposal_id           TEXT NOT NULL,
  op_index              INTEGER NOT NULL,   -- submit order, dense from 0
  op_kind               TEXT NOT NULL,      -- always moment.append in PR3
  payload_json          TEXT NOT NULL,      -- the FILTER's copy
  path                  TEXT NOT NULL,      -- proven in-selector at submit
  based_on_blob_sha256  TEXT,               -- null for a new file
  PRIMARY KEY (proposal_id, op_index),
  FOREIGN KEY (proposal_id)
    REFERENCES sync_relay_share_proposals(proposal_id) ON DELETE CASCADE
) STRICT;
```

`workspace_id` is denormalized onto the proposal so the granter's owner-scoped
read never has to join through a share the granter may have revoked.

#### Blob upload by a non-owner

A proposal that introduces content needs its blobs in the granter's workspace
before its ops can be accepted. New route,
`PUT /shares/:shareId/blobs/:sha256`, gated on the same edit-level check.

**It needs no new number.** Three bounds already exist and all three apply:

| Bound | Value | Anchor |
| --- | --- | --- |
| Per blob | 20 MiB | `MAX_BLOB_BYTES`, `server.ts:88` |
| Per workspace, charged to the GRANTER | 2 GiB | `DEFAULT_WORKSPACE_QUOTA_BYTES` `storage.ts:294`; `assertWorkspaceQuota` `storage.ts:1515`, called from `putBlob` `storage.ts:1067` |
| Unreferenced sweep | 10 minutes | `DEFAULT_BLOB_GRACE_MS` `storage.ts:300`; `collectUnreferencedBlobs` `storage.ts:1090` |

> **Amended by review round 3: there is NO fourth bound.** PR3a briefly added
> one — a count of a share's uploaded-but-unclaimed blobs, with its own table
> and two storage methods — and it was removed. It duplicated a bound the
> three above already state more tightly: `putBlob` charges every upload to
> the granter's byte quota, and the sweep reclaims anything no OPEN proposal
> claims. A blob COUNT bounds bytes less tightly than the byte quota that
> already refuses them, and the table it needed was ~70 lines of machinery for
> a number nothing else reads.
>
> The residual is unchanged and still worth stating: inside the grace window a
> recipient can upload unreferenced blobs against the granter's quota. What
> bounds it is the granter's quota, which is the number that was measured.

The three bounds above are the whole answer. Proposal insert re-checks blob
presence exactly as `appendLogBatch` does (`storage.ts:1397-1408`) — run at
SUBMIT, so a recipient learns its content is missing while it can still
re-upload, rather than at accept where the granter would meet a failure they
did not cause.

**One submit still carries at most `MAX_OPS_PER_REQUEST` changes** (500,
`server.ts:90`), because one submit is one batch and one transaction.

> **Amended by review round 3: that bound must not wedge the recipient.** The
> engine used to collect every pending change and then refuse the submit when
> there were more than 500 — and refuse it forever, because the scan position
> only advances on success and nothing a person can do reduces a net-per-file
> count. Now the SCAN stops at the bound, the submit sends those changes, and
> the scan position advances to exactly the journal op it stopped at, so the
> rest travel in the next submit. The bound never splits one file across two
> submits.
>
> **Stated limitation:** a recipient with more than 500 changed files sends
> them as several proposals, one press at a time. The surface says so
> (`More changes are waiting. Send again to send the rest.`) rather than
> leaving the recipient to notice.

### Pipeline 4 — granter review, accept, decline

#### What already exists, and is reused

dohc already ships the propose → review → accept shape, for agent runs.

- `TryInVersionReviewCard` (`apps/desktop/src/renderer/workbench/TryInVersion.tsx:80`)
  is the accept/decline card: **"Review changes"** (`:274`), **"Merge into
  Main"** (`:284`), **"Set aside"** (`:304`).
- `NoticeCenter` (`NoticeCenter.tsx:222-235`) is how a sync conflict announces
  itself and offers a **"Review"** action that opens a dialog.
- `ConflictReviewDialog` (`WorkspaceVersions.tsx:1970`, title **"Decide what to
  keep"**) is the standalone review dialog for conflicts arriving outside a
  merge, wrapping `ConflictList` (`:1587`) and `ConflictResolver` (`:1278`).
- The diff engine is pure, bounded, and already shared by two callers:
  `computeTextDiff` (`workbench/unifiedDiff.tsx:300`),
  `buildUnifiedDiffLines` (`:392`), `UnifiedDiffLines` (`:418`).

PR3 reuses the diff components directly and copies the notice → dialog pattern.
It does **not** reuse the version machinery — see the rejected alternatives.

#### The flow

1. The relay notifies the granter's client that a share has open proposals, on
   the owner lane the granter already polls.
2. A notice fires, shaped like the conflict notice (`NoticeCenter.tsx:222-235`)
   with a **Review** action.
3. `ProposalReviewDialog` lists the proposal's paths. For each, the two sides
   are the granter's current content and the proposal's after-blob, rendered
   through `UnifiedDiffLines`. A path whose current hash differs from the op's
   `based_on_blob_sha256` shows the drift line.
4. **Accept** — an owner-scoped `POST /shares/:shareId/proposals/:id/accept`.
   The relay rewrites each op's `before*` fields per decision 5 and calls
   `appendLogBatch` under `share:<shareId>:<originId>`. The proposal moves to
   `accepted`. The granter's engine applies the ops on its ordinary owner lane.
5. **Decline** — the same route with `decline`. Ops never move; the proposal
   moves to `declined`.

Accept and decline are **owner-scoped**: authorization derives from workspace
ownership, not from the share. A recipient can never accept its own proposal.

#### Why the live-session problem disappears

The engine already fences a `moment.append` against a live Y.Doc session:

```rust
if leases.is_live(&key) {
    return Err(SyncError::RetryableState { reason: "ydoc-session-live" });
}
```

`crates/dohc-engine-sync/src/moment_apply.rs:245-249`. The envelope is never
applied and never acked; it retries on a later pull once the session releases
its lease. The session registry is `EngineService.sessions` /
`EngineService.leases` (`crates/dohc-workspace-engine/src/lib.rs:663-679`), and
settlement is `settle` (`crates/dohc-engine-collab/src/durable.rs:1892`).

So "applies at settlement, never mid-session" is **already true and already
enforced**, for accepted proposals exactly as for the granter's own second
machine. PR3 adds nothing here and must not.

---

## Enforcement table

Server-side means the surface decides and a lying client cannot win. UX mirror
means the surface reflects a decision made elsewhere.

| Surface | View | Comment | Edit | Class | Anchor |
| --- | --- | --- | --- | --- | --- |
| Share-log GET | files + in-selector file chat | same | same | server-side | `shareFilter.ts:779` |
| Share-log POST | refuse | chat ops | chat ops only — **moments refused** | server-side | `server.ts:489`; fixed by PR3-0 |
| Proposal POST (new) | refuse | refuse | `moment.append` only | server-side | new route |
| Share blob PUT (new) | refuse | refuse | allow, bounded | server-side | new route |
| Proposal accept / decline | granter only | granter only | granter only | server-side | new route, owner-scoped |
| Recipient pull boundary | pinned grant + level | same | same | server-side | `share.rs:489` |
| Recipient push scope | nothing | chat only | chat + in-grant moments | server-side | `relay.rs:3175-3225` |
| Share-view capture | none | none | none | server-side | `engineCaptureGate.ts:42-44` |
| Share-view editor save | refuse | refuse | engine, then projection | server-side (main is the trust boundary) | `workspaceTextWrite.ts` |
| `assertWritableWorkspace` in a share view | refuse | refuse | **refuse** | server-side (main is the trust boundary) | `shareWriteGate.ts` |
| Share-view create / rename / delete / import | refuse | refuse | **refuse** | server-side | the row above |
| Granter's own files, written by a recipient | refuse | refuse | **refuse** | server-side | unchanged |
| Live-session fence on accepted ops | n/a | n/a | retry until settled | server-side | `moment_apply.rs:245-249` |
| Editor `readOnly` in a share view | true | true | false | UX mirror | `DesktopWorkspaceShell.tsx:5218` |
| Recipient banner | read-only line | chat line | proposal line | UX mirror | `DesktopWorkspaceShell.tsx:4689-4753` |

> **Amended by PR3a: the capture row is `none` at every level, and the row
> below it replaces it.** See pipeline 1.
>
> **Amended by review round 3: `assertWritableWorkspace` refuses at EVERY
> level, and so does the explorer menu.** That gate stands in front of 27
> handlers — create, rename, move, delete, import, asset writes, database
> edits, the plugin pipeline — every one of which writes the workspace
> FOLDER. A share view's folder is a projection of its engine store, so a
> raw-disk write there states content no moment does: unsendable, and
> overwritten by the next pull. Making the gate level-aware opened all 27 at
> once to buy one of them.
>
> The one write Edit v1 supports is routed instead: `routeWorkspaceTextWrite`
> asks `shareViewTakesLocalWrites` at the seam that would otherwise write, and
> the ordinary gate is skipped only there, by name. The rule the gate asks
> cannot see a level at all — its input carries the marker, never the grant —
> so it cannot be widened by one.

The row that matters most: **Edit never makes the granter's workspace writable
by anyone but the granter.** A recipient at edit level writes only to its own
share-view store.

---

## UI

Copy follows `docs/brand/copy.md`: sentence case, no terminal period on labels,
one instruction per sentence, the noun the UI already uses.

### The noun

The UI already says **changes** — "Review changes" (`TryInVersion.tsx:274`),
"The agent didn't change any files" (`:53`). PR3 uses `changes` in every user-facing
string and reserves `proposal` for code and storage. One name for one thing.

### Open question for Ice — the level is no longer called what it does

Under B the third level grants *sending changes for review*, not editing the
granter's files. Google Docs calls this **Suggesting**, and Ice's 2026-08-05
decision was "three levels shaped like Google Docs".

Recommendation: keep the wire value `edit` — PR1 shipped it end to end with a
Rust twin (`ShareAccess`, `share.rs:66-97`) and generated fixtures, and
renaming it is churn with no behaviour change. But the picker label is a
product decision, and calling it `Edit` overstates the right.

Two honest options, for Ice to pick:

- **Keep `Edit`**, and let the helper line carry the truth.
- **Label it `Suggest`**, matching what it actually is, with the wire value
  unchanged.

This document assumes the first and flags it rather than deciding silently.

### Create dialog — `RelayShareDialog.tsx`

| Option | State in PR3 | Helper line |
| --- | --- | --- |
| View | enabled | `They can read what you selected.` |
| Comment | enabled | `They can read what you selected and chat about it.` |
| Edit | enabled | `They can read, chat, and send you changes to accept.` |

The pending line is removed — all three levels are real from PR3.

> **Amended by PR3a: the shipped string is `Edit is not ready yet.`**, at
> `RelayShareDialog.tsx:168`, not the two-level line quoted above; PR2 already
> made Comment ready. Several other anchors in this document are stale against
> the code: `NoticeCenter.tsx` and `WorkspaceVersions.tsx` live under
> `renderer/workbench/`, `SharedByMeList.tsx` under `renderer/settings/`,
> `captureForFlaggedWorkspace` spans `engineCaptureGate.ts:31-68`, and the
> recipient banner spans `DesktopWorkspaceShell.tsx:4689-4769`.

### Recipient banner — `DesktopWorkspaceShell.tsx:4689-4753`

The banner phases with the rights, as the parent document requires. Existing
strings for ended, damaged, and view stay exactly as they are. Comment keeps
its PR2 line. Edit gains its own, replacing the PR2 fallback that currently
tells an edit recipient they cannot edit (`:4708`):

> `Shared view from {granter}. Edit these files and send your changes for {granter} to accept.`

### Recipient state, after submit

| State | Copy | Move |
| --- | --- | --- |
| Sent | `Sent to {granter} for review.` | State |
| Accepted | `{granter} accepted your changes.` | Change |
| Declined | `{granter} declined your changes. Your copy still has them.` | Change |

The declined case owes a Next, and it must be one that works on that surface:
`Edit again and send new changes.` It does — the composer and the editor are
both still there. No new machinery.

**What accept and decline do to the recipient's copy.** Neither touches it. On
accept the granter's log now holds the moments, they fall inside the selector,
and the recipient's next `pull_share_view` serves them back and converges the
copy on content. On decline the recipient's copy simply keeps the edit and
diverges from the granter's; the copy above says so plainly rather than
implying the change was lost.

### Granter's review surface

Notice, shaped like the conflict notice (`NoticeCenter.tsx:222-235`):

- Title: `{recipient} sent you changes`
- Body: `Review them to choose what to keep.`
- Action: `Review`

`ProposalReviewDialog`, modelled on `ConflictReviewDialog`
(`WorkspaceVersions.tsx:1970`):

- Title: `Changes from {recipient}`
- Per-file drift line: `This file changed since they sent it.`
- Confirm: `Accept changes`
- Reject: `Decline`

`SharedByMeList.tsx` gains a count on the row — the list is a grant inventory
today with one action, `End share`, and no detail view, so the row links to the
dialog rather than growing one.

> **Amended by review round 3, three ways.**
>
> **The review is ONE read.** The dialog asked for the listing and then asked
> again per file, and each of those asks re-read the whole proposal list from
> the relay: a five-file review cost six listings and six more requests to
> rebuild the sender's name. `readShareProposalChanges` answers all of it once.
>
> **A change the review cannot PREVIEW is still decidable.** Binary content,
> content over the editor's text bound, and a blob the relay will not serve
> now read as "no incoming side" rather than failing the read — because
> failing it disabled Accept and Decline together, leaving the granter unable
> to say no to something they could not see.
>
> **The granter's waiting changes are re-read on the share cadence.** They
> were read once per workspace open, so a proposal arriving afterwards stayed
> invisible until the workspace was reopened. They now ride the same slow poll
> the recipient's mounts already use — no second timer, because a proposal is
> deliberately not in anyone's log and so never arrives as workspace activity.

---

## Lifecycle edges

| Edge | Answer | Why |
| --- | --- | --- |
| Revoke with an open proposal | Ending the share SETTLES its open proposals as declined. | Amended by review round 3, replacing "the granter can still accept or decline". An open proposal outlives the grant it arrived through: the recipient can no longer withdraw it, and its content stays pinned out of the blob sweep for as long as it stays open. Declined is the honest state, and the recipient's own copy still has the changes. |
| Downgrade edit → comment mid-flight | The submit loses the race inside `BEGIN IMMEDIATE`. Changes already SENT stay listable and withdrawable. | The guard re-runs the level test (`server.ts:601`). Withdraw asks for membership, not for edit: submitting is a reversible state change, and a reverse path a downgrade removes is not one. |
| Rename or delete under an in-flight proposal | Caught by decision 5, through the object id resolved at submit. A delete opens a conflict; a rename applies cleanly, because a rename changes no content. | One mechanism covers rename, delete, and concurrent edit. |
| Path renamed out of the selector | The recipient's own scan drops that file WHOLE and counts it, and the surface states the count. A change that still named an out-of-share path would fail `visibleSharePath` at submit and refuse the whole submit. | Amended by review round 3: dropping it silently meant pressing send and having some work simply not go, and offering the pre-rename state instead would propose content the recipient had moved away from. |
| Damaged share record | `parseShareSelectorJson` returns null → generic 404 → no submit. Existing proposals stay readable to the granter, keyed by workspace. | Decision G, and the banner already states the damaged case (`:4702`). |
| Ended share, recipient side | Existing copy unchanged: `This share was ended by {granter}...` | `:4700`. |
| Granter accepts while the file is open | The op returns `RetryableState { "ydoc-session-live" }` and retries after the session releases. | `moment_apply.rs:245-249`. |

---

## Shard specs

Three PRs. The split is by trust boundary and by urgency, not by convenience.

### PR3-0 — close the append gate (relay only, urgent, independent)

1. `shareFilter.ts`: add `filterOpForShareAppend`. For a path selector it
   admits nothing in PR3-0 beyond the five file-chat kinds PR2 serves — no
   `moment.append`, no `workspace.init`, no `version.create`.
2. `server.ts:528`: the share-log POST route calls the append filter, not
   `filterOpForShare`.
3. Tests: the first relay tests that construct `access: "edit"`. An edit
   recipient's delete moment, rename moment, `workspace.init`, and
   `version.create` are each refused, and the granter's log is unchanged.

This PR is a fix. It should merge without waiting for the rest.

### PR3a — the proposal lane

**Relay.**

1. The two tables above, plus their migration row (`sync_relay_migrations`).
2. `POST /shares/:shareId/proposals` — the gauntlet in pipeline 3.
3. `PUT /shares/:shareId/blobs/:sha256` — edit-gated, bounded as specified.
4. `POST /shares/:shareId/proposals/:id/accept` and `.../decline` —
   owner-scoped.
5. The base rewrite of decision 5, and the lookup it needs: resolve
   `based_on_blob_sha256` to the granter's moment for that object. Extend the
   insert-time index the parent document built (`sync_relay_object_paths`,
   `storage.ts:440-448`) rather than scanning the log.
6. `filterOpForShareAppend` gains its `moment.append` arm, used **only** by the
   proposal route.

**Rust.**

7. `SharePushScope::View` admits `moment.append` at edit level
   (`relay.rs:3175-3225`), with the same in-grant containment.
8. Submit bound on `push_share_ops` (`relay.rs:1678-1796`).

**Desktop.**

9. ~~`engineCaptureGate.ts:42-44` — a real capture at edit level.~~ Replaced by
   the engine-direct write in pipeline 1; the gate is unchanged.
10. ~~`main.ts:758-764` — `assertWritableWorkspace` becomes level-aware.~~
    Withdrawn by review round 3: it guards 27 folder-writing handlers and
    stays a presence refusal. The one supported write is gated at its own
    routed seam instead. See the enforcement table.
11. `DesktopWorkspaceShell.tsx:5218` — `readOnly` becomes level-aware.
12. The submit action, the recipient state copy, and the banner line.
13. The notice, `ProposalReviewDialog`, and the diff, reusing
    `UnifiedDiffLines` (`unifiedDiff.tsx:418`).

### PR3b — deferred, explicitly

Per-file accept, richer drift presentation, granter-side provenance beyond the
proposal record, and auto-accept (Option A's future).

Added by review round 3: **routing the other file operations through the
engine**, one handler at a time — create, rename, delete, import. Each needs
the same shape the text write got (engine moment, then projection) and its own
gate at its own seam. Until then they stay refused at every level, and the
explorer menu says so by offering none of them.

**Why not split PR3a further.** Any smaller cut ships a lane no user can reach,
which is the failure mode this repo has paid for repeatedly: a green check over
a path nothing exercises. PR3a is the smallest end-to-end slice.

---

## Test plan

Every refusal is driven through the real boundary. For each new gate run the
inverse mutation — delete the gate line, confirm a **named** test fails — and
record the result in the PR body. A gate with no failing mutation is not
covered.

**Relay.**

- `shares.test.ts`: create at edit; the summary rows carry it.
- `server.test.ts`: an edit recipient's `moment.append` to `/share-log` is
  refused, and `sync_relay_log` is unchanged. *Inverse mutation:* restore
  `filterOpForShare` at `server.ts:528` → this test fails.
- `server.test.ts`: a comment share's proposal POST and a view share's return
  **byte-identical** bodies — the anti-fingerprinting property itself.
- Blob route: a recipient PUT above `MAX_BLOB_BYTES` returns 413 and stores
  nothing, mirroring the existing owner-side case (`server.test.ts:1118`).
- Blob route: a view-level recipient's PUT is refused. *Inverse mutation:* drop
  the level test → fails.
- Revoke and downgrade each lose the race against an in-flight submit inside
  the guard. *Inverse mutation:* remove the guard's level re-check
  (`server.ts:601`) → the downgrade test fails.
- `crossUserIsolation.test.ts`: the sentinel shape this file already uses — a
  proposal from recipient A is invisible to recipient B of an overlapping
  share, asserted against real response bodies.

> **Amended by PR3a: no single test holds both a real relay and a real engine
> store, so the proof is layered and each layer says what it proves.**
> The relay tests assert the rewrite CHOOSES the right base — that the
> accepted moment names the granter's own head when the recipient was current
> and the granter's own EARLIER moment when the file drifted. The Rust tests
> assert the engine's rule — that a matching base applies with zero conflicts
> and a stale one opens exactly one. The desktop e2e proves the whole loop
> against a real relay and a real engine. Claiming "zero conflict rows" from a
> relay-only test would have been a green check over a path nothing exercises.

**Base rewrite — the mechanism that most needs proving.**

- Accept a **current** proposal → the granter's store gains the content and
  **zero** conflict rows.
- Accept a **drifted** proposal → exactly one conflict row, whose base is the
  granter's own earlier moment, not the recipient's.
- *Inverse mutation:* remove the rewrite → the current-proposal test fails by
  opening a spurious conflict. This is the test that proves the rewrite does
  something, and without it the whole decision is unverified.

**Rust (`crates/dohc-engine-sync/`).**

- `push_share_ops` at view and comment levels pushes no moment; at edit level
  it pushes only in-grant moments. *Inverse mutation:* drop the containment
  check in `share_view_push_path` → an out-of-grant moment escapes and a named
  test fails.
- `security_contract.rs`: the level twin vectors already exist; extend them to
  the push scope.
- The live-session fence: accepting while a session holds the lease returns
  `RetryableState`, and the op applies after release. *Inverse mutation:*
  delete `moment_apply.rs:245-249` → fails.

**Desktop.**

- `main.chatSecurity.test.ts` — evolve, do not delete. Its `#627` pin asserts
  the gate precedes every store and sync seam; the same property must hold for
  the new file-write seams. Add a pin that every file-write handler calls
  `assertWritableWorkspace` before any store call.
- An edit-level share view's save through the real write path produces a moment
  that is not the replayed one, a `replication_log` row, and a matching file on
  disk; a comment-level save is refused
  (`shareViewTextWrite.e2e.test.ts`, against a real daemon). *Inverse
  mutations:* route the share-view write back to the disk writer → the moment
  test fails; drop the level branch → the ordinary-workspace test fails; drop
  the `expectedContentHash` check → the stale-save test fails.
- Source-scan pins prove position, never behaviour. Pair each with a
  behavioural test, as `main.chatSecurity.test.ts:600-602` itself requires.

**End to end.** One desktop e2e: a recipient opens an edit share, edits a file,
sends the changes, and the granter accepts them. Stage
`dohc-workspace-engine.exe` into `apps/desktop/target/debug` first, and do not
run it concurrently with another e2e lane — they collide on the Electron
user-data dir.

---

## Rejected alternatives

- **A proposal is a named version in the granter's workspace** — the tempting
  one, because the whole review flow already exists: `create_named_version`
  (`store.rs:1838`), the three-way `merge_text_file_from_version`
  (`merge.rs:303`), `mergeVersionIntoMain`
  (`workspaceEngineCapture.ts:5138`), and `TryInVersionReviewCard` +
  `VersionMergeDialog` + `ConflictList` as a shipped accept/decline UI.
  Rejected because a version is **workspace-global structure**: letting a
  foreign account mint one puts a recipient's submissions in the granter's own
  version picker, and it punches through the single invariant both share
  boundaries exist to hold — exactly one version per share, ever
  (`enforce_granted_version` `share.rs:680`, `targetVersionId`
  `shareFilter.ts:865-869`). It is the right shape if proposals ever need to be
  long-lived branches; it is too much authority for "park some bytes for
  review".
- **Reusing the existing share-log POST route with a hold flag** — one route
  with two destinations is the conflation that produced the defect above.
- **Reusing `filterOpForShare` for the write direction** — same root cause: a
  read filter answers a read question.
- **Continuous push with a relay-side draft** — sends work the recipient has
  not chosen to send, and produces one proposal per debounce tick.
- **Grouping proposals per file** — splits one intent across several reviews.
- **Carrying `beforeLatestMomentId` from the recipient's store** — names a
  moment the granter has never seen, so every accept would open a spurious
  conflict (`moment_apply.rs:443-450`).
- **Letting the recipient supply the base** — it cannot: the served moment
  drops `momentId` and every `before*` field (`shareFilter.ts:836-855`).
- **Stamping the recipient's identity inside the moment payload** — apply
  validates authors as agent-only (`moment_apply.rs:958-963`), so this is an
  identity-model change wearing a share change's clothes.
- **A new per-recipient storage quota** — the granter's workspace quota already
  charges it (`storage.ts:1515`), and a second number would reject work nobody
  measured.
- **Giving a share mount write capture** — its paths are reserved by a security
  floor (`paths.ts:76-83`), and weakening a floor for a feature is the trade
  this repo refuses.
- **Building a new diff renderer** — `computeTextDiff` and `UnifiedDiffLines`
  (`unifiedDiff.tsx:300`, `:418`) are pure, bounded, and already shared by two
  callers.

---

## What A would still need, if Ice reverses again

Stated so the door is visibly open and its cost is visible too. Auto-accept is
the accept step running at submit time: one branch in the proposal route, plus
a per-share flag. Everything else in this document — capture, push scope, blob
route, base rewrite, the owner-lane release — is already what A would need.
That is the point of building B this way.

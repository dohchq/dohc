# Team apps and shared Collections

Reader: Ice, who settled the decisions below, and the agents who build and review this work.

Status: accepted for Phase 1. Ice settled the decisions on November 25, 2026, across a three-provider Design Council and a two-round design interview. Remove this plan when the work it describes has landed.

## Why

dohc models team software as capability-secure microservices disguised as Folders, Collections, and Apps ([AGENTS.md](../../../AGENTS.md)). One person owns a shared Collection with narrow typed operations, and people across the team build their own triage, planning, and rollup apps on top of it without copying data, breaking each other's apps, or widening anyone's permissions.

Wave A landed the first three building blocks on `main`:

- Folder access rules act as a strict ceiling on member Collection calls (PR #4641).
- Custom Collection actions support optional input and output contracts, generated types, and advisory breaking-change warnings (PR #4643).
- `examples/team-roadmap` proves three narrow-capability apps on one Collection with a measured 5,000-item concurrency benchmark (PR #4654).

The benchmark in PR #4654 showed two concrete bottlenecks on a single Collection (30 ops/s flat from 10 to 30 callers, 1,867 ms p95 at 30 callers): 21 to 26 ms of host-thread JS per call, and serial execution that queues reads behind writes. Meanwhile, shared Publications are still capped at one Collection and tied to single share-link grants, and Members cannot yet run Personal apps or share Member apps inside a workspace.

## Vocabulary

[CONTEXT.md](../../../CONTEXT.md) defines the canonical terms:

- **Publication**: an immutable, owner-approved bundle of one app revision shared to a Share link or to the Workspace.
- **Personal app**: an app a person runs locally on their own computer against Collections they already reach, never shared with others.
- **Member app**: an immutable app bundle and source that a Member or Admin shares inside the workspace, capped by both its author's and each viewer's reach and requiring each viewer to review its permissions before opening it.

## Settled decisions

### Collection governance and grants

- **Phase 1 Collection ownership**: creating transactional Collections and approving `schema.sql` and `operations.ts` revisions stay Owner-only.
- **Phase 1 Admin grant management**: Admins can manage workspace defaults and per-person `dohc_dataset_data_grants` on existing Owner-approved Collections.
- **Phase 2 Admin Collection creation**: letting Admins create transactional Collections and approve Collection revisions moves to Phase 2, because it requires direct-write admission for transactional Collection files in the relay and Rust engine plus a demoted-Admin code-trust policy.
- **Collection workspace defaults** ([ADR 0020](../adr/0020-collection-workspace-defaults-live-on-the-server.md)): each Collection can opt in on `sync-relay` to default operations by folder access level (`View`, `Comment`, `Edit`), capped by folder access rules. Existing Collections default to none. Operations marked `owner` are never included. Admins inherit `Edit` defaults plus any explicit per-person grants. Per-person grants remain for narrow exceptions.
- **Read-only below Edit**: whenever a caller's effective folder level on a Collection is `View` or `Comment`, only `readOnly` operations run through workspace Publications, Personal apps, and Member apps.

### Workspace Publications

- **Explicit workspace audience**: Workspace Publications are published explicitly to the workspace audience (`audience = 'workspace'`), separate from Share link Publications (`audience = 'link'`). Existing link Publications stay link-only until the Owner publishes them to the workspace.
- **Multi-Collection support**: both Link Publications and Workspace Publications support up to 16 Collections, matching local owner apps.
- **All-or-nothing reach**: a viewer must reach the app's source paths and every bound Collection at load; each invocation rechecks the targeted Collection's reach and grants.
- **No first-open review prompt for Owner Publications**: official Workspace Publications open for workspace members with no extra confirmation.

### Personal apps and Member apps

- **Personal app authoring** ([ADR 0019](../adr/0019-member-app-source-stays-off-the-synced-tree.md)): Personal apps and local forks of Member apps live in a dedicated local folder outside the synced received-workspace tree, with Open folder, Copy path, CLI verbs, and generated Collection types. They compile with `closedAppCompiler`, run in `LocalAppLaunchHost`, and call the person's existing direct Collection endpoints through `serverDatasetApps` with zero new relay tables.
- **Workspace sharing switch**: Members settings gains a workspace switch, "Members can share apps", off by default so public communities are protected. Admins can always share Member apps. Personal apps always work for anyone with Collection reach.
- **Double ceiling** ([ADR 0018](../adr/0018-member-apps-cap-every-viewer-to-both-reaches.md)): every Member app call runs under `declared ∩ author_grants ∩ viewer_grants ∩ consented_scope`, with `readOnly` enforced when `min(authorAccess, viewerAccess) < edit`. This applies even when the Owner or an Admin opens a Member app; `caller.kind` is never `"owner"` for a Member app.
- **Verified uploads and inspectable source** ([ADR 0019](../adr/0019-member-app-source-stays-off-the-synced-tree.md)): sharing a Member app uploads both compiled bundle blobs and declared source blobs verified byte for byte against candidate digests. Member app publishing never falls back to reading existing hashes from `sync_relay_blobs`. Member app candidates forbid `linkReads`.
- **Logical Member app slots**: each Member app occupies one `(workspace, author, slug)` slot pointing to its latest active immutable revision. Pushing a new version supersedes the previous revision and shows teammates an "Updated, review changes" prompt.
- **Pinned first-open viewer consent**: consent stores the reviewed effective-operation scope digest for `(workspace, viewer, revision)`. Any code change (new revision) or widened effective-operation set prompts for a fresh review. The consent endpoint refuses `auth.agent`.
- **Workspace-internal only**: Member apps never attach to external Share links (`currentLinkAppPublication` refuses them).
- **Moderation, takedown, and account deletion**: authors can withdraw their own Member apps; the Owner and Admins can list and withdraw any Member app. Operator takedowns and publishing holds key on `publisher_user_id` rather than the workspace Owner. Removing an author stops their Member apps immediately via live membership checks; deleting an author's account terminates active launches and cleans up their Member apps.
- **Promotion**: in Phase 1, the Owner promotes a critical Member app by inspecting its source, copying it into the workspace, and publishing an official Workspace Publication. A one-click Promote action is deferred.

### Surfaces in Phase 1

- **Desktop**: full authoring, launch, consent review, moderation, Collection defaults, History attribution, and workspace dependency view.
- **CLI and MCP**: parity for Workspace Publications, Collection workspace defaults, Personal app local workflow, and Member app share, list, inspect, fork, and withdraw (consent remains human-only and refuses agents).
- **Browser (`share-web`)**: opening multi-Collection Workspace Publications and a server-rendered first-open review and consent page for Member apps.
- **Phone (`apps/mobile`)**: updating the existing `AppReview` flow on `ice-m2` so workspace Owners can review and open multi-Collection Workspace Publications and Member apps on their phone. Joined Member workspaces on phone remain in the mobile workspace-members roadmap.

## Architectural invariants

- **Keep `datasetPrincipalKey` intact**: never append `:app:<id>` to a named caller's `principalKey`, which breaks `dohc_dataset_data_grants`, idempotency, participants, and account deletion. Use `authority.appId` for History attribution.
- **Single runtime ceiling mechanism**: pass an optional host-computed operation ceiling on `DatasetAuthority` directly into `permissions()` in `packages/app-backend-runtime/src/dataset-host.ts`, rather than adding a new `DatasetAccess` union kind. Fold per-Collection reach, Collection default revision, author grant token, viewer grant token, publication authority revision, and consent scope digest into `authorityToken` so every entry point (`describe`, `authorize`, `invoke`, `readOperation`, `upload`, `attempt`) and commit recheck enforce the same ceiling.
- **Decoupled workspace publication lifetime**: Workspace Publications and Member apps bind to the workspace's `{"kind":"workspace"}` share rather than an individual member's `(grant_id, grant_generation)`, so changing `member_level`, changing roles, or removing another member never breaks live apps.
- **Clean unbinding**: withdrawing a Publication, taking down a Publication, or deleting a bound Collection removes all `dohc_dataset_bindings` rows for that app and keeps storage usage counters exact.
- **Phone guard**: `phoneApps.ts` verifies viewer consent and effective reach before issuing a phone launch grant, so an Owner's phone cannot bypass first-open consent on a Member app.

## Work plan and PR split

### Active parallel tracks (already running)

- **Wave B2 (`perf/collection-runtime-throughput`)**: profile and cut the 21 to 26 ms host-thread JS hot path and add a bounded parallel read path in `packages/app-backend-runtime`, proven by before-and-after runs of `bench:team-roadmap`.
- **Wave B3 (`feat/team-history-topology-polish`)**: readable human, agent, and app names in Collection History, a reach-filtered Collections, Apps, and Automations dependency view, and the `app-kit` dark-mode button contrast fix.

### Wave B1: multi-Collection sharing, Collection defaults, Personal apps, and Member apps

1. **PR B1.1: Multi-Collection Publications, Workspace Audience, and Collection Defaults** (`feat/multi-collection-workspace-apps`, budget ~520 product lines):
   - Marked schema migrations for `audience ('link' | 'workspace')` on `sync_relay_app_publications` (nullable `grant_id` and `grant_generation` for `'workspace'`) and `dohc_dataset_workspace_defaults` on `sync-relay`.
   - Lift the 1-Collection cap across relay, desktop (`ownerAppPublication.ts`, `ownerAppPublicationIpc.ts`), CLI (`packages/cli/src/appPublication.ts`), MCP, `OwnerAppPublication.tsx`, `linkAppPublicationRoutes.ts`, and `phoneApps.ts`. Return 404 on `/backend/events` when `capabilities.length > 1` (single-Collection live events unchanged).
   - Unbind all `dohc_dataset_bindings` on withdrawal, takedown, and Collection deletion.
   - Support Owner Workspace Publications, per-Collection `resolveAuthority(datasetId)`, `DatasetAuthority.operationCeiling` with read-only enforcement below `Edit`, and `authorityToken` rotation on folder-rule or Collection-default changes.
   - Allow Owner and Admins to configure Collection workspace defaults and per-person grants on existing Collections (UI, CLI, MCP, and `pnpm write:operation-pins`).
2. **PR B1.2: Member Personal Apps** (`feat/member-personal-apps`, budget ~320 product lines; can run in parallel with B1.1 or right after):
   - Desktop-managed local Personal app folder outside the synced received-workspace tree, with Open folder, Copy path, CLI verbs, and generated Collection types.
   - Member-safe Collection capability lookup via `describe` (never owner-only `approvedArtifacts`), forbidding `linkReads` and `owner` ops.
   - Local compilation and `LocalAppLaunchHost` execution over `serverDatasetApps` against the member's direct Collection endpoints, keeping `stage`, `approveStaged`, `createLink`, and Owner publish refused on received workspaces.
3. **PR B1.3a: Member Apps Relay, Double Ceiling, Verified Upload, Consent, and `share-web` Review** (`feat/member-apps-relay-web`, budget ~480 product lines; starts after PR B1.1 merges):
   - Marked migrations for `publisher_user_id`, `publisher_kind ('owner' | 'member')`, logical Member app slots `(workspace_id, publisher_user_id, slug)`, `sync_relay_app_viewer_consents (scope_digest)`, and workspace `"Members can share apps"` setting (off by default).
   - Authenticated Member app publish endpoint requiring publisher-uploaded, hash-verified bundle and source blobs (zero fallback to existing `sync_relay_blobs`), per-member storage cap, and `linkReads` refusal.
   - Discovery, source inspection, withdrawal (author, Admin, Owner), operator takedown holds on `publisher_user_id`, account deletion cleanup, and phone refusal of unconsented Member apps.
   - Double-ceiling enforcement (`declared ∩ author ∩ viewer ∩ consented`, read-only below `Edit`, never `owner` caller) at dispatch and commit.
   - Server-enforced consent endpoint refusing `auth.agent`, plus server-rendered first-open review and consent page in `share-web`.
4. **PR B1.3b: Member Apps Desktop UI, CLI/MCP, and Docs** (`feat/member-apps-desktop-ui`, budget ~360 product lines; starts after PR B1.3a or stacked on its contract):
   - Desktop "Share to workspace" publish and update flow, Workspace Apps listing with "Updated, review changes" badge, first-open Review and Consent dialog, one-click Fork to local Personal app, Members settings switch, and Owner/Admin moderation list with Withdraw.
   - CLI and MCP parity (publish, list, inspect, fork, withdraw; no agent consent) with updated operation pins.
   - Update `docs/engineering/security-boundaries.md` and `docs/engineering/plans/workspace-members.md`.
5. **PR B1.4: Phone Multi-Collection and Member App Review on `ice-m2`** (`feat/phone-team-apps`, budget ~260 product lines; runs on `ice-m2` once PR B1.1 + PR B1.3a relay contract is frozen/merged):
   - Extend `phoneApps.ts` and `apps/mobile/src/apps/AppReview.tsx` so workspace Owners can review, inspect source, consent, and open multi-Collection Workspace Publications and Member apps on iOS and Android, verified in real simulators on `ice-m2`.

### Phase 2 (after Phase 1 lands)

- **Admin Collection governance**: direct-write admission for transactional Collection files (`dataset.json`, `schema.sql`, `operations.ts`) in relay and Rust engine, Admin Collection creation and migration approval, and explicit demoted-Admin trust policy.
- **Joined Member workspaces on Phone**: listing, syncing, and enforcing folder access rules for joined workspaces in `apps/mobile`.
- **Multi-Collection live events**: multi-cursor `/backend/events` watch across `appEventWaits.ts`, `appBackendProxy.ts`, and `appLaunch.ts`.
- **One-click Promote**: letting an Owner adopt a Member app into an official Workspace Publication in one step.

import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

// Tenancy: POST-AUTH, PRE-MULTI-TENANT (corrected — the old
// "single-workspace prototype / no auth / no users table" comment was
// stale by ≥1 iteration). WorkOS auth is wired; every public function
// derives `workspaceId` from `requireWorkspace(ctx)` and for v0
// `workspace == user` (the WorkOS subject). Multi-user/orgs arrive via
// the fail-closed `resolveWindow` primitive — see
// docs/strategy/tenancy-authz-v0.md. The three tenancy tables at the
// bottom are defined now (Phase 0, additive) but have NO readers until
// Phase 3; their presence is a zero-behaviour scaffold.
export default defineSchema({
  // `atoms` == the product concept "note" (a markdown document).
  // Founder decision 2026-05-17: NO rename — code keeps the name
  // `atoms`; the new inline value unit is namespaced separately as
  // `inlineAtom` (src/lib/inlineAtom.ts). See
  // docs/strategy/terminology-and-migration-v0.md. The user-facing
  // markdown files: body + optional frontmatter, may contain ```query
  // block-views the renderer evaluates on view.
  atoms: defineTable({
    workspaceId: v.string(),
    path: v.string(),
    body: v.string(),
    updatedAt: v.number(),
    source: v.optional(v.string()), // 'agent' | 'user'
    // skills-commands-v1 §6.4 (Track-3 P2a): per-atom advisory set
    // by `internal.skillsMigration._migrateLegacyPaths` to flag
    // atoms whose `type: skill` was uniformly injected into a
    // pre-existing `skills/*.md` body. Cleared on the user's first
    // edit OR on path-move (both signal acknowledgment/intent).
    // Pure metadata — never affects routing/captures.
    migrationNotice: v.optional(v.string()),
    // file-org-v1 §2.1 (Track-4 D4.1a). Three OPTIONAL booleans —
    // additive on existing rows (default `undefined`, treated as
    // false at every read site). The lock guards refuse a write at
    // the data layer; the star is a pure cosmetic.
    //   systemLocked — written by `_upsertSystem` only (currently no
    //     production callers); refuses ALL writes save
    //     `allowSystemOverride: true` and `_upsertSystem` itself.
    //   userLocked — soft lock set by the user via the future
    //     `setLock` mutation (lands D4.1b ATOMICALLY with §2-A.1);
    //     refuses agent writes; the user's OWN edit still succeeds.
    //   starred — pure cosmetic (no behavior). Sort/favorites only.
    systemLocked: v.optional(v.boolean()),
    userLocked: v.optional(v.boolean()),
    starred: v.optional(v.boolean()),
    // DEPRECATED — the file icon now lives in the frontmatter `icon:`
    // property (the file's metadata, shown above the title + in the
    // tree). This column is retained only so pre-existing rows that
    // were written with it still validate; it is no longer read/written.
    icon: v.optional(v.string()),
    // app-wide search (docs/development/search-plan.md). Derived on every
    // path/body write via deriveSearchFields(); see convex/searchText.ts.
    //   searchText  — indexed: title×3 + basename + path + plaintext(body)
    //   searchable  — false only for the derived index `.context/_map.md`
    searchText: v.optional(v.string()),
    searchable: v.optional(v.boolean()),
    // org-plan §4/§7 — collaborator edit lease for human-vs-human
    // conflict (NOT the AI/system locks; those stay on systemLocked /
    // userLocked). `editingBy` is the writer's WorkOS subject;
    // `editingUntil` is the lease expiry (ms epoch). Expires naturally
    // — no heartbeat — so a closed tab can't permanently block teammates.
    editingBy: v.optional(v.string()),
    editingUntil: v.optional(v.number()),
    // org-plan §4 — provenance. The pill shows "last writer," not the
    // original author (the name is precise: lastEdited, not author).
    lastEditedByUserId: v.optional(v.string()),
    // v2 Phase 1.6 — `body` is a derived markdown cache projected from
    // the canonical Y.Doc. These fields make cache freshness/drift
    // observable without loading the Y.Doc for normal search/read paths.
    bodyProjectionHash: v.optional(v.string()),
    bodyProjectionVersion: v.optional(v.number()),
    bodyProjectionStateVector: v.optional(v.string()),
    bodyProjectedAt: v.optional(v.number()),
  })
    .index('by_workspace_path', ['workspaceId', 'path'])
    .index('by_workspace', ['workspaceId'])
    // recent-docs empty state for search (newest-updated first).
    .index('by_workspace_updated', ['workspaceId', 'updatedAt'])
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['workspaceId', 'searchable'],
    }),

  // skills-commands-v1 §2-A.2 (Track-3 P2b.1) — per-turn structural
  // enforcement of the UNAUTHORIZABLE-set rule. Keyed by
  // (threadId, promptMessageId): the agent's `run_skill` tool
  // writes {depth:1} on entry; every UNAUTHORIZABLE-set tool's
  // handler calls `requireDirectUserAuthorization(ctx, op)` which
  // reads this row via internal query — depth>0 ⇒ throw the
  // structured `SkillAuthRequiredError` (the tool's side effect
  // never runs). `sendMessage`/`startOnboarding` CLEAR the row
  // BEFORE `streamText` so prepareStep on step 0 sees depth=0.
  // Bounded growth: rows are per-turn ephemeral. A future GC
  // sweeps stale rows (none for v1; turn counts are bounded by
  // user usage). Workspace scoping is NOT on this table — the row
  // is keyed by the agent SDK's threadId+promptMessageId which are
  // already workspace-scoped via the existing thread auth.
  skillTurnState: defineTable({
    threadId: v.string(),
    promptMessageId: v.string(),
    depth: v.number(), // 0 = normal user turn; 1 = inside run_skill
    startedAt: v.number(),
  }).index('by_thread_msg', ['threadId', 'promptMessageId']),

  // atom-address-v1 (design-gate CLEARED v4 — docs/strategy/
  // atom-address-v1.md §1.2). The rename-proof namespace index: a
  // stable dotted `fileId` (lives in the file's frontmatter, seeded
  // once from path then immutable) → its current concrete `path`.
  // Formula/address resolution is fileId→path (NEVER path-derived),
  // so a rename moves `path` here and every `{= …fileId… }` reference
  // keeps resolving.
  // `state:'released'` is the TOMBSTONE. D4.25 — tombstone-WHILE-
  // REFERENCED: on delete or `id:` hand-edit, the abandoned id is
  // DELETED (freed for reuse — filesystem-like, no `_2`) UNLESS some
  // other atom's formula CONCRETELY names it, in which case the row
  // is tombstoned (path:null) so the stale ref renders `—` instead of
  // silently re-pointing to a recreate (the silent-hijack guard).
  // `*`-glob / all-match aggregates don't pin an id (a recreate
  // rejoins them correctly). Seeding treats `released` as taken (a
  // recreate at a tombstoned id is suffixed). A tombstone flips back
  // to `bound` only via restore-from-trash; any ordinary write
  // matching a released id is a loud collision.
  atomIds: defineTable({
    workspaceId: v.string(),
    fileId: v.string(),
    path: v.union(v.string(), v.null()), // null ⇔ released (tombstone)
    state: v.union(v.literal('bound'), v.literal('released')),
  })
    .index('by_workspace_fileId', ['workspaceId', 'fileId'])
    .index('by_workspace_path', ['workspaceId', 'path']),

  // sharing-v1 (Track-5 1a) — FILE-LEVEL share grants (ACL). The
  // canonical atom STAYS in the owner's workspace; this row grants a
  // specific viewer cross-workspace access to it, addressed by the
  // owner's rename-proof `fileId` (survives the owner renaming the
  // file). The row `_id` is the only cross-workspace handle (a
  // `shareId`); every shared read/render/write resolves through
  // `resolveShareAccess`, which re-verifies `granteeWorkspaceId ===
  // caller` — so a guessed shareId grants nothing (absence ⇒ DENY,
  // mirroring resolveWindow). NOT a widening of `atoms` queries: a
  // parallel, gated read path keeps the owner's own functions
  // workspace-scoped + untouched.
  atomShares: defineTable({
    ownerWorkspaceId: v.string(),
    fileId: v.string(),
    // EXACTLY ONE audience is set:
    //   granteeWorkspaceId — a person-to-person share (1a/1b).
    //   granteeOrgId       — a workspace share: every member may read it.
    //   publicAccess       — anyone signed in with the shareId may read it.
    // resolveShareAccess branches on which is present.
    granteeWorkspaceId: v.optional(v.string()),
    granteeOrgId: v.optional(v.string()),
    publicAccess: v.optional(v.boolean()),
    permission: v.union(v.literal('view'), v.literal('edit')),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    // who shared with me (the "Shared with me" tree + the scoped
    // dependency set for formula resolution). Org-shares have an
    // undefined granteeWorkspaceId, so they never match a real viewer.
    .index('by_grantee', ['granteeWorkspaceId'])
    // org-shares for a given org (the company graph + org-scoped set)
    .index('by_org', ['granteeOrgId'])
    // cascade on owner delete/rename + "what have I shared" + dup-guard
    .index('by_owner_fileId', ['ownerWorkspaceId', 'fileId'])
    // exact grant lookup / idempotent re-share / revoke-to-exhaustion
    .index('by_owner_grantee_fileId', [
      'ownerWorkspaceId',
      'granteeWorkspaceId',
      'fileId',
    ])
    .index('by_owner_org_fileId', ['ownerWorkspaceId', 'granteeOrgId', 'fileId']),

  userProfiles: defineTable({
    workspaceId: v.string(),
    email: v.string(),
    normalizedEmail: v.string(),
    name: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_normalizedEmail', ['normalizedEmail']),

  // sharing-v1 1c — app-level "company"/org. A workspace creates an
  // org (becomes owner) and others join by the invite code. Members
  // are `memberships` rows. Org-shared atoms (atomShares.granteeOrgId)
  // form the company graph, visible to members only.
  orgs: defineTable({
    name: v.string(),
    inviteCode: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
    // org-plan §4 additions (Phase 3: orgs promoted from share-audience
    // to tenancy unit). All optional + back-compatible.
    //   accent       — tiny visual identity token (v1.5 polish).
    //   workosOrgId  — SSO link to a WorkOS Organization (deferred — set
    //                  via the reconcile bridge once WorkOS wiring lands).
    //   status       — 'active' | 'archived'. Defaults to 'active' on new
    //                  orgs; existing rows treated as 'active'.
    accent: v.optional(v.string()),
    workosOrgId: v.optional(v.string()),
    status: v.optional(v.union(v.literal('active'), v.literal('archived'))),
  })
    .index('by_inviteCode', ['inviteCode'])
    .index('by_workos_org', ['workosOrgId']),

  // Entities — the underlying data the user's atoms query. The agent
  // declares types per workspace (e.g. 'person', 'project', 'booking').
  // No schema enforcement; `data` is any-shape. The agent is responsible
  // for keeping shapes consistent.
  entities: defineTable({
    workspaceId: v.string(),
    type: v.string(),
    slug: v.string(),
    data: v.any(),
    updatedAt: v.number(),
  })
    .index('by_workspace_type', ['workspaceId', 'type'])
    .index('by_workspace_type_slug', ['workspaceId', 'type', 'slug']),

  // Obsidian-style folder placeholders so empty folders can persist in
  // the tree. Path is a slash-separated string without a trailing slash
  // (e.g. "team" or "team/leads"). The folder isn't required to have
  // any atoms inside it.
  folders: defineTable({
    workspaceId: v.string(),
    path: v.string(),
    createdAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_path', ['workspaceId', 'path']),

  // file-org-v1 §2.2 (Track-4 D4.1a). Per-folder cosmetic state +
  // star — stored SEPARATELY from `folders` so:
  //   1) An empty-but-DECORATED folder needs no `folders` row clone
  //      (decoration alone is enough to persist via §5 list union).
  //   2) Folder rename Option B can follow recursively (every row
  //      whose `path` starts with the source prefix gets re-pathed).
  //   3) An all-empty row is GC'd by the same write that emptied it
  //      (setMeta with no decorations + starred=false ⇒ delete row),
  //      so decoration accounting stays clean (no zombie metadata).
  // All three cosmetic fields are OPTIONAL: absence means "default"
  // (no icon, theme-default color, not starred). Schema-shape is
  // tolerant to a future field addition.
  folderMetadata: defineTable({
    workspaceId: v.string(),
    path: v.string(),
    icon: v.optional(v.string()), // FOLDER_ICONS allowlist (9 lucide names)
    color: v.optional(v.string()), // FOLDER_COLORS allowlist (7 tokens)
    starred: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_path', ['workspaceId', 'path']),

  // One agent thread per workspace. Persisted so reloads keep history.
  threadRefs: defineTable({
    workspaceId: v.string(),
    threadId: v.string(),
  }).index('by_workspace', ['workspaceId']),

  // org-plan §5/§13 Phase C — DEBOUNCED `.context/_map.md` regen.
  //
  // Each row says "a regen for this workspace is already scheduled to
  // fire at `scheduledFor`". A second mutation arriving inside that
  // 2-second window short-circuits — no extra schedule, no extra row.
  // When the scheduled job runs it deletes its own row; the NEXT
  // mutation re-arms. Net effect: rapid edits coalesce to one regen
  // per `REGEN_DEBOUNCE_MS` window per workspace.
  mapRegenSchedule: defineTable({
    workspaceId: v.string(),
    scheduledFor: v.number(),
    scheduledJobId: v.optional(v.id('_scheduled_functions')),
  }).index('by_workspace', ['workspaceId']),

  // Explicit onboarding state (Phase 1 / Eng-EG6). The agent USED to
  // infer "ONBOARDING vs MAINTENANCE" from `list_atoms` being empty —
  // which flipped mid-onboarding the instant dohc wrote its first
  // atom, abandoning the flow half-built. State is now explicit:
  // present row + completedAt set ⇒ MAINTENANCE.
  onboarding: defineTable({
    workspaceId: v.string(),
    completedAt: v.optional(v.number()),
    // P1 design v1 Q2: the quiet "explore on my own" escape — distinct
    // from completedAt so the never-empty invariant stays honest.
    deferredAt: v.optional(v.number()),
    // P1 design v5/v5.1: the start-kickoff LEASE. Single-document
    // atomic CAS guard + action-driven heartbeat timestamp; `owner`
    // is the per-claim nonce so a superseded run can't pin the lease.
    kickoffAt: v.optional(v.number()),
    kickoffOwner: v.optional(v.string()),
  }).index('by_workspace', ['workspaceId']),

  // Trash (Phase 2 — structural recoverability). Every destructive op
  // on user data snapshots the row HERE, then hard-deletes from the
  // live table. Separate table ⇒ ZERO blast radius on read paths
  // (live tables stay clean; no read needs a soft-delete filter).
  // Guarantee: no delete/destructive-overwrite causes irreversible
  // loss within the retention window — enforced at the data layer,
  // independent of the model/prompt. Retention-bounded by a cron.
  // `ref` = atom/folder path or "type/slug"; `payload` = the full
  // snapshot needed to restore.
  trash: defineTable({
    workspaceId: v.string(),
    kind: v.union(v.literal('atom'), v.literal('folder'), v.literal('entity')),
    ref: v.string(),
    payload: v.any(),
    deletedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_kind_ref', ['workspaceId', 'kind', 'ref'])
    .index('by_deletedAt', ['deletedAt']),

  // Captures (Phase 2 keystone — reviewed-by-default ledger). When
  // dohc notes a structured value as a BYPRODUCT of the user's work
  // (no explicit "filing" by the user), a row is recorded here and
  // routed by the confirm-tier classifier:
  //   silent → status 'auto'    (private; accumulates, never surfaced
  //                              — the no-tax path)
  //   digest/inline → 'pending' (surfaced in ONE batched review; the
  //                              value exists but isn't "blessed" yet)
  //   confirm → 'confirmed' (blessed; may cross a shared window)
  //   reject  → 'rejected'  (pure status flip — NOT deleted; the
  //                              value is PERMANENTLY withheld from
  //                              every shared window via resolveWindow,
  //                              the owner's own copy is untouched)
  // Destructive never reaches here (the delete/overwrite gates handle
  // 'blocking'). This is the engine; whether dohc calls capture at the
  // right moments is agent behaviour (deploy-gated).
  captures: defineTable({
    workspaceId: v.string(),
    kind: v.union(v.literal('atom'), v.literal('entity')),
    ref: v.string(),
    // R2.1 (Codex CRITICAL): withhold/confirm is per (ref, KEY) —
    // confirming `hours` for one window must NOT release `salary` for
    // another. Optional (evolve-not-rewrite): a capture with NO key
    // ⇒ whole-ref withhold (the safe over-withhold direction): a
    // legacy/agent-tool entity row, OR R3's parse-fail atom SENTINEL.
    // R3: kind:'atom' captures DO use `key` — per (notePath, atomKey),
    // exactly like entities.
    key: v.optional(v.string()),
    summary: v.string(),
    tier: v.union(
      v.literal('silent'),
      v.literal('digest'),
      v.literal('inline'),
      v.literal('blocking'),
    ),
    status: v.union(
      v.literal('auto'),
      v.literal('pending'),
      v.literal('confirmed'),
      v.literal('rejected'),
    ),
    createdAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_status', ['workspaceId', 'status'])
    // R3 (design v3/v4 §4): the unreviewed-gate scan is KIND-
    // PARTITIONED — entity and atom non-confirmed rows are scanned
    // independently, each with its own overflow cap, so an atom-
    // capture flood can never push the ENTITY partition past its cap
    // and DENY an unrelated entity window (a silent entity regression
    // the R2 suite cannot catch). Replaces the by_workspace_status
    // scan for the gate (which had no `kind` column).
    .index('by_workspace_kind_status', ['workspaceId', 'kind', 'status'])
    // R2 strict keystone: coalesce a structural capture per entity ref
    // (don't pile rows), find a ref's captures to confirm-at-the-edge,
    // and clear them on entity delete (M6).
    .index('by_workspace_kind_ref', ['workspaceId', 'kind', 'ref'])
    // R2.2 (Codex MED #4): ref+KEY+status scoped so per-(ref,key)
    // coalesce/confirm/withhold-probe scans hit an EXACT partition
    // (≤1 row after coalescing) — truly bounded, NOT "scan the ref's
    // rows of one status and filter key locally" (O(#keys) for a
    // fat/legacy entity). `key` is optional ⇒ no-key/legacy rows
    // index as `key:undefined`, queried with .eq('key', undefined).
    // Status-scoped ⇒ confirmed history can't hide a withhold row.
    .index('by_workspace_kind_ref_key_status', [
      'workspaceId',
      'kind',
      'ref',
      'key',
      'status',
    ])
    .index('by_createdAt', ['createdAt']),

  // Opt-in plugins. Plugin IDs are defined in src/plugins/registry.ts.
  // A row's presence + `enabled: true` means the plugin is active for
  // this workspace. The renderer consults this on every query render.
  pluginSettings: defineTable({
    workspaceId: v.string(),
    pluginId: v.string(),
    enabled: v.boolean(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_plugin', ['workspaceId', 'pluginId']),

  // --- Carried over but unused in this iteration (kept so Convex doesn't
  // reject the schema push while old rows exist; safe to drop later). ---

  sourceAtoms: defineTable({
    workspaceId: v.string(),
    source: v.string(),
    kind: v.string(),
    externalId: v.string(),
    path: v.string(),
    author: v.optional(v.string()),
    reviewers: v.optional(v.array(v.string())),
    assignees: v.optional(v.array(v.string())),
    state: v.optional(v.string()),
    repo: v.optional(v.string()),
    number: v.optional(v.number()),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    data: v.any(),
    body: v.string(),
    fetchedAt: v.number(),
  })
    .index('by_workspace_source_kind', ['workspaceId', 'source', 'kind'])
    .index('by_workspace_path', ['workspaceId', 'path'])
    .index('by_workspace_state', ['workspaceId', 'state']),

  workspaceSettings: defineTable({
    workspaceId: v.string(),
    githubUsername: v.optional(v.string()),
    githubPat: v.optional(v.string()),
    lastGithubSyncAt: v.optional(v.number()),
  }).index('by_workspace', ['workspaceId']),

  // ── Tenancy scaffold (Phase 0, additive, NO readers until Phase 3) ──
  // Defined now so Phase 0 is conceptually re-grounded; behaviour is
  // unchanged because nothing queries these. The ONLY cross-person
  // read path will be a fail-closed `resolveWindow` over `windows` +
  // `windowGrants`. See docs/strategy/tenancy-authz-v0.md.

  // A workspace stays a single user; an org groups workspaces.
  memberships: defineTable({
    orgId: v.string(),
    workspaceId: v.string(), // == the member's user/workspace id
    // role is the typed v1 union (org-plan §6 / decisions.md §3).
    // Phase 0 rows only ever wrote 'owner' / 'member' (legacy code path
    // had no admin tier), so this tightening doesn't fail existing data.
    role: v.union(v.literal('owner'), v.literal('member')),
    // org-plan §4 additions. All optional + back-compatible (rows that
    // predate this default to status:'active'). status='invited' is the
    // pending-invite row written by a future inviteMember mutation;
    // joinOrg flips it to 'active'. status='removed' is the soft-tombstone
    // for offboarding (preserves the row so joinOrg-via-invite reactivates
    // instead of orphaning a duplicate row).
    //   invitedBy   — WorkOS subject of the inviting owner.
    //   invitedAt   — ms epoch, set on row insert.
    //   acceptedAt  — ms epoch, set when the invitee joins.
    status: v.optional(
      v.union(v.literal('active'), v.literal('invited'), v.literal('removed')),
    ),
    invitedBy: v.optional(v.string()),
    invitedAt: v.optional(v.number()),
    acceptedAt: v.optional(v.number()),
  })
    .index('by_org', ['orgId'])
    .index('by_workspace', ['workspaceId'])
    // exact (org, member) lookup — the hot path for requireWorkspace /
    // requireRole. Replaces the by_workspace + linear scan in isMember.
    .index('by_org_workspace', ['orgId', 'workspaceId']),

  // P1 (multiplayer-and-h-followups §6.5) — per-atom + per-folder
  // access controls. New user/agent-created docs in org workspaces
  // are born private by inserting an atomAccess row. Absence of a row
  // still means "org-default" (company-visible) for legacy docs,
  // explicit toggle-offs, and system-maintained rows.

  /** Per-atom access override. Set by `atoms.setAccess` mutation;
   *  consulted by `resolveAtomAccess` after the membership gate but
   *  before the org-default ALLOW. Owners do NOT bypass (decision
   *  P1-B): the `ownerUserId` field is the only principal allowed to
   *  read a `private` atom. */
  atomAccess: defineTable({
    atomId: v.id('atoms'),
    mode: v.union(v.literal('private'), v.literal('restricted')),
    /** The single principal allowed to read + edit + change access.
     *  For `restricted`, this is the owner; `allowedUserIds` extends
     *  read+edit to a list. For `private`, `allowedUserIds` must be
     *  `[]` — only the owner reads. */
    ownerUserId: v.string(),
    allowedUserIds: v.array(v.string()),
    setAt: v.number(),
    setByUserId: v.string(),
  }).index('by_atom', ['atomId']),

  /** Per-folder access override. Cascades to atoms inside the folder
   *  via `resolveAtomAccess`'s folder-walk (deepest folder with a row
   *  wins). An atom inside a restricted folder can override back to
   *  org-default by setting its own `atomAccess` row with the right
   *  mode + allowedUserIds. */
  folderAccess: defineTable({
    workspaceId: v.string(),
    /** Canonical folder path (no leading/trailing slash; matches
     *  `folders.path` shape). Empty string means "workspace root" —
     *  a workspace-wide private mark (rare; used for "this whole
     *  org is restricted to a sub-team"). */
    folderPath: v.string(),
    mode: v.union(v.literal('private'), v.literal('restricted')),
    ownerUserId: v.string(),
    allowedUserIds: v.array(v.string()),
    setAt: v.number(),
    setByUserId: v.string(),
  }).index('by_workspace_path', ['workspaceId', 'folderPath']),

  /** Tombstoned atoms (decision P1-C). When a member is removed from
   *  an org (`removeMember` / `leaveOrg`), their `private` atoms are
   *  not deleted — they get a tombstone row that makes them invisible
   *  to everyone (including org Owners) until an Owner explicitly
   *  calls `recoverTombstonedAtom` to re-categorize them.
   *
   *  Preserves the departed member's work without leaking it on
   *  accidental offboarding + without orphaning data. */
  atomTombstones: defineTable({
    atomId: v.id('atoms'),
    workspaceId: v.string(),
    reason: v.union(v.literal('member-departed')),
    tombstonedAt: v.number(),
    originalOwnerUserId: v.string(),
    /** Set when an Owner calls `recoverTombstonedAtom` — the tombstone
     *  row stays for audit but the atom becomes visible per its new
     *  access. */
    recoveredByOwnerUserId: v.optional(v.string()),
    recoveredAt: v.optional(v.number()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_atom', ['atomId']),

  // An owner-defined, permissioned projection of their own atoms.
  // selector/shape/audience are declarative config (data, not code).
  windows: defineTable({
    ownerWorkspaceId: v.string(),
    name: v.string(),
    selector: v.any(),
    shape: v.any(),
    audience: v.any(),
  }).index('by_owner', ['ownerWorkspaceId']),

  // Explicit, append-only, revocable authz rows. Absence ⇒ DENY.
  windowGrants: defineTable({
    windowId: v.id('windows'),
    viewerWorkspaceId: v.string(),
  })
    .index('by_window', ['windowId'])
    .index('by_viewer', ['viewerWorkspaceId'])
    .index('by_window_viewer', ['windowId', 'viewerWorkspaceId']),

  // Phase 4 — the loop. The binding registry for a `{identifier}`
  // live-total. ADDITIVE; no readers until liveTotals.resolve. A live
  // total is a RENDERED PROJECTION (UC-3/EF4): this table only records
  // HOW to compute it, NEVER the computed value. One binding per
  // (workspace, identifier). `ownDesk` = sum/count the caller's own
  // value-atoms (markdown is truth, parsed by the FROZEN parser);
  // `window` = a Phase-3 cross-desk window aggregate (reviewed-by-
  // default + grant already enforced by resolveWindow).
  rollups: defineTable({
    workspaceId: v.string(),
    identifier: v.string(),
    spec: v.union(
      v.object({
        kind: v.literal('ownDesk'),
        op: v.union(v.literal('sum'), v.literal('count')),
        key: v.string(),
      }),
      v.object({
        kind: v.literal('window'),
        windowId: v.id('windows'),
      }),
    ),
  }).index('by_workspace_identifier', ['workspaceId', 'identifier']),

  // Phase 4 Unit 4b — the weekly loop. An ADVISORY reconcile proposal
  // (intent vs reality). NOT a capture (recordCapture VERIFIES an
  // atom/entity target — an insight has none); this mirrors the
  // reviewed-by-default PATTERN without overloading that table.
  //
  // Phase-4 review (Codex HIGH): the row stores ONLY the workspace's
  // OWN data (goal, from its own .context/intent.md) + a marker. It does NOT
  // persist `actual`/`message` — a cross-desk live-total cached here
  // would survive grant revocation and leak (sharing-and-lenses.md:
  // live totals roll up "through permitted windows"; markdown is the
  // truth, "not a database underneath"). `actual` is re-resolved LIVE
  // and fully grant-gated at digest time (_pendingProposals); a
  // revoked/withheld/caught-up proposal silently drops. Accept is
  // ADVISORY ONLY — never auto-applies (masterplan non-goal).
  // Idempotent per (workspace, period, identifier).
  //
  // Unit 4c: also carries `kind:'gardening'` proposals (orphan/dup
  // notes). `goal` is metric-only (optional). `summary` is
  // gardening-only and is SAFE to persist — it describes the
  // workspace's OWN note structure (paths), never a cross-desk value
  // (the Codex-HIGH cache concern was cross-desk live-totals only).
  // Both kinds are re-evaluated LIVE at digest time and dropped when
  // no longer applicable.
  proposals: defineTable({
    workspaceId: v.string(),
    period: v.string(), // epoch-week bucket (stable idempotency key)
    identifier: v.string(),
    // OPTIONAL on purpose (evolve-not-rewrite / widen-migrate-narrow:
    // a required field would reject any pre-existing row on deploy).
    // Absent ⇒ treated as 'metric' by readers (the original shape).
    kind: v.optional(v.union(v.literal('metric'), v.literal('gardening'))),
    goal: v.optional(v.number()), // metric only — own .context/intent.md goal
    summary: v.optional(v.string()), // gardening only — own note paths
    status: v.union(
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('dismissed'),
    ),
    createdAt: v.number(),
  })
    .index('by_workspace_status', ['workspaceId', 'status'])
    .index('by_workspace_period_identifier', [
      'workspaceId',
      'period',
      'identifier',
    ]),

  // v2 atomSuggestions sidecar. Semantic agent tools write proposed
  // edits here; the editor subscribes and renders inline bubbles.
  // Accept calls Hocuspocus to mutate canonical Y.Doc state; reject
  // only resolves the sidecar row. Suggestions are not embedded in
  // the markdown projection.
  atomSuggestions: defineTable({
    atomId: v.id('atoms'),
    workspaceId: v.string(),
    // Deprecated v1 markdown-body offsets. New suggestions must use
    // anchorStart/anchorEnd. These remain optional only so old rows
    // can load during the v2 cleanup window.
    rangeFrom: v.optional(v.number()),
    rangeTo: v.optional(v.number()),
    // v2 Phase 1.7: Y.RelativePosition anchors encoded as base64
    // `Y.encodeRelativePosition(...)`. These are canonical for
    // suggestions on Y.Doc-backed atoms; rangeFrom/rangeTo remain
    // optional only for temporary v1 cleanup compatibility.
    anchorStart: v.optional(v.string()),
    anchorEnd: v.optional(v.string()),
    // The text the agent wants to write at the anchored range.
    proposedText: v.string(),
    // Semantic intent witness. Y.RelativePosition preserves location
    // through CRDT edits; expectedText/prefix/suffix preserve meaning.
    // Hocuspocus refuses or marks needs-review when the live text no
    // longer matches the agent's witness.
    expectedText: v.optional(v.string()),
    expectedPrefix: v.optional(v.string()),
    expectedSuffix: v.optional(v.string()),
    createdFromProjectionHash: v.optional(v.string()),
    // The original instruction that produced this suggestion
    // (e.g. "rewrite intro"). Surfaced in the bubble UI.
    instruction: v.string(),
    // True when the agent created this. v1 always true (only
    // agent → suggestion path); reserved for future human-to-human
    // suggestion threads.
    authorIsAgent: v.boolean(),
    // identity.subject of the agent or human author.
    authorUserId: v.string(),
    // 3.9.18 — cached display name (identity.name) at create
    // time. Bubble headers render "Agent suggestion (Alice)"
    // instead of "Agent suggestion (ws_alice_)".
    authorUserName: v.optional(v.string()),
    // Set when accepted; the human who clicked Accept.
    resolvedByUserId: v.optional(v.string()),
    // 3.9.18 — cached display name at resolve time. Bubble
    // shows "accepted by Alice 2s ago" instead of subject prefix.
    resolvedByUserName: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    // 'pending' until accept/reject; then 'accepted' or 'rejected'.
    // We keep accepted/rejected rows briefly (see 3.9.1
    // listPending filter) so other tabs can show the fade-out
    // "accepted by Bob 2s ago" UI per the plan acceptance.
    status: v.union(
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('rejected'),
      v.literal('stale'),
      v.literal('needs-review'),
    ),
    createdAt: v.number(),
  })
    .index('by_atomId_status', ['atomId', 'status'])
    .index('by_atomId', ['atomId'])
    .index('by_workspaceId', ['workspaceId']),
})

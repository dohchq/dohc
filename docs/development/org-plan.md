# Organizations — design plan

**Status:** draft / proposal (not yet implemented)
**Supersession note:** Any `_map.md` / map regeneration pieces in this
older plan are no longer MVP direction. See `decisions.md`: the generated
workspace map feature was removed in favor of explicit navigation tools
and context atoms.
**Goal:** Bring **multi-user organizations** to dohc while keeping the
calm, personal-first soul of the product intact. Each human keeps their
**personal workspace**; orgs are **separate shared workspaces** with
members and roles. The agent operates per-workspace: in your personal
workspace it knows *you* (`me.md`); in an org workspace it knows the
*team* (`company.md`). **Personal context never silently leaks into org
retrieval.**

This plan was pressure-tested with Codex twice and fact-checked against
the codebase. **Round-2 corrections (folded in):**

> The biggest miss in round 1 was ignoring **existing tenancy infra
> already in `schema.ts:129-410`** — `orgs`, `memberships`,
> `atomShares.granteeOrgId`, `windows` + `windowGrants` — a Phase 0
> scaffold added explicitly anticipating this work ("**NO readers until
> Phase 3**"; this *is* Phase 3). The plan now **extends those tables**
> instead of introducing parallel `workspaces`/`workspaceMembers`.
> Other folded fixes: `orgs._id` IS the org's workspaceId (Convex
> auto-generates `_id`, the original "_id == WorkOS subject" claim was
> impossible); `threadRefs` becomes workspace-keyed (one thread per
> *workspace*-per-user, not one per user); four retrieval surfaces are
> marked **non-defaultable**; `onboarding.progressOf` + agent prompt
> need a workspace-kind branch; `mapEntries` deferred to V2 (debounced
> regen achieves the user's "feels in sync" goal with no new table);
> roles trimmed to Owner/Member; editing drops heartbeat; revision
> check uses `baseBody` not `updatedAt`; skill execution gets explicit
> scope.

Decisions locked (see `decisions.md`):

- **Org model:** Personal + org hybrid (option B).
- **Workspace boundary in v1: HARD.** Each agent sees only its
  workspace's content; no `@`-cite of personal atoms into org chats,
  no cross-workspace retrieval. Users bring personal context into an
  org chat via copy-paste — a user-initiated, visible action.
- **V1 scope:** workspace switcher, create/join org via WorkOS, two
  roles (**Owner / Member**, multiple Owners allowed; rename = Owner
  only — see §6), org atoms/folders/skills, org `company.md`
  + org `_map.md`, **org-scoped agent with provenance**, presence +
  revision-check editing (no heartbeat), **debounced (2s coalesced)
  regen of `_map.md` on atom writes** (the simpler answer to "feels in
  sync" — `mapEntries` table deferred), starter `company.md` +
  dashboard on new-org creation.
- **Deferred to V2+:** `mapEntries` indexed table; SCIM; folder-level
  ACLs; CRDT live editing; cross-workspace search; **personal→org atom
  promotion** (the realistic solver for "this draft belongs to the
  team").

---

## 1. Requirements

**Functional (v1)**
- A user can **create** an org and **invite** other users by email.
- A user can **belong to multiple workspaces**: their own personal one,
  and any orgs they were invited to.
- An **active-workspace switcher** in the UI; the URL reflects the
  active workspace.
- **Roles** in an org: **Owner / Member** (multiple Owners allowed).
- Org workspaces have their own **atoms, folders, skills,
  `company.md`, `_map.md`** — disjoint from personal data.
- The **agent runs in the active workspace's scope** only. In an org,
  it has org atoms/skills/`company.md`/`_map.md` in context; it does
  **not** see personal atoms — period. **Hard workspace boundary**:
  there is no `@`-cite, no thread attachment, no retrieval path that
  crosses workspaces in v1. Users who want to inject personal context
  copy-paste the text into the prompt (a user-initiated visible
  action). V2 revisits via personal→org atom promotion.
- **Agent provenance:** every agent response that cites an atom shows
  `{path, author, workspace}` so users always know which page the
  agent's claim came from.
- **Concurrent editing:** revision check + presence + a short
  collaborator edit lease. No silent overwrites of bodies.

**Non-goals (v1)**
- SCIM provisioning, fine-grained folder/atom ACLs within an org,
  CRDT-grade live editing, cross-workspace search, "promote my personal
  atom to the org" as a first-class flow, nested teams, audit log,
  billing.

---

## 2. Current state (what the org work must respect)

- **Tenancy is single-tenant per user:** every public Convex
  query/mutation calls `requireWorkspace(ctx)` (`convex/auth.ts:20`),
  which returns the **WorkOS user subject** as `workspaceId`. So
  today, `workspaceId == one human`. Atoms, folders, `atomShares`,
  captures, skills, the agent, the loop — all keyed by it.
- **Sharing today:** `atomShares` supports both **person-to-person**
  (`granteeWorkspaceId`) *and* **org-wide** (`granteeOrgId`), with the
  org-share branch backed by an existing `orgs` + `memberships` pair
  (`convex/schema.ts:129-169, 387-393`; `convex/orgs.ts`:
  `createOrg`, `joinOrg`, `leaveOrg`, `myOrgs`, `orgMembers`,
  `viewerOrgIds`, `isMember`; `convex/atomShares.ts:170-207`
  `shareAtomToOrg`). This is **the existing model:** an "org" is a
  share-audience group; atoms live in members' personal workspaces and
  are *shared to* the org by `granteeOrgId`. It works but it doesn't
  give the team a *shared* workspace with its own atoms/folders/agent
  context.
- **The Phase 0 scaffold.** `schema.ts:380-410` adds `memberships`,
  `windows`, and `windowGrants` as "additive, NO readers until Phase
  3 … See `docs/strategy/tenancy-authz-v0.md`." Plan v1 = Phase 3.
- **Hint of intent:** `company.md` already exists as a reserved system
  atom (`convex/loop.ts:43`'s `NOT_ORPHAN` set, alongside
  `me.md`/`intent.md`/`_map.md`). It's a placeholder waiting for orgs.
- **WorkOS AuthKit** is the auth layer and natively supports
  Organizations (invites, SSO, SCIM). We adopt its primitives for
  identity + membership lifecycle, but **not** as our content authz DB.

---

## 3. Engine decision

**Decision: a workspace is the tenancy unit (personal or org).
Personal workspaceId stays the user's WorkOS subject (current behavior).
An org's workspaceId is the existing `orgs._id` — i.e. the existing
`orgs` row is *promoted* from share-audience-group to tenancy-unit by
giving it readers (Phase 3). Membership reuses the existing
`memberships` table. No new tables.**

### Why this shape

| | Approach | Verdict |
|---|---|---|
| **(i)** | **Workspace == tenancy unit; type discriminator + membership table.** | ✅ **Chosen.** Reuses every existing `by_workspace*` index and every `requireWorkspace`-gated query/mutation. Existing personal data stays put. |
| (ii) | Keep `workspaceId == user`; add a second `orgId` dimension to every row. | ❌ Two tenancy axes → guaranteed bugs (rows with mismatched workspaceId+orgId). |
| (iii) | Implement orgs purely via heavy `atomShares`. | ❌ Permission fanout per query; `_map.md`/folders/skills/agent become incoherent at the team level. |

Codex: *"Use `workspaceId = workspace unit` (i). Most queries already
use `requireWorkspace(ctx)`. The real change is
`requireWorkspace(ctx, activeWorkspaceId)` plus membership validation.
Indexes probably survive. Migration risk is mostly auth/context/UI, not
data model."*

---

## 4. Data model

**No new tables.** Extend two existing ones plus a few additive atom
fields. This is the change from round 1: ignore-and-duplicate → align
with the Phase 0 scaffold.

### `orgs` — promoted from share-audience to workspace

The existing row (`schema.ts:164-169`) keeps `name`/`inviteCode`/
`createdBy`/`createdAt`. We add purely cosmetic / lifecycle fields:

```ts
orgs: defineTable({
  name: v.string(),
  inviteCode: v.string(),
  createdBy: v.string(),
  createdAt: v.number(),
  // additions:
  accent: v.optional(v.string()),       // tiny visual identity token (v1.5 polish, see §13)
  workosOrgId: v.optional(v.string()),  // SSO link to WorkOS Organization
  status: v.optional(v.string()),       // 'active' | 'archived'
}).index('by_inviteCode', ['inviteCode'])
  .index('by_workos_org', ['workosOrgId']),
```

**An org's `workspaceId` is the org's `orgs._id`** (a Convex string id).
`atoms.workspaceId` already takes `v.string()`, so a value like
`"j97ab…"` (Convex base32) just slots in. **No new field, no row
rewrite.** Personal workspaceId stays the WorkOS user subject —
existing rows are unaffected. (This corrects round 1's "`_id` equals
WorkOS subject" claim, which was impossible — Convex auto-generates
`_id`.)

### `memberships` — already exists; widen `role` + add invite state

The existing row (`schema.ts:387-393`) has `orgId`, `workspaceId`
(= the *member's* personal workspaceId, per the schema comment),
`role: v.string()`. We widen role to a union and add invite-state
fields:

```ts
memberships: defineTable({
  orgId: v.string(),                    // == orgs._id (the org workspaceId)
  workspaceId: v.string(),              // the member's personal workspaceId (WorkOS subject)
  role: v.union(v.literal('owner'), v.literal('member')), // §6 — two roles
  // additions:
  status: v.union(v.literal('active'), v.literal('invited'), v.literal('removed')),
  invitedBy: v.optional(v.string()),
  invitedAt: v.number(),
  acceptedAt: v.optional(v.number()),
})
  .index('by_org', ['orgId'])
  .index('by_workspace', ['workspaceId'])
  .index('by_org_workspace', ['orgId', 'workspaceId']),
```

Naming nit acknowledged: `memberships.workspaceId` here means the
*member's personal workspaceId*, not the org. Schema comment already
calls that out; we keep the name for back-compat. (A future rename to
`memberUserId` is a no-op data migration if it becomes confusing.)

### `threadRefs` — workspace-keyed, N threads per user

Currently one thread per user (`schema.ts:221-224`, `by_workspace`
index where workspaceId = the user's personal id). Each workspace
needs its own thread or every org agent call silently reuses the
personal thread. The row keeps its shape; the index semantics shift:

```ts
threadRefs: defineTable({
  workspaceId: v.string(),     // now == the active workspace (personal or org)
  threadId: v.string(),
  // ...existing fields...
})
  .index('by_workspace', ['workspaceId']),
```

`ensureThread` (`agent.ts:1583-1596`) takes `activeWorkspaceId` and
looks up by that. Migration: existing rows are valid (they're personal
threads keyed by the user's WorkOS subject == personal workspaceId).
New org threads materialize on first agent call in that workspace.

### Atom additive fields (back-compatible)

```ts
// Collaborator edit lease — separate from systemLocked / userLocked.
editingBy: v.optional(v.string()),       // WorkOS user subject
editingUntil: v.optional(v.number()),    // ms epoch

// Provenance: who last wrote this atom. The pill shows "last writer,"
// not "original author" — the name is precise.
lastEditedByUserId: v.optional(v.string()),
```

### `_map.md` refresh — debounced regen (V2 = `mapEntries`)

The user wanted "feels in sync, push-based." The leanest correct v1 is
a **debounced full-regen of `_map.md` on atom writes** — reusing the
existing `loop.regenerateMap` machinery (`loop.ts:232-273`) and its
"`skipped-not-agent-owned`" guard so user-edited `_map.md` is never
overwritten.

Wiring:
- The shared atom-write helper (search plan §5) schedules
  `regenerateMap(workspaceId)` 2s out via `ctx.scheduler.runAfter`.
- Coalesce per workspace via a small `mapSchedule` marker (or
  per-workspace "pending scheduled id" tracked in a tiny row): if a
  schedule is already pending for this workspace, the next write
  doesn't enqueue another.
- Extend `_upsertSystem` with `skipTrash: true` so map regens don't
  bloat the trash table.
- `regenerateMap` keeps its current `source !== 'agent'` guard
  (`loop.ts:254-257`); a user-edited `_map.md` is preserved.

**V2 (deferred):** `mapEntries` indexed table for O(1)-per-write maps +
an instant agent query. The search-plan precedent (single field, no new
table, "revisit if/when") applies. Promote if a workspace's regen time
becomes user-visible — almost certainly not at v1's scale.

---

## 5. Auth: workspace selection + membership

The shift from "always personal" to "active workspace" is the highest
blast-radius change. The plan keeps it explicit, server-verified, and
backward-compatible:

```ts
// convex/auth.ts — replace requireWorkspace
export async function requireWorkspace(
  ctx: QueryCtx | MutationCtx,
  active?: string, // workspaceId from the client
): Promise<string> {
  const subject = await requireSubject(ctx) // existing WorkOS subject
  // Default: the user's personal workspace (id == subject).
  const target = active ?? subject
  if (target === subject) return subject
  // Org workspace — must be a member.
  const m = await ctx.db
    .query('memberships')
    .withIndex('by_workspace_user', q =>
      q.eq('workspaceId', target).eq('userId', subject))
    .unique()
  if (!m || m.status !== 'active') {
    throw new Error('not a member of this workspace')
  }
  return target
}
```

**Every public mutation/query gains an optional `activeWorkspaceId`
arg** that's passed straight through to `requireWorkspace`. Existing
callers that don't pass it keep working — they get the user's personal
workspace, exactly as today. This is the migration valve: we don't have
to rewrite every callsite on day one.

**Active workspace = URL path:** `/w/<workspaceId>/p/<atomId>`. The
router carries `workspaceId` everywhere; a small `useActiveWorkspaceId()`
hook reads from the router, and every mutation/query caller passes it.
URL-based is bookmarkable, race-free, and survives reloads; a server
preference would create stale-context races on switch.

### Non-defaultable surfaces (REQUIRED `activeWorkspaceId` arg)

Most public functions can safely default to personal on a missing arg
(the migration valve above). **Four surfaces cannot** — defaulting them
to personal would silently render org content against personal data and
is a privacy bug:

- **`queries.evalQueryBlocks`** (`convex/queries.ts:228`) — the formula
  DSL evaluator. An org atom's `docs.find` / `docs.glob` / `entities.*`
  block must resolve against the *org's* data.
- **`formulaEval.evalFormulas`** (`convex/formulaEval.ts:275`) — same
  hazard for inline `{=…}` formulas.
- **`htmlAtoms.getRenderable`** (`convex/htmlAtoms.ts:30`) — the HTML
  render route is keyed by atom fileId; must scope to the active
  workspace.
- **Agent thread surface:** `agent.ensureThread`, `sendMessage`,
  `startOnboarding`, `listMessages` (`agent.ts:1570, 1828, 1954, 2048`)
  — `threadRefs` must bind to the *active* workspace so the org chat
  doesn't reuse the personal thread and inherit its history.

These four pass `activeWorkspaceId` as a required arg from day one;
`requireWorkspace(ctx, active)` with `active === undefined` is treated
as a contract error, not silently defaulted.

> **Codex trap, called out:** *"WorkOS proves identity and org
> membership. Convex still needs its own workspace/member records —
> product permissions, agent access, migration history live in your
> app. Never let a client-provided `organizationId` pick tenancy unless
> the server verifies the user is a member of the corresponding Convex
> workspace."*

---

## 6. Roles & permissions

**Two roles** (round-2 cut from three — the pragmatist's review showed
Owner and Admin differed on exactly one row, and "multiple Owners
allowed" already covers shared admin work). Add Admin in V2 if a real
Admin-but-not-Owner gap emerges.

| Role | Read | Write atoms/folders | Save/edit skills | Edit `company.md` / rename org | Invite / remove / change role | Delete workspace |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Member | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

Multiple Owners allowed (decisions.md §2). Last-Owner-removal is
refused server-side.

```ts
// convex/orgRoles.ts
async function requireRole(ctx, workspaceId, atLeast: 'member' | 'owner')
```

Used at the head of every privileged mutation. **Agent tools that map
to privileged ops** (`save_skill`, `delete_folder`
where it'd touch shared content, etc. — `agent.ts:1657-1675`
`UNAUTHORIZABLE_TOOLS`) also pass through `requireRole` in org context.

An **audit-by-grep test** (mirroring `searchWriteAudit.test.ts`)
asserts every privileged mutation calls `requireRole` before any
write — guards new mutations from silently shipping without the gate.

Personal workspaces implicitly grant Owner to their owner (the WorkOS
subject) — no `memberships` row, no extra checks.

**`_map.md` stays system-owned** (`loop.regenerateMap` is the sole
writer, gated by `_upsertSystem` — same machinery, just keyed by the
org's `workspaceId`). The org's `_map.md` is the agent's team-memory
index.

---

## 7. Concurrent editing — minimum viable

**Revision check + presence + no-heartbeat lease.** Not CRDT, not
silent LWW. Round 2 cut: dropped the 10s heartbeat (writes every 10s
while focused = too much churn for the conflict-class it prevents).

- **Revision check (load-bearing):** save carries `baseBody` (the body
  the client started editing from) — same primitive the codebase
  already uses for shared edits (`atoms.ts:454`); same-millisecond
  `updatedAt` checks silently clobber and we already learned that
  lesson. If `existing.body !== baseBody`, server rejects with
  `CONFLICT`; the client surfaces a calm resolve UI (your version /
  latest / save-as-copy).
- **Presence (reactive):** on AtomView open, the client writes
  `editingBy = me, editingUntil = now + 60s`. Refreshed on save and on
  focus-regain — **no recurring heartbeat**. The reactive query
  surfaces "Alex is editing this page" before conflicts happen. Lease
  is **advisory** — the revision check is what makes saving safe.
- **No silent body LWW.** Metadata-only fields (icon, star) may LWW.
- The lease expires naturally (`editingUntil` in the past); stale tabs
  don't permanently block teammates.

This stays **separate** from existing locks:
- `systemLocked` (`atomId.ts:268` etc.): agent/system cannot mutate.
- `userLocked`: AI/system cannot mutate user-protected content. *Human* edits still go through.
- `editingBy/Until`: a *human-vs-human* soft lock for the in-flight tab.

Codex: *"Human collaboration and AI/system mutation are different
problems — don't overload lock semantics."*

---

## 8. The agent in an org context (provenance is v1)

This is the part that makes dohc-in-an-org different from "Notion plus
a chatbot." The agent runs **per active workspace**:

- **In personal:** sees `me.md`, personal `intent.md`, personal atoms,
  personal skills, personal `_map.md`. Same as today.
- **In an org:** sees `company.md`, org `intent.md`, org atoms, org
  skills, org `_map.md`. **Does not see personal atoms.**

**Thread isolation requires a schema change.** Today `threadRefs`
(`schema.ts:221-224`) is one row per user (`workspaceId` = personal id).
With orgs, each user gets one thread *per workspace they're in*; the
`by_workspace` index continues to work once `workspaceId` is the active
workspace's id. `agent.ensureThread` (`agent.ts:1583-1596`) looks up by
the active workspace, not the user's personal id. A thread started in
personal stays personal forever, even after a switch — the row binds to
that workspaceId at creation.

**Skill execution scope (round-2 addition).** Codex P1: "Do
not let saved execution surfaces inherit org-wide power from the author."
Concretely:
- Only **Owners** save skills in an org workspace (§6).
- Skill **execution** runs under the *invoking member's* session but its
  writes go through the org workspace's `requireWorkspace` +
  `requireRole` check — a member-invoked skill cannot perform
  Owner-only writes.
- The `agent.ts:1657-1675` `UNAUTHORIZABLE_TOOLS` list extends with
  `requireRole` for org context.

**Onboarding mirror (workspace-kind branch).** Per §15.5, org creation
seeds `company.md` + a starter dashboard. Implementation specifics
(round-2 addition):
- `onboarding.progressOf` (`onboarding.ts:82-83`) currently hardcodes
  `me.md`; it gains a workspace-kind branch (`workspaces[kind] →
  identity atom path`). For orgs the identity atom is `company.md`.
- The agent's onboarding system prompt (`agent.ts:59-503`) gains the
  same branch — for orgs it writes `company.md` + the starter
  dashboard, not `me.md`.
- The org's onboarding `threadRefs` row binds to the org workspaceId
  (per "Thread isolation" above) so it's a separate conversation from
  the user's personal onboarding.
- The cron's reconcile pass (`loop.ts:618`) iterates `onboarding` rows;
  org `onboarding` rows are picked up for free once they exist.

**Provenance is non-optional.** Every atom retrieval the agent does
attaches `{path, authorUserId, workspaceId, kind}` to the reference.
When the agent surfaces a claim, the UI shows:
> *"From `roadmap.md` · @alex · Acme org"*

Without this, shared AI memory is *"office folklore with an autocomplete
box"* (Codex's phrase, and exactly right). The data is already in our
hands — `atomShares`/atoms know their author + workspace — we just have
to thread it through the retrieval and render path.

**Privacy primitives** the implementation must hold:
- Atom retrieval is gated by `requireWorkspace(ctx, activeWorkspaceId)`
  — the retrieval function literally cannot reach atoms in a different
  workspace.
- **No cross-workspace mention path in v1.** No `@`-cite, no thread
  attachment, no retrieval shortcut. If a user wants to inject personal
  context into an org chat, they paste the text into the prompt
  themselves — a visible, user-initiated action with no structural
  cross-tenant infrastructure to misfire. V2 revisits via personal→org
  atom promotion (a one-shot move), not per-thread bridging.
- A test asserts the org agent thread cannot, under any path, retrieve
  a personal atom (cross-tenant isolation extended).

---

## 9. UI / UX

- **Workspace switcher**: a small dropdown in the FileTree brand header
  (next to the dohc mark) — `Personal · Acme · Beta`. Keyboard shortcut
  `⌘⇧O` (open). Switching navigates to `/w/<new>/…`; the FileTree
  reactively rebinds.
- **Visual cue**: in an org workspace, the dohc mark sits beside the org
  **name** (and an optional accent dot). The mark itself is unchanged
  — calm.
- **Members admin** (Settings → Members): list, invite (email), role
  change, remove. Owner-only.
- **Provenance pill** in agent responses: clickable, opens the cited
  atom in the right workspace.
- **Sign-up flow** unchanged for personal. An invited user lands on the
  invite-accept screen → joins the org → workspace switcher shows it.

---

## 10. WorkOS Organizations integration

Use WorkOS for:
- **Organizations** (create/get; the canonical org identity).
- **Invitations** (email; recipient accepts via a callback).
- **Membership lifecycle** (add, remove, role tag).
- **SSO** (out of v1 polish but the door stays open).

Do **not** use WorkOS for:
- Content authorization (role-gated mutations).
- Workspace state (Convex `orgs` + `memberships` is the source of
  truth for app authz).

**Server-side reconcile:** on every mutation that depends on org
membership, the server consults `memberships` — **not** the WorkOS API
on the hot path. A lightweight reconcile (triggered on sign-in + on
invite-accept) syncs WorkOS membership into Convex. The reconcile is
**fail-closed**: a user removed from WorkOS but still `active` in
Convex loses access on the next sign-in, before the periodic job runs.

A periodic reconcile job is **deferred** until we observe drift —
sign-in + invite-accept covers the happy path. Adding a webhook later
is the right move when WorkOS Organizations changes happen out-of-band.

Additional WorkOS gotchas the plan must respect:
- **JWT org claims can drift** — never trust client `organizationId`
  without a Convex `memberships` lookup.
- **SSO/domain auto-join** must not imply content access until Convex
  `memberships` exists.
- **Role mapping**: Convex `memberships.role` is the canonical app
  role; WorkOS role tags are advisory.
- **Last-Owner removal** is refused server-side.
- Reconcile must support **tombstoning** (status: 'removed'), not just
  additive sync.

---

## 11. Migration plan

Backwards-compatible by construction; **no row rewrite**, no
`_backfillPersonalWorkspaces` mutation (because personal workspaceIds
already exist as the WorkOS subject on every existing atom; there's
nothing to backfill).

1. **Schema changes only** (additive): `orgs` field additions,
   `memberships` widened `role` + invite-state fields, optional atom
   fields. Existing rows untouched.
2. **`requireWorkspace(ctx, active?)`** with the default-to-personal
   branch (§5). Old callers continue to receive their personal id.
   **Exception:** the four non-defaultable surfaces (§5) require an
   explicit `activeWorkspaceId` from day one.
3. **WorkOS bridge**: on sign-in, idempotent reconcile of the user's
   WorkOS org memberships into `memberships` rows.
4. **Org creation flow**: `orgs.create` mutation (extended) → WorkOS
   org create → Convex `orgs` row → Owner `memberships` row → seed
   `company.md` + starter dashboard via the same agent onboarding
   path as personal (with the workspace-kind branch from §8).
5. **Per-mutation `activeWorkspaceId` arg refactor.** A grep-derived
   list of public-mutation/query callsites that need the arg lives in
   this PR (not "gradual" — concrete). Most callers route via a few
   thin React hooks (`useActiveWorkspaceId()` reading the URL), so the
   client-side change is a small wrapping, not a callsite-by-callsite
   sweep.
6. **The existing `orgs`/`memberships`/`atomShares.granteeOrgId` path
   stays alive.** v1 doesn't break or migrate it — orgs are now both
   share-audiences (legacy) and workspaces (new), which is fine
   because the schema treats them as the same entity. Folder-level
   ACLs and the personal→org promote flow (V2) can revisit.

**User-visible answer (UX):** "On first sign-in after deploy, you see
only your personal workspace, exactly as before. Orgs appear in the
switcher only after you create one or accept an invite."

---

## 12. Phasing

- **V1 (this plan):** workspaces table + memberships + role-gated
  mutations; `requireWorkspace` v2; workspace switcher; URL routing;
  WorkOS create-org + invite-by-email; org agent scope + provenance;
  presence + edit lease + revision check; backfill mutation.
- **V2:** SCIM provisioning; folder-level ACLs; cross-workspace search;
  "promote a personal atom into the org" flow; `atomShares.workspaceId`
  recipient (share to whole org instead of a person); audit log.
- **V3:** CRDT live editing; nested teams; billing; data export/import
  at workspace granularity.

---

## 13. Risks & pitfalls

- **Personal context leak into org prompts** — privacy trust collapses
  on first incident. Mitigations: hard workspace boundary (§8),
  workspace-scoped retrieval at the data layer, the four
  non-defaultable surfaces (§5), an explicit cross-tenant agent test
  per retrieval surface (§14).
- **Treating WorkOS as the authz DB** (Codex trap, §5/§10).
- **Migrations assuming `workspaceId == user`** — there are comments
  throughout the codebase that say this. They get updated in the same
  PR that introduces the new `requireWorkspace` semantics; an
  audit-by-grep test catches new ones.
- **Skill execution scope** (§8 has the policy) — Owner-saved code
  running under a Member's session must not inherit org-wide power.
- **Member offboarding** — removed user's authored atoms stay in the
  org (team memory shouldn't evaporate); their agent threads stay
  attributed to them (now-inactive); their access is revoked.
- **WorkOS / Convex membership drift** — handled by reconcile on
  sign-in + invite-accept. Fail-closed (revoked-in-WorkOS = no access
  on next sign-in). Webhook deferred.
- **`editingBy` cleanup** — leases expire naturally (`editingUntil` in
  the past); no heartbeat to leak.
- **Workspace-switcher data hygiene** — when the user switches
  workspace, reactive queries from the prior workspace's URL must
  unsubscribe; the new URL's queries take over. Test for this (§14).
- **The `orgs` table is now both share-audience AND workspace** —
  potential semantic confusion for future devs. A schema comment + a
  short ADR-style line in `tenancy-authz-v0.md` (if it materializes)
  captures this.

---

## 14. Testing

- **Cross-tenant isolation per retrieval surface**: workspace A's
  agent (and every retrieval surface) cannot return workspace B's
  atoms or snippets. Coverage: `atoms.list`, `search.run`,
  `queries.evalQueryBlocks`, `formulaEval.evalFormulas`,
  `htmlAtoms.getRenderable`, every agent tool, skill execution.
- **Role enforcement**: each role × each privileged mutation.
- **`requireRole` audit-by-grep** (mirrors `searchWriteAudit.test.ts`):
  every privileged mutation calls `requireRole` before any write; new
  files inserting org-scoped writes must opt in explicitly.
- **Edit conflict**: two clients open the same atom; one saves; the
  other's save is rejected with `CONFLICT` and `baseBody` mismatch.
- **Edit lease expiry**: stale `editingUntil` no longer blocks.
- **Workspace switch data hygiene**: after switching from `/w/<A>` to
  `/w/<B>`, no reactive subscription from A's workspace remains
  visible.
- **Agent provenance**: every cited atom in an agent response carries
  `{path, lastEditedByUserId, workspaceId}`.
- **Non-defaultable surfaces**: calling
  `queries.evalQueryBlocks` / `formulaEval.evalFormulas` /
  `htmlAtoms.getRenderable` / agent thread mutations without
  `activeWorkspaceId` throws.
- **Thread isolation**: a thread created in personal stays personal;
  switching to an org creates a fresh org thread.
- **Onboarding workspace-kind branch**: `progressOf` checks
  `company.md` for org workspaces and `me.md` for personal.
- **`atomShares` interop**: a peer share from a personal atom to a
  user in the same org still works (the existing flow doesn't depend
  on `memberships`); a `granteeOrgId` share remains readable by org
  members.

---

## 15. Resolved (planning session)

All five originally-open questions were resolved with the user (see
`decisions.md`). Two of them were **refined in round 2** based on the
review pass — the refinements preserve the user-visible outcome but
swap the implementation for a simpler one:

1. **Map cadence: feels-in-sync, push-based.** Round-1 picked
   "straight to V2 `mapEntries`"; round-2 demoted that to V2-deferred
   and picked **debounced regen of `_map.md` on atom writes (2s
   coalesced)** using the existing `loop.regenerateMap` machinery —
   same user-visible "feels in sync" outcome, no new table/backfill/
   audit. Applies to personal AND org. Details in §4. (Pragmatist
   review: matches the search-plan precedent of fields-not-tables.)
2. **Multiple Owners** allowed — survives an Owner leaving.
3. **Rename / accent: Owner-only.** Round-1 picked "Admin+"; round-2
   cut the Admin role entirely (Admin and Owner differed on exactly
   one row, and multiple-Owners covers the use case). Two roles only:
   Owner / Member. Rename is naturally Owner-only.
4. **Personal atoms in an org chat: NOT in v1.** Hard workspace
   boundary; copy-paste is the workaround. V2 revisits via
   personal→org atom promotion.
5. **New-org seeding:** starter `company.md` + dashboard, mirroring
   personal onboarding (via the workspace-kind branch in
   `onboarding.progressOf` + the agent prompt, §8).

---

## 16. Rough sequencing

1. `convex/schema.ts` — **extend** `orgs` (`accent`, `workosOrgId`,
   `status`), **extend** `memberships` (widen `role` to
   `'owner'|'member'`, add `status`/`invitedBy`/`invitedAt`/
   `acceptedAt`), atom field additions (`editingBy`/`editingUntil`/
   `lastEditedByUserId`). **No new tables.**
2. `convex/auth.ts` — `requireWorkspace(ctx, active?)`, default-to-personal
   for most callers, throw on `active === undefined` for the four
   non-defaultable surfaces (§5).
3. WorkOS sign-in reconcile: idempotent membership sync into
   `memberships`; fail-closed on revoked-in-WorkOS.
3a. Debounced `_map.md` regen: per-workspace 2s coalesced
    `ctx.scheduler.runAfter` from the shared atom-write helper; extend
    `_upsertSystem` with `skipTrash: true` for the map path; keep
    `regenerateMap`'s `source !== 'agent'` guard.
4. `convex/orgs.ts` — `org.create`, `org.invite`, `org.acceptInvite`,
   `org.removeMember`, `org.changeRole`, `org.list` (for the switcher).
5. WorkOS Organizations wiring (server) + invite callback route.
6. Per-mutation refactor: thread `activeWorkspaceId` arg through the
   public surface (atoms, folders, skills, agent send, etc.).
7. Router: `/w/<workspaceId>/p/<atomId>` shape; `_app` layout reads it.
8. UI: workspace switcher, Members admin page, provenance pill in
   agent responses.
9. Edit conflict: `atoms.editingBy/Until` (on-open + on-save + on-focus,
   **no heartbeat**), `baseBody`-based revision check at save, conflict
   resolve UI (your / latest / save-as-copy).
10. Onboarding workspace-kind branch: `progressOf` + agent prompt
    branch by `workspaces[kind].identityAtomPath` (`me.md` for personal,
    `company.md` for org).
11. Tests: cross-tenant isolation × every retrieval surface; role
    matrix; `requireRole` audit-by-grep; edit-conflict + lease-expiry;
    workspace-switcher data hygiene; thread isolation; agent provenance;
    non-defaultable-surface enforcement.
12. (Later) V2/V3 per §12.

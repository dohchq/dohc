# Org integration — decisions

Resolved in the planning session for `docs/development/org-plan.md`.
Two decisions were refined in **round 2** (review pass: Codex +
codebase-verifier + pragmatist). The refinements preserve the
user-visible outcome but swap a simpler implementation in.

## 1. `_map.md` refresh cadence (personal + org)
**Decided (round 2): debounced full-regen on every atom write, 2s
coalesced per workspace, reusing `loop.regenerateMap` (extended with
`skipTrash: true` so the trash table doesn't bloat).** The
user-visible outcome — "feels in sync, push-based, faster than weekly,
for personal too" — is preserved.

The round-1 choice ("straight to V2 — `mapEntries` indexed table") was
demoted to **V2-deferred**. Both Codex and the pragmatist flagged it
as scope-creep relative to the search-plan precedent (which adds
fields, not tables): the debounced approach achieves the same UX with
no new table, no audit-by-grep, no `_backfillMapEntries`, no write-site
threading. Promote if/when a workspace's regen time becomes
user-visible (almost certainly not at v1's scale).

## 2. Org Owners
**Decided: multiple Owners allowed.** Survives a single Owner leaving.
Last-Owner removal refused server-side.

## 3. Org rename / accent edit
**Decided (round 2): Owner-only.** The Admin role was cut entirely in
round 2 (Admin and Owner differed on exactly one row in the role
matrix — workspace deletion — and multiple-Owners already covers
shared admin work). v1 has **two roles: Owner / Member**. Rename
becomes Owner-only as a consequence of that simpler model. The spirit
of the original decision ("rename is restricted, not all members") is
preserved.

## 4. Personal atoms in an org agent thread
**Decided: NOT in v1 — hard workspace boundary.** The agent in an org
workspace knows only org content; the agent in a personal workspace
knows only personal content. No `threadAttachments`, no `@`-shortcut,
no cross-workspace retrieval. If a user needs personal context in an
org chat, they copy-paste the text into the prompt (a user-initiated,
visible action — not a structural bridge). Codex agreed:
*"Maybe allow 'share personal atom into org' later, but I would not
make that v1's centerpiece."*

V2 will likely solve the real underlying need via the **promote-atom**
flow (one-shot move from personal → org), not per-thread attachments.

## 5. New-org seeding
**Decided: starter `company.md` + dashboard, mirroring personal
onboarding.** Org begins with the same shape personal does — a real
identity file and a starter page — so the agent has something to read
on day one. Implementation: `onboarding.progressOf` + the agent's
onboarding system prompt gain a workspace-kind branch (org →
`company.md`; personal → `me.md`).

---

## Round-2 architectural reconciliations (no new user decisions —
structural fixes folded directly into the plan)

- **Existing schema is the foundation.** The plan now extends the
  existing `orgs` + `memberships` + `atomShares.granteeOrgId` scaffold
  in `schema.ts:129-410` (the Phase 0 scaffold whose own comment says
  "NO readers until Phase 3" — this *is* Phase 3) instead of
  introducing parallel `workspaces` + `workspaceMembers` tables.
- **`orgs._id` IS the org's workspaceId** (a Convex string foreign key
  for `atoms.workspaceId`). The round-1 "_id == WorkOS subject" claim
  was impossible — Convex auto-generates `_id`.
- **`threadRefs` becomes workspace-keyed** (one thread per
  workspace-per-user, not one per user); existing rows remain valid
  (they're personal threads keyed by the user's WorkOS subject ==
  personal workspaceId).
- **Four retrieval surfaces are non-defaultable** —
  `queries.evalQueryBlocks`, `formulaEval.evalFormulas`,
  `htmlAtoms.getRenderable`, agent thread surface — they MUST require
  an explicit `activeWorkspaceId`. Defaulting to personal in those
  paths would silently render org content against personal data.
- **Editing: drop the 10s heartbeat.** Open + save + focus-regain lease
  writes only; `baseBody` (not `updatedAt`) is the revision-check
  primitive (the codebase already learned this — `atoms.ts:454`).
- **Skill execution scope** is explicit in §8: Owner-installed code
  runs under the invoking member's session but its writes pass through
  `requireRole`, recording the *invoking* user's id for provenance.

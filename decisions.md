# Org integration — decisions

Resolved in the planning session for `docs/development/org-plan.md`.
Two decisions were refined in **round 2** (review pass: Codex +
codebase-verifier + pragmatist). The refinements preserve the
user-visible outcome but swap a simpler implementation in.

## 1. Workspace map
**Superseded for MVP: remove `_map.md` generation and refresh machinery.**
The MVP agent should navigate with explicit tools (`list_atoms`, search,
`read_atom`, recents/source citations) plus the canonical context atoms
(`.context/me.md`, `.context/company.md`, `.context/intent.md`) instead
of a generated workspace map.

The earlier debounced `_map.md` plan sounded aligned with the AI OS
inspiration, but it did not prove enough value for MVP-sized workspaces
and created a generated artifact agents could over-trust. Revisit later
only if real usage shows navigation failures at scale; the likely future
shape is a database-backed context router, not a large text map.

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

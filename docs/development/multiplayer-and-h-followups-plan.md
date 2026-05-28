# dohc next-phase plan — multiplayer, AI collaboration, and H-* followups (v2)

Status: revised v2 after a 5-reviewer round-2 review (Codex, Plan agent, Karen, Pragmatist, Jenny). Companion to `org-plan.md` (Phase 3 org-tenancy; landing).
Audience: dohc team + implementing engineers; structured so each phase is its own PR.

> **Supersession note:** Any generated `_map.md` / map regeneration items
> in this older plan are no longer MVP direction. See `decisions.md`.
> **Round-2 review changes + user decisions (this revision absorbs):**
> 0. **One single PR, not 6-7 splits** (user decision after the round-2 review). The phase labels below are work-sequencing aids inside one ship, not separate review units. ~13-18 weeks of work landing as one drop, opened against `main` once `feat/orgs-tenancy` (PR #1) merges.
> 0a. **NEW Phase P1 — Notion-full per-atom + per-folder access controls** (user decision after the multiplayer plan). Org workspaces stay "everyone sees everything by default," but every atom + folder gets a per-page access toggle (private / restricted-to-list / org-default). Lands BEFORE multiplayer because cursor presence + AI visibility need to be access-aware from the start. Owners do NOT bypass restrictions. Departed members' private atoms tombstone with Owner recovery.
> 1. **Transport decision deferred to a spike.** `@convex-dev/prosemirror-sync` (a first-party Convex Component) does most of what the y-websocket plan proposed — without the new Node service, custom auth, or 2 Codex BLOCKERS. New PR #0 is a 1-2 day spike to validate against dohc's custom node types; transport is locked in based on the spike outcome.
> 2. **Suggestions become DECORATIONS + sidecar table, NOT custom ProseMirror nodes.** Matches dohc's existing pattern (inline atoms, wikilinks, formulas) and survives markdown projection.
> 3. **M4 cross-workspace AI-to-AI cut from this plan.** Deferred to v2; the user's ask is real but the proposed M4 delivered only coexistence-plumbing, not a participation protocol.
> 4. **M3 scoped to chat-driven only.** `@dohc` inline + palette deferred to follow-up PRs.
> 5. **H-5 "Awareness dissolves editingBy" is wrong** — Yjs Awareness is ephemeral. Replaced by an explicit Convex-mirror-of-presence pattern that preserves the file-tree "X is editing this page" promise.
> 6. **Codex BLOCKERS addressed in transport choice or auth design:** view-only role enforcement, edit-loss-on-WS-crash, signed delegated-agent token, cost caps beyond tokens, ydocBinary schema/version + escape hatch.
> 7. **H-1 substitution surface is 5+ not 3** — and includes tool descriptions the SDK serializes separately.
> 8. **H-2 keeps agent kickoff in v1** (was demoted to v1.5; would have shipped orgs with literal-stub onboarding).
> 9. **R1 covers `/r/<atomId>`** explicitly (was missing).
> 10. **W1 stops calling itself "fail-closed"** (it's fail-eventually-closed; pull-on-sign-in + periodic reconcile for org-sensitive paths).
> 11. **Timeline tripled** (Karen's reality check): pre-multiplayer is 3-4 weeks, multiplayer is 6-8 weeks if prosemirror-sync wins the spike, 10-12 weeks if y-websocket does.

---

## §0 Why this doc exists

The org-tenancy review pass (5 reviewers) found seven substantial items Jenny flagged as v1 gaps and three small followups. We applied the critical and high fixes in the org-tenancy PR; the rest are tracked here as **H-1..H-7** + **F-1, F-2**.

User pushback while reviewing the H-list: **"H-4 (revision check) and H-5 (presence) — can't we have real multiplayer like Notion / Google Docs? AIs should be participants, including AI-to-AI across workspaces."**

That reframing is right. H-4/H-5 are the floor; multiplayer is the ceiling and subsumes both. AI-as-participant is novel and uniquely-dohc.

This doc covers (in order of execution): **R1** (URL routing) → **A1+A2** (org agent + seed) → **W1** (WorkOS reconcile) → **PR #0 transport spike** → **M1+M2 combined** (Y.Doc storage + multiplayer humans) → **M3** (AI as collaborator, chat-driven). M4 (cross-workspace AI-to-AI) cut from this plan; F1+F2 land opportunistically.

---

## §1 Scope + work sequence (single PR)

**Per user decision (round-2 review): all of this lands in ONE PR**, not split. The phase labels below are work-sequencing aids (the order things should be built in), not separate ship units.

**Internal work sequence**:

| # | Phase | What | Realistic effort |
|---|---|---|---|
| 1 | R1 | URL-based workspace routing (`/w/<wsId>/...`); H-6 | **1-1.5 weeks** (Karen) |
| 2 | A1+A2 | Workspace-kind agent prompt + `createOrg` seeds `company.md` + agent kickoff; H-1+H-2 | **3-5 days** |
| 3 | W1 | WorkOS membership reconcile on sign-in + periodic; H-7 | **2-3 days** |
| 4 | **P1** | Per-atom + per-folder access controls (Notion-full). Org-default-public + private/restricted opt-ins. Folder restrictions cascade to atoms. Owners do NOT bypass. Lands before multiplayer so cursor presence + AI visibility are access-aware from the start. | **3-4 weeks** |
| 5 | Transport spike | 1-2 day investigation: does `@convex-dev/prosemirror-sync` work for dohc's editor (custom nodes, frontmatter/sourceMode, cross-workspace auth)? Output: `docs/development/transport-spike-result.md`. Spike code is throwaway — only the decision doc commits. | **1-2 days** |
| 6 | M1+M2 | Live editing + multiplayer humans (access-aware), per spike outcome | **3-4 weeks** if prosemirror-sync; **5-6 weeks** if y-websocket |
| 7 | M3 | AI as collaborator (chat-driven only — `@dohc` inline + palette deferred). Suggestions as decorations + sidecar table. Access-aware. | **4-6 weeks** (Karen: M3 is "AI collaboration as a product"; not a 1-week chunk) |
| 8 | F1+F2 | Stream-orphan-on-switch (mandatory after R1) + double-click create-org lock | Hours; folded in |

**Single PR implications:**
- ~10-14 weeks of work landing as one drop. Diff will likely be 5K-10K lines.
- No incremental review checkpoints — the whole arc is built before any of it merges. Mitigation: keep commits clean and atomic per phase so the diff is reviewable commit-by-commit even if it lands as one PR.
- Self-review (per the existing 5-agent pattern) at the END of the arc rather than between phases.
- Branch: opens against `main` once `feat/orgs-tenancy` (PR #1) lands first. The org-tenancy work is review-ready as-is and doesn't need to wait.

**Cut from this plan:**
- **M4 (cross-workspace AI-to-AI)** — defer to v2. User's ask is real but the v1 design delivers only coexistence-plumbing; a real participation protocol (how does workspace B's AI get invited; how do two AIs see/react to each other's suggestions) is a separate product question.
- **`@dohc` inline trigger** — defer post-M3. Brings back the cursor-coexistence problem (other collaborators see the typed `@dohc summarize this section` as live text before it's consumed) that suggestion-overlay claimed to dissolve.
- **Palette suggest command** — defer post-M3.
- **v1.5 raw-edits opt-in** — cut entirely. Was architectural debt waiting to happen.
- **`atomBlockAuthors` sidecar table** — cut. Per-block authorship from Yjs clientID is too weak for audit anyway (Codex); use server-signed transaction metadata if real audit is needed.

**Realistic total:** ~12-14 weeks for everything in this plan if `@convex-dev/prosemirror-sync` wins the spike; ~16-18 weeks if y-websocket does.

---

## §2 Architectural decisions

### Decision A — CRDT model: open until the spike

The doc's original Decision A (Yjs) is now **open**. PR #0 (transport spike) evaluates two candidates:

1. **`@convex-dev/prosemirror-sync`** — first-party Convex Component. ProseMirror's native OT (`prosemirror-collab`) over Convex subscriptions. Native Convex auth, server-side AI editing via `prosemirrorSync.transform()`, no new infrastructure.
2. **Yjs + y-websocket** (the doc's original choice). CRDT with Awareness protocol; richer offline story (IndexedDB persistence later, peer-to-peer possible); requires a Node service + bespoke auth + 2 Codex BLOCKERS to solve.

**The spike decides.** For prose at dohc's use case (paragraph-level concurrency, no offline-first requirement, no peer-to-peer), OT is sufficient. The "Yjs is the de-facto" framing in v1 of this doc overstated necessity for our use case.

### Decision B — Transport: per spike outcome

- **If `@convex-dev/prosemirror-sync` wins:** no new infrastructure. Convex subscriptions stream incremental ProseMirror steps. Auth via `checkRead`/`checkWrite` natively. Codex's two BLOCKERS dissolve (view-only enforcement and edit-loss-on-crash both become Convex's standard guarantees). Most of the §10 risks shrink.

- **If y-websocket wins:** Convex `apps/ws/` Node service + `/api/wsAuth` HTTP action. Plus all of the items below to address Codex's BLOCKERS:
  - **Per-message auth, not just per-upgrade.** Awareness leak risk otherwise.
  - **Token refresh / share-revocation channel.** WorkOS tokens are 5-10min; share revocation has no signal today.
  - **WAL or persistent provider.** Edits acked to clients but not yet snapshotted to Convex must not be lost on WS crash.
  - **Custom server path that rejects updates from `role: 'view'` clients.** Plain `y-websocket` doesn't enforce read-only.
  - **Local dev story.** Adds a third process to `pnpm dev`; needs port assignment + local cert.
  - **Horizontal scaling.** Y.Doc lives in WS process memory; two users on different instances = no shared state. Sticky sessions or Redis pubsub.
  - **`v.bytes()` 1MB hard cap (Convex).** Y.Doc binary grows with history. Need GC (`gc:true`) + periodic state-vector rebases.

### Decision C — Storage model: markdown canonical + persistence sidecar + escape hatch

The atom body **stays as markdown.** All of dohc — search, queries, formulas, agent tools, `/r` route, sharing, capture — assumes markdown. Switching the canonical would be a rewrite.

**New sidecar table** (Convex):
```ts
atomDocs: defineTable({
  atomId: v.id('atoms'),
  // If prosemirror-sync wins: the Component manages this; sidecar may be unused.
  // If y-websocket wins: ydocBinary lives here (with the 1MB cap caveat).
  state: v.bytes(),                          // ≤1MB; GC'd Y.Doc state or PM steps
  stateVersion: v.number(),                  // schema version stamp
  serializerVersion: v.number(),             // markdown serializer version
  checksum: v.string(),                      // body integrity check
  lastSnapshotAt: v.number(),
}).index('by_atom', ['atomId'])
```

**Save flow:** editor projects to markdown via Milkdown's serializer + upserts `atoms.body` AND `atomDocs` atomically. If the projection fails round-trip validation (see below), the save is rejected with a clear error.

**Round-trip acceptance test for M1** (idempotency, mandated by Plan agent):
```
serialize(parse(serialize(parse(md)))) === serialize(parse(md))
```
…across a fixed corpus covering EVERY existing custom node type: frontmatter, inline atoms `{key: value}`, formula blocks `{=...}`, query fences ` ```query `, wikilinks `[[path]]`, ASCII sketch blocks, HTML blocks, tables, `_map.md` system content. **If any construct fails idempotency, M1 is not done.**

**Frontmatter** (Plan agent's blocker on the original v1):
- Crepe has no remark-frontmatter; current solution (`atomId.ts:73-75`) peels off frontmatter, renders only `rest` in Crepe, byte-exact reattaches on save.
- **Y.Doc cannot contain the frontmatter bytes.** New rule: **the Y.Doc tracks only the `rest`; frontmatter is a separate field on the atom edited via a dedicated mutation.** Live editing and sourceMode-editing-frontmatter cannot race.

**Source mode** (raw textarea editor at `AtomView.tsx:414-427`):
- Used for frontmatter id editing + HTML atoms.
- During sourceMode: Y.Doc-bound Crepe is unmounted. On exit, the body commits via the standard mutation, and the Y.Doc is **rebuilt from the new markdown** (deterministic, idempotent — guaranteed by the round-trip acceptance test).
- This is the **escape hatch** Codex flagged as missing: any divergence between `atomDocs.state` and `atoms.body` is resolved by trusting `atoms.body` and rebuilding the state from it.

**Read flow:**
1. Editor opens. Query returns `{atom, atomDoc?}`.
2. If `atomDoc` exists AND `atomDoc.serializerVersion === current`: load the state directly.
3. Else (no state row, or version drift, or corruption): rebuild state from `atoms.body`. First save lands the state row.

**No data loss on schema/serializer upgrade:** the rebuild path always works because markdown is canonical.

### Decision D — AI as collaborator: decorations + sidecar (NOT a custom ProseMirror node)

The original v1 proposed a custom `suggestion` ProseMirror node. Plan agent identified this as the **showstopper for "markdown canonical"** — where do suggestion nodes serialize to in markdown?

**Revised model** (matches dohc's existing pattern for inline atoms, wikilinks, formula widgets, query result widgets):

1. **Sidecar table `atomSuggestions`:**
   ```ts
   atomSuggestions: defineTable({
     atomId: v.id('atoms'),
     suggestionId: v.string(),               // stable id for the suggestion
     originalRange: v.object({ from: v.number(), to: v.number() }),
     proposedText: v.string(),
     instruction: v.string(),                // debugging / re-explain UI
     authorWorkspaceId: v.string(),
     authorUserId: v.string(),
     authorIsAgent: v.boolean(),
     status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('rejected')),
     createdAt: v.number(),
     resolvedAt: v.optional(v.number()),
     resolvedByUserId: v.optional(v.string()),
   }).index('by_atom_status', ['atomId', 'status'])
   ```

2. **Stable block-id marks in the Y.Doc** (or PM doc if prosemirror-sync wins): each top-level block gets a stable id mark on creation; suggestions reference the mark.

3. **Decoration renderer:** ProseMirror plugin queries pending suggestions for the open atom, renders them inline as decorations (bubbles) with [Accept]/[Reject] buttons.

4. **Accept = atomic mutation:** insert `proposedText` at `originalRange`, mark suggestion `accepted`, record `resolvedByUserId`. Reject = mark suggestion `rejected`.

5. **Markdown projection unaffected.** The body serializes exactly as before; suggestions live in the sidecar.

6. **Cross-collaborator visibility:** the sidecar is a Convex query — all open editors of the atom see the same pending suggestions reactively (no Yjs / PM Plugin gymnastics for cross-session sync).

**Why this is better than the v1 custom node:**
- Survives markdown projection (Decision C unbroken)
- No Yjs/PM schema invention
- Reactive cross-collaborator sync via Convex's standard pattern
- Server-authoritative state (accept/reject are mutations, not CRDT ops — no concurrent-accept double-insert bug Codex flagged)
- Matches dohc's existing decoration pattern (inline atoms, formulas)

### Decision E — Provenance: server-signed transaction metadata; "last-editor" labeling

Original v1 proposed walking Yjs history per snapshot to attribute each block. Codex: **clientIDs are ephemeral; edits move/rewrite content; "latest contributor" ≠ authorship.**

**Revised:**
- **Accepted suggestions are append-only audit records.** The `atomSuggestions` row (Decision D) IS the audit trail: it carries `authorWorkspaceId/UserId/IsAgent`, `resolvedByUserId`, `proposedText`, timestamps. Server-side mutation = server-signed.
- **Atom-level fields** (`lastEditedByUserId`, `lastEditedByAgentOfUserId`) are explicitly labeled **"last editor"** (not "author"). Set on every save; surface in UI as a non-authoritative signal.
- **No `atomBlockAuthors` sidecar table** in this plan. If real per-block authorship is ever needed, build it from the `atomSuggestions` accept history (the only authoritative source).

### Decision F — Provenance in chat: plain text in v1

Original v1 specified a clickable pill ("→ edited dashboard.md @ 14:23 · 2 paragraphs") with deep-link + scroll-to-edit + highlight-range. Multiple reviewers (pragmatist, Karen) flagged this as a new affordance with no demand signal.

**Revised:** v1 = plain-text reference in chat ("Suggested an edit in dashboard.md"). The pill becomes a follow-up after the suggestion flow is validated.

### Decision G — Cross-workspace auth: per-message check + signed delegated-agent token

**Original v1 had three Codex HIGHs around this.** Revised model:

- **Per-message authz, not just on connection.** Whether prosemirror-sync (every step query is gated by `checkRead`/`checkWrite`) or y-websocket (every Yjs update message → re-check) — never trust the upgrade-time decision through a long-lived session.
- **Signed delegated-agent token for AI participants.** A WorkOS JWT identifies a human; an agent acting on behalf of a workspace needs a different principal. Define a Convex-signed token carrying `{ actorKind: 'agent', userId, workspaceId, scopes, expiry }`. The auth gate (whether `checkRead` or `/api/wsAuth`) accepts BOTH JWT-shape and agent-token-shape, resolves to a principal, then evaluates `resolveShareAccess`.
- **Token refresh story for y-websocket path** (only): the WS connection re-validates on token-near-expiry; sends a `force-disconnect` on expired or revoked.
- **Active-workspace switch mid-session:** the URL change (R1) propagates a new `activeWorkspaceId`; the gate re-evaluates membership on the next message.
- **Cross-workspace share revocation:** Convex emits an event (via internal action subscribed by the auth gate) that invalidates the cached permission. If prosemirror-sync wins: this is automatic via reactive `checkRead` re-runs. If y-websocket wins: need an explicit invalidation channel.

### Decision H — AI participation mode: suggestion overlay only

v1 is **suggestion overlay** (Decision D). **Raw-edits opt-in CUT from this plan** (was v1.5; reviewers flagged it as architectural debt waiting to happen).

If users ever ask for raw mode later, evaluate then. The decoration+sidecar model could support it (skip the suggestion row; apply the edit directly to `atoms.body`), but adding the toggle today is speculative.

### Decision I — URL routing: `/w/<wsId>/...` with `me` sentinel; covers `/r/<atomId>`

URL paths:
- `/w/<wsId>/p/<atomId>` — open atom
- `/w/<wsId>/shared/<shareId>` — open shared atom
- `/w/<wsId>/r/<atomId>` — **HTML render route** (Jenny: was missing from v1)
- `/w/<wsId>` — workspace home

**`me` sentinel** for personal workspace: `/w/me/p/dashboard` (stable across browsers; cleaner than the WorkOS subject id).

**`/r/<atomId>` cross-tenant fix:** the route reads `wsId` from the URL params and passes `activeWorkspaceId` to `htmlAtoms.getRenderable` per the org-tenancy work already in place. Legacy `/r/<atomId>` (no `/w/<wsId>/` prefix) redirects to `/w/me/r/<atomId>`.

**Legacy redirects:** `/p/<atomId>` → `/w/me/p/<atomId>`; `/shared/<shareId>` → `/w/me/shared/<shareId>`; `/r/<atomId>` → `/w/me/r/<atomId>`.

**`useActiveWorkspaceId`** becomes a thin pass-through over route params. localStorage stays as a fallback for empty-path landings only.

### Decision J — WorkOS reconcile: pull on sign-in + periodic; honest fail-mode language

**Original v1 called this "fail-closed."** Codex: **overstated.** Reconcile is fire-and-forget; errors keep current memberships; a user removed in WorkOS retains access until next sign-in.

**Revised model:**
- **Pull on every sign-in** via the AuthKit callback (per the original v1).
- **Periodic reconcile** (cron, e.g. every 4h) for org-sensitive paths — catches removals between sign-ins for users with long-lived sessions.
- **On-access reconcile** for the org-write paths (`createOrg`, `removeMember`, `changeRole`) — these refresh the caller's membership before authz.
- **Honest naming:** **"fail-eventually-closed."** A user removed in WorkOS loses access at the earliest of: next sign-in, next periodic reconcile (≤4h), next org-write op. NOT instantaneous.
- **Sign-in blocking** option for WorkOS-backed orgs: if `_reconcileMembershipForCaller` fails during sign-in, block the redirect with a "could not verify org memberships" error. (Configurable; default off because it makes sign-in flaky during WorkOS outages.)

### Decision K — Workspace-kind system prompt: ~5+ substitution points + tool descriptions

v1 said "~3 substitution points." Jenny grepped the actual prompt and found 5+:
- `agent.ts:104` — "build and maintain ONE user's workspace"
- `:134` — "vault MUST contain a populated dashboard AND a me.md"
- `:141` — "me.md — a PORTABLE identity atom"
- `:199` — "Show me.md back in one line"
- `:206` — "AND me.md: call finish_onboarding"
- `:587` — `finish_onboarding` tool description: "populated dashboard AND me.md (never end empty)"
- `:600` — `set_lock` tool example: `"lock me.md", "unlock my plan"`

**A1 must rescan the entire 444-line prompt + every tool description for personal-only language.** Substitution mechanism (per the agent SDK's `instructions:` callback) is sound; the scope is bigger than v1 claimed.

### Decision K' — AI invitation surfaces (per user decision Q2; revised scope)

**v1 ships ONLY the chat-driven path.** Existing chat-driven AI edits get refactored from "silent `write_atom` whole-body swap" to "create `atomSuggestions` row → renders as bubble decoration → user accepts/rejects".

**Behavior migration callout** for solo chat users (today's silent whole-doc swap is muscle memory):
- Feature flag for the first release; default on for new workspaces, opt-in for existing.
- In-product callout the first time a suggestion bubble appears: "dohc now proposes changes here; click Accept to apply."
- Two-week observation window before flipping to default-on for all.

**`@dohc` inline trigger + palette command:** explicitly deferred. Multiple reviewers flagged them as separate features in their own PRs, AND the `@dohc` inline trigger reopens the cursor-coexistence problem suggestion-overlay claimed to dissolve.

### Decision L — `createOrg` seeds `company.md` + dashboard + AGENT KICKOFF (in v1)

Original v1 had agent kickoff at "Optional v1.5." Jenny: this ships orgs with a literal stub + no tailored starter (existing personal flow has a 10-min-wow questionnaire kickoff).

**Revised:** v1 kickoff IS in scope. After `createOrgWithBridge` inserts the row + seeds `company.md`/`dashboard.md`/`onboarding` row, the dialog navigates the user to `/w/<orgId>/p/<companyMdFileId>` AND auto-fires `agent.startOnboarding({activeWorkspaceId: orgId})` so the agent welcomes the team. The agent uses Decision K's workspace-kind branch automatically.

---

## §3 Multiplayer phases (M-track)

### PR #0 — Transport spike (1-2 days, blocks all M-PRs)

**Goal:** decide Decision A/B with empirical data, not whiteboard reasoning.

**Spike work:**
1. Stand up a minimal test against dohc's current AtomEditor:
   - Wire `@convex-dev/prosemirror-sync` to Milkdown's Crepe preset.
   - Verify it works with our **custom nodes** (inline atoms decorations, wikilinks, formula widgets, query block widgets).
   - Verify it survives **frontmatter** (per Decision C: frontmatter lives outside the synced doc).
   - Verify **sourceMode** can unmount/remount cleanly.
   - Try a 2-tab edit session; verify cursor presence + concurrent paragraph edits.
   - Try a server-side edit via `prosemirrorSync.transform()` (the foundation for M3 AI suggestions).
2. Compare against the Yjs + y-websocket path (Decision A/B alternative): does any feature gap warrant the Node service + custom auth + 2 Codex BLOCKERS?

**Decision matrix (out of the spike):**
- Round-trip idempotency: which serializer round-trips cleanly?
- Auth fit: which integrates with `resolveShareAccess` more naturally?
- AI editing fit: which makes server-side suggestion writes cleaner?
- Ops surface: zero (prosemirror-sync) vs one (y-websocket) vs Hocuspocus.
- Failure modes: Codex BLOCKERS dissolve in option A?

**Output:** a spike doc (2-3 pages) committed to `docs/development/transport-spike-result.md` with the decision + 1-paragraph rationale. Subsequent M-PRs follow this.

### PR M1+M2 (combined) — Live editing + multiplayer humans

**Combined intentionally** — M1 alone has no user-facing signal; couple with M2 for verification (pragmatist + Karen).

**Per spike outcome:**
- **If prosemirror-sync:** install + bind to Milkdown; configure `checkRead`/`checkWrite` against `resolveShareAccess`; presence via the component's awareness story.
- **If y-websocket:** stand up `apps/ws/` Node service per Decision B's expanded checklist (per-message auth, WAL, view-only enforcement, GC, horizontal scaling story, local dev script).

**Round-trip work (the load-bearing M1 effort per Plan agent + Karen):**
- Validate idempotency across the dohc custom-node corpus (Decision C's test).
- Carve out frontmatter (separate field; never in Y.Doc / synced doc).
- Carve out HTML atoms (`type: html` renders via iframe, not the editor; no sync needed).
- Carve out source-mode (unmount/remount + deterministic rebuild from markdown).

**Presence + H-5 honoring** (Jenny's correction):
- Awareness/transport presence shows cursors INSIDE the editor for live collaborators.
- **PLUS** a Convex-side `atomPresence` table: `{atomId, workspaceId, userId, lastSeenAt}`. The editor writes a row on open + heartbeats every 30s; row expires after 90s. **The file tree subscribes** to show "Alex is editing this page" cross-session — the persistent signal H-5 actually promised, which neither Awareness nor `checkRead`-style state covers.
- The schema fields `editingBy`/`editingUntil` from Phase A are REPURPOSED into this — no zombie storage.

**Acceptance:**
- Two browser sessions on same atom: both cursors visible, edits stream within ~100ms.
- File tree shows "Alex is editing" while Alex has the editor open; clears within 90s of close.
- Round-trip idempotency passes across the corpus.
- View-only shared user CANNOT submit edits (Codex BLOCKER 1).
- WS / Convex restart does not lose acknowledged edits (Codex BLOCKER 2).

### PR M3 — AI as collaborator (chat-driven only)

**Scope:** existing chat-driven AI edits get refactored from `write_atom` (silent whole-body swap) to `suggest_in_doc` (creates `atomSuggestions` row → decoration bubble in editor → user accepts/rejects).

**Out of scope for M3:** `@dohc` inline trigger; palette command; cross-workspace AI-to-AI (that was M4, now cut).

**Implementation:**
- New agent tool `suggest_in_doc({ atomId, originalRange, proposedText, instruction })` — privileged, Owner-gated in orgs (re-uses `ownerWorkspaceFromTool` from the org-tenancy PR).
- Tool handler runs as Convex action, calls internal mutation that inserts the `atomSuggestions` row. **No** long-lived WS connection from the action (Plan agent: action V8 isolate is restrictive about long-lived I/O).
- New ProseMirror plugin: subscribes to `api.atomSuggestions.listPending({atomId})`, renders decoration bubbles at the marked positions. [Accept] / [Reject] buttons fire mutations.
- **Behavior migration:** feature-flag the first release per Decision K'.

**Cost caps** (Codex HIGH 4):
- **Per-turn**: hard cap on number of `suggest_in_doc` calls (e.g. 5) AND total proposed chars (e.g. 5000) AND touched ranges (no overlapping suggestions on the same block).
- **Per-day-per-workspace**: soft warning at 50 suggestions / 50K chars; configurable per workspace.
- **Prompt-injection guard**: an agent that tries to fire 100 `suggest_in_doc` calls hits the per-turn cap and the rest are silently truncated + logged.

**Signed delegated-agent token** (Codex HIGH 2):
- Agent's internal mutation runs with a Convex-signed delegated-agent token (per Decision G), recorded in the `atomSuggestions.authorIsAgent` field.
- Audit log: every accepted suggestion's `resolvedByUserId` proves it was a HUMAN action (not the agent self-accepting).

**Acceptance:**
- Chat: "rewrite intro" → bubble appears in dashboard.md; accept inlines text; reject removes the bubble.
- Two users editing same doc: both see the same bubble; either can accept; the other's UI shows "accepted by Bob 2s ago" then fades.
- Prompt-injection corpus: agent attempting >5 suggestions in one turn has the rest dropped.

### M4 — CUT from this plan

Cross-workspace AI-to-AI: deferred to v2. **The v1 design delivered coexistence-plumbing, not a participation protocol.** Specifically missing:
- How does workspace B's AI get invited to a doc shared from A? (Decision K's invitation surfaces are all human-fronted from the CALLER's workspace.)
- How does A's AI see / react to / build on B's AI's suggestions?
- Per-block authorship across tenants is weak provenance per Codex.

When demand emerges, design these explicitly as their own track.

---

## §4 Org agent + seed (Phases A1–A2; H-1 + H-2)

### Phase A1 — Workspace-kind-aware system prompt (H-1)

Convert `SYSTEM_PROMPT` to a builder via the agent SDK's `instructions:` callback (Decision K).

**Substitution scan must cover** (rescan in PR; v1's "~3" was wrong):
- Identity atom path: `me.md` ↔ `company.md`
- Space descriptor: "your vault" ↔ "the {orgName} workspace"
- Identity descriptor: "a personal brief about you" ↔ "the {orgName} company brief"
- Onboarding pivot text: 5+ instances in the prompt body + 2+ in tool descriptions
- Tool descriptions: `finish_onboarding`, `set_lock` examples currently literal `me.md`

**Tests:** personal vs org workspace produces distinct prompts with the right identity-atom + descriptor text; existing agent tests pass under both.

### Phase A2 — `createOrg` seeds `company.md` + dashboard + AGENT KICKOFF (H-2)

`createOrgWithBridge`, after Convex insert + WorkOS sync:
1. `runMutation(internal.orgs._seedNewOrg, {orgId})` inserts:
   - `onboarding` row for the new org.
   - Starter `company.md` (with org name pre-filled).
   - Starter `dashboard.md` with a query block listing recent atoms.
2. **Dialog navigates** to `/w/<orgId>/p/<companyMdFileId>`.
3. **Auto-fires** `agent.startOnboarding({activeWorkspaceId: orgId})` — the agent welcomes the team into the new workspace, using A1's workspace-kind branch.

**Tests:** new org → `myWorkspaces` includes it → `atoms.list` shows seeded files → `onboarding.state` returns IN_PROGRESS → `progressOf` reports `hasMe: true` (company.md).

---

## §5 URL routing (Phase R1; H-6)

Routes (per Decision I):
- `apps/app/src/routes/_app.w.$wsId.tsx` — layout
- `apps/app/src/routes/_app.w.$wsId.index.tsx`
- `apps/app/src/routes/_app.w.$wsId.p.$atomId.tsx`
- `apps/app/src/routes/_app.w.$wsId.shared.$shareId.tsx`
- **`apps/app/src/routes/_app.w.$wsId.r.$atomId.tsx`** — explicitly included (Jenny: was missing in v1)

`useActiveWorkspaceId` becomes a route-params pass-through. `setActiveWorkspaceId` becomes `navigate('/w/<id>/...')`. localStorage stays only as the empty-path-landing fallback.

`me` sentinel resolution: a tiny loader call to `api.auth.whoami` (already exists; returns the caller's subject). One round-trip on first paint; cached in module memory for subsequent route changes.

**Legacy redirects:** `/p/$atomId` → `/w/me/p/$atomId`; `/shared/$shareId` → `/w/me/shared/$shareId`; `/r/$atomId` → `/w/me/r/$atomId`. Preserves bookmarks.

**F1 (stream-orphan-on-switch) becomes mandatory after R1.** The current localStorage-only model masked it; URL-driven switching surfaces it. Lift `chatBusy` state up; switcher reads it; clicking while busy prompts the abandon-confirm.

---

## §6 WorkOS reconcile (Phase W1; H-7)

Per Decision J (revised):

**Sign-in pull** (existing scope from v1):
- AuthKit callback fires `ctx.runAction(internal.orgsBridge._reconcileMembershipForCaller, {subject})`.
- The action calls `workos.userManagement.listOrganizationMemberships({userId: subject})`, lists every WorkOS org the user is in.
- Upsert Convex `memberships`: each WorkOS org → row with `status:'active'`; any existing Convex membership not in the WorkOS list → soft-remove.

**Periodic reconcile** (NEW per round-2):
- Convex cron every 4 hours.
- For each user with a recent session, run `_reconcileMembershipForCaller`.
- Bounds: rate-limit to N reconciles per minute; skip if WorkOS rate-limit returns 429.

**On-access reconcile** (NEW per round-2):
- The four org-write mutations (`createOrg`, `removeMember`, `changeRole`, `renameOrg`) re-fetch the caller's WorkOS memberships before authz when `WORKOS_API_KEY` is set.
- This is the "best-effort fail-closed" for org-sensitive paths — a Convex Owner whose WorkOS membership has been revoked discovers it on their next sensitive op.

**Honest naming:** **"fail-eventually-closed."** A user removed in WorkOS loses access at earliest of: next sign-in, next periodic reconcile (≤4h), next org-write op. NOT instantaneous.

**Tests:** mocked WorkOS list response with 2 orgs + Convex has 3 memberships → 1 soft-removed, 2 active. Periodic cron skips users with no recent session. Org-write op re-fetches even with valid session.

---

## §6.5 Per-atom + per-folder access controls (Phase P1; Notion-full)

**Why this lands before multiplayer:** cursor presence, AI visibility, and the WS auth gate all need to be access-aware from the start. Building multiplayer on "everyone sees everything" and retrofitting access later means redoing the cursor + WS gate + agent visibility work.

**Today's model** (before this phase):
- Personal workspace = only owner reads
- Org workspace = all active members read everything
- `atomShares` = explicit cross-workspace per-doc grants

**P1 adds:** every atom + folder in an org workspace gets an **access mode**. Default behavior is unchanged ("org-default" = visible to all org members). Users opt INTO restriction per atom/folder.

### Schema additions

```ts
// Sidecar tables; ABSENCE of a row means org-default (the common case).
// Sidecar pattern keeps query cost flat for the 99% of atoms that are org-default.

atomAccess: defineTable({
  atomId: v.id('atoms'),
  mode: v.union(v.literal('private'), v.literal('restricted')),
  ownerUserId: v.string(),
  allowedUserIds: v.array(v.string()),   // empty for 'private'; non-empty for 'restricted'
  setAt: v.number(),
  setByUserId: v.string(),
}).index('by_atom', ['atomId']),

folderAccess: defineTable({
  workspaceId: v.string(),
  folderPath: v.string(),                  // canonical folder path (e.g. "hr/sensitive")
  mode: v.union(v.literal('private'), v.literal('restricted')),
  ownerUserId: v.string(),
  allowedUserIds: v.array(v.string()),
  setAt: v.number(),
  setByUserId: v.string(),
}).index('by_workspace_path', ['workspaceId', 'folderPath']),

// Tombstoned private atoms (Member offboarding; see Decision P1-C below).
atomTombstones: defineTable({
  atomId: v.id('atoms'),
  workspaceId: v.string(),
  reason: v.union(v.literal('member-departed')),
  tombstonedAt: v.number(),
  originalOwnerUserId: v.string(),
  recoveredByOwnerUserId: v.optional(v.string()),
  recoveredAt: v.optional(v.number()),
}).index('by_workspace', ['workspaceId'])
```

### Decision P1-A — Folder access cascades; atom access overrides

Resolution function for "can user X read atom Y in workspace W?":

```
1. If X is not an active member of W → DENY (existing requireWorkspace gate)
2. Lookup atomAccess for Y:
   - If mode='private': allow iff X == ownerUserId.
   - If mode='restricted': allow iff X == ownerUserId OR X ∈ allowedUserIds.
   - If no row: continue to folder check.
3. Walk Y's folder path bottom-up looking for folderAccess rows:
   - Deepest folder with a folderAccess row wins.
   - Apply same private/restricted rule using that row's ownerUserId + allowedUserIds.
4. If no atom OR folder restriction found → org-default → ALLOW (X is an active org member).
```

Cascade example: a folder `hr/` is `restricted` to {Alice, Bob}. An atom `hr/employees.md` inherits the restriction (only Alice + Bob read it). An atom `hr/public-policies.md` could have its own `atomAccess` with `mode='restricted'` and `allowedUserIds: [...all members]` to make it visible despite the folder restriction.

### Decision P1-B — Owners do NOT bypass restrictions (user decision)

Org Owners get admin power for membership/role/billing, but NO special read access to private atoms. The `requireRole(ctx, ws, 'owner')` gate stays for member-admin ops; `resolveAtomAccess` does NOT consult role. Owners + Members are equal in the read-access layer.

**Future opt-in:** if a workspace later wants "admin search" or "compliance recovery," that's a v2 add-on — explicit per-workspace setting, not the default.

### Decision P1-C — Member offboarding: tombstone with Owner recovery (user decision)

When `removeMember` or `leaveOrg` runs (existing mutations from Phase A):
- The member's `private` atoms get a row in `atomTombstones` with `reason: 'member-departed'`.
- The atoms themselves are NOT deleted; their `atomAccess` row stays.
- Resolution function: an atom with a `member-departed` tombstone is INVISIBLE to everyone (Owners, Members, even the original owner if they rejoin) until an Owner explicitly recovers.
- New mutation `recoverTombstonedAtom({atomId, newAccessMode, newOwnerUserId?, allowedUserIds?})` — Owner-only, re-categorizes the atom. Audit log records the recovery.
- `restricted` atoms with the departed member as owner-not-removed: similar treatment if the owner field becomes vacant; if other allowed users remain, the access shifts to "owned by the next allowed user" with audit log.

### Mutations

```ts
// Public, member-only.
setAtomAccess({ atomId, mode: 'private'|'restricted'|null, allowedUserIds? })
// mode: null clears the override → atom reverts to folder/org-default.
// Only the current owner (or an Owner via override path) can call.

setFolderAccess({ workspaceId, folderPath, mode, allowedUserIds })
// Member-only. Folder access transfer-of-ownership has its own UX (out of scope here).

// Owner-only.
recoverTombstonedAtom({ atomId, newAccessMode, newOwnerUserId?, allowedUserIds? })
```

### Read paths that need filtering (the substantial work)

Every atom-read surface gains an access filter:

- `atoms.list` — exclude atoms the viewer can't read
- `atoms.getByPath` — return null if access denied
- `atoms.idAdvisory` — exclude
- `search.run` — exclude from results
- `queries.evalQueryBlocks` — exclude from query block results (a `docs.find()` query inside a public atom that touches a private atom returns the private atom as "withheld")
- `formulaEval.evalFormulas` — same (formulas referencing private atoms return null/withheld)
- `htmlAtoms.getRenderable` — return null if access denied (route returns 404)
- `atomShares.getSharedAtom` — cross-workspace share still works if granted, but the originating atom's access mode also gates (a private atom can be cross-shared by its owner; but if the owner removes themselves, the cross-share goes dark per the tombstone rule)
- Agent tools: `list_atoms`, `read_atom`, `search`, `get_atom_path`, etc. — all need to receive the viewer's userId + filter. **This means changing every agent tool to thread `viewerUserId` from experimental_context**, similar to how Phase B threaded `activeWorkspaceId`.
- File tree query (frontend): excludes hidden atoms + folders. The user just doesn't see them.
- `_map.md` generator: skips atoms the agent shouldn't include in the workspace map (the agent IS a user; uses its caller's identity for visibility)

### Write paths

`atoms.upsert`, `atoms.move`, `atoms.remove`, `atoms.setLock`, `atoms.setStar`, `atoms.setIcon`: gate on the same access rule (need read access AND owner-or-allowed to write). Folder mutations the same.

### UI surfaces

- **Per-atom Share button** (header of the editor): opens an `AccessDialog` similar to `ShareDialog` but for in-org restrictions. Toggles: "Org members (default)", "Private to me", "Specific people".
- **Per-folder Share affordance** (folder context menu): same dialog, applies to the folder.
- **File tree icons**:
  - Lock 🔒 = private
  - Limited 👥 = restricted
  - (No icon) = org-default
- **Search results**: same icons inline so users see why a teammate's restricted atom doesn't appear.
- **Tombstoned atoms surface for Owners**: a settings page or admin panel listing tombstoned atoms with "Recover" buttons (departed-member's atoms aren't surfaced in normal nav).

### Tests

- **Access matrix**: for each (atom-access-mode × folder-access-mode × viewer-role) combination, the resolution function returns the expected ALLOW/DENY.
- **Cross-tenant × access-restriction × every retrieval surface**: similar pattern to Phase F's audit. A non-allowed member CANNOT read a private atom via atoms.list / search.run / agent tools / etc.
- **Cascade**: folder-restricted → atoms inherit; atom-override → wins over folder.
- **Tombstone lifecycle**: removeMember → private atoms tombstoned → invisible to all → Owner recovery surfaces them with new access.
- **Cross-workspace shares interact correctly**: an atom can be both private-to-its-owner AND cross-shared via `atomShares`; access to the cross-share depends on the share permission, not the in-org access mode.
- **Audit-by-grep**: every public atom-read fn calls the access resolver before returning data.

### Realistic effort: 3-4 weeks

**Breakdown:**
- Schema + resolver function + tests: 3-4 days
- Backend read/write path filtering across all surfaces: 1-1.5 weeks (~30 surfaces, all need viewer-userId threading)
- Agent tool surface change (thread viewerUserId): 2-3 days
- UI: AccessDialog + file tree icons + tombstone admin panel: 1-1.5 weeks
- Tests: 3-4 days

---

## §7 Small followups (F1, F2)

### F1 — Stream-orphan-on-switch (ultrathink-debugger H3)

Per §5: becomes mandatory after R1 (URL routing surfaces the bug the localStorage model masked). Lifted chat-busy state + abandon-confirm dialog + `AbortController` plumbing through `sendMessage`.

### F2 — Double-click create-org lock (ultrathink-debugger H4)

`CreateOrgForm` uses `useRef<boolean>(false)` lock checked + set synchronously in `onSubmit`. Beats React's async setState.

Bundles with A2 or its own ~30min PR.

---

## §8 Realistic cost / scope estimate (post round-2 review)

| Phase | v1 doc claim | Realistic (round-2 + P1) | Notes |
|---|---|---|---|
| R1 URL routing | "moderate, 1 PR" | **1-1.5 weeks** | Inverts the workspace-context model (Karen) |
| A1+A2 | "moderate, 1 PR" | **3-5 days** | Prompt scan + seed flow + dialog navigate |
| W1 | "moderate" | **2-3 days** | Pull on sign-in + periodic cron + on-access |
| **P1** (per-atom + per-folder access) | (new) | **3-4 weeks** | ~30 read/write surfaces gain access filtering; agent tools thread `viewerUserId`; AccessDialog + file-tree icons; tombstone recovery flow |
| Transport spike | (didn't exist in v1) | **1-2 days** | Empirical decision; output is a decision doc commit |
| M1+M2 (combined) | "1 + 1 PR, large each" | **3-4 weeks** (prosemirror-sync) OR **5-6 weeks** (y-websocket) | Round-trip work + presence + view-only enforcement + persistence. Access-aware from start (per P1). |
| M3 (chat-driven) | "1 PR, large" | **4-6 weeks** (Karen) | Sidecar table + decoration plugin + agent tool + cost caps + behavior migration. Access-aware from start. |
| F1, F2 | — | Hours | Folded into adjacent phases |

**Single-PR total realistic timeline: 13-18 weeks** for the whole arc landing as one drop.
- If `@convex-dev/prosemirror-sync` wins the spike: closer to **13-14 weeks**.
- If y-websocket wins: closer to **17-18 weeks** (the Node service + 2 Codex BLOCKERS + ops surface eats 2-3 extra weeks).
- P1 adds ~3-4 weeks but unblocks access-aware multiplayer from the start (vs retrofitting later, which would cost more).

---

## §9 User decisions resolved + open questions

7 user decisions confirmed and reflected throughout this doc (top-note + Decisions A-L+K'):

| Decision | Status |
|---|---|
| Suggestion overlay (not raw edits) | ✓ Decision D, H, Phase M3 |
| `@dohc` inline + chat-driven + palette | ✓ Decision K'. NOTE: only chat-driven ships in M3 v1; inline + palette deferred per round-2 reviewers. |
| Hybrid transport (y-websocket + Convex snapshots) | **REOPENED.** Per Plan agent, `@convex-dev/prosemirror-sync` is a first-party Convex alternative that may eliminate the need for the Node service. PR #0 spike decides. |
| Pull-on-sign-in WorkOS (no webhook) | ✓ Decision J, Phase W1. Augmented with periodic + on-access reconcile. |
| `/w/me/...` URL sentinel | ✓ Decision I, Phase R1 |
| R1 → A1+A2 → W1 → M | ✓ §1 PR order (R1 first; M-track gated on PR #0 spike) |
| Self-hosted WS (downstream of #3) | **DOWNSTREAM OF SPIKE.** If prosemirror-sync wins, this question dissolves. |

**Open questions for the team / next iterations:**
- Per-workspace AI cost cap defaults — suggestions per turn (5?), proposed chars per turn (5000?), per-day soft warning thresholds.
- Suggestion bubble visual treatment — inline (compact) vs right-margin column (Google Docs-style).
- M3 behavior migration cadence — feature flag default state for existing workspaces; observation window before flipping default.
- WorkOS periodic reconcile interval — 4h default; 1h for high-security orgs?
- Sign-in blocking on reconcile failure — default off; per-org opt-in?

---

## §10 Risks (revised)

1. **`@convex-dev/prosemirror-sync` may not fit dohc's custom-node round-trip.** Mitigation: PR #0 spike. If it doesn't fit, fall back to y-websocket per Decision B's expanded checklist.
2. **Markdown round-trip fidelity for the custom-node corpus.** The load-bearing M1 work per Plan agent + Karen. Mitigation: idempotency test (Decision C) is M1 acceptance.
3. **Frontmatter + sourceMode incompatibility with synced editor.** Mitigation: Decision C carves frontmatter out of the synced doc; sourceMode unmounts the editor + rebuilds on exit.
4. **Suggestion-bubble UX in nested contexts** (tables, code blocks, list items, footnotes). Mitigation per Codex LOW: limit v1 to paragraph/list text ranges; sidebar-style for unsupported ranges.
5. **Cost / prompt-injection of `suggest_in_doc`.** Mitigation per Codex HIGH 4: hard per-turn caps on count + chars + ranges; per-day soft warning.
6. **WS / sync server crash loses acknowledged edits.** Mitigation per Codex BLOCKER 2: WAL or persistent provider; if prosemirror-sync wins, Convex's standard durability covers this.
7. **View-only role enforcement at the transport layer.** Mitigation per Codex BLOCKER 1: custom server path (y-websocket) OR native `checkWrite` (prosemirror-sync).
8. **Convex `v.bytes()` 1MB cap on `ydocBinary`.** Only relevant if y-websocket wins; mitigation: GC + state-vector rebases (Yjs `gc:true`).
9. **Markdown serializer non-idempotency.** Progressive corruption across snapshot ticks. Mitigation: M1 idempotency acceptance test mandatory.
10. **Authoritative AI participation across workspaces.** Punted from this plan (M4 cut); revisit in v2 when shared-doc usage proves demand.
11. **WorkOS reconcile race / partial reconcile.** Mitigation per Decision J: periodic + on-access reconcile complements sign-in pull.
12. **Schema/serializer version drift across atomDocs rows.** Mitigation per Decision C: version stamps + deterministic rebuild from markdown.

---

## §11 Round-2 review consensus (informational appendix)

Five reviewers (Codex, Plan agent, Karen realism, code-quality-pragmatist, Jenny spec-compliance) reviewed v1 of this doc in parallel. Convergence and key novel findings:

**Universal consensus (4+ reviewers):**
- Cut M4 from v1 (pragmatist, Karen, Jenny, Codex)
- Scope M3 to chat-driven only (all 5)
- Drop `atomBlockAuthors` sidecar (pragmatist, Karen, Plan, Codex)
- H-5 "Awareness replaces editingBy" is wrong (Jenny, Karen, Plan, pragmatist via "verbal sleight of hand")

**Codex BLOCKERS:** view-only role enforcement at transport; edit-loss-on-WS-crash. Both addressed (or dissolved by prosemirror-sync) in Decision B's expanded checklist.

**Codex HIGHs:** WorkOS "fail-closed" overstated; AI WS auth needs signed delegated-agent token; cost caps beyond tokens; ydocBinary schema/version + escape hatch; M4 hand-waviness. All addressed in Decisions G/J + cost-cap section of M3 + Decision C's storage model.

**Plan agent's biggest finding:** `@convex-dev/prosemirror-sync` exists as a first-party Convex Component; v1's "rejected Convex-only" was rejecting a straw man. Triggers PR #0 spike.

**Karen's realism check:** every phase estimate in v1 was 2-3x too optimistic; round-2 timeline triples.

**Pragmatist's principal cut:** the suggestion-node custom-PM-node model is over-engineered; decoration + sidecar (Decision D revised) matches dohc's existing pattern.

**Jenny's deepest gap:** H-1 substitution surface is 5+ not 3; H-6 R1 missed `/r/<atomId>`; "AI-to-AI across workspaces" was coexistence-plumbing not collaboration-protocol.

Full review transcripts available in conversation history; key file:line references from the v1 review are folded into the relevant decisions above.

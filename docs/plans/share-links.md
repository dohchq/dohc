# Share links implementation plan

Reader: the agent or person implementing the share links program, one phase at a time. Each phase names what it builds, what it must settle first, and the gate that ends it. Do not start a phase before its predecessor's gate passes.

The design is recorded in `CONTEXT.md` (vocabulary) and `docs/adr/0001` through `0006` (decisions). The full adversarial design review that shaped this sequencing is `docs/plans/share-links-review-2026-08-24.md`; consult it when a phase's threat detail here feels thin. Design summary in one paragraph: a share link is a URL-shaped grant on an existing share (View, Comment, or Edit; revocable, retunable, rotatable), served to accountless link holders by a new public service `services/share-web`, backed by the relay replica for availability, with multiplayer live-document editing under a single configured session host, and owner-approved app publications on isolated origins. Everything ships in staged slices of one final model; nothing here is a temporary contract.

## Phase 0: contracts

Build the data and authorization contracts before any route or UI.

- Replace the one-row share model with share, grant, and link credential records (ADR 0005), in `packages/security-contract` and the Rust twin, with contract tests holding them equal.
- Define grant generations and the `{grant, generation, access}` binding for every derived credential.
- Define one `authorizeShareAction` seam owned by the relay: server-derived principal, action, resource in; effective capability or generic refusal out. Callers never combine link, selector, approval, and policy rules themselves.
- Define the link principal (server-minted, per link grant per browser) and the audit record that survives Y.Doc compaction, replication, and settlement.
- Define host lease, epoch, and append-before-acknowledge journaling shapes (ADR 0003), and the publication record (ADR 0006).

Settle first: whether one share can hold several links and mixed levels; whether selector scope is immutable after creation; link expiry vs revoke; what derived named grants survive; what the owner can inspect, block, and delete from the audit record.

Gate: contract tests pass in both languages; a written state machine for grant transitions (create, narrow, widen, rotate, revoke, expire, convert, promote) with no undefined transition.

## Phase 1: prototypes

Prove the failure cases before committing to implementation shape. Each prototype is throwaway code with a written result.

1. **Credential lifecycle.** Exchange a fragment secret for a session, open HTTP and websocket sessions, then rotate, revoke, narrow, and widen. No old generation commits after the transition; no secret appears in logs, history, referrers, or cache keys.
2. **Stop-and-restore.** Run a vandal and two legitimate Yjs editors, execute the owner stop-and-restore action (ADR 0002), and record what good work is lost, what audit remains, and how clients recover from the successor lineage. This is the go/no-go for anonymous Edit: if a whole-document forward restore is not acceptable under interleaved edits, the Edit decision changes before Phase 4.
3. **Selector drift.** Move, delete, and recreate a document while a session edits it; narrow the selector mid-append; fetch `../` assets. Every stale action must fail at commit.
4. **Browser isolation.** Attack the viewer and app origins: raw HTML, SVG, MIME confusion, service workers, CORS, CSRF, navigation, remote fetches, cross-app storage, reaching viewer credentials.
5. **Anonymous load.** Real CRDT decode, replay, compaction, presence, comments, and egress under per-link limits, not just frame throughput.

Gate: each prototype has a written pass, or a design revision recorded as an ADR update.

## Phase 2: View slice

The first shippable vertical: accountless viewing.

- Desktop: create, rotate, retune, and revoke a share link from the existing share dialog.
- `share-web`: secret exchange at the relay seam (ADR 0001), folder navigation, sanitized Markdown, safe images, Excalidraw view, forced download for untrusted formats. Secrets travel in the URL fragment and become short-lived cookies.
- Honest freshness: the viewer shows settled content with a "last settled" indicator; it never calls a stale snapshot live.
- Refusal discipline: invalid id, bad secret, revoked, and rate-limited responses are indistinguishable before authentication.
- Owner visibility: per-link usage, and a warning that a link exposes everything under the selector, including files added later.

Settle first: which metadata a viewer receives (no owner email, workspace ids, private ancestor paths, or participant identities by default); remote-media policy (blocked in v1); cache and unfurl-bot policy. Chat-channel selectors are excluded from links in this program.

Gate: hostile-content, refusal-oracle, and revocation tests pass; a leaked-URL walkthrough of what an attacker gets matches the owner-facing warning text.

## Phase 3: Comment

- Mint link principals on first interaction; claimed names are display metadata, marked unverified.
- Extend the relay's chat author contract to recognize a server-minted link principal as the authenticated pusher without weakening named-user authorship.
- One share-level discussion object; text only. No attachments, reactions, decisions, or anchored comments.
- Owner moderation: delete comments, block principals, throttle notifications; a single "pause all link writes" control that preserves viewing.

Gate: quota, moderation, and revoke-during-append tests pass; provenance shows link id and principal on every message.

## Phase 4: Edit

- One configured session host per deployment (ADR 0003): the service host module for dohc Cloud and willing self-hosters; device-only mode otherwise. No automatic movement.
- Journal before acknowledgement; grant generation and host epoch on the session ticket and on every accepted update; commit-time recheck of grant, selector containment, and epoch.
- Durable authorship records outside the prunable Y.Doc update cache; settlement references its audit interval.
- Build the owner stop-and-restore action before exposing Edit to anyone.
- Ship named-recipient browser Edit first; enable anonymous Edit only after the same path passes adversarial load with link principals.
- Scope: existing Markdown live documents on the main version. No create, rename, delete, Excalidraw editing, or pinned-version editing.

Settle first: what a desktop named recipient's Edit means when no host is online (pause, or proposal); when View joins the live Y.Doc read-only vs reads settled Markdown; settlement cadence and maximum document size.

Gate: restart, stale-frame, selector-drift, access-change, and restore tests pass under load; the stop-and-restore drill completes against a live hostile session.

## Phase 5: apps

- Publications first (ADR 0006): immutable, capability-free bundles on isolated per-publication origins, served static. Choose the build trust model here, including whether Vite's plugin surface is admissible.
- Then owner-approved read capabilities tied to the bundle digest, delivered through the scoped data API.
- Then, only if a launch app needs it, one typed create-only collection per ADR 0004, after naming the authoritative app-data store and its sync, export, backup, and deletion path.
- Service workers, persistent storage, raw HTML, inline SVG, and remote embeds stay disabled until a specific use case passes a threat test.

Gate: the Phase 1 isolation attacks re-run green against the real origin model; a capability widening attempt fails closed at the approval seam.

## Cross-cutting

- Operational contract before Phase 2 ships: public base domains, wildcard DNS and TLS needs, trusted proxies, websocket timeouts, durable volumes, backup and restore, degraded modes, secret scrubbing in logs, and retention for link ids, IPs, and audit records. Self-hosting docs state plainly that the relay sees share plaintext and that per-publication origins need wildcard DNS or a second domain.
- Abuse budgets are layered (per IP pre-auth, then per grant, principal, document, workspace, owner) and charged separately from the owner's own sync quota.
- "Open in dohc" is an explicit acceptance step that tells the viewer the owner will learn their identity; the desktop handoff uses a single-purpose short-lived code, never the bearer URL.
- Every phase runs the repository gates that its changed paths select, per `AGENTS.md`.

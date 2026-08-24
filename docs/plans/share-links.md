# Share links implementation plan

Reader: the agent or person implementing the share links program, one phase at a time. Each phase names what it builds, what it must settle first, and the gate that ends it. Do not start a phase before its predecessor's gate passes.

The design is recorded in `CONTEXT.md` (vocabulary) and `docs/adr/0001` through `0006` (decisions). The full adversarial design review that shaped this sequencing is `docs/plans/share-links-review-2026-08-24.md`; consult it when a phase's threat detail here feels thin. Design summary in one paragraph: a share link is a URL-shaped grant on an existing share (View, Comment, or Edit; revocable, retunable, rotatable), served to accountless link holders by a new public service `services/share-web`, backed by the relay replica for availability, with multiplayer live-document editing under a single configured session host, and owner-approved app publications on isolated origins. Everything ships in staged slices of one final model; nothing here is a temporary contract.

## Phase 0: contracts

Build the data and authorization contracts before any route or UI.

- Replace the one-row share model with share, grant, and link credential records (ADR 0005) in `packages/security-contract`. Grant and credential persistence records stay relay-side per ADR 0005; only `GrantBinding` crosses the engine boundary (a device session host checks it), so only it gets a Rust twin held equal by shared vectors.
- The normalization covers chat-channel grants in the same table: a channel grant keeps its read-only or read-write access, typed by the share's selector kind, on the grant. No second access location survives. Channel shares still never get public links in this program.
- Define grant generations and the `{grant, generation, access}` binding for every derived credential.
- Define one `authorizeShareAction` seam owned by the relay: server-derived principal, action, resource in; effective capability or generic refusal out. Callers never combine link, selector, approval, and policy rules themselves. The seam reloads the share's active status and the granter's current standing on every check; deleting a share revokes every grant.
- Define the link principal (server-minted, per link grant per browser) and the audit record that survives Y.Doc compaction, replication, and settlement.
- Define host lease, epoch, and append-before-acknowledge journaling shapes (ADR 0003), and the publication record (ADR 0006).

Settle first: whether one share can hold several links and mixed levels; what derived named grants survive; what the owner can inspect, block, and delete from the audit record. Already settled: no expiry in v1 (the state machine refuses it; owners revoke instead), and selector scope is immutable after share creation — a different scope is a new share, so no transition can silently widen what a leaked URL reaches.

Gate: contract tests pass in both languages; a written state machine for grant transitions (create, narrow, widen, rotate, revoke, expire, convert, promote) with no undefined transition.

## Phase 1: prototypes

Prove the failure cases before committing to implementation shape. Each prototype is throwaway code with a written result.

1. **Credential lifecycle.** Exchange a fragment secret for a session, open HTTP and websocket sessions, then rotate, revoke, narrow, and widen. No old generation commits or reads after the transition — subsequent reads refuse and open sockets close, tested alongside commits; no secret appears in logs, history, referrers, or cache keys.
2. **Stop-and-restore.** Run a vandal and two legitimate Yjs editors, execute the owner stop-and-restore action (ADR 0002), and record what good work is lost, what audit remains, and how clients recover from the successor lineage. This is the go/no-go for anonymous Edit: if a whole-document forward restore is not acceptable under interleaved edits, the Edit decision changes before Phase 4.
3. **Selector drift.** Move, delete, and recreate a document while a session edits it; narrow the selector mid-append; fetch `../` assets. Every stale action must fail at commit.
4. **Browser isolation.** Attack the viewer and app origins: raw HTML, SVG, MIME confusion, service workers, CORS, CSRF, navigation, remote fetches, cross-app storage, reaching viewer credentials.
5. **Anonymous load.** Real CRDT decode, replay, compaction, presence, comments, and egress under per-link limits, not just frame throughput.

Gate: each prototype has a written pass, or a design revision recorded as an ADR update.

## Phase 2: View slice

The first shippable vertical: accountless viewing.

- Desktop: create, rotate, retune, and revoke a share link from the existing share dialog. Creation and retuning offer only levels whose phase gate has passed — View here, Comment after Phase 3, Edit after Phase 4 — so no link ever advertises authority its safeguards have not earned. Rotate, revoke, and raising a link's level warn before running: rotation and a level raise permanently kill the old URL, and revoke ends every session and dependent grant derived from the link.
- `share-web`: secret exchange at the relay seam (ADR 0001), folder navigation, sanitized Markdown, safe images, Excalidraw view, forced download for untrusted formats. The fragment secret is exchanged by POST for a short-lived derived session capability stored in a `Secure`, `HttpOnly`, host-only cookie; the viewer then removes the fragment from the address bar and history (`history.replaceState` or equivalent), the secret never persists client-side, and the gate tests the cookie's attributes, the final address, and history state. A link secret comes from a CSPRNG with at least 256 bits of entropy, is stored only as a keyed hash, and verifies in constant time, with tests for all three properties.
- Sessions are per-link: cookie naming or a server-side session map keyed by link id keeps two links open in one browser fully distinct. The gate includes a two-tab test covering reads, rotation, and revocation across different shares.
- Honest freshness: the viewer shows settled content with a "last settled" indicator; it never calls a stale snapshot live.
- Refusal discipline: invalid id, bad secret, revoked, and rate-limited responses are indistinguishable before authentication.
- Owner visibility: per-link usage, and a warning that a link exposes everything under the selector — including files added later for live-follow path shares; a version share is a snapshot, so its warning omits the future-files clause. Both the creation warning and the leaked-URL walkthrough say plainly that revocation ends future access but cannot recall content already downloaded, cached, or copied.
- Promoting a derived named grant warns that it is permanent: the former parent link's rotation and revocation no longer reach that grantee, and the reverse path afterward is revoking the named grant itself.

Settle first: which metadata a viewer receives (no owner email, workspace ids, private ancestor paths, or participant identities by default); remote-media policy (blocked in v1); cache and unfurl-bot policy. Chat-channel selectors are excluded from links in this program.

Gate: hostile-content, refusal-oracle, and revocation tests pass; selector-drift integration tests prove the shipped read path drops object and blob access on move, deletion, and recreation under an open session, and refuses stale cached reads; granter ownership loss goes dark generically; a leaked-URL walkthrough of what an attacker gets matches the owner-facing warning text.

## Phase 3: Comment

- Mint link principals on first interaction; claimed names are display metadata, marked unverified.
- Extend the relay's chat author contract to recognize a server-minted link principal as the authenticated pusher without weakening named-user authorship.
- One share-level discussion object; text only. No attachments, reactions, decisions, or anchored comments. Messages reach link holders through a server-side author projection that exposes only the approved display identity — never account identifiers — with a mixed named-and-link-author disclosure test in the gate.
- Owner moderation: delete comments, block principals, throttle notifications; a single "pause all link writes" control that preserves viewing. Blocking and pausing reverse in place (unblock, resume); comment deletion warns that it is permanent before it runs. Blocking an accountless principal ejects its sessions and stops its writes, and the UI says plainly that a determined holder can remint an identity from the same link: rotation is the durable response. The gate includes a fresh-profile remint test. Block and pause join revoke in the commit-time authority check — a buffered append from a blocked principal or paused link refuses at commit, and the gate races both transitions against in-flight appends.

Gate: quota, moderation, and revoke-during-append tests pass; provenance shows link id and principal on every message; hostile markup, URL-scheme, and output-encoding tests cover comment bodies and claimed names, which are new attacker-controlled rendering inputs the Phase 2 gate never saw.

## Phase 4: Edit

- One configured session host per deployment (ADR 0003): the service host module for dohc Cloud and willing self-hosters; device-only mode otherwise. No automatic movement.
- Journal before acknowledgement; the session ticket is single-use, short-lived, and bound to principal, audience, workspace, version, object, lineage, grant generation, and host epoch, with replay and cross-document tests; commit-time recheck of grant, selector containment, and epoch on every accepted update.
- Durable authorship records outside the prunable Y.Doc update cache; settlement references its audit interval.
- Build the owner stop-and-restore action before exposing Edit to anyone. Grant invalidation is inside the action, atomic with it — revoke or downgrade first, then fence, then restore — and the gate proves the old URL cannot open a session against the successor lineage.
- Ship named-recipient browser Edit first; enable anonymous Edit only after the same path passes adversarial load with link principals.
- Named browser sessions authenticate for real: sign-in on `share-web` maps a relay-derived account identity to its named grant, never a client claim, and a cookie for one grantee never authorizes another. Without this, "named Edit first" would silently run on the anonymous link path under a different label.
- A device host maintains an authenticated outbound connection to `share-web` (registration, document routing, reconnect, and fencing over that pipe), because NAT means `share-web` can never dial the device. The gate includes a test where `share-web` cannot initiate connections.
- Presence is server-projected per principal kind: define which fields an anonymous editor receives, redact server-side, and test what an anonymous session can see of named collaborators.
- Scope: existing Markdown live documents on the main version. No create, rename, delete, Excalidraw editing, or pinned-version editing.

Settled: a desktop named recipient's live-document Edit pauses when no host is online, exactly like the browser — a proposal lane there would give Edit two meanings, which ADR 0002 and the glossary both forbid. Settle first: what the owner's local edits mean while a service host holds the session and the owner's device is offline, including which side settles on reconnect; when View joins the live Y.Doc read-only vs reads settled Markdown; settlement cadence and maximum document size.

Gate: restart, stale-frame, selector-drift, access-change, and restore tests pass under load; the stop-and-restore drill completes against a live hostile session; an attributed-update test verifies link and principal audit records survive compaction, replication, settlement, and lineage replacement.

## Phase 5: apps

- Publications first (ADR 0006): immutable, capability-free bundles on isolated per-publication origins, served static. Choose the build trust model here, including whether Vite's plugin surface is admissible.
- Then owner-approved read capabilities tied to the bundle digest, delivered through the scoped data API. Settle first: the app-session credential exchange — a one-time launch handoff mints an app-scoped session bound to grant, generation, and publication, because the viewer's host-only cookie cannot cross to the app origin and the link secret must never enter JavaScript-visible app state. App sessions stay distinct per link exactly as viewer sessions do — the same publication launched from two links keeps two bindings, gated with a concurrent-links test — and each app session carries its server-minted link principal, so provenance, budgets, and principal blocks distinguish two browsers on one grant (tested with two principals writing through one link). An approved capability never reaches outside the share's selector in v1: an out-of-selector dataset fails closed at approval, visibly.
- Then, only if a launch app needs it, one typed create-only collection per ADR 0004, after naming the authoritative app-data store and its sync, export, backup, and deletion path.
- Service workers, persistent storage, raw HTML, inline SVG, and remote embeds stay disabled until a specific use case passes a threat test.
- Publications and capabilities have visible withdrawal paths: unpublish a publication, and revoke or narrow an approved capability. Active app sessions lose data authority at their next data-API check; withdrawing external-network access additionally makes the viewer destroy the app's browsing context — invalidating server-side credentials alone cannot stop a loaded page from fetching, so the enforcement is teardown of the frame itself. The phase gate tests both withdrawals, including that a running page stops sending traffic after the network withdrawal.

Gate: the Phase 1 isolation attacks re-run green against the real origin model; a capability widening attempt fails closed at the approval seam.

## Cross-cutting

- Operational contract before Phase 2 ships: public base domains, wildcard DNS and TLS needs, trusted proxies, websocket timeouts, durable volumes, backup and restore, degraded modes, secret scrubbing in logs, and retention for link ids, IPs, and audit records. Self-hosting docs state plainly that the relay sees share plaintext. App content is served from a separate registrable domain, never a subdomain of the viewer's site: wildcard subdomains under the viewer's domain stay same-site, which leaves cookie-tossing and CSRF paths open.
- Abuse budgets are layered (per IP pre-auth, then per grant, principal, document, workspace, owner) and charged separately from the owner's own sync quota.
- "Open in dohc" is an explicit acceptance step that tells the viewer the owner will learn their identity; the desktop handoff uses a single-purpose short-lived code, never the bearer URL.
- Every phase runs the repository gates that its changed paths select, per `AGENTS.md`.

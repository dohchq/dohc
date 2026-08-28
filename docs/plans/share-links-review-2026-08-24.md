# Share links design review

Review target: `share-links-design-brief.md`, checked against dohc at `cc015f7787b7440357d59314d24e7c8947cf3c90`.

The design is not ready for implementation planning. The product direction can survive, including accountless links and direct multiplayer editing, but the design has not settled the authority, identity, durability, and recovery contracts that make those decisions safe. Planning now would harden the wrong share data model and hide a distributed-writer problem behind the term "session host."

## Review basis

The intent under review is to add accountless URL grants at the existing selector grain, then support browser viewing, comments, live document editing, and isolated published apps without weakening dohc's authorization, provenance, history, or self-hosting commitments.

Two independent Sol reviews and one Fable judgment pass examined the same design and relevant source. The passes produced 13, 15, and 6 substantive findings. All three agreed on the core blockers in sections C1 through C6. They also agreed that writable app data should not ship before its permission and recovery model exists.

The reviewers disagreed on whether an owner device or a service should be the only v1 session host. The important conclusion is narrower and stronger: v1 should have one configured host authority, not automatic movement between two authorities. Cloud can use a service host. A self-hoster can run the same host or choose an honest device-only mode.

## 1. Holes and risks

Findings are ordered by severity. "Critical" means the current design can produce unauthorized access, acknowledged data loss, or a recovery promise that does not work. "High" means the design can ship safely only after the named contract exists.

### Critical

#### C1. The current share row cannot represent the proposed grant lifecycle

Design points 1 and 2 require a link grant on an existing share, independent link rotation, mutable access, and conversion into named grantees while retaining the same history. The current model has one `sync_relay_shares` row per grant. Each row has one `share_id`, one user or email recipient, one `selector_json`, and one revocation timestamp. Access lives inside the selector.

Adding `link` as a third recipient variant does not solve this. One row still cannot hold a link and several converted users with independent access and revocation. Mutating the row during "Open in dohc" consumes the link. Copying the row creates another share ID. Content and file-chat reads may still converge because both rows filter the same workspace log, but proposals and revocation remain keyed to separate grant IDs. No stable share object owns the common discussion and history promised by the design. A leaked link can also be converted into named grants that survive rotation unless the model records their parent authority.

Replace the storage model before adding routes:

- A `share` owns the workspace, selector scope, discussion identity, and shared history.
- A `grant` owns its principal kind, access, generation, status, and timestamps.
- A `link credential` owns a secret hash and rotation metadata for one link grant.
- A converted named grant remains dependent on its parent link grant unless the owner explicitly promotes it.

Move stored access from the reusable selector scope to the grant. The TS and Rust engines can still receive one effective selector plus access after the server resolves the grant. They do not need link credentials or principal records. There are no users, so this should replace the current model rather than add nullable fields and compatibility paths.

#### C2. Link verification and relay authority have no defined owner

Design point 4 puts all anonymous traffic at `share-web` while keeping the relay bearer-only. The design does not say who verifies a link secret or how `share-web` reads relay data after verification.

A broad service credential would make the public service a deputy for every workspace. One route bug or service compromise could read any plaintext share blob. Direct database access would bypass the relay's central checks. Reimplementing selectors in `share-web` would create another authorization implementation beside `filterOpForShare` and the Rust recipient boundary.

The relay must own link grants and link-secret verification. `share-web` should call one narrow internal exchange using workload identity. The relay should compare a stored secret hash and return a short-lived, audience-bound capability for a specific grant generation. Later reads and writes must name an action and resource, not a client-supplied workspace, selector, user, or access level. The relay must reload the current grant and derive authorization server-side.

This can stay consistent with "the relay is bearer-only." The public browser talks only to `share-web`. The internal exchange authenticates `share-web`, and the relay issues a narrow bearer capability. `share-web` never holds standing workspace authority.

#### C3. Rotation, revocation, and access changes do not invalidate active authority

Design point 1 says rotation kills the old URL, and Design point 3 treats per-link revoke and rotate as safeguards for direct editing. Those claims are false if an exchanged cookie, app session, WebSocket ticket, service worker, or open socket remains valid.

The existing relay already treats this class of race as a correctness issue. It reauthorizes a parked long poll after wake and checks a member append in the same transaction as the write. A WebSocket handshake check is weaker. Frames already queued at downgrade time can still commit.

Every grant needs a monotonic generation. Bind browser sessions, app capabilities, WebSocket tickets, and host leases to `{grantId, generation, access}`. Recheck that tuple, the current selector, and the granter's standing at the authoritative mutation transaction. Push invalidation to close sockets quickly, but use the commit-time check as the rule that prevents writes.

Define the transition semantics now:

- Revoke and rotate increment the generation and invalidate every derived credential.
- A downgrade rejects uncommitted and buffered writes from the old generation.
- A committed write remains in history and can be restored. Revocation is not retroactive deletion.
- A privilege increase, such as View to Edit, should mint a new secret. Otherwise every leaked copy of the old View URL silently becomes a write credential.
- Rotation and revoke must also affect named grants derived from that link, unless the owner promoted them explicitly.

#### C4. The movable session host has no leadership or durability protocol

Design point 6 names the session host as a role, but it does not define how that role moves. A suspended or partitioned owner device is indistinguishable from a dead one. A service can take over while the device still accepts updates. Both hosts can then write and settle the same Y.Doc.

Yjs can merge concurrent document updates. That does not make two hosts safe. Settlement into Markdown, lineage origination, history creation, and acknowledgement are not resolved by CRDT merge. The current engine's leases protect one process and one engine database. They do not fence another machine.

The acknowledgement point is also missing. If a host acknowledges a browser update from memory or from a local database, then dies before the next host can read it, a reconnecting browser may resend the update through Yjs state-vector exchange. That is recovery from a surviving client, not server durability. The update is lost if no browser retains the state, and the product cannot claim that acknowledgement means durable commit.

Automatic takeover requires all of these rules:

- A durable lease on `{workspaceId, versionId, objectId}` with a monotonic epoch.
- A shared journal append before the browser receives acknowledgement.
- The epoch on every accepted update and every settlement.
- A transactional stale-epoch refusal at the authoritative store.
- State-vector replay through the current fence before a new host accepts writes.
- Termination of the old pipe and refusal of its delayed frames.
- A handback rule and recovery for a crash after append but before broadcast.

Do not put automatic device-to-service takeover in v1. Choose one host authority per deployment. Cloud should use the session-capable service as the sole web-edit host. A self-hoster can run that same module or select device-only hosting and accept that editing stops when the device disconnects. Host movement can follow only after the fencing prototype passes.

`share-web` is not a dumb pipe in either version. It authenticates upgrades, validates `Origin`, routes to the authorized document and host epoch, enforces frame and connection limits, applies backpressure, refreshes grant authority, and closes invalid sessions. It need not interpret Yjs semantics, but it is an authorizing session gateway.

This point also leaves "live View" undefined. The relay serves settled artifacts, so it can lag accepted Y.Doc updates. While a live session exists, either a View client joins the canonical Y.Doc read-only, or the UI shows the last settled revision with a freshness timestamp. Pick one. Do not call a stale relay snapshot live.

#### C5. Attribution and rollback are not real safeguards yet

Design points 2 and 3 rely on attribution, provenance, and history rollback to justify direct anonymous writes. A browser-scoped pseudonym and a self-claimed name cannot carry that weight. Another holder of the same URL can choose the same name, clear storage, or create many identities.

The server must mint an unforgeable principal for the browser, scoped to one link grant. The claimed name is display metadata and must be marked unverified. The host stamps the minted principal and link grant onto accepted work. The browser never supplies authoritative authorship.

Current Y.Doc persistence does not retain the promised record. `ydoc.update` replication omits the local actor origin, compaction deletes local update rows, and settlement can write a combined Markdown moment without an author. A durable audit record must survive CRDT compaction, replication, settlement, and lineage replacement. Each accepted update or batch needs the grant, minted principal, object, lineage, update digest, host epoch, and server time. A settlement should reference the exact audit interval or contributor set.

Rollback also needs a precise grain. Selective removal of one person's interleaved Yjs edits while preserving every later edit is not a credible v1 promise. Define rollback as a whole-document restore to a selected revision or timestamp, applied as a new forward history action. Preserve later audit records even when content is restored.

The recovery path must work during an attack. Current write and rollback paths refuse while a live Y.Doc lease exists. A hostile editor can keep the document leased. The owner needs one visible "stop and restore" operation that:

1. Revokes or downgrades the grant.
2. Fences the current host epoch and disconnects writers.
3. Durably drains or quarantines acknowledged updates.
4. Closes the document lease.
5. Applies a forward restore.
6. Creates the successor Y.Doc state and history entry.
7. Tells remaining clients that their lineage changed.

Until this works end to end, rollback is a requirement, not a safeguard.

#### C6. A live object session can outlive its path authority

Design point 1 keeps the current path selector grain. Existing share reads resolve an object's current path repeatedly because a move can remove it from a granted subtree. A live session instead opens an object and lineage, then remains connected.

If the owner moves the object out of scope, deletes it, recreates the old path with a new object, narrows the selector, or changes the relevant version, a stale session can keep editing data it no longer covers. It may also settle at an obsolete path. The same issue applies to Markdown images, app imports, and downloads whose paths resolve outside the granted subtree.

Bind the session to the server-derived workspace, version, object, lineage, current path, grant generation, and host epoch. Recheck current object identity, current path containment, selector generation, access, and epoch before each durable update and settlement. A move out of scope, deletion, lineage replacement, selector change, or access change must fence the session.

Authorize every referenced asset after path normalization. Authorizing a Markdown file does not authorize `../private/image.png`. Decide before planning whether Edit is allowed on pinned versions and on pathless whole-version selectors.

### High

#### H1. The browser credential and origin design is incomplete

Design points 1, 4, and 5 create the first anonymous browser authority in dohc. A secret in a URL path or query reaches reverse-proxy logs, browser history, analytics, screenshots, and sometimes `Referer` headers. A WebSocket query is often logged too. A shared cache can serve content after revoke if its key omits grant generation.

Use a random public link ID and at least 256 bits of secret. Store only a keyed hash or hash of the secret and compare it in constant time. Put the initial secret in the URL fragment, exchange it by POST for a short-lived `Secure`, `HttpOnly`, host-only session cookie, and remove the fragment with `history.replaceState`. Use one-time, short-lived WebSocket tickets rather than a query credential.

Set `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and an explicit `frame-ancestors` rule. Do not run third-party analytics on authenticated pages. Search-engine `noindex` is useful but does not protect a leaked URL.

Separate trust with origins, not only routes:

- The viewer shell origin must run no workspace-authored code.
- Shared active content and risky downloads need a credential-free content origin or forced download.
- Each published app revision needs its own origin or opaque sandbox, not one origin shared by every app behind a link.
- App data endpoints must receive no ambient viewer cookie.

A per-link subdomain is a different origin but can still be the same site, which leaves cookie and CSRF traps. A stable per-link origin also lets a service worker survive source changes and secret rotation. Use a separate registrable domain for untrusted apps. Disable service workers and persistent storage in v1, or use a new origin for every publication and link generation.

#### H2. Public rendering treats shared content as hostile input

Design point 7 lists Markdown, images, Excalidraw, apps, and downloads. The fact that desktop editor components run in a browser does not prove that they are safe on a public origin.

Raw Markdown HTML, unsafe URLs, SVG, Excalidraw links, comments, and claimed names can become stored XSS. An external image can disclose a visitor's IP and viewing time. Proxying it can instead create SSRF. Inline HTML or SVG downloads can execute with viewer credentials if the browser sniffs or renders them.

Define a small sanitization and MIME policy. Sanitize Markdown and comments, reject active URL schemes, and force HTML and SVG to download unless a separate sandbox handles them. Use a credential-free origin for shared media. Block remote embeds in v1, or add an SSRF-resistant proxy with private-address denial, redirect limits, MIME checks, and byte caps. Apply path containment to every local asset fetch.

#### H3. An app manifest is a request, not a security boundary

The "one app term" decision in Design point 5 is fine. The problem is the claim that a capability manifest alone separates static and connected apps. Source can request authority. Only an owner-approved publication grant can confer it.

Vite also runs code at build time. Configuration, plugins, dependency hooks, and imported Node modules can read the builder's filesystem or network. Running a workspace's build inside `share-web` would contradict the browser-only execution rule and add server-side code execution.

Publish an immutable, content-addressed bundle tied to a source revision, dependency lock, manifest digest, build record, and owner approval. A source, dependency, or manifest change creates a new unpublished revision. A missing manifest requests no capabilities. A malformed manifest fails publication. It must not fall back to static mode.

Choose one build trust model before choosing Vite:

- The owner builds locally and uploads a bundle with its source digest.
- A fixed compiler builds from a selector-filtered virtual filesystem without arbitrary configuration or plugins.
- An isolated disposable builder runs without credentials, host workspace access, or network, under CPU, memory, and time limits.

Effective app authority is the intersection of the pinned app revision's requests, the owner's explicit approval, the active link grant, and server policy. External network access is a capability because it lets an app exfiltrate every datum it can read. A zero-capability app is still untrusted code and still needs the browser sandbox.

#### H4. "Writable-by-link" is too coarse to authorize app data

Design point 5 does not define the resource or operation grain for writable app data. A boolean writable flag can easily become read, insert, update, and delete across a table. A visitor can call the endpoint without using the app UI, so UI controls do not count.

Define capabilities by published app revision, dataset, operation, allowed fields, row policy, schema, and size. At minimum, distinguish create-only, read-filtered, update-own-row, and no-delete. Derive row ownership from the server-minted link principal. Do not expose raw SQL or reuse a broad plugin database interface.

Writes need idempotency keys, atomic history, server-derived provenance, per-grant quotas, and a visible reverse action. Include indirect effects such as triggers, notifications, and automations in the capability review. A write to structured data can cause effects outside the row even when it never touches a file directly.

Authorization is only half of this lane. The design does not name the authoritative structured-data store. If the owner's local database is authoritative, an offline owner makes browser writes unavailable or creates a later multi-writer merge. If a relay or session service is authoritative, dohc must define how the owner's local copy syncs, exports, backs up, restores, and deletes that data. Self-hosters need the same storage and recovery path. Pick the source of truth and its replication contract before promising that writable apps stay available while the owner sleeps.

The ADR's phrase "only direct anonymous write path" is also inaccurate. Anonymous Y.Doc Edit is a direct document write. Comment may write chat records and attachments. The useful rule is narrower: owner-approved app data is the only non-document application state that a link holder may change without a proposal.

#### H5. Anonymous traffic can consume the owner's storage and compute

Design point 3 opens chat and CRDT writes without an account abuse boundary. Design point 5 adds structured writes. View adds blob egress and scraping. A holder can open many sockets, churn presence, send expensive Yjs updates, flood comments and notifications, fill app collections, and hotlink downloads.

The current 20 MiB Y.Doc update ceiling protects trusted full-state replication. It is not a safe public-frame allowance. A small wire update can also cause expensive decode, replay, projection, compaction, or broadcast work. Workspace quota alone lets one leaked link consume the owner's normal sync allowance.

Apply limits in layers:

- Per IP before credential verification, without revealing whether a link exists.
- Per grant, minted principal, document, app dataset, workspace, and owner after verification.
- Concurrent sockets, connection churn, frame bytes, decoded update growth, update rate, presence rate, comments, attachments, notifications, data mutations, asset bytes, and total egress.
- CPU and wall-time budgets around CRDT decode, replay, compaction, rendering, image work, and app builds.
- Backpressure and bounded queues. Disable WebSocket compression unless decompressed size and CPU are bounded.

Give the owner one control that pauses all link writes, ejects active sessions, and preserves viewing. Add comment deletion, principal blocking, notification throttling, and per-link usage visibility. Charge public activity to a separate budget so abuse cannot stop the owner's own sync.

#### H6. A leaked URL leaks more than the design acknowledges

Design point 2 calls the viewer anonymous, but the URL is still a bearer credential. Anyone or any link-unfurl bot that receives it can read everything under the selector. An Edit URL permits vandalism until invalidation reaches the mutation store. Rotation stops future access but cannot erase browser caches, downloads, screenshots, copied text, or app data already exported.

The owner UI must say exactly what a link exposes and that files added later under a shared folder also become visible. It must warn before rotation because rotation is irreversible for the old URL. It must not imply that revoke recalls downloaded data.

The relay sees share plaintext today. Web links widen the audience and traffic path, but they do not add end-to-end secrecy. State that in the sharing UI and self-hosting docs. Do not imply that possession of the secret hides content from dohc Cloud.

Decide what metadata anonymous viewers receive. Workspace IDs, private ancestor paths, owner email, account IDs, history outside the selector, deleted paths, presence, and other participants' identities should not flow by default. The existing recipient summary is not automatically appropriate for the public viewer.

"Open in dohc" must be an explicit acceptance step. Automatic conversion would disclose a signed-in viewer's identity to the owner and let a malicious link perform account linking. Exchange the web credential for a single-purpose, short-lived desktop handoff code. Do not put the bearer URL in a desktop protocol handler.

#### H7. Comment does not fit the existing chat contract

Design point 3 says Comment reuses the existing share chat thread. Current chat writes require a relay user ID that equals the authenticated pusher. A link holder has no such ID. Making up an account ID or trusting the displayed name would weaken a server-derived authorship rule.

The existing file-chat filter also has no file thread for a valid whole-workspace version selector with `paths: []`. The design has not said what a comment attaches to there. Reusing the full chat lane may also expose reactions, decisions, and attachments. Attachments are another anonymous blob-write path with separate abuse and malware costs.

Add an explicit author-principal union and make the relay recognize a server-minted link principal as the authenticated pusher. Keep the claimed name separate. Start Comment with text messages only. Either add one share-level discussion object or disallow Comment and Edit on pathless version shares in v1. Defer attachments, reactions, and decisions until their limits, moderation, deletion, and provenance rules exist.

#### H8. The public operational contract is missing

Design points 4 through 6 add public HTTP, WebSocket routing, app origins, optional session hosting, and self-hosted availability. The design does not define the deployment contract that makes these work.

Per-publication origins may require wildcard DNS and TLS. Reverse proxies must preserve WebSocket behavior and route hostnames safely. A service host needs durable storage, backups, lease recovery, capacity limits, and health checks. The UI needs distinct states for revoked, invalid, host unavailable, stale settled view, overloaded, and temporarily disconnected without turning pre-auth responses into existence oracles.

Specify the public base domains, TLS and DNS requirements, allowed `Host` values, cookie scope, trusted proxies, WebSocket timeouts, durable volumes, backup and restore, and degraded modes. Scrub URL secrets from access logs, error reports, traces, and analytics. Decide whether and how long to retain link IDs, IP addresses, browser principal activity, and audit records.

Generic 404 discipline needs exact behavior. Invalid ID, bad secret, revoked link, wrong generation, and pre-auth rate limiting should not differ by body, cache headers, or a large timing gap. After successful exchange, the UI can report an honest availability state without creating a pre-auth oracle.

#### H9. Chat-channel share links have no level or rendering contract

Design point 1 keeps the existing selector grain, which includes chat-channel selectors as well as path/version selectors. Design point 3 then offers View, Comment, and Edit on the web. Chat-channel selectors use a different `read-only` or `read-write` access contract, and the v1 renderer does not list channel viewing.

The design therefore leaves basic questions unanswered. A View link could expose an entire channel. Comment could mean the existing channel's `read-write` level, but that also includes more operations than text comments. Edit has no additional document meaning for a channel. Anonymous presence, membership metadata, attachments, reactions, decisions, retention, and notification abuse would all need separate treatment.

Exclude chat-channel selectors from public link grants in v1. Revisit them as a separate browser-chat design if a product case requires it. Do not force their binary access model through the path selector's View/Comment/Edit labels.

## 2. Challenges to the decisions

### Retiring the no-outside-writes invariant

The product case for direct live-document editing is sound. Keeping proposal-only editing would not produce multiplayer collaboration. The design is still relying on safeguards it has not built or defined.

Accept the retirement only for a document-scoped Y.Doc capability with server-derived identity, commit-time grant checks, durable append-before-ack, a single fenced host, retained audit records, and a tested stop-and-restore path. Do not extend it to file-tree changes, arbitrary file writes, or general database edits.

Keep View, Comment, and Edit as user-facing labels if they remain useful, but do not use the ordinal enum as the authorization model. The server needs action-level capabilities. `Edit` means Y.Doc write for both named and link principals. It may also mean proposals for a named recipient, while a link holder has no proposal lane. App-data writes are independent and may exist on a link whose document level is View. Those differences must be explicit in the derived capability set and in the UI.

The design also needs an offline rule. A named recipient already has a materialized copy. If the session host is absent, does a desktop edit pause, become a proposal, or merge into the canonical Y.Doc later? Each answer changes the meaning of Edit. Pick one before reusing the current received-share workspace.

### All three levels in v1

Reject this as one release constraint. It is not three labels. It is anonymous credential exchange, public rendering, anonymous chat authorship, multiplayer hosting, durable provenance, recovery, abuse control, and app isolation.

The product commitment is that these paths exist, not that every path turns on together. Stage them behind the same final grant model. Ship View first, then text-only Comment, then named browser Edit on one host, then anonymous Edit after rollback and abuse tests. Writable app data should follow later. This avoids temporary contracts and still works toward the settled product.

### Session host as a role

Keep `session host` as the product term. Reject dynamic role movement in v1.

The ADR rejects service-only hosting because it appears to require another stateful service for self-hosters. That mixes a module decision with a deployment decision. Public links already need a reachable relay and `share-web`. The session-host implementation can be packaged with those services. Cloud can use that service as the one host. A self-hoster can run the same package or select device-only mode. Neither mode needs automatic failover.

Later host movement must be a protocol, not a routing feature. A reconnect is an acceptable client experience, but it does nothing to prevent two servers from accepting or settling writes.

### One app term and the capability-manifest seam

Keep one product term, `app`. Splitting static sites from dynamic apps would add vocabulary without improving safety.

Internally, keep separate modules for publication, immutable bundle storage, browser isolation, capability approval, data access, and mutation history. This is a useful deep-module split. A manifest request crosses into an owner-approved publication grant. The runtime receives only the effective grant. Callers should not need to reproduce manifest, link, and owner-policy intersection rules.

Zero requested capabilities means no data capability. It does not mean trusted code. The app still receives the same navigation, storage, service-worker, network, and origin restrictions.

### The writable-app-data lane

The product need is real. A poll or RSVP form cannot wait for a file-tree proposal per click. The proposed lane is still too broad to plan.

Defer general writable data. If one write case must ship, make it a typed create-only collection with a fixed schema, idempotency, server-set principal fields, a per-link quota, append-only history, and one owner-visible bulk undo. Add update-own-row only after a real app requires it. Do not start with general table mutation and try to constrain it later.

### "Open in dohc" conversion

Do not convert merely because a signed-in person opens a URL. Require explicit acceptance and say that the owner will learn the account identity. Keep the new named grant dependent on the link's generation, access, selector, revoke, and expiry. An owner can later promote it to an independent grant through a separate action.

## 3. What's missing

### Grant and identity decisions

- Whether one share can have several links, named grants, and mixed access levels.
- Whether selector scope is immutable after creation.
- Which access changes rotate the secret and whether rotations have an overlap window.
- Whether links expire, and how expiry differs from revoke.
- Whether derived named grants survive rotate, revoke, expiry, selector changes, or share deletion.
- Whether a browser principal is per link, browser profile, session, or published app. Per-link browser identity is the least tracking-prone default.
- How an unverified claimed name appears beside a verified account identity.
- What the owner can inspect, block, delete, and export from the audit record.

### Secret and session decisions

- Secret entropy, encoding, hashing, comparison, rotation, and recovery.
- The credential exchange protocol and its resistance to CSRF, link unfurlers, and replay.
- Cookie host, path, lifetime, SameSite policy, and grant-generation binding.
- WebSocket ticket audience, lifetime, refresh, origin check, and invalidation deadline.
- Whether access widening always creates a new URL.
- The exact commit boundary for a write racing revoke or downgrade.

### Live document decisions

- Which document kinds support browser Edit. The rendering list promises only Excalidraw view.
- Whether pinned versions and whole-version selectors may be edited.
- Whether authority follows a path or a stable object after move or rename.
- What a desktop named recipient may do offline.
- What store receives an update before acknowledgement.
- Who allocates host epochs and what clock or quorum assumptions apply.
- How a new host proves catch-up and how a stale host is fenced.
- When View reads the live Y.Doc and when it reads settled Markdown.
- Settlement cadence, crash recovery, compaction, and maximum document size.
- The retained provenance format after update compaction.
- Restore target, restore grain, lineage replacement, and handling of later good edits.

### Comment decisions

- Whether discussion belongs to the share or to one file.
- Comment behavior for folders and pathless version shares.
- Text length, rate limits, editing, deletion, moderation, retention, and notification rules.
- Whether reactions, decisions, mentions, and attachments are available to link principals.
- Malware and quota policy if anonymous attachments are allowed.

### App decisions

- The immutable publication identity and the source, lockfile, manifest, and bundle digests it binds.
- Where builds run and whether config, plugins, package scripts, dependencies, and network are allowed.
- Whether source changes publish automatically. They should not.
- Whether one link can expose several apps without sharing an origin or storage.
- Service-worker, storage, navigation, popup, download, CSP, Permissions Policy, and network rules.
- The resource and operation grammar for app data, including row ownership and schema evolution.
- The authoritative structured-data store, its offline behavior, sync and conflict rules, export, deletion, backup, restore, and self-hosted deployment.
- Whether data capabilities can reference resources outside the path selector and how the UI discloses that expansion.
- Transitive effects reachable from a data mutation.
- History and reverse actions for writes and capability changes.

### Privacy, abuse, and operations decisions

- Which owner, workspace, path, history, participant, presence, and freshness metadata a link reveals.
- Whether remote media is blocked, fetched directly, or proxied.
- Cache and CDN policy, search indexing, bot previews, and downloadable content types.
- Limits for authentication attempts, sockets, Yjs work, chat, app mutations, rendering, storage, and egress.
- The owner-facing pause, block, delete, rotate, restore, and incident workflow.
- Whether public usage can exhaust the owner's normal sync quota.
- Access-log redaction, audit retention, IP retention, and privacy disclosure.
- The self-host DNS, TLS, origin, proxy, durable-storage, backup, and degraded-mode contract.

## 4. Simplifications

These cuts preserve local-first ownership, meaningful self-hosting, browser sharing, real apps, and eventual multiplayer collaboration.

1. Use one configured session host per deployment in v1. Cloud uses the service host. Self-hosters run the same host or choose device-only mode. Defer automatic takeover and handback.
2. Normalize `share`, `grant`, and `link credential` now. Do not carry the one-row recipient model forward.
3. Allow access narrowing in place. Mint a new URL for privilege increases. This makes leaked-credential behavior obvious.
4. Ship accountless View first. Start with folder navigation, sanitized Markdown, safe images, and forced downloads for untrusted formats.
5. Add text-only Comment through one share-level discussion. Defer attachments, reactions, decisions, and anchored comments.
6. Exclude chat-channel selectors from public links until browser chat has its own access and privacy design.
7. Limit the first Edit release to existing Markdown live documents on `main`. Exclude create, rename, delete, Excalidraw editing, pinned versions, and pathless whole-version selectors.
8. Prove named browser Edit before anonymous Edit. Both use the same Y.Doc path and host, but named identity removes one variable during durability testing.
9. Defer automatic "Open in dohc" conversion. A desktop can initially open the link with link-dependent authority.
10. Publish immutable capability-free app bundles first. Add read capabilities after the origin and approval model passes review.
11. Defer writable app data. If a launch use case requires it, implement one typed create-only collection instead of a general data interface.
12. Disable service workers, persistent app storage, raw HTML, inline SVG, and remote embeds in v1. Add each only with a specific use case and threat test.
13. Keep `share-web` and session hosting as modules that may ship in one process. Do not create a separate deployable merely to match the design nouns.

## 5. Sequencing advice

### Phase 0. Settle the contracts

Write the entity and state machines before route or UI planning:

- Share, grant, credential, derived principal, and derived named grant.
- Access transition, rotation, revoke, expiry, selector change, and deletion.
- One `authorizeShareAction` interface that accepts a server-derived principal, action, and current resource, then returns the effective capability or a generic refusal.
- Host lease, epoch, durable acknowledgement, settlement, audit, and restore.
- Publication revision, owner approval, app capability, and data mutation history.

The authorization module should be deep. Callers should not know how link generation, grantee kind, selector containment, app approval, or owner standing combine. The relay owns the external seam. The engine remains a fail-closed backstop for the effective selector.

### Phase 1. Prototype the failure cases

Prototype these before committing to implementation shape:

1. **Credential lifecycle.** Exchange a fragment secret, open HTTP and WebSocket sessions, then rotate, revoke, narrow, and widen access. Prove that no old generation commits after the transition and that no secret appears in logs, history, referrers, or cache keys.
2. **Interleaved restore.** Run a vandal and two legitimate Yjs editors, then execute the owner stop-and-restore action. Verify what good work is lost, what audit remains, and how every client recovers from the successor lineage.
3. **Host failure.** If automatic takeover remains under consideration, partition two hosts, expire a lease, wake the stale host, replay delayed frames, and crash after journal append but before broadcast. Require zero lost acknowledged updates and zero stale settlements.
4. **Selector drift.** Move, delete, and recreate a document while a link edits it. Narrow the selector and access during an append. Fetch `../` assets. Every stale action must fail at commit.
5. **Browser isolation.** Attack the viewer and app origins with raw HTML, SVG, MIME confusion, service workers, CORS, CSRF, navigation, remote fetches, cross-app storage, and attempts to reach viewer credentials.
6. **Anonymous load.** Exercise real CRDT decoding, replay, projection, compaction, presence, comments, downloads, and egress under per-link limits. Do not benchmark only WebSocket frame throughput.

The rollback prototype is the earliest product test. If a document-level forward restore is not acceptable when edits interleave, the safety case for anonymous Edit fails and the Edit decision must change.

### Phase 2. Build a View-only vertical slice

Implement link creation, secret exchange, grant-scoped relay reads, safe folder navigation, rendering, downloads, rotation, revoke, and owner audit. Use the final share/grant model and final credential-generation semantics. Do not create a temporary public relay path.

Test generic refusals, granter ownership loss, path moves, version shares, blob reachability, stale cache entries, hostile content, bot unfurls, and bandwidth limits. Show `last settled` or another honest freshness indicator.

### Phase 3. Add text-only Comment

Add the server-minted link principal and the share-level discussion object. Extend the chat author contract without weakening named-user authorship. Prove comment deletion, owner moderation, notification throttling, quotas, revoke during append, and audit retention.

### Phase 4. Build the durable live-document path

Add grant generation and host epoch to the session ticket and mutation path. Journal before acknowledgement. Persist authorship outside the prunable Y.Doc update cache. Build the stop-and-restore action before exposing Edit.

Enable named browser Edit on the one configured host. Test restart, stale frames, path movement, access change, compaction, settlement, and restore. Add anonymous Edit only after the same path passes adversarial load with link principals.

### Phase 5. Publish apps in layers

Start with immutable capability-free bundles on the final origin model. Then add owner-approved read capabilities tied to the bundle digest. Only then prototype one typed create-only mutation with idempotency, schema validation, provenance, quota, history, bulk undo, and a local-first replication path. General writable data should exist only if real apps prove the narrow operation insufficient.

## 6. Verdict

Revise first.

The design has settled desirable product behavior but not the mechanisms that preserve dohc's product invariants. Implementation planning should wait for these revisions:

1. Replace the one-row share/grantee model with share, grant, and credential records.
2. Put link verification and action authorization at a relay-owned seam. Give `share-web` no broad workspace authority.
3. Define grant generations and commit-time invalidation for every derived credential and active session.
4. Remove automatic host movement from v1, or specify and prove durable leases, fencing, and append-before-ack first.
5. Define a server-minted anonymous principal and durable provenance that survives Y.Doc compaction and settlement.
6. Define rollback as an executable stop-and-forward-restore workflow, including active-session fencing.
7. Define selector-drift behavior for live objects and every referenced asset.
8. Replace "manifest equals boundary" with immutable publication approval and an effective capability grant.
9. Define the structured-data source of truth and replication lifecycle. Defer writable app data or constrain it to one typed operation with quotas, history, and undo.
10. Stage View, Comment, named Edit, anonymous Edit, and app writes rather than treating all three access levels and both write lanes as one v1 milestone.

Three tempting objections do not change this verdict. End-to-end encryption is not a new prerequisite because the existing share model already exposes plaintext to the relay, though the UI must disclose it. Client-transparent failover is not required; correct fencing is. The single product term `app` is not a problem; the missing publication and capability modules are.

Once these decisions are recorded, the design is sound enough to plan in vertical slices. Until then, the largest risks sit exactly where dohc promises to be rigid: authorization, isolation, history, provenance, and ownership.

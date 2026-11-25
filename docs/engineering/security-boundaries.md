# Security boundaries

Use this reference when changing sharing, app execution, datasets, or automations.
The product invariants remain in [AGENTS.md](../../AGENTS.md).

## Grants authorize each action

The relay owns share selectors, grants, and link credentials. It derives authority
server-side and checks current access at reads and authoritative commits.
Browser identities provide provenance, not additional authority.
See the [grant transitions](share-grants.md) when changing generations or credentials.

Share-web exchanges a link secret for a scoped relay capability. It has no standing
workspace authority and does not read relay storage directly. Keep generic public
refusals, origin checks, and credential isolation.
Every link route, the live routes included, takes that capability as
`Authorization: LinkCapability <capability>`, so the relay never reads one as
another kind of credential.
The [operations reference](../../services/share-web/README.md) defines deployment controls.

## An owner reads their workspace in a browser with their own sign-in

The owner signs in on share-web with their email and password. That makes a
`browser` session, which share-web keeps in its host-only cookie. For the owner,
share-web forwards that cookie to the relay with its own origin and the relay
exchange key, as it does for a workspace member. The page names the workspace
with `Authorization: DohcOwner <workspace>`. The relay finds the person from the
cookie, checks that they own the workspace and that the account isn't fenced,
and gives them an admin's reach. Secret files, ignored files, and folder markers
stay hidden. The owner holds no share or grant, so the relay checks ownership
again on every read.

This is the one place a browser session carries authority: the owner's browser
reads what the owner's computer reads. It reaches only the link read routes
(`/sync/link/share`, `current`, `log`, and `blobs`) and the list of the
account's workspaces at `/sync/members/workspaces`. It also reaches the
named-chat routes for the Groups and file Comments an admin reaches. The owner
posts there only as a person, under the relay's own `relay:owner-browser:`
origin, and deletes messages there as an admin does. The owner's browser
edits a page live as the owner's phone does, through the page open and the
one-use ticket for `/sync/workspaces/<id>/live/owner`, without the phone's Show
on phone switch. Its edits are the owner's own and never an agent's, and the
relay checks its sign-in every minute. The other account
routes, member management, settings, and sharing still refuse a cookie. A
browser can't read General, direct messages, or agent chats. Each new read checks the session
again, so signing the browser out ends its access. A history read already
waiting for changes does not check the session again, so it can return the
changes made during its wait. A member's browser behaves the same way.

## Agents act with their link's access

An agent connection holds no authority beyond its link grant. The relay keeps
only keyed hashes of its codes, tokens, and MCP address.

An agent signs in through share-web with the standard MCP authorization.
Share-web sends each step to the relay's agent routes with the exchange key. It
keeps no client, code, token, or authority, so a restart signs no agent out.
The relay starts a sign-in only for `<share-web origin>/mcp/s/<secret>` of a
link it can serve. The consent decision must come from share-web's own
`Origin` and carry a `__Host-` cookie, set for that one request, that matches
the form's secret. These checks stop a page on another site from allowing an
agent through a person's browser. They do not limit who can sign in. The MCP
address holds the link secret, so anyone who has it can open the consent page,
allow their own agent, and get the link's full access. Treat the MCP address
as the link itself.

The consent page sends a `same-origin` referrer policy, so its form's post
carries the `Origin` the decision checks. Its CSP lets the form post only to
share-web and follow the redirect to the origin of the redirect URI the relay
accepted. The sign-in error pages allow no form. The metadata, registration,
token, and MCP answers allow any origin but no credentials. The consent page
and its decision send no CORS headers.

Share-web calls the relay's link routes for an agent with
`Authorization: DohcAgent <access token>`, the MCP address in
`x-dohc-agent-resource`, and the relay exchange key. The relay refuses an agent
request that also sends a link profile or a cookie. It refuses a link
capability that names an MCP address. Every refusal is the response for a link
that does not exist.

Each read and write checks the access token's expiry, the connection's status,
the MCP address, the link's current credential and generation, and the current
access. With this header, an agent reads the share, its files, its discussion,
and a Group link's messages. It posts to the discussion and writes a Collection
through an Edit link. Through an Edit link, it also finds a Markdown file and
opens it as a live document. Agent chat takes the access token and the MCP
address in its request body and makes the same checks. Other link routes refuse
an agent.

A live ticket issued to an agent names its connection. Redeeming the ticket
checks the access token again, with the clock read in that transaction. So does
every later check of the live session: each wake, read, and edit. Disconnect,
Reset link, and End link each commit a relay write, which wakes every live
session, so the agent's session closes. Nothing writes when an access token
expires, so its session closes at the next check. Each live edit records the
connection's own link principal, never a link holder's.

On the link routes, a response, blob or JSON, checks again before each chunk.
Agent chat checks once, before it answers. A write checks again in its
transaction, with the clock read there. The agent writes as its connection's
link principal, so pause and block apply to it. Each message and Collection
write it makes records its agent connection.

The relay keeps a used refresh token for 30 days after its use. Reuse in that
time ends the connection. After that the token is unknown, and the next refresh
deletes it.
See the [agent link tests](../../services/sync-relay/src/linkAgentAuthority.test.ts),
the [live route tests](../../services/sync-relay/src/namedLiveRoutes.test.ts),
and the [sign-in tests](../../services/share-web/src/mcpSignIn.test.ts).

## A personal agent's live session is provenance only

A personal agent edits a live document with its owner's access, and adds only
its name to the record. It edits only in a workspace its owner owns, only where
the owner gave it Edit, and never through a share.

Share-web calls `/sync/live/personal-document`, `/sync/live/personal-tickets`,
and the `/sync/live/personal?workspaceId=` socket with the agent's access
token, its MCP address, and the relay exchange key, as it calls the agent's
other personal routes. A request names only a workspace and a path, or an
object. The relay derives the agent, its owner, its reach, and the account's
fence from the token and its own tables.

The open, the mint, and the socket each read the fence again. Each checks the
token, the agent's Edit reach in a workspace its owner owns, and the
self-hosted live host. A ticket names the agent's connection, so another
connection, another agent, or a link can't redeem it. The session's authority
is `personal`, with the agent's id and no grant. Each edit records the agent as
its author, on behalf of the workspace's owner. The relay ignores any context
an update declares.

The relay reads the fence again before it sends the initial state, before it
releases each received update, and before it commits each edit. Each session
registers as running work that needs Edit. Sign-out, removing the agent,
narrowing its reach, lowering its level below Edit, and a newer fence each end
the session at the commit that makes the change. An expired token ends it at
the next update. Share-web mints a ticket and opens a session for each tool
call, with the token that call carries, so no ticket or socket serves more
than one tool call.
See the [personal live route tests](../../services/sync-relay/src/personalLiveRoutes.test.ts),
the [held open tests](../../services/sync-relay/src/personalLiveDocumentRoutes.test.ts),
and the [share-web tool tests](../../services/share-web/src/personalLiveDocument.test.ts).

## A phone edits a page only with its sign-in's ticket

A phone sign-in reaches a page for editing in two steps. Each one checks the
sign-in, its account fence, the workspace's owner, and Show on phone.

1. **Open.** The phone sends `POST /sync/:workspaceId/ops/openPage` with
   `{path}` and its Bearer. Only a phone sign-in can open, and it has its own
   pace and its account's. A secret file's path and a path with no page answer
   the same `missing`. The relay checks the path before it enrolls anything.
   - **A page with no live history.** If no computer has opened the page live,
     the relay holds no Y.Doc lineage for it on main. The open answers
     `live-document-without-lineage` and enrolls nothing: its owner opens it on
     a desktop first. The server makes no lineage of its own, for a phone or
     for a personal agent.
   - **A page with history.** The open enrolls it as the owner's open. It never
     resumes a Pause or Stop. A page enrolled before at another path answers
     `document-unavailable`. A phone's open creates no new enrollment once its
     account has 16 pages enrolled by its owner's opens. A desktop open counts
     toward those 16, but the limit never stops one, so after 16 desktop
     opens a phone's open of a new page answers `live_host_full`. Pages
     enrolled only through a share or an agent don't count, and neither does
     the page being opened if it is already enrolled. Until the live host
     activates the page, the open answers `preparing`.
   - **Checks.** The open checks access again after reading the body, and
     before and after minting.
2. **Ticket and connection.** Once the page is ready, the open reads the
   sign-in from the session table without a cache. The sign-in must still be
   a phone sign-in for the same account. That read and the mint each stop
   waiting after 10 seconds. The ticket ends within 30 seconds, and never after
   the sign-in. Only the response body carries it. The open reads the page
   again after minting. A page moved to a secret path meanwhile answers
   `missing`, and one whose binding changed answers `preparing`. The
   phone presents the ticket once, as the `dohc-live-ticket.*` protocol beside
   its Bearer, on the owner connection. Only that sign-in can redeem it, for
   that page's current binding.

The connection ends when the phone signs out or the sign-in is revoked, at
once through the relay, or within 60 seconds when another process deletes it.
It also ends when the sign-in expires, when Show on phone turns off, when the
account is fenced, and when the binding changes. A reconnect needs a new open.
An edit admitted before the end is kept and saved.
See the [phone page tests](../../services/sync-relay/src/phonePages.test.ts),
the [owner connection tests](../../services/sync-relay/src/namedLiveRoutes.test.ts),
and the [native phone open proof](../../services/share-web/src/selfHostedLiveNative.integration.ts).

## Live documents have one canonical host

The session host holds the canonical Y.Doc. It journals accepted updates durably
before acknowledgement and settles Markdown through the engine.
With no host online, shared files remain readable but live editing pauses.
Automatic device-to-service failover requires fences against competing writers.

Direct Edit checks the sender's grant in full when the relay accepts each edit,
not again when the edit is saved to the note. An edit accepted before access
ended is kept. It is saved to the note, or, if the note can no longer take it,
kept in the copy its owner gets when the note pauses. Each save holds one
sender's edits and is stored under the access that sender had when the relay
accepted them, never the owner's. Others' edits handed to a reader check its access again at
most once a second, so a reader whose link session or token expires can receive
them for up to a second more. Its own edits are refused at once, and access
removed by hand ends its connection at once.

Direct Edit also requires stop and restore. Before they close the note, stop
and restore save every edit the relay accepted, or keep it in the note's copy
when the note pauses.
Restore creates a forward change and preserves legitimate unsynced work.
It cannot promise selective removal of one author's interleaved edits or recovery
of work already deleted before the restore point.

## App approval pins code and capabilities

A manifest requests capabilities. Only an immutable, owner-approved publication
grants them. Changed source, dependencies, or capabilities require a new review.
Apps receive only approved data and operations, subject to current grants and
server policy. Their browser origins remain isolated from viewer credentials.

Collection-create responses are ordinary shared files. Anyone with the share can
read every response field, including fields outside `readFields`.
Private responses require a dataset with explicitly authorized reads.

Frontends can contact external services and send received data elsewhere.
Approval does not certify app behavior. Withdrawal stops later authorized dohc
reads and writes; it cannot recall data or stop a loaded app's external traffic.
Keep these limits visible during approval and launch.

The fixed compiler reads declared inputs and bundles approved dependencies.
It does not run app-provided configuration, plugins, build hooks, or source.
Remote scripts stay blocked. On Windows, the compiler's process limits and
minimal environment do not provide OS network denial. On macOS, Seatbelt also
denies the network, reads of file contents other than the compiler's, the OS
libraries' and the build directory's, and writes outside the build directory.
It does not stop a compromised worker reading other processes' arguments and
environment. [App compiler containment](app-compiler.md) states what each
platform bounds. Arbitrary build scripts need a separate, credential-free sandbox before
they can run.

## A phone runs an app in a locked web view

The phone posts a one-use handoff to the app's bootstrap on a random host under
the app domain. The app runs in the bootstrap's sandboxed `srcdoc` frame, with
no top navigation and no same-origin access. The server's CSPs allow no frames
in the app, no form posts and no workers. Its permissions policy allows no
camera, microphone or location. These hold in any browser that opens the app.

The phone's web view adds its own refusals. After the bootstrap it refuses
every top-level navigation, hands no address to the system, saves no download,
grants no camera, microphone or location, and turns a new window into a link
the person tapped. The phone asks before that link leaves dohc, and only for
HTTPS outside the dohc server and the app domain (`apps/mobile/src/apps/`).
The app's own requests and subresources follow its CSP.

- iOS uses react-native-webview: incognito, a navigation rule for every frame,
  and a separate web content process.
- Android uses dohc's own view (`apps/mobile/modules/app-web-view`), which
  decides in native code and refuses by default. Android doesn't report HTTP(S)
  frame loads or POSTs to it, so those rules rest on the sandbox and CSP.
- On Android, an app shares the web renderer process with dohc's page editor.
  Browser rules separate them, but a Chromium exploit would not be contained.
- On Android, the launch cookie lives in the app's shared cookie jar until the
  launch expires. Each launch has its own host and needs the launch's proof.

## Dataset hosts commit authority

A transactional dataset's checkpoint and committed journal are authoritative.
Isolated workers evaluate approved operations and materialize committed events.
The host rechecks access and commits changes, retry receipts, history, file
associations, quotas, and the revision together. Recovery applies committed events
without rerunning authored code.

Collections, apps, forms, imports, and agent tools use that authority.
Document Collections keep record properties in the live document's frontmatter
map and project them to Markdown on settlement, without a second field writer.
Shared datasets have one configured writer; unavailable hosts cannot accept
offline shared writes. Cross-dataset transactions are unsupported.
See the [runtime contract](../../packages/app-backend-runtime/README.md).

A link app hears that its Collection changed through a held read,
`/sync/link/app-publications/<id>/backend/events`. It answers only the
Collection's alias and revision, so a link holder learns when anyone writes
there, but nothing about what was written. The relay answers only while the
link can run one of the app's read operations: the same check an invoke makes,
including pause, block, narrowing, archive, and withdrawal. A link that can only
write gets no answer. The relay checks again before every answer, and wakes held
reads at least once a second while writes happen, so an ended link's held read
is refused within about a second. Held reads count against the link read
budget, at most 256 per link grant and 1,024 in all.
See the [route tests](../../services/sync-relay/src/datasetRoutes.test.ts).

Persistent Collection workers isolate SQLite memory differently by host runtime.
Desktop Electron utility processes and Node.js builds linked against a shared SQLite
with `SQLITE_DEFAULT_MEMSTATUS=1` (such as Homebrew Node on macOS) enforce
`PRAGMA hard_heap_limit=67108864` (64 MiB) inside SQLite's allocator, returning
`SQLITE_NOMEM`, which the worker surfaces as a `resource_limit` refusal naming the
64 MiB SQLite memory limit without killing the worker. Official standalone Node.js
builds (`services/sync-relay`) bundle `node:sqlite` with `SQLITE_DEFAULT_MEMSTATUS=0`,
which ignores `PRAGMA hard_heap_limit`. When `DEFAULT_MEMSTATUS=0` is detected,
persistent workers enable a 256 MiB peak-RSS ceiling on their budget watch thread
during budgeted steps (app code and dataset checks, polled every 50 ms and rechecked
at step completion). Crossing the ceiling kills and recycles the worker with
`worker_budget` naming the limit, unit, and observed peak usage. Because this
watchdog observes OS RSS after pages fault rather than inside SQLite's allocator, it
bounds sustained and completed allocations without replacing host memory limits.
Snapshot evaluations (`child.ts`) on standalone Node with `DEFAULT_MEMSTATUS=0` rely
on `deadlineMs` and `PRAGMA max_page_count`.

## Automation edits do not widen access

An automation can reach only what all its Collection's editors can reach.
The executor checks each target even when it runs on the owner's computer.
Personal steps use one person's access and remain limited to Collections only
that person can edit. Sharing can stop steps that exceed the editors' common access.

When unchanged steps become allowed after an editor is removed, a current editor
must confirm them. Removing an editor cannot silently activate their stopped code.

Record-triggered runs originate on the device that journals the triggering change.
Schedules, Group messages, and buttons pressed in a received share run on the
configured automation host. Shared presses require the presser's current named
Edit grant and expire after 30 days if unclaimed. Revoked presses cannot run.
Claims and idempotent workspace writes bound crash retries; they do not provide
exactly-once external effects.
The [reach tests](../../packages/automation-executor/src/automationReach.test.ts)
and [verdict tests](../../packages/automation-executor/src/reachVerdicts.test.ts)
cover the access rules.

## Direct Collection writes stay narrow

Edit on a Collection permits validated changes to its `collection.yaml` and
`automations.yaml`. Named recipients and Edit link holders can also create a
Collection with its first records inside a shared folder.
Named recipients must choose to propose other file changes.
Link holders cannot submit proposals, so unsupported changes are refused.
A dependent named grant needs promotion before it receives this direct lane.
Edit link holders can change the Collection's own files, with their grant and
server-minted link principal recorded as authors.

The relay checks current grant generation, expected file state, and content before
commit. The owner's engine admits only the allowed files and authors from the
relay's origin. Each author kind requires working stop and restore.
See the [Collection write tests](../../services/sync-relay/src/collectionWrites.test.ts).

## Share history needs Edit

A View or Comment grant reads current files only, by link or by name.
The relay serves such a grant a file's content only while it is that file's
current state. No log op, content hash, blob, or live document
session gives it a version replaced earlier. It keeps following later changes.
The relay reads the level from the current grant on every request, so a
narrowed grant loses history on its next read. Bytes a device already holds stay there.

An Edit grant reads the share's retained history. A named Edit recipient reads
every version that an op admitted by its selector names, with no epoch floor and
no grant-time cutoff.
A workspace member's level differs by folder, so the relay judges it at the
path each version was written to. A member reads a version only if they have
Edit at that path. A version written where they have View or Comment reaches
them as current content only. A version written where they have Edit stays
readable after the file moves into a View folder, as it does for a named Edit
recipient.
A link with Edit reads earlier revisions only while the same file remains
continuously inside its share and the revision remains above the workspace's
epoch floor. Deletion or movement outside the share withdraws that file's
history from the link immediately. Moving it back does not restore earlier
access. A content hash alone grants nothing.

An overwrite leaves previous content readable to Edit within retention. Removing
sensitive text from an Edit share requires withdrawing the file or revoking the grant.
Every read rechecks current authority and uses bounded history scans.
See [share reads](../../services/sync-relay/src/shareReadQueries.ts) and the
[named recipient tests](../../services/sync-relay/src/namedShareHistory.test.ts).

## Workspace secrets and outbound HTTPS

Workspace automation secrets are separate from `.env` secret files. They stay write-only
and outside the workspace directory, so copying a workspace or running a file-based agent
inside it never exposes secret values.

Each secret belongs to one workspace and has one fixed purpose:

- `http-header`: an opaque credential (printable ASCII without tabs or line breaks, up to
  4 KiB) pinned to 1–10 exact lowercase public hostnames. It can be attached only to
  requests whose canonical host matches that list.
- `http-url`: a complete public HTTPS URL (port 443, no credentials, no fragment, no IP
  literals or local hosts, up to 2 KiB), reserved for outbound destination URLs and never
  returned by any list or metadata API.

Creating, rotating, and deleting workspace secrets happen only through the desktop
Settings UI. Add uses create-only semantics and Replace updates an existing name, so a
stale list cannot silently overwrite a secret. CLI and MCP doors expose no secret
mutation operations, preventing local or connected agents from overwriting a secret URL
or credential. Saved secret values never return to the renderer; while the owner types a
new value in the desktop Settings dialog, the unsaved input lives transiently in the
trusted desktop renderer until saved, cancelled, or unmounted, isolated from sandboxed
apps and previews.

Storage follows the workspace's sync mode:

- **Local-only workspaces** seal secrets in the desktop profile's `workspace-secrets/`
  folder (`0700` directory, `0600` file) with Electron `safeStorage`. On Linux, dohc
  checks that `safeStorage.getSelectedStorageBackend()` is neither `basic_text` nor
  `unknown` and refuses to store secrets when no OS keyring is active. An unreadable or
  schema-invalid local vault fails closed instead of appearing empty, so existing
  ciphertext cannot be overwritten. OS keychain storage keeps values out of workspace
  files and API responses; it does not defend against arbitrary code running as the same
  OS user. Turning on sync later does not copy local secrets to the server; the owner
  enters them on the server directly. Pausing sync on a synced workspace keeps its server
  binding and refuses secret reads or changes until sync resumes instead of switching to
  local keychain storage.
- **Synced workspaces** seal secrets on `sync-relay` in `sync_relay_workspace_secrets`
  using AES-256-GCM (12-byte random nonce, key derived via HKDF-SHA256 from
  `DOHC_RELAY_LINK_KEY` with info `dohc-workspace-secret-seal-v1`, recorded `key_id`, and
  AAD binding workspace, owner, secret name, usage, allowed hosts, generation, and key ID). The relay
  accepts only cookie-less desktop owner Bearer sessions (`resolveAccountSession` with
  `clientKind === "desktop"`), refusing browser sessions (cookie or Bearer), phone
  sessions, personal agents, share links, and non-owners, and rechecks session authority,
  account fencing, and workspace ownership at commit time. Because the server holds the
  sealing key in its environment, the server operator (dohc Drive or a self-hoster) has
  technical capability to unseal stored secrets at runtime; rotating `DOHC_RELAY_LINK_KEY`
  invalidates previously sealed secrets until re-entered. Account deletion purges all
  workspace secret rows automatically.

Shared outbound HTTPS transport (`packages/service-http/src/safeOutboundHttps.ts`)
enforces HTTPS on port 443 only, rejects credentials, fragments (including empty `#`),
raw IPv4/IPv6 literals, trailing dots, single-label hosts, and reserved local suffixes
(`.local`, `.internal`, `.localhost`, `.home.arpa`), resolves cancellable DNS A and AAAA
records via `node:dns/promises` `Resolver` with a 2-second timeout, refuses any answer
containing a private, loopback, link-local, carrier-grade NAT, multicast, mapped,
translated, or non-global IP, brands the resolved destination internally so forged or
mutated destinations are rejected, pins the validated address through `node:https`
connect with TLS certificate verification (`servername` set to the canonical host,
`rejectUnauthorized: true`, `autoSelectFamily: false`, `agent: false`, no proxy env
variables), enforces a finite request timeout (default 10 s, capped at 30 s), disables
response compression (`Accept-Encoding: identity`), refuses redirects by default, bounds
header and response sizes, and scrubs transport errors.
Hosted relays still require host or network egress isolation: IP classification alone
cannot tell whether a public-looking IP routes to an internal network service.
See the [outbound HTTPS tests](../../packages/service-http/src/safeOutboundHttps.test.ts),
[relay secret route tests](../../services/sync-relay/src/workspaceSecretRoutes.test.ts),
and [local secret store tests](../../apps/desktop/src/workspaces/localWorkspaceSecretStore.test.ts).

## Incoming webhooks

Incoming webhooks accept unauthenticated HTTPS `POST` deliveries at `/sync/hooks/:token`
and turn each delivery into a quarantined Markdown record inside a private Collection
(defaulting to `Inbox`) owned by the workspace owner.

- **Routing and log redaction.** `/sync/hooks/:token` is matched before `/sync/:workspaceId`
  and `hooks` is a reserved workspace ID. Request logs collapse the route to
  `/sync/hooks/:token` so raw webhook tokens never enter relay logs. Self-hosters enabling
  reverse-proxy access logs must redact `/sync/hooks/*` paths as documented in
  `tools/self-host/Caddyfile`.
- **Owner management authority.** Creating, listing, renaming, pausing, resuming, rotating,
  and deleting incoming webhooks under `/sync/:workspaceId/webhooks*` accept only cookie-less
  desktop owner Bearer sessions (`clientKind === "desktop"`), rechecking session authority,
  account fencing, and workspace ownership before every mutation. Each workspace is capped at
  20 incoming webhooks. Raw tokens are shown once at creation or rotation and stored only as
  keyed `HMAC-SHA256(DOHC_RELAY_LINK_KEY, ...)` digests compared in constant time.
- **Public ingress defenses.** `POST /sync/hooks/:token` rejects non-`POST` methods with
  `405` and self-loop headers (`X-Dohc-Chain-Depth >= 4`) with `422`. Token lookup runs
  before rate limiting: unknown, malformed, paused, deleted, or fenced endpoints return an
  opaque `404 { ok: false, error: "not found" }`, and unknown-token probing uses a separate
  global probe bucket so scanners cannot starve valid endpoints. Active endpoints enforce a
  per-endpoint token bucket (30 burst, 0.5/s refill), a 500 deliveries/day cap (recording at
  most one daily Notice naming the limit), a 100 pending deliveries / 4 MiB pending bytes
  budget, an allowlist of `Content-Type` (`application/json`, `text/plain`,
  `application/x-www-form-urlencoded`), a streaming 256 KiB body cap with a 10 s read timeout,
  header allowlisting (`Content-Type`, `Idempotency-Key`, `X-Webhook-Delivery`,
  `X-Event-Type`, `X-GitHub-Event`, `User-Agent`), and 7-day idempotency (`202` deduplicated
  on matching SHA-256 body hash, `409` on mismatch).
- **Queue-only ingress, server-host requirement, and fenced drain.** Incoming webhooks require
  server-hosted automations and the sync server as the workspace's active automation host;
  creating or resuming a webhook on a computer-hosted workspace fails with `409`, and servers
  without server-hosted automations refuse management/delivery with `503` instead of accepting
  undrained `202` deliveries. Ingress only enqueues deliveries (`202 Accepted`), re-verifying the
  keyed token digest and active server host inside the SQLite enqueue transaction after streaming
  the body so a token rotated mid-upload cannot enqueue; it never opens `ServerCopy` or runs user
  code. The fenced automation host drains pending deliveries under its host generation and per-open
  lease fences (recovering `accepted` rows across same-generation restarts), preserves the validated
  `X-Dohc-Chain-Depth` (`0..3`) on the record's author
  `{ kind: "automation", automationId: "webhook:" + webhookId, onBehalfOf: owner, depth }`,
  writes each record deterministically (`derivedRecordId("webhook:" + deliveryId)`), quarantines
  the full accepted payload inside an escaped fenced code block without truncating payload bytes,
  applies exponential retry backoff with a 5-attempt cap settling persistently failing deliveries
  as `failed`, and immediately nulls `payload_blob` and zeroes `storage_bytes` upon settlement or
  terminal failure (updating `sync_relay_workspace_usage` via SQLite triggers). Hourly relay
  maintenance prunes expired settled/failed/paused delivery metadata after the 7-day idempotency
  window.
- **Private-Collection boundary.** Incoming webhooks deliver only to private solo Collections
  in v1. Creating, retuning, or undoing the removal of any share grant (View, Comment, or Edit,
  including whole-version `paths: []` shares) covering a webhook's Collection or any ancestor
  folder atomically pauses the webhook and clears queued payload bytes; resuming is refused with
  `409` while the share remains active. Both the drain and `appendLogBatchInTransaction` (under
  SQLite `BEGIN IMMEDIATE`) enforce Collection privacy: any in-flight replica write from a webhook
  whose Collection was shared before replication commits is atomically marked
  `relay_admission = 'departed'` so zero rows enter `sync_relay_current_files` or
  `sync_relay_object_moments` and zero log ops or blob bytes ever reach a share recipient, while
  keeping the coordinate's `op_kind` intact so the pushing replica's pull advances without
  `OriginDiverged` and the drain confirms publication before settling. Account deletion
  purges all webhook definitions and deliveries via `ON DELETE CASCADE`.
  See the [incoming webhook route and drain tests](../../services/sync-relay/src/incomingWebhookRoutes.test.ts).

## Decision numbers in existing code

Existing comments cite the former ADR numbers. Their current boundaries are here:

| Former decisions | Current reference |
| --- | --- |
| ADR 0001, ADR 0005 | [Grant authority](#grants-authorize-each-action) and [grant transitions](share-grants.md) |
| ADR 0002, ADR 0003 | [Live documents](#live-documents-have-one-canonical-host) |
| ADR 0004, ADR 0006 | [App approval](#app-approval-pins-code-and-capabilities) |
| ADR 0007, ADR 0010, ADR 0011 | [Dataset and document authority](#dataset-hosts-commit-authority) |
| ADR 0008, ADR 0012 | [Automation access](#automation-edits-do-not-widen-access) |
| ADR 0009 | [Hosting requirements](../reference/desktop-capabilities.md) and [local ownership](../../AGENTS.md#what-dohc-stands-for) |
| ADR 0013 | [Direct Collection writes](#direct-collection-writes-stay-narrow) |
| ADR 0014 | [Share history](#share-history-needs-edit) |

# dohc Cloud: Sync, Hosting, And Collaboration

dohc Cloud is the managed server side of dohc: account + device auth,
merge-based workspace sync, and live co-editing. It is the paid engine for
shared building — dohc brings git-grade building-collaboration (change sets,
history, attribution, AI-assisted merge) to everyday people, and the cloud is
what lets several of them build in one workspace.

Local-only dohc works fully with no account. A self-hosted dohc runs this
exact server stack from `docker-compose.self-host.yml` (see
`docs/self-hosting.md`). Federation between servers is deferred.

## The server process

`services/workspace-api/src/main.ts` is the one production wiring: a single
Node HTTP server with

- **Better Auth** mounted at `/api/auth/*` on the same Postgres as the
  workspace data (no auth vendor),
- the **workspace API** (`services/workspace-api/src/server.ts`) behind
  session-resolved actors,
- `/health` for probes.

Required env: `POSTGRES_URL`, `BETTER_AUTH_SECRET` (>= 32 chars),
`WORKSPACE_API_PORT` (default 1786), and optionally `HOCUSPOCUS_JWT_SECRET`
(below). The `/test/device/approve` impersonation seam is fail-closed:
`DOHC_TEST_AUTH=1` outside `NODE_ENV=development|test` crashes the server at
boot rather than exposing it, and with the seam on the server binds loopback
only.

## Auth: Better Auth device flow

`services/workspace-api/src/auth/betterAuth.ts` configures email/password
accounts, the `organization` plugin for team workspaces, the `bearer` plugin
(API calls carry `Authorization: Bearer <session token>`), and the OAuth
`deviceAuthorization` grant (10-minute codes, 3-second polling).

The desktop's side is `apps/desktop/src/workspaces/cloudLogin.ts`:

1. `POST /api/auth/device/code` — the desktop shows the short user code and
   opens `verification_uri` in the system browser.
2. The user approves in the browser against the server.
3. `POST /api/auth/device/token` — the desktop polls until approved; the
   access token IS a session token.

The token is persisted through the safeStorage-encrypted credential store
(`cloudCredentialStore.ts`) and never crosses IPC; the renderer only ever
sees status + email. Identity for every API call is derived server-side from
the session (`actorFromSession`, `auth/session.ts`) — never from
client-supplied ids. WorkOS remains the deferred enterprise-SSO path behind
this surface.

## Postgres schema roles

One database, three layers
(`packages/workspace-postgres/src/db/migrations/`):

- **`0001_initial.sql` — workspace data.** `workspaces`,
  `workspace_members`, `folders`, `atoms` (text files; `body` is a derived
  cache), `atom_revisions` (per-write revision history with the acting
  user), `assets`, `database_files` + `database_operations`, `permissions`,
  `shares`, `locks`, `app_packages`, `app_trust_grants`, `agent_runs`,
  `agent_approvals`, `workspace_events`, `document_states` (Yjs
  persistence).
- **`0002_better_auth.sql` — auth.** Better Auth's `user`, `session`,
  `account`, `verification`, `organization`, `member`, `invitation`, and
  `deviceCode` tables.
- **`0003_partial_path_unique.sql` — correctness fix.** Path uniqueness on
  `atoms`/`assets` is partial (live rows only) so soft-delete tombstones
  never wedge delete-then-recreate or rename-onto-a-deleted-name.

## Live co-editing: collab tokens and the Hocuspocus ACL

The workspace API is the only collab-token minter.
`POST /workspaces/:id/collab/token`
(`services/workspace-api/src/routes/collab.ts`) checks workspace membership
(membership before existence, so non-members cannot probe atom paths),
resolves the atom by path, and returns a 5-minute HS256 JWT
(`COLLAB_TOKEN_TTL_SECONDS` in `services/hocuspocus/src/auth.ts`) plus a
document name keyed by the stable `atoms.id` — paths can change, doc
identity cannot. The signing secret is `HOCUSPOCUS_JWT_SECRET`, shared
between workspace-api and the Hocuspocus service; a deployment without a
collab server leaves it unset and the route fails closed with
`collab-disabled`.

Hocuspocus (`services/hocuspocus/src/server.ts`) verifies that JWT and
enforces per-atom access through the Postgres ACL
(`services/hocuspocus/src/postgres-acl.ts`,
`HOCUSPOCUS_WORKSPACE_DATABASE_URL`): one SQL round trip over
`workspace_members`, `workspaces.owner_user_id`, `shares`, and `locks`
answers both canRead (member, owner, or view/edit share) and canWrite (read
plus member/owner/edit-share, and no active lock).

On the Postgres path the Yjs **plainText is canonical** for a live shared
document: the projection worker (`services/hocuspocus/src/projection.ts`)
writes the doc's text back into the atom body cache and inserts
`atom_revisions` rows, so pull-based sync clients and the live session see
the same content through the same tables. How that meets the desktop's
file-canonical model is covered in `docs/architecture/workspace-sync.md`.

## What "shared workspace" means

Sharing is a property of the workspace folder plus a binding, not a separate
data silo:

- the folder's `.dohc/manifest.json` has `kind: "shared"`
  (`packages/workspace-core/src/workspaceMode.ts` defines the kinds), and
- the desktop registry entry carries the `remote` binding
  `{ serverUrl, remoteWorkspaceId }`
  (`apps/desktop/src/workspaces/registryStore.ts`).

Membership, shares, and locks live server-side in the tables above. The
desktop only mints collab tokens for shared cloud workspaces with a
signed-in session; everything else stays a plain local folder.

## Self-host parity

There is no separate self-host build. `docker-compose.self-host.yml` runs
the same workspace-api and Hocuspocus services against the same migrations,
with `BETTER_AUTH_SECRET` and `HOCUSPOCUS_JWT_SECRET` supplied by the
operator. The desktop points at it with `DOHC_CLOUD_URL` (default
`http://localhost:1786` in `apps/desktop/src/main.ts`).
`scripts/check-self-host-desktop-path.mjs` proves the desktop-facing
surfaces (health + device flow) are live.

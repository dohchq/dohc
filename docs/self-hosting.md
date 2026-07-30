# Self-hosting

Self-hosting runs the optional sync stack. The desktop app remains local-first
and works without it.

## Services

- `postgres` stores Better Auth data.
- `postgres-migrate` applies the auth migrations before services start.
- `workspace-api` serves Better Auth and the desktop device flow.
- `sync-relay` serves operations, blobs, shares, presence, and co-editing.

The relay stores its application data in a mounted SQLite file.

## Start

```bash
cp .env.self-host.example .env.self-host
# replace every change-me value
pnpm check:self-host
pnpm check:self-host -- --start
```

The workspace API and relay must use the same `BETTER_AUTH_SECRET`. Keep the
default loopback bindings unless you have added TLS and an external access
policy.

## Migrations

`pnpm migrate` applies each SQL file under
`packages/workspace-postgres/src/db/migrations`. The first migration creates
the Better Auth schema. The cleanup migration removes unused application tables
from earlier pre-launch installations.

`pnpm reset:postgres` clears Better Auth development data. Do not run it against
production data.

## Backup

Back up:

- the Postgres database;
- the sync relay SQLite volume;
- deployment secrets.

Restore Postgres first, run migrations, then start the workspace API and relay.

## Security

- Browser clients do not provide trusted identity.
- Expose the services only through TLS.
- Use a high-entropy Better Auth secret.
- Keep Postgres and relay storage private.
- Test sign-in, relay push and pull, sharing, and revocation after an upgrade.

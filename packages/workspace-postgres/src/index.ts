// The reduced workspace-postgres surface: the Postgres schema migrations only.
// The former backend/provisioning/blobStore/import/atoms/assets/events surface
// was retired with the workspace-api routes it served, and the collab
// membership slice (hasWorkspaceMembership/listUserWorkspaces) was retired with
// Hocuspocus (G2-C-3). What survives is the `db/migrations/*` SQL — notably
// `0002_better_auth.sql`, the Better Auth user/session schema that the
// workspace-api auth server and the sync-relay both read (the relay queries the
// `"user"` table directly). The migration files are applied by
// `scripts/reset-postgres-dev-data.mjs` and exercised by
// `@dohc/workspace-auth`'s betterAuth.test; this pool helper stays available for
// scripts that need a connection.
export { defaultPostgresUrl, createPgPool } from "./db/client";

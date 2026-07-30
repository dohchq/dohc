// Postgres stores Better Auth state for the workspace API and sync relay.
// The migration files are applied by
// `scripts/reset-postgres-dev-data.mjs` and exercised by
// `@dohc/workspace-auth` tests. This pool helper stays available for scripts.
export { defaultPostgresUrl, createPgPool } from "./db/client";

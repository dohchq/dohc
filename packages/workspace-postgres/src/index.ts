// The reduced workspace-postgres surface: the collab membership slice. The
// former backend/provisioning/blobStore/import/atoms/assets/events surface was
// retired with the workspace-api routes it served; Postgres survives for Better
// Auth's user table and the collab route's membership check.
export { defaultPostgresUrl, createPgPool } from "./db/client";
export { hasWorkspaceMembership, listUserWorkspaces } from "./repositories/workspaces";

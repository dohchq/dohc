import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Phase 3 scaffold note: referential relationships are documented here but
// FK constraints are deferred until the migration path can prove soft-delete,
// restore, and dev-reset behavior without orphaning compatibility data.
// Expected relationships include:
// workspace_members.user_id -> users.id,
// folders/workspace content tables.workspace_id -> workspaces.workspace_id,
// atom_revisions.atom_id -> atoms.id,
// database_operations.database_file_id -> database_files.id,
// app_trust_grants.app_package_id -> app_packages.id.
export const workspaceTables = [
  "users",
  "workspaces",
  "workspace_members",
  "folders",
  "atoms",
  "atom_revisions",
  "document_states",
  "assets",
  "database_files",
  "database_operations",
  "permissions",
  "shares",
  "locks",
  "app_packages",
  "app_trust_grants",
  "agent_runs",
  "agent_approvals",
  "workspace_events",
] as const;

export const migrationIndexes = [
  "atoms_workspace_path_idx",
  "assets_workspace_path_idx",
  "workspace_events_workspace_created_idx",
  "locks_workspace_target_idx",
  "database_operations_file_version_idx",
] as const;

const scopedTimestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  tokenIdentifier: text("token_identifier").notNull(),
  email: text("email"),
  name: text("name"),
  ...scopedTimestamps,
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().unique(),
  ownerUserId: text("owner_user_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  ...scopedTimestamps,
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    ...scopedTimestamps,
  },
  (table) => [
    uniqueIndex("workspace_members_workspace_user_unique").on(
      table.workspaceId,
      table.userId,
    ),
  ],
);

export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    path: text("path").notNull(),
    parentPath: text("parent_path"),
    title: text("title").notNull(),
    revision: integer("revision").notNull().default(1),
    ...scopedTimestamps,
  },
  (table) => [
    uniqueIndex("folders_workspace_path_unique").on(
      table.workspaceId,
      table.path,
    ),
  ],
);

export const atoms = pgTable(
  "atoms",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    revision: integer("revision").notNull().default(1),
    ydocStateKey: text("ydoc_state_key"),
    ...scopedTimestamps,
  },
  (table) => [
    uniqueIndex("atoms_workspace_path_unique").on(table.workspaceId, table.path),
    index("atoms_workspace_path_idx").on(table.workspaceId, table.path),
  ],
);

export const atomRevisions = pgTable("atom_revisions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  atomId: text("atom_id").notNull(),
  revision: integer("revision").notNull(),
  body: text("body").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentStates = pgTable("document_states", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  atomId: text("atom_id").notNull(),
  stateKey: text("state_key").notNull(),
  revision: integer("revision").notNull(),
  ...scopedTimestamps,
});

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    revision: integer("revision").notNull().default(1),
    ...scopedTimestamps,
  },
  (table) => [
    uniqueIndex("assets_workspace_path_unique").on(
      table.workspaceId,
      table.path,
    ),
    index("assets_workspace_path_idx").on(table.workspaceId, table.path),
  ],
);

export const databaseFiles = pgTable(
  "database_files",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    path: text("path").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    revision: integer("revision").notNull().default(1),
    schemaSnapshot: jsonb("schema_snapshot").notNull().default({}),
    ...scopedTimestamps,
  },
  (table) => [
    uniqueIndex("database_files_workspace_path_unique").on(
      table.workspaceId,
      table.path,
    ),
  ],
);

export const databaseOperations = pgTable(
  "database_operations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    databaseFileId: text("database_file_id").notNull(),
    operationId: text("operation_id").notNull(),
    baseVersion: integer("base_version").notNull(),
    resultVersion: integer("result_version").notNull(),
    operation: jsonb("operation").notNull(),
    result: jsonb("result").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("database_operations_operation_unique").on(
      table.workspaceId,
      table.operationId,
    ),
    index("database_operations_file_version_idx").on(
      table.databaseFileId,
      table.resultVersion,
    ),
  ],
);

export const permissions = pgTable("permissions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  capability: text("capability").notNull(),
  ...scopedTimestamps,
});

export const shares = pgTable("shares", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  recipientUserId: text("recipient_user_id"),
  recipientEmail: text("recipient_email"),
  capability: text("capability").notNull(),
  ...scopedTimestamps,
});

export const locks = pgTable(
  "locks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason").notNull(),
    lockedByUserId: text("locked_by_user_id").notNull(),
    ...scopedTimestamps,
  },
  (table) => [
    index("locks_workspace_target_idx").on(
      table.workspaceId,
      table.targetKind,
      table.targetId,
    ),
  ],
);

export const appPackages = pgTable("app_packages", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  packageRoot: text("package_root").notNull(),
  manifest: jsonb("manifest").notNull(),
  sourceDigest: text("source_digest").notNull(),
  writeKey: text("write_key").notNull(),
  ...scopedTimestamps,
});

export const appTrustGrants = pgTable("app_trust_grants", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  appPackageId: text("app_package_id").notNull(),
  userId: text("user_id").notNull(),
  manifestWriteKey: text("manifest_write_key").notNull(),
  scopes: jsonb("scopes").notNull().default([]),
  ...scopedTimestamps,
});

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  provenance: jsonb("provenance").notNull().default({}),
  ...scopedTimestamps,
});

export const agentApprovals = pgTable("agent_approvals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  userId: text("user_id").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").notNull().default({}),
  ...scopedTimestamps,
});

export const workspaceEvents = pgTable(
  "workspace_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    kind: text("kind").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("workspace_events_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);

-- Phase 3 scaffold note: foreign keys are intentionally deferred while the
-- schema proves soft-delete, restore, and dev-reset behavior.
-- Expected relationships are documented in src/db/schema.ts and should be
-- promoted to FK constraints once compatibility tests cover those flows.

create table if not exists users (
  id text primary key,
  workspace_id text not null,
  token_identifier text not null,
  email text,
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists workspaces (
  id text primary key,
  workspace_id text not null unique,
  owner_user_id text not null,
  slug text not null,
  name text not null,
  kind text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists workspace_members (
  id text primary key,
  workspace_id text not null,
  user_id text not null,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists workspace_members_workspace_user_unique
  on workspace_members(workspace_id, user_id);

create table if not exists folders (
  id text primary key,
  workspace_id text not null,
  path text not null,
  parent_path text,
  title text not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists folders_workspace_path_unique
  on folders(workspace_id, path);

create table if not exists atoms (
  id text primary key,
  workspace_id text not null,
  path text not null,
  kind text not null,
  body text not null,
  revision integer not null default 1,
  ydoc_state_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists atoms_workspace_path_unique
  on atoms(workspace_id, path);

create table if not exists atom_revisions (
  id text primary key,
  workspace_id text not null,
  atom_id text not null,
  revision integer not null,
  body text not null,
  actor_user_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists document_states (
  id text primary key,
  workspace_id text not null,
  atom_id text not null,
  state_key text not null,
  revision integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists assets (
  id text primary key,
  workspace_id text not null,
  path text not null,
  kind text not null,
  media_type text not null,
  size integer not null,
  sha256 text not null,
  object_key text not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists assets_workspace_path_unique
  on assets(workspace_id, path);

create table if not exists database_files (
  id text primary key,
  workspace_id text not null,
  path text not null,
  media_type text not null,
  size integer not null,
  sha256 text not null,
  object_key text not null,
  revision integer not null default 1,
  schema_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists database_files_workspace_path_unique
  on database_files(workspace_id, path);

create table if not exists database_operations (
  id text primary key,
  workspace_id text not null,
  database_file_id text not null,
  operation_id text not null,
  base_version integer not null,
  result_version integer not null,
  operation jsonb not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists database_operations_operation_unique
  on database_operations(workspace_id, operation_id);
create index if not exists database_operations_file_version_idx
  on database_operations(database_file_id, result_version);

create table if not exists permissions (
  id text primary key,
  workspace_id text not null,
  subject_kind text not null,
  subject_id text not null,
  target_kind text not null,
  target_id text not null,
  capability text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists shares (
  id text primary key,
  workspace_id text not null,
  target_kind text not null,
  target_id text not null,
  recipient_user_id text,
  recipient_email text,
  capability text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists locks (
  id text primary key,
  workspace_id text not null,
  target_kind text not null,
  target_id text not null,
  reason text not null,
  locked_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists locks_workspace_target_idx
  on locks(workspace_id, target_kind, target_id);

create table if not exists app_packages (
  id text primary key,
  workspace_id text not null,
  package_root text not null,
  manifest jsonb not null,
  source_digest text not null,
  write_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists app_trust_grants (
  id text primary key,
  workspace_id text not null,
  app_package_id text not null,
  user_id text not null,
  manifest_write_key text not null,
  scopes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists agent_runs (
  id text primary key,
  workspace_id text not null,
  user_id text not null,
  status text not null,
  prompt text not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists agent_approvals (
  id text primary key,
  workspace_id text not null,
  agent_run_id text not null,
  user_id text not null,
  action text not null,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists workspace_events (
  id text primary key,
  workspace_id text not null,
  actor_user_id text not null,
  kind text not null,
  target_kind text not null,
  target_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workspace_events_workspace_created_idx
  on workspace_events(workspace_id, created_at);

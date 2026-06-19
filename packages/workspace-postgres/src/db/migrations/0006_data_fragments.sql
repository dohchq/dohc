-- Data fragments are dohc Cloud's "copy/paste across workspaces with
-- provenance and permissions" primitive. They intentionally do NOT grant
-- access to the source atom/file: the exported body lives in its own row and
-- data_fragment_shares authorizes only that fragment.

create table if not exists data_fragments (
  id text primary key,
  workspace_id text not null,
  source_path text,
  title text not null,
  preview text not null,
  content_type text not null,
  body text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists data_fragments_workspace_created_idx
  on data_fragments(workspace_id, created_at);

create table if not exists data_fragment_shares (
  id text primary key,
  fragment_id text not null,
  workspace_id text not null,
  recipient_user_id text not null,
  recipient_email text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists data_fragment_shares_audience_unique
  on data_fragment_shares(fragment_id, recipient_user_id)
  where deleted_at is null;

create index if not exists data_fragment_shares_recipient_created_idx
  on data_fragment_shares(recipient_user_id, created_at);

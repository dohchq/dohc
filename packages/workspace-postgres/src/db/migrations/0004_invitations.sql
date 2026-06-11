-- Phase E5 server lane: workspace member invitations (closes the tracked
-- member-invite gap from the convex-deletion review). Inviting an EXISTING
-- user writes the workspace_members row immediately and records the
-- invitation as claimed; inviting an unknown email leaves a pending row that
-- the Better Auth after-email-verification hook claims once the signer
-- verifies the invited address (never at bare signup). Claimed and revoked
-- rows are kept for audit (claimed_at / deleted_at), mirroring the
-- soft-delete pattern of every other table.

create table if not exists workspace_invitations (
  id text primary key,
  workspace_id text not null,
  email text not null,
  invited_by text not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  deleted_at timestamptz
);

-- Verification-time claim looks invitations up by email alone.
create index if not exists workspace_invitations_email_idx
  on workspace_invitations(lower(email));

-- One LIVE pending invitation per (workspace, email): double-invites upsert
-- onto the same row; claimed and revoked rows never block a re-invite.
create unique index if not exists workspace_invitations_pending_unique
  on workspace_invitations(workspace_id, lower(email))
  where claimed_at is null and deleted_at is null;

-- Shares gain provenance: revocation is "the sharer or the workspace owner",
-- which requires knowing who created the share. Pre-existing rows stay null
-- (owner-revocable only).
alter table shares add column if not exists created_by text;

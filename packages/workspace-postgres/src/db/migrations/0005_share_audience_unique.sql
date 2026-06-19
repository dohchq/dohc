-- E5 security review P2: the share "audience upsert" was two statements with
-- no live uniqueness index, so two concurrent create-share requests could both
-- miss the update and both insert — revoking one duplicate still left the
-- other satisfying the shared-link resolver. Enforce ONE live share per
-- (workspace, target, recipient) and let createShare become a single
-- INSERT ... ON CONFLICT ... DO UPDATE against this index.

-- First dedupe any live duplicates the racy upsert already produced: keep the
-- newest row per audience (the latest capability decision), soft-delete the
-- rest — tombstones are kept for audit like every other table.
with ranked as (
  select id,
    row_number() over (
      partition by workspace_id, target_kind, target_id, recipient_user_id
      order by created_at desc, id desc
    ) as rn
  from shares
  where deleted_at is null and recipient_user_id is not null
)
update shares set deleted_at = now(), updated_at = now()
where id in (select id from ranked where rn > 1);

-- Partial: uniqueness constrains LIVE rows only (the migration 0003 pattern),
-- so revoke-then-reshare onto the same audience never collides with the
-- tombstone. NULL recipient_user_id rows are unconstrained (distinct nulls).
create unique index if not exists shares_audience_unique
  on shares(workspace_id, target_kind, target_id, recipient_user_id)
  where deleted_at is null;

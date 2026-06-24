-- Run outside a transaction: CREATE INDEX CONCURRENTLY cannot execute in a
-- transaction block.
-- Supports completed share-revocation disconnect retention cleanup.
create index concurrently if not exists workspace_events_share_revocation_completed_cleanup_idx
  on workspace_events ((nullif(payload->>'completedAt', '')))
  where kind = 'share.revocation.disconnect_completed';

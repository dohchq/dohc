-- Run outside a transaction: CREATE INDEX CONCURRENTLY cannot execute in a
-- transaction block.
-- Supports share-revocation backlog stats and active disconnect scans.
create index concurrently if not exists workspace_events_share_revocation_active_backlog_idx
  on workspace_events (kind, created_at)
  where kind in (
    'share.revocation.disconnect_pending',
    'share.revocation.disconnect_claimed'
  );

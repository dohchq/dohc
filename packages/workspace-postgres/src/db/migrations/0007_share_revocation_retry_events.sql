-- Run outside a transaction: CREATE INDEX CONCURRENTLY cannot execute in a
-- transaction block.
-- Mirrors the worker's kind-filtered retry scan and order key.
create index concurrently if not exists workspace_events_share_revocation_pending_retry_idx
  on workspace_events ((coalesce(payload->>'retryAfter', '')), created_at)
  where kind = 'share.revocation.disconnect_pending';

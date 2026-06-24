-- Run outside a transaction: CREATE INDEX CONCURRENTLY cannot execute in a
-- transaction block.
create index concurrently if not exists workspace_events_share_revocation_claimed_retry_idx
  on workspace_events ((coalesce(payload->>'claimExpiresAt', payload->>'claimedAt', '')), created_at)
  where kind = 'share.revocation.disconnect_claimed';

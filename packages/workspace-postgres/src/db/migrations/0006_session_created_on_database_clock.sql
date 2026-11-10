-- Consent compares when a browser session began with the credential fence's
-- last change. The fence takes this database's clock, so the session's start
-- does too, in its own column. Better Auth's "createdAt" keeps the auth
-- server's clock for its own checks. No one knows when a session from before
-- this migration began by this clock, so it counts as older than any password
-- change: an account with a fence signs in again before it consents.
alter table "session" add column if not exists dohc_created_at timestamptz not null default '-infinity';
alter table "session" alter column dohc_created_at set default clock_timestamp();

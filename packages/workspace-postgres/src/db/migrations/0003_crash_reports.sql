-- Crash reports a person chose to send from the desktop app. workspace-api
-- stores them only while DOHC_CRASH_REPORTS=1 and deletes each one 90 days
-- after it arrives. A row holds no account, IP address, or device id.

create table if not exists crash_reports (
  id text primary key,
  received_at timestamptz not null default now(),
  app_version text,
  body text not null
);

create index if not exists crash_reports_received_at on crash_reports (received_at);

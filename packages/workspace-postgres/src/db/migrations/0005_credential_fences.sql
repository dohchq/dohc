-- An account's credential fence. Its epoch increases in the same transaction
-- that changes or deletes the account's stored password, so a reset is fenced
-- the moment it commits. The relay compares it on every request a personal
-- agent makes, and listens on dohc_credential_fence to end running work promptly.
create table if not exists dohc_credential_fences (
  user_id text primary key references "user" ("id") on delete cascade,
  epoch bigint not null check (epoch >= 1),
  changed_at timestamptz not null
);
create index if not exists dohc_credential_fences_changed_at on dohc_credential_fences (changed_at);

create or replace function dohc_fence_credentials() returns trigger language plpgsql as $$
declare
  fenced_user text;
  fenced_epoch bigint;
  fenced_at timestamptz;
begin
  fenced_user := case when TG_OP = 'DELETE' then OLD."userId" else NEW."userId" end;
  -- Deleting the user deletes its fence too; there is nothing left to fence.
  if not exists (select 1 from "user" where id = fenced_user) then
    return null;
  end if;
  insert into dohc_credential_fences (user_id, epoch, changed_at)
    values (fenced_user, 1, clock_timestamp())
    on conflict (user_id) do update
      set epoch = dohc_credential_fences.epoch + 1, changed_at = excluded.changed_at
    returning epoch, changed_at into fenced_epoch, fenced_at;
  perform pg_notify('dohc_credential_fence', json_build_object(
    'userId', fenced_user,
    'epoch', fenced_epoch,
    'changedAtMs', floor(extract(epoch from fenced_at) * 1000)::bigint
  )::text);
  return null;
end;
$$;

-- A reset and a voluntary change both write the password; the trigger can't
-- tell them apart and fences both. Sign-up adds the password without a fence,
-- so its first session is current. Deleting the password fences, so one added
-- again later can't bring back credentials from before.
create or replace trigger dohc_credential_fence_update after update of "password" on "account"
  for each row when (NEW."providerId" = 'credential' and OLD."password" is distinct from NEW."password")
  execute function dohc_fence_credentials();
create or replace trigger dohc_credential_fence_delete after delete on "account"
  for each row when (OLD."providerId" = 'credential')
  execute function dohc_fence_credentials();

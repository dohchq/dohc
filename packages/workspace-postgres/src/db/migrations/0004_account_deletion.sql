create table if not exists account_deletion_jobs (
  user_id text primary key,
  email text not null,
  created_at timestamptz not null default current_timestamp
);

-- Lock the account before changing credentials. Deletion takes the same lock
-- before recording its job, so a credential cannot cross the fence.
create or replace function refuse_deleting_account() returns trigger language plpgsql as $$
declare account_id text;
begin
  if TG_TABLE_NAME = 'user' then account_id := NEW.id;
  elsif TG_TABLE_NAME = 'verification' then account_id := NEW.value;
  else account_id := NEW."userId";
  end if;
  perform 1 from "user" where id = account_id for key share;
  if exists (select 1 from account_deletion_jobs where user_id = account_id) then
    raise exception 'account deletion is pending' using errcode = '42501';
  end if;
  return NEW;
end;
$$;
create or replace trigger account_deletion_user before update on "user" for each row execute function refuse_deleting_account();
create or replace trigger account_deletion_session before insert or update on "session" for each row execute function refuse_deleting_account();
create or replace trigger account_deletion_account before insert or update on "account" for each row execute function refuse_deleting_account();
create or replace trigger account_deletion_device before insert or update on "deviceCode" for each row execute function refuse_deleting_account();
create or replace trigger account_deletion_verification before insert or update on "verification" for each row execute function refuse_deleting_account();

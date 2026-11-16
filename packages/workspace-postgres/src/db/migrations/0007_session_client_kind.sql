-- Every session records the kind of sign-in that created it: a phone or a
-- desktop through device sign-in, or a browser through password sign-in. The
-- server refuses a phone session everywhere except the routes the phone uses.
-- No earlier session or pending device code says which kind it is, and nothing
-- can tell afterwards, so this deletes them all and every account signs in
-- again. An auth server still running the old code then fails to create a
-- session instead of creating one without a kind.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'session' and column_name = 'clientKind'
  ) then
    delete from "session";
    delete from "deviceCode";
    alter table "session" add column "clientKind" text not null
      check ("clientKind" in ('phone', 'desktop', 'browser'));
  end if;
end $$;

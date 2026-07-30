-- The desktop workspace engine owns application data in per-workspace SQLite.
-- Postgres now stores Better Auth data only. Remove the unused application
-- tables from installations that ran the earlier cloud-backend migrations.

drop table if exists agent_approvals cascade;
drop table if exists agent_runs cascade;
drop table if exists app_trust_grants cascade;
drop table if exists app_packages cascade;
drop table if exists database_operations cascade;
drop table if exists database_files cascade;
drop table if exists assets cascade;
drop table if exists document_states cascade;
drop table if exists atom_revisions cascade;
drop table if exists atoms cascade;
drop table if exists locks cascade;
drop table if exists shares cascade;
drop table if exists permissions cascade;
drop table if exists folders cascade;
drop table if exists workspace_events cascade;
drop table if exists workspace_members cascade;
drop table if exists workspaces cascade;
drop table if exists users cascade;

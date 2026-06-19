-- Phase 9 data-loss fix: the path-uniqueness indexes on atoms/assets were
-- plain unique(workspace_id, path) and so collided with soft-delete tombstones
-- (deleted_at set, row kept at the same path). That wedged the ordinary
-- delete-then-recreate flow and rename-onto-a-deleted-name. Make both indexes
-- PARTIAL so uniqueness only constrains LIVE rows; tombstones never block a
-- recreate. Idempotent: drop the old shape, create the partial one.

drop index if exists atoms_workspace_path_unique;
create unique index if not exists atoms_workspace_path_unique
  on atoms(workspace_id, path)
  where deleted_at is null;

drop index if exists assets_workspace_path_unique;
create unique index if not exists assets_workspace_path_unique
  on assets(workspace_id, path)
  where deleted_at is null;

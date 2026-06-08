import { describe, expect, it } from "vitest";
import { migrationIndexes, workspaceTables } from "./schema";

describe("Postgres workspace schema scaffold", () => {
  it("defines the required workspace tables", () => {
    expect(workspaceTables).toEqual([
      "users",
      "workspaces",
      "workspace_members",
      "folders",
      "atoms",
      "atom_revisions",
      "document_states",
      "assets",
      "database_files",
      "database_operations",
      "permissions",
      "shares",
      "locks",
      "app_packages",
      "app_trust_grants",
      "agent_runs",
      "agent_approvals",
      "workspace_events",
    ]);
  });

  it("lists the minimum migration indexes", () => {
    expect(migrationIndexes).toEqual([
      "atoms_workspace_path_idx",
      "assets_workspace_path_idx",
      "workspace_events_workspace_created_idx",
      "locks_workspace_target_idx",
      "database_operations_file_version_idx",
    ]);
  });
});

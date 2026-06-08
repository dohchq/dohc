import type { WorkspaceBackendTestAdapter } from "@dohc/workspace-contracts";

export const postgresTestAdapter: WorkspaceBackendTestAdapter = {
  name: "postgres",
  async setup() {
    throw new Error("Postgres test adapter is implemented in Phase 4");
  },
  async teardown() {},
};

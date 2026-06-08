import { describe, expect, it } from "vitest";
import type { WorkspaceBackendTestAdapter } from "./testHarness";

export function runWorkspaceBackendConformance(
  adapter: WorkspaceBackendTestAdapter,
) {
  describe(`${adapter.name} workspace backend conformance`, () => {
    it("creates, reads, and lists a text file", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        await backend.createAtom(actor, {
          path: "finance/transactions.csv",
          kind: "csv",
          body: "date,merchant,amount\n2026-06-01,Atome,26262\n",
        });

        const read = await backend.readText(
          actor,
          "finance/transactions.csv",
        );
        expect(read.body).toContain("Atome");

        const files = await backend.listFiles(actor);
        expect(
          files.some((file) => file.path === "finance/transactions.csv"),
        ).toBe(true);
      } finally {
        await adapter.teardown();
      }
    });

    it("rejects cross-workspace reads", async () => {
      const { backend, actor, otherActor } = await adapter.setup();
      try {
        await backend.createAtom(actor, {
          path: "private/me.md",
          kind: "markdown",
          body: "# Me\n",
        });

        await expect(
          backend.readText(otherActor, "private/me.md"),
        ).rejects.toThrow();
      } finally {
        await adapter.teardown();
      }
    });

    it("rejects stale writes", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        const created = await backend.createAtom(actor, {
          path: "notes/day.md",
          kind: "markdown",
          body: "# Day\n",
        });

        await backend.writeAtom(actor, {
          path: "notes/day.md",
          expectedRevision: created.revision,
          body: "# Day\nUpdated\n",
        });

        await expect(
          backend.writeAtom(actor, {
            path: "notes/day.md",
            expectedRevision: created.revision,
            body: "# Day\nStale\n",
          }),
        ).rejects.toThrow();
      } finally {
        await adapter.teardown();
      }
    });
  });
}

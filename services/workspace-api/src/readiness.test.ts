import { describe, expect, it, vi } from "vitest";
import { createReadinessProbe, REQUIRED_TABLES, type TableQuery } from "./readiness";

function answering(tables: readonly string[]): TableQuery {
  return {
    async query(_sql, values) {
      const requested = (values[0] as string[]).filter((name) => tables.includes(name));
      return { rows: requested.map((name) => ({ name })) };
    },
  };
}

describe("createReadinessProbe", () => {
  it("is ready when Postgres answers with the whole auth schema", async () => {
    const report = await createReadinessProbe(answering(REQUIRED_TABLES))();
    expect(report).toEqual({ ok: true, database: "ok", schema: "ok", missingTables: [] });
  });

  it("is not ready until account email is configured", async () => {
    const report = await createReadinessProbe(answering(REQUIRED_TABLES), { emailConfigured: false })();
    expect(report).toMatchObject({ ok: false, database: "ok", detail: "Configure SMTP for account email." });
  });

  it("names the tables a migration has not created yet", async () => {
    const report = await createReadinessProbe(
      answering(REQUIRED_TABLES.filter((table) => table !== "deviceCode")),
    )();
    expect(report.ok).toBe(false);
    expect(report.schema).toBe("incomplete");
    expect(report.missingTables).toEqual(["deviceCode"]);
    expect(report.detail).toMatch(/pnpm migrate/);
  });

  it("reports an unreachable database", async () => {
    const report = await createReadinessProbe({
      query: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:54329")),
    })();
    expect(report).toMatchObject({
      ok: false,
      database: "unreachable",
      schema: "unknown",
      detail: "The account database is unavailable.",
    });
  });

  it("gives up on a database that never answers", async () => {
    const report = await createReadinessProbe({ query: () => new Promise(() => {}) }, { timeoutMs: 5 })();
    expect(report.database).toBe("unreachable");
    expect(report.detail).toBe("The account database is unavailable.");
  });
  it("shares a stalled query across requests and retries after it settles", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (error: Error) => void;
      const stalled = new Promise<{ rows: Array<Record<string, unknown>> }>((_resolve, fail) => {
        reject = fail;
      });
      const query = vi.fn().mockReturnValueOnce(stalled).mockResolvedValue({ rows: REQUIRED_TABLES.map(name => ({ name })) });
      const probe = createReadinessProbe({ query }, { timeoutMs: 5 });
      const first = Array.from({ length: 20 }, () => probe());
      await vi.advanceTimersByTimeAsync(5);
      expect((await Promise.all(first)).every(report => report.database === "unreachable")).toBe(true);
      const second = probe();
      await vi.advanceTimersByTimeAsync(5);
      expect((await second).database).toBe("unreachable");
      expect(query).toHaveBeenCalledTimes(1);
      reject(new Error("database timeout"));
      await vi.advanceTimersByTimeAsync(0);
      expect((await probe()).ok).toBe(true);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

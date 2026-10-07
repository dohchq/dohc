import { describe, expect, it } from "vitest";
import { CLI_CAPABILITIES, cliRequestSchema, CLI_PROTOCOL_VERSION, type CliRequest } from "@dohc/cli/protocol";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS, UsageVersionCoverage, queryUsage } from "@dohc/workspace-contracts/usage";
import { cliUsageInvocation, CLI_USAGE_ACTION_IDS, DESKTOP_USAGE_COVERAGE } from "./cliUsage";

const request = (verb: string, args: object = {}, door?: "cli" | "mcp"): CliRequest => cliRequestSchema.parse({
  token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, door, verb,
  args: { cwd: "C:/workspace", actor: "agent", ...args },
});

describe("socket usage coverage", () => {
  it("covers only issued explicit actions on the CLI and actually advertised MCP doors", () => {
    expect(UsageVersionCoverage.safeParse({ appVersion: "0.1.0", pairs: DESKTOP_USAGE_COVERAGE }).success).toBe(true);
    expect(CLI_USAGE_ACTION_IDS.length).toBeGreaterThan(0);
    for (const id of CLI_USAGE_ACTION_IDS) {
      expect(Object.hasOwn(CAPABILITIES, id)).toBe(true);
      expect(USAGE_ACTION_IDS).toContain(id);
      expect(Object.values(CLI_CAPABILITIES).flat()).toContain(id);
    }
    for (const pair of DESKTOP_USAGE_COVERAGE) {
      if (pair.door === "cli") expect(pair.status === "covered").toBe(CLI_USAGE_ACTION_IDS.includes(pair.capabilityId as (typeof CLI_USAGE_ACTION_IDS)[number]));
      if (pair.door === "mcp") expect(pair.status === "covered").toBe(
        CLI_USAGE_ACTION_IDS.includes(pair.capabilityId as (typeof CLI_USAGE_ACTION_IDS)[number])
        && pair.capabilityId !== "file.write"
        && Object.values(CAPABILITIES[pair.capabilityId].mcp).some(value => Array.isArray(value) && value.length > 0));
      if (pair.door === "automation") expect(pair.status).toBe("uncovered");
    }
  });

  it("counts CLI file writes but leaves multiplexed MCP file writes unmeasured", () => {
    const args = { requestId: "r", files: [{ path: "a.txt", contentBase64: "eA==" }] };
    const result = { ok: true as const, written: ["a.txt"] };
    expect(cliUsageInvocation(request("fileWrite", args, "mcp"), result)).toBeNull();
    for (const door of ["cli", undefined] as const) {
      expect(cliUsageInvocation(request("fileWrite", args, door), result))
        .toEqual({ capabilityId: "file.write", door: "cli" });
    }
    const rows = queryUsage({ version: 1, enabled: true, cleanExit: true, counts: [],
      days: [{ day: "2026-10-08", appVersions: ["0.1.0"], complete: true }],
      coverage: [{ appVersion: "0.1.0", pairs: DESKTOP_USAGE_COVERAGE }] },
    { from: "2026-10-08", through: "2026-10-08", pairs: [
      { capabilityId: "file.write", door: "cli" }, { capabilityId: "file.write", door: "mcp" },
    ] });
    expect(rows).toEqual([
      expect.objectContaining({ door: "cli", total: 0, usedDays: 0, coveredDays: 1 }),
      expect.objectContaining({ door: "mcp", total: null, usedDays: null, coveredDays: 0 }),
    ]);
  });

  it("keeps direct-disk MCP tools, reads, missing MCP commands and automation unknown", () => {
    const pairs = (["file.list", "file.read", "file.search", "workspace.list", "chat.export", "chat.react", "dataset.operation.invoke", "chat.show"] as const)
      .map(capabilityId => ({ capabilityId, door: "mcp" } as const));
    const rows = queryUsage({ version: 1, enabled: true, cleanExit: true, counts: [],
      days: [{ day: "2026-10-08", appVersions: ["0.1.0"], complete: true }],
      coverage: [{ appVersion: "0.1.0", pairs: DESKTOP_USAGE_COVERAGE }] },
    { from: "2026-10-08", through: "2026-10-08", pairs });
    for (const row of rows) expect(row).toMatchObject({ total: null, usedDays: null, coveredDays: 0 });
  });

  it("resolves multiplexed actions without counting reads, refusals, partial results or replays", () => {
    const base = { workspaceId: "w" };
    expect(cliUsageInvocation(request("dataset", { request: { ...base, action: "discard", preparationId: "00000000-0000-4000-8000-000000000001" } }, "mcp"), { kind: "discarded" }))
      .toEqual({ capabilityId: "dataset.discard", door: "mcp" });
    expect(cliUsageInvocation(request("dataset", { request: { ...base, action: "list" } }), { kind: "list", datasets: [], nextCursor: null })).toBeNull();
    const discard = request("dataset", { request: { ...base, action: "discard", preparationId: "00000000-0000-4000-8000-000000000001" } });
    expect(cliUsageInvocation(discard, { kind: "refused", code: "denied", message: "No authority" })).toBeNull();
    const recovery = request("dataset", { request: { ...base, action: "prepareRecovery" } });
    expect(cliUsageInvocation(recovery, { kind: "recovery-prepared", recovery: null })).toBeNull();
    const upload = request("dataset", { request: { ...base, action: "upload", datasetPath: "data/dataset.json",
      revision: 1, revisionSha256: "a".repeat(64), fieldId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "upload", name: "a.txt", contentType: "text/plain", bytesBase64: "eA==" } });
    const file = { fileId: "abcdefghijklmnop", name: "a.txt", contentType: "text/plain", byteLength: 1, sha256: "a".repeat(64) };
    expect(cliUsageInvocation(upload, { kind: "uploaded", file, replayed: true })).toBeNull();
    expect(cliUsageInvocation(upload, { kind: "uploaded", file, replayed: false }))
      .toEqual({ capabilityId: "dataset.file.upload", door: "cli" });
    expect(cliUsageInvocation(request("fileWrite", { requestId: "r", files: [{ path: "a.txt", contentBase64: "eA==" }] }), { ok: false, written: ["a.txt"], reason: "partial" })).toBeNull();
    const kept = request("saveKeptCopy", { id: 1 });
    expect(cliUsageInvocation(kept, { ok: true, status: "gone" })).toBeNull();
    expect(cliUsageInvocation(kept, { ok: true, status: "saved", path: "PRIVATE PATH" })).toEqual({ capabilityId: "file.kept.save", door: "cli" });
    const edit = request("documentEdit", { path: "a.md", replacement: "private" });
    expect(cliUsageInvocation(edit, { ok: true, path: "a.md", changed: false })).toBeNull();
    const press = request("automationPress", { collectionPath: "tasks", field: "go", record: "r", confirm: [] });
    expect(cliUsageInvocation(press, { ok: true, run: "r", outcome: "done", error: null, waiting: null })).toBeNull();
  });
});

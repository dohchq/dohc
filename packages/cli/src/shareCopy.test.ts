import { expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, cliRequestSchema, parseCliResult } from "./protocol";
import { parseCliArguments } from "./args";

const input = { shareId: "share", grantId: "grant" };
it("parses share copy and sends only grant coordinates and local cwd", async () => {
  expect(parseCliArguments(["share", "copy", "share", "grant"], {})).toMatchObject({ verb: "shareCopy", ...input });
  const request = vi.fn(async () => ({ status: "active", shareCode: "code", browserInvitationUrl: "https://share.test/s/edit/grant" }));
  const result = await executeCli({ argv: ["share", "copy", "share", "grant"], cwd: "/workspace", env: {}, request });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"shareCode": "code"');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "shareCopy", args: { ...input, cwd: expect.any(String), actor: "human" } }));
});
it.each([{ operands: [] }, { operands: ["share"] }, { operands: ["share", "grant", "extra"] }])("refuses missing or extra operands %j", ({ operands }) => {
  expect(() => parseCliArguments(["share", "copy", ...operands], {})).toThrow();
});
it.each(["workspaceId", "ownerUserId", "userId", "credentials", "relayUrl"])("refuses caller-supplied %s at socket parsing", key => {
  expect(cliRequestSchema.safeParse({ protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "shareCopy",
    args: { ...input, cwd: "/workspace", actor: "agent", [key]: "other" } }).success).toBe(false);
});
it("pins copy results to the IPC contract, with no data for ended grants", () => {
  expect(parseCliResult("shareCopy", { status: "ended" })).toEqual({ status: "ended" });
  expect(() => parseCliResult("shareCopy", { status: "ended", shareCode: "stale" })).toThrow();
  expect(() => parseCliResult("shareCopy", { status: "active", shareCode: "code", token: "secret" })).toThrow();
});

import { expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { parseCliArguments } from "./args";
import { cliRequestSchema, CLI_PROTOCOL_VERSION } from "./protocol";
const operationId = "dohc-operation:11111111-1111-4111-8111-111111111111";
it("sends an agent Undo and prints each remaining path with its retry", async () => {
  const request = vi.fn(async () => ({ ok: true, tracked: { state: "restoring", momentCount: 1 }, restored: [], remaining: [
    { path: "a.txt", reason: "a.txt now occupies the old path. Move it first.", retry: true },
    { path: "b.txt", reason: "b.txt may be incomplete. Undo again to retry, or restore it from the trash.", retry: true },
  ] }));
  expect(parseCliArguments(["history", "undo", operationId], {})).toMatchObject({ actor: "agent", verb: "historyUndo" });
  const result = await executeCli({ argv: ["history", "undo", operationId], cwd: process.cwd(), request });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.split("\n")).toEqual(["History: restoring", "a.txt now occupies the old path. Move it first. Undo again to retry.", "b.txt may be incomplete. Undo again to retry, or restore it from the trash.", ""]);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "historyUndo", args: expect.objectContaining({ actor: "agent", operationId }) }));
});
it("prints a successful move Undo and rejects an id without its namespace before transport", async () => {
  const request = vi.fn(async () => ({ ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [], remaining: [] }));
  expect(await executeCli({ argv: ["history", "undo", operationId], request })).toEqual({ exitCode: 0, stdout: "History: restored\n", stderr: "" });
  request.mockClear();
  for (const verb of ["undo", "operation"]) {
    expect((await executeCli({ argv: ["history", verb, operationId.slice(15)], request })).exitCode).toBe(1);
    expect(cliRequestSchema.safeParse({ token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb: verb === "undo" ? "historyUndo" : "historyOperation", args: { cwd: process.cwd(), actor: "agent", operationId: operationId.slice(15) } }).success).toBe(false);
  }
  expect(request).not.toHaveBeenCalled();
});

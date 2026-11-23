import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { DohcCliError } from "@dohc/cli/errors";
import { createDohcMcpServer } from "./server";
import { dataset, type ToolContext } from "./tools";
const request = {
  action: "invoke",
  workspaceId: "workspace",
  datasetPath: "equipment/dataset.json",
  operationId: "00000000-0000-4000-8000-000000000002",
  revision: 1,
  revisionSha256: "a".repeat(64),
  input: { name: "Camera" },
  idempotencyKey: "add-1",
};
describe("dataset MCP transport", () => {
  it("cancels a named invocation through the same Collection handler without promising rollback", async () => {
    const reply = { kind: "invoke-cancel-requested", outcome: "unknown" };
    const send = vi.fn(async () => reply),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };
    const input = {
      action: "cancelInvoke",
      workspaceId: request.workspaceId,
      invocationId: "00000000-0000-4000-8000-000000000099",
    };
    expect(await dataset(context, input)).toEqual(reply);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        verb: "dataset",
        args: expect.objectContaining({ request: input }),
      }),
    );
  });
  it("rejects opaque IDs and folder paths before transport", async () => {
    const send = vi.fn(),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };
    for (const selection of [
      { datasetId: "00000000-0000-4000-8000-000000000001" },
      { datasetPath: "equipment" },
      { datasetPath: "../equipment/dataset.json" },
    ]) {
      expect(
        await dataset(context, { action: "describe", workspaceId: "workspace", ...selection }),
      ).toMatchObject({ ok: false });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("explains how to address a Collection listed outside the MCP folder", async () => {
    const send = vi.fn(),
      context: ToolContext = { root: "/workspace/app", home: "/home", request: send };
    expect(
      await dataset(context, {
        action: "describe",
        workspaceId: "workspace",
        datasetPath: "../equipment/dataset.json",
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "Run the MCP server from the workspace root or a folder containing the Collection.",
      ),
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("requires explicit owner cancellation acknowledgement and preserves the result", async () => {
    const reply = { kind: "attempt-cancelled", cancelled: true };
    const send = vi.fn(async () => reply),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };
    const input = {
      action: "cancelAttempt",
      workspaceId: request.workspaceId,
      datasetPath: request.datasetPath,
      reference: "a".repeat(64),
      acknowledge: true,
    };
    expect(await dataset(context, { ...input, acknowledge: false })).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
    expect(await dataset(context, input)).toEqual(reply);
    expect(send).toHaveBeenCalledOnce();
  });
  it("exports only to an explicit owner-selected path without returning archive bytes", async () => {
    const reply = { kind: "exported", savedPath: "C:/private/backup.dohc-recovery" };
    const send = vi.fn(async () => reply),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };
    const input = {
      action: "export",
      workspaceId: request.workspaceId,
      datasetPath: request.datasetPath,
    };
    expect(await dataset(context, input)).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
    expect(await dataset(context, { ...input, savePath: reply.savedPath })).toEqual(reply);
    expect(send).toHaveBeenCalledOnce();
  });
  it("uses the scoped desktop transport and validates its result", async () => {
    const reply = { kind: "invoked", result: { id: "record" }, revision: 2, replayed: false };
    const send = vi.fn(async () => reply),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };
    expect(await dataset(context, request)).toEqual(reply);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        verb: "dataset",
        args: { cwd: context.root, actor: "agent", request },
      }),
    );
    expect(
      await dataset(
        { ...context, request: async () => ({ ...reply, extraAuthority: true }) },
        request,
      ),
    ).toMatchObject({ ok: false });
  });
  it("tells an agent to archive a Collection before deleting it", async () => {
    const reason =
      "dohc: This Collection isn't archived. Archive it before you delete it permanently.";
    const send = vi.fn(async () => {
        throw new DohcCliError(reason);
      }),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };
    const expected = {
      workspaceId: "workspace",
      datasetId: "00000000-0000-4000-8000-000000000001",
      hostEpoch: "epoch",
      approvedRevisionHash: "a".repeat(64),
      revision: 0,
      digest: "b".repeat(64),
    };
    expect(
      await dataset(context, {
        action: "delete",
        workspaceId: "workspace",
        datasetPath: "equipment/dataset.json",
        expected,
        reviewToken: "c".repeat(64),
        acknowledge: true,
      }),
    ).toEqual({ ok: false, reason });
    expect(send).toHaveBeenCalledOnce();
  });
  it("does not turn folder sharing or arbitrary SQL into dataset authority", async () => {
    const send = vi.fn(),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };
    for (const shareAccess of ["view", "comment", "edit"] as const)
      expect(await dataset({ ...context, shareAccess }, request)).toMatchObject({ ok: false });
    expect(await dataset(context, { ...request, sql: "SELECT * FROM private" })).toMatchObject({
      ok: false,
    });
    expect(await dataset(context, { ...request, caller: { kind: "owner" } })).toMatchObject({
      ok: false,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("returns self-remedying errors for wrong actions, unrecognized keys, and broken definitions", async () => {
    const send = vi.fn(),
      context: ToolContext = { root: "/workspace", home: "/home", request: send };

    const badAction = await dataset(context, { action: "help" });
    expect(badAction).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Valid actions:"),
    });

    const wrongKey = await dataset(context, {
      action: "prepare",
      workspaceId: "workspace",
      datasetPath: "equipment/dataset.json",
    });
    expect(wrongKey).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Unrecognized key "datasetPath" for action "prepare"'),
    });
    expect((wrongKey as { reason: string }).reason).toContain("descriptorPath");

    const folderPath = await dataset(context, {
      action: "describe",
      workspaceId: "workspace",
      datasetPath: "equipment",
    });
    expect(folderPath).toMatchObject({
      ok: false,
      reason: expect.stringContaining("equipment/dataset.json"),
    });

    const missingPath = await dataset(context, {
      action: "describe",
      workspaceId: "workspace",
    });
    expect(missingPath).toMatchObject({
      ok: false,
      reason: expect.stringContaining("datasetPath"),
    });

    const badCreate = await dataset(context, {
      action: "create",
      workspaceId: "workspace",
      definition: { formatVersion: 2 },
    });
    expect(badCreate).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing required field(s)"),
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("delivers self-remedying validation messages through the MCP server", async () => {
    const server = createDohcMcpServer({
      root: "/workspace",
      home: "/home",
      request: async () => {
        throw new Error("should not reach desktop");
      },
    });
    const client = new Client({ name: "dataset-validation-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const badPrepare = await client.callTool({
        name: "dohc_dataset",
        arguments: {
          request: {
            action: "prepare",
            workspaceId: "workspace",
            datasetPath: "equipment/dataset.json",
          },
        },
      });
      const prepareText = (badPrepare.content as Array<{ text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n");
      expect(badPrepare.isError).toBe(true);
      expect(prepareText).toContain("descriptorPath");

      const badApp = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: { action: "deploy", workspaceId: "workspace" },
        },
      });
      const appText = (badApp.content as Array<{ text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n");
      expect(badApp.isError).toBe(true);
      expect(appText).toContain("Valid actions:");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

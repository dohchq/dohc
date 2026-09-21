import { describe, expect, it, vi } from "vitest";
import { createOwnerAppBackendHandler, createRemoteAppBackendTransport, registerOwnerAppBackendIpc } from "./ownerAppBackendIpc";

const publicationId = "a".repeat(64);
const capability = { kind: "app-backend", dataPath: "private/data.sqlite", backendPath: "backend.js", schemaPath: "schema.sql",
  backendSha256: "b".repeat(64), schemaSha256: "c".repeat(64), schemaVersion: 1,
  operations: [{ name: "list", access: "owner", readOnly: true }], tables: [] };
const description = { publicationId, authorityRevision: 7, capability, active: true, revision: 3 };
function harness() {
  const controller = new AbortController();
  const workspace = { workspaceId: "w", shareView: undefined as unknown };
  let current = true, generation = 1;
  const relay = vi.fn(async (_credentials: unknown, path: string, init: RequestInit): Promise<unknown> => {
    if (path.endsWith("/describe")) return description;
    if (path.endsWith("/invoke")) return { result: [{ id: "one" }], revision: 3, replayed: false };
    if (path.endsWith("/helper")) { const body = JSON.parse(String(init.body)); return { grantId: body.grantId, enabled: body.enabled }; }
    return { formatVersion: 1, snapshot: { encoding: "base64", bytes: "AA==" } };
  });
  const transport = vi.fn(async () => createRemoteAppBackendTransport({ workspaceId: "w", credentials: { userId: "owner", token: "test", email: "owner@test.invalid", serverUrl: "https://account.test", relayUrl: "https://relay.test" },
    credentialGeneration: generation, currentCredentialGeneration: () => generation, relayJson: relay }));
  const save = vi.fn(async () => "C:\\Exports\\recovery.json");
  const deps = { transportForWorkspace: transport, saveExport: save,
    async withWorkspaceOperation<T>(_sender: number, workspaceId: string, work: (operation: { workspace: typeof workspace; signal: AbortSignal; assertCurrent(): void }) => Promise<T>) {
      if (workspaceId !== "w") throw new Error("wrong workspace");
      return work({ workspace, signal: controller.signal, assertCurrent() { if (!current) throw new Error("retired"); } });
    } };
  const handler = createOwnerAppBackendHandler(deps);
  let renderer!: (event: { sender: number }, raw: unknown) => unknown;
  registerOwnerAppBackendIpc({ ...deps, registerHandler(_channel, handler) { renderer = handler; }, assertTrustedSender({ sender }) { if (sender !== 1) throw new Error("untrusted"); },
    withRendererWorkspaceOperation: (sender, workspaceId, _message, work) => deps.withWorkspaceOperation(sender, workspaceId, work) });
  return { relay, transport, save, workspace, controller, renderer, invoke: (raw: unknown) => handler(1, raw), retire() { current = false; }, changeCredentials() { generation++; } };
}

describe("owner backend IPC", () => {
  it("uses current trusted authority for invocation and ignores caller authority fields", async () => {
    const h = harness();
    expect(await h.invoke({ workspaceId: "w", publicationId, action: "describe" })).toEqual({ capability, revision: 3, online: true });
    const request = { workspaceId: "w", publicationId, action: "invoke", operation: "list", idempotencyKey: "request-1", input: {} };
    expect(await h.invoke(request)).toEqual({ result: [{ id: "one" }], revision: 3, replayed: false });
    expect(JSON.parse(String(h.relay.mock.calls.at(-1)![2].body))).toEqual({ authorityRevision: 7, operation: "list", idempotencyKey: "request-1", input: {} });
    await expect(h.invoke({ ...request, authorityRevision: 99 })).rejects.toThrow();
  });

  it.each(["retired", "credential", "aborted"])("does not invoke after %s during describe", async kind => {
    const h = harness();
    h.relay.mockImplementationOnce(async () => { if (kind === "retired") h.retire(); else if (kind === "credential") h.changeCredentials(); else h.controller.abort(); return description; });
    await expect(h.invoke({ workspaceId: "w", publicationId, action: "invoke", operation: "list", idempotencyKey: "one", input: null })).rejects.toThrow();
    expect(h.relay).toHaveBeenCalledTimes(1);
  });

  it.each(["workspace", "received", "sender"])("refuses %s authority before transport access", async kind => {
    const h = harness(); if (kind === "received") h.workspace.shareView = { shareId: "s" };
    await expect(async () => h.renderer({ sender: kind === "sender" ? 2 : 1 }, { workspaceId: kind === "workspace" ? "other" : "w", publicationId, action: "describe" })).rejects.toThrow();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("refuses a different publication or unknown operation before mutation", async () => {
    const h = harness(); h.relay.mockResolvedValueOnce({ ...description, publicationId: "d".repeat(64) });
    await expect(h.invoke({ workspaceId: "w", publicationId, action: "helper", grantId: "g", enabled: true })).rejects.toThrow();
    await expect(h.invoke({ workspaceId: "w", publicationId, action: "invoke", operation: "missing", idempotencyKey: "one", input: {} })).rejects.toThrow();
    expect(h.relay).toHaveBeenCalledTimes(2);
  });

  it("exports a complete bundle through the save boundary and never accepts a renderer path", async () => {
    const h = harness();
    expect(await h.invoke({ workspaceId: "w", publicationId, action: "export", savePath: "C:\\Exports\\recovery.json" })).toEqual({ savedPath: "C:\\Exports\\recovery.json" });
    expect(h.save).toHaveBeenCalledWith(h.workspace, publicationId, { formatVersion: 1, snapshot: { encoding: "base64", bytes: "AA==" } }, h.controller.signal, { path: "C:\\Exports\\recovery.json", overwrite: false });
    expect(() => h.renderer({ sender: 1 }, { workspaceId: "w", publicationId, action: "export", savePath: "C:\\private.json" })).toThrow(/save dialog/);
  });

  it("validates helper confirmation before reporting success", async () => {
    const h = harness();
    expect(await h.invoke({ workspaceId: "w", publicationId, action: "helper", grantId: "g", enabled: true })).toEqual({ grantId: "g", enabled: true });
    h.relay.mockResolvedValueOnce(description).mockResolvedValueOnce({ grantId: "another", enabled: true });
    await expect(h.invoke({ workspaceId: "w", publicationId, action: "helper", grantId: "g", enabled: true })).rejects.toThrow(/confirm/);
  });
});

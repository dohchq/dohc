import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { compileClosedApp } from "../workspaces/closedAppCompiler";
import { registerOwnerAppPublicationIpc } from "./ownerAppPublicationIpc";
import { OwnerAppPublicationResult } from "./ownerAppPublicationContract";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const prepareInput = { action: "prepare", workspaceId: "w", appRoot: "app", shareId: "s", grantId: "g" };
function harness() {
  const source = new Map<string, Uint8Array>([
    ["app/app.publish.json", Buffer.from(JSON.stringify({ entryPath: "app/index.js", inputs: ["app/index.js"], packageMap: {} }))],
    ["app/index.js", Buffer.from("document.body.textContent='trip';")],
  ]);
  const blobs = new Map<string, Uint8Array>();
  const controller = new AbortController();
  const workspace = { workspaceId: "w", shareView: undefined as unknown };
  let rendererGeneration = 1, credentialGeneration = 1, current = true, captures = 0;
  let beforeCapture: (count: number) => void = () => {};
  const requests: string[] = [];
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    requests.push(request.method);
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      beforeCapture(++captures);
      const paths = params.paths as string[];
      const files = [...paths].sort().map(path => {
        const bytes = source.get(path)!;
        const sha256 = hash(bytes); blobs.set(sha256, Uint8Array.from(bytes));
        return { path, objectId: path, contentKind: "text", sha256, byteLength: bytes.byteLength, latestMomentId: "m" };
      });
      return { id: request.id, result: { workspaceId: "w", versionId: "main", files, totalBytes: files.reduce((n, f) => n + f.byteLength, 0),
        sourceDigest: hash(JSON.stringify(["dohc-source-capture-v1", "w", "main", files])) } };
    }
    const bytes = blobs.get(String(params.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "w" });
  const credentials = { serverUrl: "https://account.example", relayUrl: "https://relay.example", userId: "owner", token: "test-only", email: "owner@example.test" };
  const grant = { shareId: "s", grantId: "g", generation: 7, status: "active", revokedAtMs: null, selector: { paths: ["app"], versionId: null },
    createdAtMs: 1, lastUsedAtMs: null, urlIssuedAtMs: null, dependents: [], access: "view" };
  const publicationId = "a".repeat(64);
  const relay = vi.fn(async (_credentials: typeof credentials, path: string, init?: RequestInit): Promise<unknown> => {
    if (path.endsWith("/shares/links")) return { ok: true, supportedLinkAccess: ["view", "comment"], links: [grant], independentGrants: [] };
    if (path.endsWith("/withdraw")) return { publicationId, active: false, authorityRevision: 2, owner: { workspaceId: "w" } };
    const body = JSON.parse(String(init!.body));
    if (body.expectedGrantGeneration !== grant.generation) throw new Error("grant conflict");
    return { publicationId, candidate: body.candidate, active: true, authorityRevision: 1, owner: {
      workspaceId: "w", shareId: body.shareId, grantId: body.grantId, generation: body.expectedGrantGeneration, ownerUserId: "owner" } };
  });
  const compile = vi.fn(compileClosedApp), upload = vi.fn(async () => {}), flush = vi.fn(async () => {});
  let handler!: (event: { sender: { id: number } }, payload: unknown) => unknown;
  registerOwnerAppPublicationIpc({ registerHandler(_channel, fn) { handler = fn; }, assertTrustedSender(event: { sender: { id: number } }) { if (event.sender.id < 0) throw new Error("untrusted"); },
    async withRendererWorkspaceOperation(_sender, _workspaceId, _message, work) { return work({ workspace, signal: controller.signal, session: { generation: rendererGeneration }, assertCurrent() { if (!current) throw new Error("retired"); } }); },
    remoteForWorkspace: async () => ({ credentials, credentialGeneration }), currentCredentialGeneration: () => credentialGeneration,
    flushCapture: flush, withAdapter: async (_workspace, work) => work(adapter), compile, relayJson: relay, upload });
  const invoke = async (input: unknown, senderId = 1) => OwnerAppPublicationResult.parse(await handler({ sender: { id: senderId } }, input));
  const prepare = async () => { const result = await invoke(prepareInput); if (result.kind !== "prepared") throw new Error("not prepared"); return result; };
  const approve = (value: Awaited<ReturnType<typeof prepare>>, digest = value.candidateDigest) => invoke({ action: "approve", workspaceId: "w", approvalId: value.approvalId, candidateDigest: digest });
  return { source, grant, controller, workspace, requests, compile, upload, relay, flush, invoke, prepare, approve,
    setBeforeCapture(fn: typeof beforeCapture) { beforeCapture = fn; }, retire() { current = false; },
    switchRenderer() { rendererGeneration++; }, switchCredential() { credentialGeneration++; } };
}

describe("owner app publication", () => {
  it("prepares exact sources without upload, then approves the displayed digest and supports withdrawal", async () => {
    const h = harness(), prepared = await h.prepare();
    expect(prepared).toMatchObject({ externalNetwork: true, capabilities: [], sourcePaths: ["app/app.publish.json", "app/index.js"] });
    expect(h.upload).not.toHaveBeenCalled();
    h.source.set("app/index.js", Buffer.from("later source edit"));
    expect(await h.approve(prepared)).toMatchObject({ kind: "published", authorityRevision: 1 });
    const body = JSON.parse(String(h.relay.mock.calls.at(-1)![2]!.body));
    expect(body.expectedGrantGeneration).toBe(7);
    expect(body.candidate.sourceRevision).toBe(prepared.sourceRevision);
    expect(body.candidate.inputs.find((row: {path: string}) => row.path === "app/index.js").sha256).toBe(hash("document.body.textContent='trip';"));
    await expect(h.approve(prepared)).rejects.toThrow("expired");
    expect(await h.invoke({ action: "withdraw", workspaceId: "w", publicationId: "a".repeat(64), expectedAuthorityRevision: 1 })).toMatchObject({ kind: "withdrawn", authorityRevision: 2 });
  });
  it("refuses approval of a different digest before upload", async () => {
    const h = harness(), prepared = await h.prepare();
    await expect(h.approve(prepared, "b".repeat(64))).rejects.toThrow("candidate changed");
    expect(h.upload).not.toHaveBeenCalled();
    await h.invoke({ action: "cancel", workspaceId: "w", approvalId: prepared.approvalId });
    await expect(h.approve(prepared)).rejects.toThrow("expired");
  });
  it("reviews immutable withdrawn bytes before an explicit revision-checked republish", async () => {
    const h = harness(), first = await h.prepare(); await h.approve(first);
    const body = JSON.parse(String(h.relay.mock.calls.at(-1)![2]!.body));
    const owner = { workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 7 };
    h.relay.mockResolvedValueOnce({ publicationId: "a".repeat(64), candidate: body.candidate, owner, active: false, authorityRevision: 2 });
    const reviewed = await h.invoke({ action: "reviewReactivation", workspaceId: "w", publicationId: "a".repeat(64) });
    if (reviewed.kind !== "prepared") throw new Error("Expected reviewed publication.");
    expect(reviewed.candidateDigest).toBe(first.candidateDigest);
    await expect(h.approve(reviewed, "b".repeat(64))).rejects.toThrow("candidate changed");
    h.relay.mockResolvedValueOnce({ publicationId: "a".repeat(64), owner, active: true, authorityRevision: 3 });
    expect(await h.approve(reviewed)).toMatchObject({ kind: "published", authorityRevision: 3 });
    expect(h.relay.mock.calls.at(-1)![1]).toMatch(/\/reactivate$/);
    expect(JSON.parse(String(h.relay.mock.calls.at(-1)![2]!.body))).toEqual({ expectedAuthorityRevision: 2 });
    expect(h.upload).toHaveBeenCalledOnce();
  });
  it("refuses an individual bundle above the relay blob cap before approval", async () => {
    const h = harness();
    h.compile.mockImplementationOnce(async request => {
      const built = await compileClosedApp(request);
      built.files[0]!.byteLength = 20 * 1024 * 1024 + 1;
      return built;
    });
    await expect(h.prepare()).rejects.toThrow("bundle bound");
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("refuses source declarations that change before final capture", async () => {
    const h = harness();
    h.setBeforeCapture(count => { if (count === 2) h.source.set("app/app.publish.json", Buffer.from("{}")); });
    await expect(h.prepare()).rejects.toThrow("declaration changed");
    expect(h.compile).not.toHaveBeenCalled();
  });
  it("preflights all declared paths before reading their bytes", async () => {
    const h = harness();
    h.source.set("app/app.publish.json", Buffer.from(JSON.stringify({ entryPath: "private/index.js", inputs: ["private/index.js"], packageMap: {} })));
    await expect(h.prepare()).rejects.toThrow("outside this link");
    expect(h.requests.filter(method => method === "versionedText.captureSources")).toHaveLength(1);
  });
  it.each(["renderer", "credential", "physical"])("refuses approval after %s authority changes", async kind => {
    const h = harness(), prepared = await h.prepare();
    if (kind === "renderer") h.switchRenderer();
    if (kind === "credential") h.switchCredential();
    if (kind === "physical") h.controller.abort();
    await expect(h.approve(prepared)).rejects.toThrow("expired");
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("keeps the prepared grant generation for the relay CAS", async () => {
    const h = harness(), prepared = await h.prepare(); h.grant.generation++;
    await expect(h.approve(prepared)).rejects.toThrow("grant conflict");
  });
  it("does not publish after compiler or upload failure", async () => {
    const h = harness(); h.compile.mockRejectedValueOnce(new Error("compiler failed"));
    await expect(h.prepare()).rejects.toThrow("compiler failed");
    const prepared = await h.prepare(); h.upload.mockRejectedValueOnce(new Error("upload failed"));
    await expect(h.approve(prepared)).rejects.toThrow("upload failed");
    expect(h.relay.mock.calls.every(call => call[1].endsWith("/shares/links"))).toBe(true);
  });
  it("refuses overlapping preparation in one window", async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const compiling = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    h.compile.mockImplementationOnce(async request => { entered(); await blocked; return compileClosedApp(request); });
    const first = h.prepare();
    await compiling;
    await expect(h.prepare()).rejects.toThrow("already preparing");
    release();
    const prepared = await first;
    await h.invoke({ action: "cancel", workspaceId: "w", approvalId: prepared.approvalId });
  });
  it("rejects received shares before credentials, capture, or compilation", async () => {
    const h = harness(); h.workspace.shareView = { shareId: "received" };
    await expect(h.prepare()).rejects.toThrow("original workspace");
    expect(h.requests).toEqual([]); expect(h.flush).not.toHaveBeenCalled();
  });
  it("preserves an empty list page with a continuation and refuses another app's rows", async () => {
    const h = harness(), cursor = "c".repeat(64);
    h.relay.mockResolvedValueOnce({ publications: [], nextCursor: cursor });
    expect(await h.invoke({ action: "list", workspaceId: "w", appRoot: "app" })).toEqual({ kind: "listed", publications: [], nextCursor: cursor });
    expect(h.requests).toEqual([]);
    h.relay.mockResolvedValueOnce({ publications: [{ publicationId: "a".repeat(64), authorityRevision: 1, shareId: "s", grantId: "g", appRoot: "another", sourceRevision: "d".repeat(64), active: true, manifestUnavailable: false }], nextCursor: null });
    await expect(h.invoke({ action: "list", workspaceId: "w", appRoot: "app", cursor })).rejects.toThrow("another app");
    const damaged = { publicationId: "a".repeat(64), authorityRevision: 1, shareId: "s", grantId: "g", active: true, manifestUnavailable: true };
    h.relay.mockResolvedValueOnce({ publications: [damaged], nextCursor: null });
    expect(await h.invoke({ action: "list", workspaceId: "w", appRoot: "app" })).toEqual({ kind: "listed", publications: [damaged], nextCursor: null });
  });
});

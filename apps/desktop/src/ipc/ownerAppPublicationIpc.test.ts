import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { APP_PUBLICATION_MAX_BLOB_BYTES, APP_PUBLICATION_MAX_REQUEST_BYTES } from "@dohc/security-contract/app-publication";
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
    if (path.endsWith("/collection-approval")) return { publicationId, authorityRevision: body.expectedAuthorityRevision + 1, capability: body.capability };
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

const collection = { kind: "collection-create", collectionPath: "app/responses", allowedFields: ["name", "destination"], requiredFields: ["destination"], readFields: ["name", "destination"] };
const collectionSchema = "fields:\n  name:\n    type: text\n  destination:\n    type: select\n    options: [Tokyo, Manila]\n";
function withCollection(h: ReturnType<typeof harness>, declaration = collection) {
  h.source.set("app/app.publish.json", Buffer.from(JSON.stringify({ entryPath: "app/index.js", inputs: ["app/index.js"], packageMap: {}, collection: declaration })));
  h.source.set(`${declaration.collectionPath}/collection.yaml`, Buffer.from(collectionSchema));
  return h;
}

describe("owner app publication", () => {
  it("captures and reviews the exact selected collection before granting access", async () => {
    const h = withCollection(harness());
    const prepared = await h.prepare();
    const capability = { ...collection, schemaSha256: hash(collectionSchema), allowedFields: ["destination", "name"], readFields: ["destination", "name"] };
    expect(prepared.capabilities).toEqual([capability]);
    expect(prepared.sourcePaths).toContain("app/responses/collection.yaml");
    expect(h.compile.mock.calls[0]![0].inputs.map(file => file.path)).toEqual(prepared.sourcePaths);
    expect(h.relay.mock.calls.every(call => call[1].endsWith("/shares/links"))).toBe(true);
    expect(await h.approve(prepared)).toMatchObject({ kind: "published", authorityRevision: 2 });
    const publishBody = JSON.parse(String(h.relay.mock.calls.at(-2)![2]!.body));
    expect(publishBody.candidate.capabilities).toEqual([capability]);
    expect(publishBody.candidate.inputs.find((file: { path: string }) => file.path.endsWith("collection.yaml")).sha256).toBe(hash(collectionSchema));
    expect(JSON.parse(String(h.relay.mock.calls.at(-1)![2]!.body))).toEqual({ expectedAuthorityRevision: 1, capability });
  });
  it.each(["outside", "malformed", "missing-field", "oversized"])("refuses %s collection schema before compiling", async kind => {
    const h = withCollection(harness(), kind === "outside" ? { ...collection, collectionPath: "private/responses" } : collection);
    if (kind === "malformed") h.source.set("app/responses/collection.yaml", Buffer.from("fields: ["));
    if (kind === "missing-field") h.source.set("app/responses/collection.yaml", Buffer.from("fields:\n  name:\n    type: text\n"));
    if (kind === "oversized") h.source.set("app/responses/collection.yaml", Buffer.alloc(65_537, 32));
    await expect(h.prepare()).rejects.toThrow();
    expect(h.compile).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    if (kind === "outside") expect(h.requests.filter(method => method === "versionedText.captureSources")).toHaveLength(1);
  });
  it.each(["network", "null", "mismatch"])("reports partial publication and permits retry after %s collection approval failure", async kind => {
    const h = withCollection(harness()), prepared = await h.prepare();
    const original = h.relay.getMockImplementation()!;
    h.relay.mockImplementation(async (...args) => {
      if (!args[1].endsWith("/collection-approval")) return original(...args);
      if (kind === "network") throw new Error("404");
      return { publicationId: "a".repeat(64), authorityRevision: 2,
        capability: kind === "null" ? null : { ...prepared.capabilities[0], readFields: [] } };
    });
    await expect(h.approve(prepared)).rejects.toThrow("The app is published.");
    expect(h.relay.mock.calls.filter(call => call[1].endsWith("/app-publications"))).toHaveLength(1);
    h.relay.mockImplementation(original);
    expect(await h.approve(await h.prepare())).toMatchObject({ kind: "published", authorityRevision: 2 });
  });
  it("preserves the full collection capability when reviewing and approving reactivation", async () => {
    const h = withCollection(harness()), prepared = await h.prepare();
    await h.approve(prepared);
    const { candidate } = JSON.parse(String(h.relay.mock.calls.at(-2)![2]!.body));
    const owner = { workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 7 };
    h.relay.mockResolvedValueOnce({ publicationId: "a".repeat(64), candidate, owner, active: false, authorityRevision: 3 });
    const reviewed = await h.invoke({ action: "reviewReactivation", workspaceId: "w", publicationId: "a".repeat(64) });
    if (reviewed.kind !== "prepared") throw new Error("Expected reviewed publication.");
    expect(reviewed.capabilities).toEqual(prepared.capabilities);
    expect(reviewed.candidateDigest).toBe(prepared.candidateDigest);
    h.relay.mockResolvedValueOnce({ publicationId: "a".repeat(64), owner, active: true, authorityRevision: 4 });
    expect(await h.approve(reviewed)).toMatchObject({ kind: "published", authorityRevision: 5 });
    expect(JSON.parse(String(h.relay.mock.calls.at(-1)![2]!.body))).toEqual({ expectedAuthorityRevision: 4, capability: prepared.capabilities[0] });
  });
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

  it("revokes collection access with the current authority revision", async () => {
    const h = withCollection(harness());
    const result = await h.invoke({ action: "revokeCollection", workspaceId: "w", publicationId: "a".repeat(64), expectedAuthorityRevision: 7 });
    expect(result).toEqual({ kind: "collectionRevoked", publicationId: "a".repeat(64), authorityRevision: 8 });
    expect(JSON.parse(String(h.relay.mock.calls.at(-1)![2]!.body))).toEqual({ expectedAuthorityRevision: 7, capability: null });
  });
  it.each(["abort", "conflict", "retired"])("preserves %s during collection approval", async kind => {
    const h = withCollection(harness()), prepared = await h.prepare();
    const original = h.relay.getMockImplementation()!;
    h.relay.mockImplementation(async (...args) => {
      if (!args[1].endsWith("/collection-approval")) return original(...args);
      if (kind === "abort") { h.controller.abort(); throw h.controller.signal.reason; }
      if (kind === "retired") h.retire();
      throw new Error("Publication authority changed.");
    });
    if (kind === "abort") await expect(h.approve(prepared)).rejects.toMatchObject({ name: "AbortError" });
    else await expect(h.approve(prepared)).rejects.toThrow(kind === "retired" ? "retired" : "Publication authority changed.");
  });
  it.each(["wrong-id", "wrong-revision", "not-revoked", "stale", "retired"])("does not confirm %s revocation", async kind => {
    const h = harness();
    h.relay.mockImplementationOnce(async () => {
      if (kind === "stale") throw new Error("Publication authority changed.");
      if (kind === "retired") h.retire();
      return { publicationId: (kind === "wrong-id" ? "b" : "a").repeat(64), authorityRevision: kind === "wrong-revision" ? 7 : 8, capability: kind === "not-revoked" ? collection : null };
    });
    await expect(h.invoke({action:"revokeCollection",workspaceId:"w",publicationId:"a".repeat(64),expectedAuthorityRevision:7})).rejects.toThrow();
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
  it.each(["metadata", "blob"])("refuses withdrawn publications above the %s limit before approval", async kind => {
    const baseline = harness();
    await baseline.approve(await baseline.prepare());
    const { candidate } = JSON.parse(String(baseline.relay.mock.calls.at(-1)![2]!.body));
    if (kind === "metadata") candidate.compilerIdentity.version = "x".repeat(APP_PUBLICATION_MAX_REQUEST_BYTES + 1);
    else candidate.files[0].byteLength = APP_PUBLICATION_MAX_BLOB_BYTES + 1;
    const h = harness();
    h.relay.mockResolvedValueOnce({ publicationId: "a".repeat(64), candidate, active: false, authorityRevision: 2,
      owner: { workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 7 } });
    await expect(h.invoke({ action: "reviewReactivation", workspaceId: "w", publicationId: "a".repeat(64) })).rejects.toThrow();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.relay).toHaveBeenCalledOnce();
    expect(h.relay.mock.calls[0]![2]?.method).toBeUndefined();
  });
  it.each([-1, 0, 1])("checks the complete publication envelope at the byte limit %+i", async offset => {
    const baseline = harness();
    await baseline.approve(await baseline.prepare());
    const baselineBody = String(baseline.relay.mock.calls.at(-1)![2]!.body);
    const targetBytes = APP_PUBLICATION_MAX_REQUEST_BYTES + offset;
    const paddingBytes = targetBytes - Buffer.byteLength(baselineBody, "utf8");
    const h = harness();
    h.compile.mockImplementationOnce(async request => {
      const built = await compileClosedApp(request);
      built.compiler.version += "x".repeat(paddingBytes);
      return built;
    });
    if (offset > 0) {
      await expect(h.prepare()).rejects.toThrow("supported publication size");
      expect(h.upload).not.toHaveBeenCalled();
      expect(h.relay.mock.calls.every(call => call[1].endsWith("/shares/links"))).toBe(true);
      return;
    }
    const prepared = await h.prepare();
    expect(h.upload).not.toHaveBeenCalled();
    await h.approve(prepared);
    expect(Buffer.byteLength(String(h.relay.mock.calls.at(-1)![2]!.body), "utf8")).toBe(targetBytes);
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
    await expect(h.approve(prepared)).rejects.toThrow(kind === "physical" ? "aborted" : "expired");
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
    h.relay.mockResolvedValueOnce({ publications: [{ publicationId: "a".repeat(64), authorityRevision: 1, shareId: "s", grantId: "g", appRoot: "another", sourceRevision: "d".repeat(64), active: true, backendCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: false }], nextCursor: null });
    await expect(h.invoke({ action: "list", workspaceId: "w", appRoot: "app", cursor })).rejects.toThrow("another app");
    const damaged = { publicationId: "a".repeat(64), authorityRevision: 1, shareId: "s", grantId: "g", active: true, backendCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: true };
    h.relay.mockResolvedValueOnce({ publications: [damaged], nextCursor: null });
    expect(await h.invoke({ action: "list", workspaceId: "w", appRoot: "app" })).toEqual({ kind: "listed", publications: [damaged], nextCursor: null });
  });
});

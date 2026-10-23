import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { createReceivedFileReferenceScopes, type ReceivedScopeDependencies, workspaceFileRefs } from "./workspaceFileReferenceScopes";
import { createEngineFileResolver } from "./resolveEngineFiles";
import type { ShareMountRecord, ShareViewIdentity } from "./registryStore";
import { realpathSync } from "node:fs";
import { canonicalWorkspaceRoot } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";

const token = "share-object:v1:" + "a".repeat(64);
const pin = { receivedSource: "share-source:v1:" + "b".repeat(64), grantId: "grant", generation: 2 };
const selector = { paths: ["docs"], versionId: null, access: "view" as const };
const attachmentId = Symbol("attachment");
const workspace = { workspaceId: "host", rootPath: "C:/host", attachmentId };

function harness(mounted = false, rootPath = workspace.rootPath) {
  const view: ShareViewIdentity = { shareId: "share", granterEmail: null, genericChatWritable: false,
    grantedSelector: structuredClone(selector), receivedIdentity: { ...pin }, relayUrl: "https://relay.example/", recipientUserId: "recipient" };
  const mount: ShareMountRecord = { ...view, label: "alex", relayUrl: "https://relay.example/" };
  let registry = { rootPath, shareView: mounted ? undefined : view, shareMounts: mounted ? [mount] : [] };
  let credentials = { userId: "recipient", relayUrl: "https://relay.example" };
  let generation = 1, attachment = attachmentId, session = 1;
  let duringResolve: () => void = () => undefined;
  const deps: ReceivedScopeDependencies<typeof workspace> = {
    findWorkspace: () => registry,
    currentAttachment: () => attachment,
    isCurrentAttachment: (_id, expected) => attachment === expected,
    warmCredentials: vi.fn(async () => undefined), credentials: () => credentials,
    credentialGeneration: () => generation,
    mountWorkspace: (_host, record) => ({ workspaceId: "mount-store", rootPath: "C:/host/shared-with-me/" + record.label, attachmentId: attachment }),
  };
  const engine = new VersionedLoopbackEngine();
  const engineId = mounted ? "mount-store" : "host";
  engine.seedTextFile({ workspace: engineId, path: "docs/renamed.md", objectId: token, text: "source" });
  const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, engineId, { workspaceId: engineId });
  const original = adapter.resolveFiles.bind(adapter);
  const resolveFiles = vi.spyOn(adapter, "resolveFiles").mockImplementation(async input => {
    const result = await original(input);
    duringResolve();
    return result;
  });
  const scopes = createReceivedFileReferenceScopes(deps);
  const resolve = createEngineFileResolver<typeof workspace>(async (_ws, work) => {
    const capturedSession = session;
    return work(adapter, () => { if (session !== capturedSession) throw new Error("Engine session retired"); });
  }, scopes);
  const record = () => mounted ? registry.shareMounts[0]! : registry.shareView!;
  return { deps, scopes, resolve, resolveFiles, record, refs: workspaceFileRefs({ ...workspace, shareView: view }, token),
    during(work: () => void) { duringResolve = work; },
    changeCredentials(value: typeof credentials) { credentials = value; },
    changeGeneration() { generation++; }, retireAttachment() { attachment = Symbol("replacement"); }, retireSession() { session++; },
    replaceRoot() { registry = { ...registry, rootPath: "C:/replacement" }; },
  };
}

it.each(["account", "relay", "ended", "missing pin", "damaged selector"])("does not admit a projection with %s", async kind => {
  const h = harness();
  if (kind === "account") h.changeCredentials({ userId: "stranger", relayUrl: "https://relay.example" });
  if (kind === "relay") h.changeCredentials({ userId: "recipient", relayUrl: "https://other.example" });
  if (kind === "ended") h.record().ended = true;
  if (kind === "missing pin") h.record().receivedIdentity = undefined;
  if (kind === "damaged selector") h.record().grantedSelector = { ...selector, paths: ["../private"] };
  expect(await h.scopes(workspace)).toEqual([]);
  expect(await h.resolve(workspace, h.refs)).toEqual([{ status: "absent" }]);
  expect(h.resolveFiles).not.toHaveBeenCalled();
});

it("admits matching accounts and normalized relay origins and prefixes mount paths", async () => {
  const h = harness(true);
  const scopes = await h.scopes(workspace);
  expect(scopes[0]).toMatchObject({ workspace: { workspaceId: "mount-store" }, pin, selector, pathPrefix: "shared-with-me/alex/" });
  expect(await h.resolve(workspace, h.refs)).toEqual([{ status: "found", objectId: token, path: "shared-with-me/alex/docs/renamed.md" }]);
});

it.each(["selector", "version", "grant", "generation", "ended", "credential generation", "session", "attachment", "root"])("fences a production scope when %s changes during resolution", async kind => {
  const h = harness(true);
  h.during(() => {
    switch (kind) {
      case "selector": h.record().grantedSelector = { ...selector, paths: ["other"] }; break;
      case "version": h.record().grantedSelector = { ...selector, versionId: "snapshot" }; break;
      case "grant": h.record().receivedIdentity = { ...pin, grantId: "replacement" }; break;
      case "generation": h.record().receivedIdentity = { ...pin, generation: 3 }; break;
      case "ended": h.record().ended = true; break;
      case "credential generation": h.changeGeneration(); break;
      case "session": h.retireSession(); break;
      case "attachment": h.retireAttachment(); break;
      case "root": h.replaceRoot(); break;
    }
  });
  await expect(h.resolve(workspace, h.refs)).rejects.toThrow(kind === "session" ? "Engine session retired" : "The shared file session changed.");
});

it("rechecks the attachment after credential loading", async () => {
  const h = harness();
  h.deps.warmCredentials = async () => { h.retireAttachment(); };
  await expect(h.scopes(workspace)).rejects.toThrow("The shared file session changed.");
});

it("rejects a replaced caller attachment before loading credentials", async () => {
  const h = harness();
  expect(await h.scopes({ ...workspace, attachmentId: Symbol("old") })).toEqual([]);
  expect(h.deps.warmCredentials).not.toHaveBeenCalled();
});

it.each([false, true])("resolves renamed received files across root spellings and refuses another folder (mount %s)", async mounted => {
  const folder = await createTestScratch("reference-root-spelling-");
  const registryRoot = canonicalWorkspaceRoot(folder), nativeRoot = realpathSync.native(folder);
  const h = harness(mounted, registryRoot);
  for (const rootPath of [registryRoot, nativeRoot]) {
    expect(await h.scopes({ ...workspace, rootPath })).toHaveLength(1);
    expect(await h.resolve({ ...workspace, rootPath }, h.refs)).toEqual([
      { status: "found", objectId: token, path: mounted ? "shared-with-me/alex/docs/renamed.md" : "docs/renamed.md" },
    ]);
  }
  const other = canonicalWorkspaceRoot(await createTestScratch("reference-other-root-"));
  h.resolveFiles.mockClear();
  expect(await h.scopes({ ...workspace, rootPath: other })).toEqual([]);
  expect(h.resolveFiles).not.toHaveBeenCalled();
});

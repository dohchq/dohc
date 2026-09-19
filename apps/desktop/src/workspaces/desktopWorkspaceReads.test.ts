import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter, type Request } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions, type EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import { deferred } from "../testing/deferred";
import { createDesktopWorkspaceReads, type DesktopWorkspaceReadsDependencies } from "./desktopWorkspaceReads";
import { createOwnedProjectionRepairer } from "./ownedProjectionRepair";
import type { OwnedWorkspaceDatabaseReader } from "./ownedWorkspaceFileReader";
import { createReceivedShareEngineAccess } from "./receivedShareEngineAccess";
import type { RegistryEntry, ShareMountRecord } from "./registryStore";
import { assertRealMountRoot } from "./shareMounts";
import { createShareViewFiles, type ShareViewFilesStore } from "./shareViewFiles";
import { resolveRegisteredShareViewFilesTarget } from "./shareViewFilesTarget";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import { createTestScratch } from "./testTemp";

const selector = { paths: [], versionId: "main", access: "view" } as const;
const mount: ShareMountRecord = {
  shareId: "share-a", label: "alice", granterEmail: "alice@example.com",
  relayUrl: "https://relay.example", grantedSelector: { ...selector, paths: [] },
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const unused = (): never => { throw new Error("Unexpected external operation"); };

afterEach(() => vi.restoreAllMocks());

async function fixture(mode: "local" | "standalone" | "mount" = "local") {
  const rootPath = await createTestScratch("desktop-workspace-reads-");
  const workspace: RegistryEntry = {
    workspaceId: "workspace-a", rootPath, kind: "personal", mode: "local-first",
    ...(mode === "standalone" ? { shareView: {
      shareId: mount.shareId, granterEmail: mount.granterEmail, genericChatWritable: false,
      grantedSelector: { ...selector, paths: [] },
    } } : {}),
    ...(mode === "mount" ? { shareMounts: [mount] } : {}),
  };
  if (mode === "mount") await mkdir(join(rootPath, "shared-with-me", mount.label), { recursive: true });
  const authority = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: (root) => root,
    createState: () => ({}),
  });
  const attached = await authority.withOperation(workspace.workspaceId, (operation) => operation.workspace);
  const canonical = new Map<string, { kind: "text" | "binary"; bytes: Buffer }>();
  const beforeRead = { run: async () => undefined as void };
  const store = {
    ensureMainVersion: vi.fn(async () => ({ id: "main" })),
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      await beforeRead.run();
      const row = canonical.get(path);
      return row ? {
        path, contentKind: row.kind, text: row.bytes.toString("utf8"), sha256: hash(row.bytes),
        latestMomentId: `moment:${path}`,
      } : null;
    }),
    getMoment: vi.fn(async () => ({ payload: { before: null } })),
    readBinaryFile: vi.fn(async ({ path }: { path: string }) => canonical.get(path)?.bytes ?? null),
    listTextFileMetadata: vi.fn(async () => [...canonical].map(([path, row]) => ({
      path, objectId: `object:${path}`, contentKind: row.kind,
      byteLength: row.bytes.length, sha256: hash(row.bytes), updatedAtMs: 1,
      latestMomentId: `moment:${path}`, hasYdocMarker: false,
    }))),
  };
  const shareViewFiles = createShareViewFiles({
    resolveTarget: (target) => resolveRegisteredShareViewFilesTarget(workspace, target),
    openStore: () => store as unknown as ShareViewFilesStore,
    resolveRelay: async () => null, pull: unused, recordRefusals: unused,
    markEnded: unused, retireTarget: unused,
    assertProjectionRoot: async (target) => {
      if (target.kind === "mount" && target.mountLabel) {
        await assertRealMountRoot(target.schedulingRootPath, target.mountLabel);
      }
    },
    createMount: unused, removeMount: unused,
  });
  const sessions = new EngineWorkspaceSessions({ currentClient: unused });
  const receivedShareEngine = createReceivedShareEngineAccess({
    sessions: () => sessions, relayClient: unused, createStores: unused,
  });
  const startupAccessed = deferred();
  const startup = { promise: Promise.resolve(true) };
  const lateReads: string[] = [];
  const adapterRoute = { run: (async () => null) as DesktopWorkspaceReadsDependencies["withEngineAdapter"] };
  const repair = { run: createOwnedProjectionRepairer(shareViewFiles) };
  const reads = createDesktopWorkspaceReads({
    withPhysicalWorkspaceOperation: (id, work) => authority.withOperation(id, work),
    withEngineAdapter: (location, work) => adapterRoute.run(location, work),
    isRecordValue: (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    get desktopEngine() {
      lateReads.push("engine");
      return { get startup() { startupAccessed.resolve(); return startup.promise; } };
    },
    get shareViewFiles() { lateReads.push("files"); return shareViewFiles; },
    get receivedShareEngine() { lateReads.push("received"); return receivedShareEngine; },
    get ensureOwnedProjectionTargetCurrent() { lateReads.push("repair"); return repair.run; },
  });
  async function disk(path: string, content: string | Buffer) {
    await mkdir(dirname(join(rootPath, path)), { recursive: true });
    await writeFile(join(rootPath, path), content);
  }
  return {
    rootPath, workspace, attached, authority, canonical, store, beforeRead,
    startup, startupAccessed, lateReads, adapterRoute, repair, reads, disk,
    path: (path: string) => mode === "mount" ? `shared-with-me/alice/${path}` : path,
  };
}

describe("desktop workspace reads", () => {
  it("narrows ordinary SDK listings while complete workspace listings stay complete", async () => {
    const test = await fixture();
    await test.disk("notes/a.md", "---\nicon: 🚀\n---\n");
    await test.disk("notes/deep/b.md", "nested");
    await test.disk("other/c.md", "unrelated");
    const port = test.reads.ownedWorkspaceReadsFor(test.attached);
    const listed = await port.listFiles({ path: "notes", recursive: false });
    expect(listed.files).toEqual([
      expect.objectContaining({ path: "notes/a.md", icon: "🚀", contentIdentity: expect.any(String) }),
    ]);
    expect((await test.reads.listOwnedWorkspaceFilesFor(test.attached)).files).toHaveLength(3);
  });

  it.each(["standalone", "mount"] as const)("keeps the complete canonical %s listing for scoped SDK reads", async (mode) => {
    const test = await fixture(mode);
    await test.disk("local.md", "local");
    await test.disk(test.path("recipient-only.md"), "stale disk");
    test.canonical.set("owner.md", { kind: "text", bytes: Buffer.from("owner") });
    test.canonical.set("deep/other.md", { kind: "text", bytes: Buffer.from("other") });
    const complete = await test.reads.listOwnedWorkspaceFilesFor(test.attached);
    const port = test.reads.ownedWorkspaceReadsFor(test.attached);
    expect(await port.listFiles({ path: test.path("owner.md"), recursive: false })).toEqual(complete);
    expect(complete.files.map((file) => file.path)).not.toContain(test.path("recipient-only.md"));
  });

  it("constructs before late owners exist and keeps local reads concurrent with startup", async () => {
    const test = await fixture();
    expect(test.lateReads).toEqual([]);
    const handshake = deferred<boolean>();
    test.startup.promise = handshake.promise;
    await test.disk("local.md", "local bytes");
    await test.disk("picture.png", Buffer.from([1, 2, 3]));
    try {
      expect(await test.reads.readOwnedWorkspaceText({ workspaceId: "workspace-a" }, "local.md"))
        .toMatchObject({ text: "local bytes", contentHash: hash("local bytes") });
      expect(await test.reads.readOwnedWorkspaceAsset(test.workspace, "picture.png"))
        .toMatchObject({ path: "picture.png", bytes: Buffer.from([1, 2, 3]), mediaType: "image/png" });
      expect((await test.reads.listOwnedWorkspaceFilesFor(test.attached)).files)
        .toEqual(expect.arrayContaining([expect.objectContaining({ path: "local.md", contentIdentity: expect.any(String) })]));
      expect(await test.reads.shareViewFilesTargetForPath(test.workspace, "local.md")).toBeNull();
      expect(test.lateReads).not.toContain("engine");
      expect(test.store.ensureMainVersion).not.toHaveBeenCalled();
      await expect(test.reads.readOwnedWorkspaceText({ workspaceId: "missing" }, "local.md")).rejects.toThrow();
    } finally { handshake.resolve(true); }
  });

  it.each(["standalone", "mount"] as const)("waits for %s startup and reads canonical text and asset bytes", async (mode) => {
    const test = await fixture(mode);
    const handshake = deferred<boolean>();
    test.startup.promise = handshake.promise;
    test.canonical.set("note.md", { kind: "text", bytes: Buffer.from("canonical") });
    test.canonical.set("picture.png", { kind: "binary", bytes: Buffer.from([4, 5, 6]) });
    await test.disk(test.path("note.md"), "stale projection");
    await test.disk(test.path("picture.png"), Buffer.from([9]));
    const reading = test.reads.readOwnedWorkspaceText(test.workspace, test.path("note.md"));
    try {
      await test.startupAccessed.promise;
      expect(test.store.ensureMainVersion).not.toHaveBeenCalled();
      const target = await test.reads.shareViewFilesTargetForPath(test.workspace, test.path("note.md"));
      expect(target).toEqual({ path: "note.md", target: mode === "mount"
        ? { kind: "mount", workspaceId: "workspace-a", shareId: "share-a" }
        : { kind: "standalone", workspaceId: "workspace-a" } });
      handshake.resolve(true);
      expect(await reading).toMatchObject({ text: "canonical", contentHash: hash("canonical") });
      expect(await test.reads.readOwnedWorkspaceAssetFor(test.attached, test.path("picture.png")))
        .toMatchObject({ bytes: Buffer.from([4, 5, 6]), mediaType: "image/png" });
      expect(await readFile(join(test.rootPath, test.path("note.md")), "utf8")).toBe("stale projection");
    } finally { handshake.resolve(true); await Promise.allSettled([reading]); }
  });

  it.each(["standalone", "mount"] as const)("gates the %s listing and replaces stale projection entries", async (mode) => {
    const test = await fixture(mode);
    const handshake = deferred<boolean>();
    test.startup.promise = handshake.promise;
    test.canonical.set("canonical.md", { kind: "text", bytes: Buffer.from("canonical") });
    await test.disk(test.path("stale.md"), "stale");
    if (mode === "mount") await test.disk("local.md", "local");
    const listing = test.reads.listOwnedWorkspaceFilesFor(test.attached);
    try {
      await test.startupAccessed.promise;
      expect(test.store.listTextFileMetadata).not.toHaveBeenCalled();
      handshake.resolve(true);
      const listed = await listing;
      expect(listed.files.map((file) => file.path)).toEqual(mode === "mount"
        ? ["local.md", test.path("canonical.md")] : ["canonical.md"]);
      expect(listed.files.find((file) => file.path === test.path("canonical.md")))
        .toMatchObject({ contentIdentity: `object:canonical.md:${hash("canonical")}:moment:canonical.md` });
    } finally { handshake.resolve(true); await Promise.allSettled([listing]); }
  });

  it.each([
    { shareMounts: [] },
    { shareMounts: null },
    { shareMounts: [null] },
    { shareMounts: [{ ...mount, label: "../escape" }] },
  ])("refuses damaged mount paths while keeping ordinary files: %j", async ({ shareMounts }) => {
    const test = await fixture();
    Object.assign(test.workspace, { shareMounts });
    const attached = { ...test.attached, shareMounts } as unknown as typeof test.attached;
    await test.disk("local.md", "local");
    await test.disk("shared-with-me/alice/stale.md", "stale");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listed = await test.reads.listOwnedWorkspaceFilesFor(attached);
    expect(listed.files.map((file) => file.path)).toEqual(["local.md"]);
    expect(await test.reads.ownedWorkspaceReadsFor(attached).listFiles({ path: "shared-with-me", recursive: false }))
      .toEqual(listed);
    await expect(test.reads.readOwnedWorkspaceTextFor(attached, "shared-with-me/alice/stale.md")).rejects.toThrow();
    expect(test.store.listTextFileMetadata).not.toHaveBeenCalled();
    expect(test.lateReads).toContain("engine");
    if (Array.isArray(shareMounts) && shareMounts.length > 0) {
      expect(logged).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects a share read completed after the physical attachment retires", async () => {
    const test = await fixture("standalone");
    test.canonical.set("note.md", { kind: "text", bytes: Buffer.from("canonical") });
    const entered = deferred();
    const release = deferred();
    test.beforeRead.run = async () => { entered.resolve(); await release.promise; };
    const reading = test.reads.readOwnedWorkspaceText(test.workspace, "note.md");
    const outcome = expect(reading).rejects.toThrow("retired workspace authority");
    await entered.promise;
    const retired = test.authority.invalidate("workspace-a");
    try { release.resolve(); await outcome; await retired; }
    finally { release.resolve(); await Promise.allSettled([reading, retired]); }
  });

  it("keeps a damaged standalone marker on the share path", async () => {
    const test = await fixture("standalone");
    Object.assign(test.workspace, { shareView: null });
    const attached = { ...test.attached, shareView: null } as unknown as typeof test.attached;
    await test.disk("note.md", "projection bytes");
    await expect(test.reads.readOwnedWorkspaceTextFor(attached, "note.md")).rejects.toThrow();
    await expect(test.reads.listOwnedWorkspaceFilesFor(attached)).resolves.toEqual({ files: [], folders: [] });
    await expect(test.reads.ownedWorkspaceReadsFor(attached).listFiles({ path: "note.md" }))
      .resolves.toEqual({ files: [], folders: [] });
    expect(test.store.listTextFileMetadata).toHaveBeenCalledTimes(2);
    const routes: EngineWorkspace[] = [];
    test.adapterRoute.run = async (location) => { routes.push(location); return null; };
    const port = test.reads.ownedWorkspaceReadsFor(attached);
    expect(await port.listCollections()).toEqual({ collections: [] });
    expect(routes).toEqual([{
      workspaceId: "workspace-a", rootPath: test.rootPath,
      attachmentId: test.attached.attachmentId, shareMount: true,
    }]);
    await expect(port.prepareSearch()).rejects.toThrow();
  });

  it("keeps SDK canonical reads ungated while desktop share reads wait", async () => {
    const test = await fixture("standalone");
    const handshake = deferred<boolean>();
    test.startup.promise = handshake.promise;
    test.canonical.set("note.md", { kind: "text", bytes: Buffer.from("canonical") });
    try {
      const port = test.reads.ownedWorkspaceReadsFor(test.attached);
      expect(await port.readText("note.md")).toMatchObject({ text: "canonical" });
      expect(test.lateReads).not.toContain("engine");
    } finally { handshake.resolve(true); }
  });

  it.each(["local", "standalone"] as const)("routes %s collection requests through the real received-share owner and adapter", async (mode) => {
    const test = await fixture(mode);
    const routes: EngineWorkspace[] = [];
    const requests: Request[] = [];
    const refused = new Error("engine collection refusal");
    const adapter = new VersionedLiveAdapter({
      close: () => undefined,
      sendRequest: async (request) => { requests.push(request); throw refused; },
    }, "engine-handle", { workspaceId: "workspace-a" });
    test.adapterRoute.run = async (location, work) => { routes.push(location); return work(adapter); };
    const port = test.reads.ownedWorkspaceReadsFor(test.attached);
    const query = { collectionPath: "projects", limit: 7 };
    const record = { collectionPath: "projects", recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", historyLimit: 3 };
    await expect(port.listCollections()).rejects.toBe(refused);
    await expect(port.getCollection({ collectionPath: "projects" })).rejects.toBe(refused);
    await expect(port.queryCollectionRecords(query)).rejects.toBe(refused);
    await expect(port.getCollectionRecord(record)).rejects.toBe(refused);
    await expect(port.getCollectionRecord({ ...record, beforeHistoryId: 17 })).rejects.toBe(refused);
    expect(requests.map(({ method, workspace, params }) => ({ method, workspace, params }))).toEqual([
      { method: "collections.list", workspace: "engine-handle", params: {} },
      { method: "collections.get", workspace: "engine-handle", params: { collectionPath: "projects" } },
      { method: "collections.query", workspace: "engine-handle", params: query },
      { method: "collections.getRecord", workspace: "engine-handle", params: record },
      { method: "collections.getRecord", workspace: "engine-handle", params: { ...record, beforeHistoryId: 17 } },
    ]);
    for (const route of routes) expect(route).toEqual({
      workspaceId: "workspace-a", rootPath: test.rootPath, attachmentId: test.attached.attachmentId,
      ...(mode === "standalone" ? { shareMount: true } : {}),
    });
    test.adapterRoute.run = async () => null;
    expect(await port.listCollections()).toEqual({ collections: [] });
    await expect(port.getCollection({ collectionPath: "projects" })).rejects.toThrow("The workspace engine is not running.");
    await expect(port.queryCollectionRecords(query)).rejects.toThrow("The workspace engine is not running.");
    await expect(port.getCollectionRecord(record)).rejects.toThrow("The workspace engine is not running.");
  });

  it("passes the optional database reader verified local paths and canonical share bytes", async () => {
    const test = await fixture("mount");
    const bytes = Buffer.from("database transport payload");
    await test.disk("local.sqlite", bytes);
    await test.disk(test.path("shared.sqlite"), "stale projection");
    test.canonical.set("shared.sqlite", { kind: "binary", bytes });
    const refused = new Error("database worker refusal");
    const verifiedPaths: string[] = [];
    const databaseReader: OwnedWorkspaceDatabaseReader = {
      readPrepared: vi.fn<OwnedWorkspaceDatabaseReader["readPrepared"]>(async (_path, source) => source.withVerifiedPath(async (path) => {
        verifiedPaths.push(path); throw refused;
      })),
      readBytes: vi.fn(async () => { throw refused; }),
      readPagePrepared: unused, readPageBytes: unused,
    };
    const port = test.reads.ownedWorkspaceReadsFor(test.attached, databaseReader);
    await expect(port.readDatabase("local.sqlite")).rejects.toBe(refused);
    await expect(port.readDatabase(test.path("shared.sqlite"))).rejects.toBe(refused);
    expect(verifiedPaths).toEqual([join(test.rootPath, "local.sqlite")]);
    expect(databaseReader.readBytes).toHaveBeenCalledWith(test.path("shared.sqlite"), bytes);
  });

  it.each(["standalone", "mount"] as const)("repairs %s search projections through the real share owner", async (mode) => {
    const test = await fixture(mode);
    test.canonical.set("missing.md", { kind: "text", bytes: Buffer.from("canonical search text") });
    const port = test.reads.ownedWorkspaceReadsFor(test.attached);
    const repair = vi.fn(test.repair.run);
    test.repair.run = repair;
    const view = await port.prepareSearch();
    expect(repair).toHaveBeenCalledWith({ rootPath: test.rootPath, target: mode === "mount"
      ? { kind: "mount", workspaceId: "workspace-a", shareId: "share-a" }
      : { kind: "standalone", workspaceId: "workspace-a" } });
    expect(await readFile(join(test.rootPath, test.path("missing.md")), "utf8")).toBe("canonical search text");
    expect(view.allowPath(test.path("missing.md"))).toBe(true);
    expect(view.listing?.files.map((file) => file.path)).toContain(test.path("missing.md"));
    expect(await port.readText(test.path("missing.md"))).toMatchObject({ text: "canonical search text" });
  });
});

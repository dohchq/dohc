import { workspaceFileRef } from "../workspaces/resolveEngineFiles";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceFilesIpc } from "./workspaceFilesIpc";
import { registerWorkspaceGraphIpcHandlers } from "./workspaceGraphIpc";
import { registerNativeMenusIpcHandlers } from "./nativeMenusIpc";
import { CHANNELS } from "./channels";
import * as visibilityReads from "../workspaces/workspaceListingVisibility";
import { CreateWorkspaceFileResult, DeleteWorkspacePathResult, type WorkspaceListingVisibility } from "./bridgeContract";
import { createFirstAppFiles } from "../renderer/workbench/createFirstApp";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import { WorkspaceGraphIndex } from "../workspaces/workspaceGraph";
import { WorkspaceFileListingCache } from "../workspaces/workspaceFileListingCache";
import { createWorkspaceFileMutationOwner } from "../workspaces/workspaceFileMutationOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createExactRendererWorkspaceReferenceOwner } from "../window/exactRendererWorkspaceReference";
import { readWorkspaceText } from "../workspaces/workspaceAssets";
import { listFiles } from "../workspaces/workspaceFiles";
import { shareViewWriteScopeOf, workspaceWriteRefusal, type ShareViewWriteScope } from "../workspaces/shareWriteGate";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";

type Sender = { id: number };
type Event = { sender: Sender; trusted: boolean };
type Workspace = RegistryEntry & { attachmentId: symbol };

afterEach(() => vi.unstubAllEnvs());

async function harness() {
  const rootPath = await createTestScratch("workspace-ipc-");
  const workspace: Workspace = {
    workspaceId: "workspace", rootPath, attachmentId: Symbol("attachment"),
    kind: "personal", mode: "local-first",
  };
  let generation = 1;
  let physicalCurrent = true;
  let rendererCurrent = true;
  const state = { workspaceGraph: new WorkspaceGraphIndex() };
  const withOperation = createRendererWorkspaceOperationRunner({
    currentSession: (_sender: Sender) => {
      const captured = generation;
      return {
        workspaceId: workspace.workspaceId, attachmentId: workspace.attachmentId,
        generation: captured, isCurrent: () => rendererCurrent && generation === captured,
      };
    },
    withPhysicalOperation: async <Result>(id: string, work: (operation: {
      workspace: Workspace; state: typeof state; signal: AbortSignal; assertCurrent(): void;
    }) => Result | Promise<Result>) => {
      if (id !== workspace.workspaceId) throw new Error("unknown workspace");
      return work({
        workspace, state, signal: new AbortController().signal,
        assertCurrent: () => { if (!physicalCurrent) throw new Error("physical retired"); },
      });
    },
  });
  type Operation = Parameters<Parameters<typeof withOperation>[3]>[0];
  const references = createExactRendererWorkspaceReferenceOwner<Sender, Workspace, Operation>(withOperation);
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const registerHandler = (channel: string, handler: (event: Event, payload: unknown) => unknown) => {
    expect(handlers.has(channel)).toBe(false);
    handlers.set(channel, handler);
  };
  const trusted = (event: Event) => { if (!event.trusted) throw new Error("untrusted"); };
  const change = vi.fn<ShareViewFiles["change"]>(async () => { throw new Error("share mutation refused"); });
  const shareFiles: Pick<ShareViewFiles, "change" | "list" | "read"> = {
    change, list: async () => { throw new Error("unexpected shared listing"); },
    read: async () => { throw new Error("unexpected shared read"); },
  };
  const mutations = createWorkspaceFileMutationOwner<Event, Workspace>({
    assertTrustedSender: trusted,
    withRendererWorkspaceOperation: (event, id, work) => withOperation(event.sender, id, "mutation retired", async (operation) => work({
      assertCurrent: () => operation.assertCurrent(),
      authorityId: operation.workspace.attachmentId, workspace: operation.workspace, capture: null,
      yDocSessions: {
        withDocumentUnowned: async (_authority, _path, run) => run(),
        markDeletedUnderPath: () => undefined,
      },
    })),
    shareViewFiles: shareFiles, trashItem: async () => { throw new Error("trash unavailable"); },
    localPerson: async () => ({ kind: "human", humanId: "local:test" }),
    notifyRenderer: () => undefined, shareViewEdited: () => undefined, logError: () => undefined,
  });
  const openDialog = vi.fn(async () => ({ canceled: true, filePaths: [] as string[] }));
  const saveDialog = vi.fn<() => Promise<{ canceled: boolean; filePath?: string }>>(async () => ({ canceled: true }));
  const listing = vi.fn(async () => listFiles(workspace.rootPath));
  const readText = vi.fn(async (_workspace: Workspace, path: string) => readWorkspaceText(workspace.rootPath, path));
  const assertWritable = vi.fn((entry: Workspace) => {
    const refusal = workspaceWriteRefusal(entry.shareView);
    if (refusal) throw new Error(refusal);
  });
  const repair = vi.fn<() => Promise<void>>(async () => undefined);
  const openPath = vi.fn(async () => "");
  const reveal = vi.fn();
  const renderPdf = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([37, 80, 68, 70]));
  const notify = vi.fn();
  const listings = new WorkspaceFileListingCache();
  const fileOwner = createWorkspaceFilesIpc<Sender, Event, Workspace, Operation>({
    registerHandler, assertTrustedSender: trusted, app: { isPackaged: false },
    dialog: { showOpenDialog: openDialog, showSaveDialog: saveDialog }, shell: { openPath },
    withRendererWorkspaceOperation: withOperation, exactRendererWorkspaceReferences: references,
    workspaceFileListings: listings, workspaceFileMutations: mutations,
    listOwnedWorkspaceFilesFor: listing, readOwnedWorkspaceTextFor: readText,
    assertWritableWorkspace: assertWritable, shareViewFiles: shareFiles,
    listWorkspaces: () => [workspace], ensureOwnedProjectionCurrent: repair,
    renderHtmlToPdf: renderPdf, notifyRenderer: notify,
  });
  fileOwner.registerListing();
  fileOwner.registerExports();
  fileOwner.registerAccess();

  type GraphDependencies = Parameters<typeof registerWorkspaceGraphIpcHandlers<Sender, Event, Workspace, Operation>>[0];
  const capture = vi.fn(async () => ({ workspace }));
  const syncChannels = vi.fn(async () => 0);
  const store: ReturnType<GraphDependencies["linkedChatStoreFor"]> = {
    listThreads: vi.fn(async () => []), listChannels: vi.fn(async () => []),
    getChannelWireId: vi.fn(async () => null), listThreadAttachments: vi.fn(async () => []),
  };
  const resolveFiles = vi.fn<GraphDependencies["resolveEngineFiles"]>(async (_workspace, targets) => targets.map(() => ({ status: "absent" })));
  registerWorkspaceGraphIpcHandlers<Sender, Event, Workspace, Operation>({
    registerHandler, assertTrustedSender: trusted, withRendererWorkspaceOperation: withOperation,
    workspaceFileListings: listings, listOwnedWorkspaceFilesFor: listing,
    readOwnedWorkspaceTextFor: readText, requireEngineCapture: capture,
    syncWorkspaceSharedChannels: syncChannels, linkedChatStoreFor: () => store,
    resolveEngineFiles: resolveFiles,
  });

  type MenuDependencies = Parameters<typeof registerNativeMenusIpcHandlers<Sender, Event, Workspace, Operation>>[0];
  const buildMenu = vi.fn<MenuDependencies["buildFromTemplate"]>(() => ({ popup: (options) => { options?.callback?.(); } }));
  let sharedScope: ShareViewWriteScope | null = null;
  let canInstall = false;
  registerNativeMenusIpcHandlers<Sender, Event, Workspace, Operation>({
    registerHandler, assertTrustedSender: trusted, app: { isPackaged: false },
    exactRendererWorkspaceReferences: references, sharedViewOf: () => sharedScope,
    windowForSender: () => undefined, buildFromTemplate: buildMenu,
    currentUpdateState: () => ({ canInstall }), ensureOwnedProjectionCurrent: repair,
    shell: { showItemInFolder: reveal },
  });
  const invoke = async (channel: string, payload: unknown = { workspaceId: "workspace" }, isTrusted = true) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel}`);
    return handler({ sender: { id: 1 }, trusted: isTrusted }, payload);
  };
  return {
    workspace, listings, handlers, invoke, change, openDialog, saveDialog, listing, readText, repair,
    openPath, reveal, renderPdf, notify, capture, syncChannels, store, resolveFiles, buildMenu,
    retireRenderer: () => { rendererCurrent = false; },
    retirePhysical: () => { physicalCurrent = false; },
    reenterWorkspace: () => { generation += 1; },
    setSharedScope: (scope: ShareViewWriteScope | null) => { sharedScope = scope; },
    setCanInstall: (value: boolean) => { canInstall = value; },
  };
}

describe("registered workspace file handlers", () => {
  it.each(["root", "file", "subfolder"] as const)("refuses a raced %s without rolling back another writer's work", async (collision) => {
    const h = await harness();
    const root = h.workspace.rootPath;
    const foreignPath = collision === "root" ? "app/notes.txt"
      : collision === "file" ? "app/index.html" : "app/scripts/notes.txt";
    const deleted: string[] = [];
    let injected = false;
    const inject = async () => {
      await mkdir(join(root, foreignPath, ".."), { recursive: true });
      await writeFile(join(root, foreignPath), "agent work");
      injected = true;
    };
    const result = createFirstAppFiles({
      workspaceId: "workspace", files: [], folders: [],
      mutations: {
        createWorkspaceFolder: async (payload) => {
          if (!injected && (collision === "root" ||
            collision === "subfolder" && payload.relativePath === "app/scripts")) await inject();
          return CreateWorkspaceFileResult.parse(await h.invoke(CHANNELS.createWorkspaceFolder, payload));
        },
        createWorkspaceFile: async (payload) => {
          if (!injected && collision === "file") await inject();
          if (payload.relativePath === "app/package.json") throw new Error("later write failed");
          return CreateWorkspaceFileResult.parse(await h.invoke(CHANNELS.createWorkspaceFile, payload));
        },
        deleteWorkspacePath: async (payload) => {
          deleted.push(payload.relativePath);
          return DeleteWorkspacePathResult.parse(await h.invoke(CHANNELS.deleteWorkspacePath, payload));
        },
      },
    });
    await expect(result).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, foreignPath), "utf8")).toBe("agent work");
    expect(deleted).not.toContain(foreignPath);
    if (collision === "root") expect(deleted).toEqual([]);
    if (collision === "subfolder") expect(deleted).not.toContain("app/scripts");
    expect(await h.invoke(CHANNELS.listWorkspaceFiles)).toMatchObject({
      files: [{ path: foreignPath, kind: "file" }],
    });
  });

  it("keeps foreign descendants added to a created folder before rollback", async () => {
    const h = await harness();
    await expect(createFirstAppFiles({
      workspaceId: "workspace", files: [], folders: [],
      mutations: {
        createWorkspaceFolder: async (payload) => CreateWorkspaceFileResult.parse(
          await h.invoke(CHANNELS.createWorkspaceFolder, payload)),
        createWorkspaceFile: async (payload) => {
          if (payload.relativePath === "app/package.json") {
            await writeFile(join(h.workspace.rootPath, "app/scripts/agent.txt"), "agent work");
            throw new Error("later write failed");
          }
          return CreateWorkspaceFileResult.parse(await h.invoke(CHANNELS.createWorkspaceFile, payload));
        },
        deleteWorkspacePath: async (payload) => DeleteWorkspacePathResult.parse(
          await h.invoke(CHANNELS.deleteWorkspacePath, payload)),
      },
    })).rejects.toThrow("later write failed");
    expect(await readFile(join(h.workspace.rootPath, "app/scripts/agent.txt"), "utf8")).toBe("agent work");
    expect(await readdir(join(h.workspace.rootPath, "app"))).toEqual(["scripts"]);
  });

  it("registers all file, graph, and menu channels with their trust and parser order", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.listWorkspaceFiles, CHANNELS.createWorkspaceFile, CHANNELS.createWorkspaceFolder,
      CHANNELS.moveWorkspacePath, CHANNELS.deleteWorkspacePath, CHANNELS.exportWorkspaceZip,
      CHANNELS.exportDocumentFile, CHANNELS.importWorkspaceFiles, CHANNELS.readWorkspaceText,
      CHANNELS.writeWorkspaceText, CHANNELS.writeWorkspaceAsset, CHANNELS.pickImageFiles,
      CHANNELS.openFileExternally, CHANNELS.readWorkspaceGraph, CHANNELS.getBacklinks,
      CHANNELS.listWorkspaceHeadings, CHANNELS.showExplorerMenu, CHANNELS.showWorkbenchMenu,
    ]);
    for (const channel of h.handlers.keys()) {
      const payload = channel === CHANNELS.readWorkspaceText
        ? { workspaceId: "workspace", relativePath: "notes.md" } : null;
      await expect(h.invoke(channel, payload, false)).rejects.toThrow("untrusted");
    }
    await expect(h.invoke(CHANNELS.readWorkspaceText, null, false)).rejects.not.toThrow("untrusted");
    expect(h.listing).not.toHaveBeenCalled();
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.change).not.toHaveBeenCalled();
  });

  it("uses the existing mutation owner and listing cache through actual registrations", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.createWorkspaceFile, {
      workspaceId: "workspace", relativePath: "notes.md", initialText: "original",
    })).resolves.toEqual({ path: "notes.md" });
    expect(await readFile(join(h.workspace.rootPath, "notes.md"), "utf8")).toBe("original");
    await expect(h.invoke(CHANNELS.readWorkspaceText, {
      workspaceId: "workspace", relativePath: "notes.md",
    })).resolves.toMatchObject({ text: "original", truncated: false });
    await h.invoke(CHANNELS.listWorkspaceFiles);
    await expect(h.invoke(CHANNELS.listWorkspaceFiles, { workspaceId: "workspace", allowCached: true }))
      .resolves.toMatchObject({ files: [{ path: "notes.md", kind: "file" }], cached: true });
    expect(h.listing).toHaveBeenCalledOnce();
    await h.invoke(CHANNELS.listWorkspaceFiles);
    expect(h.listing).toHaveBeenCalledTimes(2);
    await expect(h.invoke(CHANNELS.createWorkspaceFile, {
      workspaceId: "workspace", relativePath: "../outside.md", initialText: "refused",
    })).rejects.toThrow();
  });

  it.each(["retireRenderer", "retirePhysical"] as const)("rejects %s during file loading", async (invalidate) => {
    const h = await harness();
    const started = deferred();
    const held = deferred<Awaited<ReturnType<typeof h.listing>>>();
    h.listing.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.listWorkspaceFiles);
    await started.promise;
    h[invalidate]();
    held.resolve({ files: [], folders: [] });
    await expect(result).rejects.toThrow();
  });

  it.each(["retireRenderer", "retirePhysical", "reenterWorkspace"] as const)(
    "rejects %s while the import dialog is open before copying", async (invalidate) => {
      const h = await harness();
      const sourceDir = await createTestScratch("import-source-");
      const source = join(sourceDir, "incoming.md");
      await writeFile(source, "incoming");
      const started = deferred();
      const held = deferred<{ canceled: boolean; filePaths: string[] }>();
      h.openDialog.mockImplementation(() => { started.resolve(); return held.promise; });
      const result = h.invoke(CHANNELS.importWorkspaceFiles);
      await started.promise;
      h[invalidate]();
      held.resolve({ canceled: false, filePaths: [source] });
      await expect(result).rejects.toThrow();
      await expect(readFile(join(h.workspace.rootPath, "incoming.md"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("screens dragged metadata and imports native picks", async () => {
    const h = await harness();
    await mkdir(join(h.workspace.rootPath, ".dohc"));
    const metadata = join(h.workspace.rootPath, ".dohc", "private.json");
    await writeFile(metadata, "secret metadata");
    await expect(h.invoke(CHANNELS.importWorkspaceFiles, {
      workspaceId: "workspace", droppedPaths: [metadata],
    })).resolves.toMatchObject({ imported: [], skipped: 1 });
    const external = await createTestScratch("native-import-");
    const path = join(external, "picked.md");
    await writeFile(path, "picked text");
    h.openDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    await expect(h.invoke(CHANNELS.importWorkspaceFiles)).resolves.toMatchObject({ imported: ["picked.md"], skipped: 0 });
    expect(await readFile(join(h.workspace.rootPath, "picked.md"), "utf8")).toBe("picked text");
  });

  it("keeps share imports on the canonical change route and reports pending projection", async () => {
    const h = await harness();
    h.workspace.shareView = {} as NonNullable<Workspace["shareView"]>;
    h.change.mockResolvedValue({
      status: "committed", kind: "import", projection: "pending", value: { imported: ["remote.md"], skipped: 0 },
    });
    await expect(h.invoke(CHANNELS.importWorkspaceFiles, {
      workspaceId: "workspace", droppedPaths: [join(h.workspace.rootPath, "source.md")],
    })).resolves.toEqual({ imported: ["remote.md"], skipped: 0 });
    expect(h.change).toHaveBeenCalledWith(expect.anything(),
      { kind: "standalone", workspaceId: "workspace" }, expect.objectContaining({ kind: "import" }));
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "workspace" });
  });

  it("rechecks the exact workspace after the PDF render before writing the export", async () => {
    const h = await harness();
    const target = join(await createTestScratch("pdf-target-"), "document.pdf");
    h.saveDialog.mockResolvedValue({ canceled: false, filePath: target });
    const started = deferred();
    const held = deferred<Uint8Array>();
    h.renderPdf.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.exportDocumentFile, {
      workspaceId: "workspace", kind: "pdf", content: "<html>body</html>", suggestedName: "document",
    });
    await started.promise;
    h.reenterWorkspace();
    held.resolve(new Uint8Array([37, 80, 68, 70]));
    await expect(result).rejects.toThrow();
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports the authorized zip and preserves exact document bytes", async () => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "notes.md"), "archive text");
    const output = await createTestScratch("export-target-");
    const zip = join(output, "workspace.zip");
    h.saveDialog.mockResolvedValue({ canceled: false, filePath: zip });
    await expect(h.invoke(CHANNELS.exportWorkspaceZip)).resolves.toEqual({ path: zip });
    const bytes = await readFile(zip);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.includes(Buffer.from("archive text"))).toBe(true);
    const markdown = join(output, "document.md");
    h.saveDialog.mockResolvedValue({ canceled: false, filePath: markdown });
    await h.invoke(CHANNELS.exportDocumentFile, {
      workspaceId: "workspace", kind: "markdown", suggestedName: "document", content: "# Exact\n\ntext\n",
    });
    expect(await readFile(markdown, "utf8")).toBe("# Exact\n\ntext\n");
  });

  it("returns only picked image bytes and refuses external opens after projection retirement", async () => {
    const h = await harness();
    const images = await createTestScratch("image-picks-");
    const image = join(images, "image.png");
    await writeFile(image, new Uint8Array([1, 2, 3]));
    h.openDialog.mockResolvedValue({ canceled: false, filePaths: [image] });
    await expect(h.invoke(CHANNELS.pickImageFiles)).resolves.toEqual({ files: [
      { name: "image.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ] });
    await writeFile(join(h.workspace.rootPath, "notes.md"), "body");
    h.repair.mockImplementation(async () => { h.retirePhysical(); });
    await expect(h.invoke(CHANNELS.openFileExternally, { workspaceId: "workspace", relativePath: "notes.md" })).rejects.toThrow();
    expect(h.openPath).not.toHaveBeenCalled();
  });
});

describe("registered graph and heading handlers", () => {
  it("reads real links, backlinks, and repeated headings through the existing graph owner", async () => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "alpha.md"), "# Alpha\n[[beta]]\n");
    await writeFile(join(h.workspace.rootPath, "beta.md"), "# Same\n\n# Same\n");
    await expect(h.invoke(CHANNELS.readWorkspaceGraph)).resolves.toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ path: "alpha.md" }), expect.objectContaining({ path: "beta.md" })]),
      edges: [{ source: "alpha.md", target: "beta.md", kind: "wikilink" }],
    });
    expect(h.capture).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.getBacklinks, { workspaceId: "workspace", path: "beta.md" }))
      .resolves.toMatchObject({ sources: [expect.objectContaining({ sourcePath: "alpha.md" })] });
    const headings = await h.invoke(CHANNELS.listWorkspaceHeadings, { workspaceId: "workspace", path: "beta.md" }) as { headings: { occurrence: number }[] };
    expect(headings.headings.map((heading) => heading.occurrence)).toEqual([0, 1]);
  });

  it("uses canonical object paths for chat mentions and omits removed objects", async () => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "current.md"), "# Current\n");
    type Thread = Awaited<ReturnType<typeof h.store.listThreads>>[number];
    type Attachment = Awaited<ReturnType<typeof h.store.listThreadAttachments>>[number];
    vi.mocked(h.store.listThreads).mockResolvedValue([{ id: "thread", workspaceId: h.workspace.workspaceId, title: "Discussion", createdAtMs: 1, updatedAtMs: 1 } satisfies Thread]);
    vi.mocked(h.store.listThreadAttachments).mockResolvedValue([
      { messageId: "message", objectId: "present", pathHint: "old.md" } as Attachment,
      { messageId: "removed-message", objectId: "removed", pathHint: "current.md" } as Attachment,
      { messageId: "invalid-hint", pathHint: "../outside.md" } as Attachment,
      { messageId: "mounted-legacy-hint", pathHint: "shared-with-me/Shared/a.md" } as Attachment,
      { messageId: "duplicate", objectId: "present", pathHint: "another-old-hint.md" } as Attachment,
    ]);
    h.resolveFiles.mockResolvedValue([
      { status: "found", objectId: "present", path: "current.md" }, { status: "absent" }, { status: "invalid" }, { status: "absent" },
    ]);
    h.syncChannels.mockResolvedValue(2);
    const graph = await h.invoke(CHANNELS.readWorkspaceGraph, { workspaceId: "workspace", includeChatMentions: true }) as {
      nodes: { path: string }[]; edges: { target: string }[]; sharedChannelRowsUncovered: number;
    };
    expect(graph.sharedChannelRowsUncovered).toBe(2);
    expect(graph.nodes.some((node) => node.path === "current.md")).toBe(true);
    expect(graph.nodes.some((node) => node.path === "old.md")).toBe(false);
    expect(graph.edges).toHaveLength(1);
    expect(h.capture).toHaveBeenCalledWith("workspace", "Chat mentions");
    expect(h.resolveFiles).toHaveBeenCalledWith(h.workspace, [workspaceFileRef("workspace", "present"), workspaceFileRef("workspace", "removed"), { path: "../outside.md" }, { path: "shared-with-me/Shared/a.md" }]);
  });

  it("rejects a heading response after renderer retirement", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred<Awaited<ReturnType<typeof h.readText>>>();
    h.readText.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.listWorkspaceHeadings, { workspaceId: "workspace", path: "notes.md" });
    await started.promise;
    h.retireRenderer();
    held.resolve({ text: "# Delayed", truncated: false, contentHash: "a".repeat(64) });
    await expect(result).rejects.toThrow();
  });
});

describe("registered native menu handlers", () => {
  it("uses the retained popup helper and native click result", async () => {
    const h = await harness();
    h.buildMenu.mockImplementation((template) => ({ popup: (options) => {
      const item = template.find((entry) => entry.label === "Close Tab");
      if (!item?.click) throw new Error("missing Close Tab");
      options?.callback?.();
      Reflect.apply(item.click, item, []);
    } }));
    await expect(h.invoke(CHANNELS.showWorkbenchMenu, { workspaceId: "workspace", context: "tab" })).resolves.toBe("close-tab");
    expect(h.buildMenu.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Close Editor Group", enabled: false }),
    ]));
  });

  it("derives sharing and update controls from main-owned state", async () => {
    const h = await harness();
    h.workspace.remote = { serverUrl: "https://account.example", ownerUserId: "owner" };
    await h.invoke(CHANNELS.showExplorerMenu, { workspaceId: "workspace", path: "notes.md", kind: "file", pinned: false });
    expect(h.buildMenu.mock.calls[0]![0].some((item) => item.label?.startsWith("Share"))).toBe(true);
    h.buildMenu.mockClear();
    h.setSharedScope({ access: "view", ended: false });
    await h.invoke(CHANNELS.showExplorerMenu, { workspaceId: "workspace", path: "notes.md", kind: "file", pinned: false });
    expect(h.buildMenu.mock.calls[0]![0].some((item) => item.label?.startsWith("Share"))).toBe(false);
    h.buildMenu.mockClear();
    h.setCanInstall(true);
    await h.invoke(CHANNELS.showWorkbenchMenu, { workspaceId: "workspace", context: "status" });
    expect(h.buildMenu.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Update and Restart", enabled: true }),
    ]));
  });

  // main's own reading of the registry marker, through the native menu. The
  // intact row proves the menu still offers writes when nothing is damaged.
  it.each([
    ["intact", {}, true],
    ["no share id", { shareId: undefined }, false],
    ["no recipient", { recipientUserId: undefined }, false],
  ] as const)("offers create commands for an Edit share view only when its marker is %s", async (_name, damage, offered) => {
    const h = await harness();
    h.setSharedScope(shareViewWriteScopeOf({
      shareId: "share-a", recipientUserId: "recipient-a", granterEmail: "granter@example.com",
      grantedSelector: { paths: [], versionId: "main", access: "edit" }, ...damage,
    }));
    for (const [kind, path] of [["root", undefined], ["folder", "notes"]] as const) {
      h.buildMenu.mockClear();
      await h.invoke(CHANNELS.showExplorerMenu, { workspaceId: "workspace", path, kind, pinned: false });
      const labels = h.buildMenu.mock.calls[0]![0].map((item) => item.label);
      for (const create of ["New File", "New Collection…", "Import Files…"]) {
        expect(labels.includes(create), `${kind}: ${create}`).toBe(offered);
      }
    }
  });

  it("reads test choices per invoke and rejects stale menu results", async () => {
    const h = await harness();
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    for (const [choice, result] of [["close-tab", "close-tab"], ["not-a-command", null]] as const) {
      vi.stubEnv("DOHC_TEST_WORKBENCH_MENU_CHOICE", choice);
      await expect(h.invoke(CHANNELS.showWorkbenchMenu, { workspaceId: "workspace", context: "tab" })).resolves.toBe(result);
    }
    expect(h.buildMenu).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    const opened = deferred();
    let closeMenu: (() => void) | undefined;
    h.buildMenu.mockImplementation(() => ({ popup: (options) => {
      closeMenu = options?.callback;
      opened.resolve();
    } }));
    const result = h.invoke(CHANNELS.showWorkbenchMenu, { workspaceId: "workspace", context: "tab" });
    await opened.promise;
    h.reenterWorkspace();
    closeMenu?.();
    await expect(result).rejects.toThrow("changed workspaces");
  });

  it("contains explorer reveals before passing a path to the OS", async () => {
    const h = await harness();
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    vi.stubEnv("DOHC_TEST_EXPLORER_MENU_CHOICE", "open-externally");
    await expect(h.invoke(CHANNELS.showExplorerMenu, {
      workspaceId: "workspace", path: "../outside.md", kind: "file", pinned: false,
    })).rejects.toThrow();
    expect(h.reveal).not.toHaveBeenCalled();
    await writeFile(join(h.workspace.rootPath, "notes.md"), "body");
    await expect(h.invoke(CHANNELS.showExplorerMenu, {
      workspaceId: "workspace", path: "notes.md", kind: "file", pinned: false,
    })).resolves.toBe("open-externally");
    expect(h.reveal).toHaveBeenCalledWith(expect.stringMatching(/notes\.md$/));
  });
});

 it("delivers current visibility verdicts after only the policy file changes", async () => {
  const h = await harness();
  await writeFile(join(h.workspace.rootPath, "private.md"), "private");
  const first = await h.invoke(CHANNELS.listWorkspaceFiles);
  expect(first).toMatchObject({ visibility: { status: "ready", rules: [] } });
  await mkdir(join(h.workspace.rootPath, ".dohc"), { recursive: true });
  await writeFile(join(h.workspace.rootPath, ".dohc/visibility.toml"), '[[rule]]\npath = "private.md"\nvisibility = "hidden"');
  h.listings.invalidate({ workspaceId: "workspace", paths: [".dohc/visibility.toml"], pathSetChanged: false });
  expect(await h.invoke(CHANNELS.listWorkspaceFiles, { workspaceId: "workspace", allowCached: true })).toMatchObject({
    files: [{ path: "private.md" }], visibility: { status: "ready", rules: [{ path: "private.md", visibility: "hidden" }] },
  });
  expect(h.listing).toHaveBeenCalledTimes(1);
});

 it.each(["retireRenderer", "retirePhysical", "reenterWorkspace"] as const)("rejects %s while visibility verdicts are in flight", async invalidate => {
  const h = await harness();
  const started = deferred();
  const verdict = deferred<WorkspaceListingVisibility>();
  const spy = vi.spyOn(visibilityReads, "readWorkspaceListingVisibility").mockImplementationOnce(() => { started.resolve(); return verdict.promise; });
  try {
    const reading = h.invoke(CHANNELS.listWorkspaceFiles);
    await started.promise;
    h[invalidate]();
    verdict.resolve({ status: "ready", rules: [{ path: "A.md", visibility: "hidden" }] });
    await expect(reading).rejects.toThrow();
  } finally { spy.mockRestore(); }
 });

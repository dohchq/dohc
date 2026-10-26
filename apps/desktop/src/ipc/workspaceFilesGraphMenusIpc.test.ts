import { createEngineFileResolver, workspaceFileRef } from "../workspaces/resolveEngineFiles";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceHeadingsIpcHandlers, createWorkspaceFilesIpc } from "./workspaceFilesIpc";
import { workspaceFileOperations } from "./workspaceFileOperations";
import { registerOperations } from "./operationTable";
import { registerNativeMenusIpcHandlers } from "./nativeMenusIpc";
import { CHANNELS } from "./channels";
import * as visibilityReads from "../workspaces/workspaceListingVisibility";
import { CreateWorkspaceFileResult, DeleteWorkspacePathResult, type WorkspaceListingVisibility } from "./bridgeContract";
import { createFirstAppFiles } from "../renderer/workbench/createFirstApp";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import { WorkspaceFileListingCache } from "../workspaces/workspaceFileListingCache";
import { createWorkspaceFileMutationOwner } from "../workspaces/workspaceFileMutationOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createExactRendererWorkspaceReferenceOwner } from "../window/exactRendererWorkspaceReference";
import { readWorkspaceText } from "../workspaces/workspaceAssets";
import { listFiles } from "../workspaces/workspaceFiles";
import { shareViewWriteScopeOf, workspaceWriteRefusal, type ShareViewWriteScope } from "../workspaces/shareWriteGate";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import { openedLocalState } from "../testing/preparedLocalState";
import { systemMarkedCopies, type MarkedCopies } from "../workspaces/markedCopies";
import { isInside } from "../security/pathContainment";

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
  const state = {};
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
      if (id !== workspace.workspaceId && id !== "foreign") throw new Error("unknown workspace");
      const selectedWorkspace = id === "foreign"
        ? { ...workspace, workspaceId: id, attachmentId: Symbol("foreign") } : workspace;
      return work({
        workspace: selectedWorkspace, state, signal: new AbortController().signal,
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
    historyFor: () => ({ readHistoryOperation: async () => {throw new Error("Unexpected History kind read");}, readHistoryPage: async () => { throw new Error("Unexpected History read"); }, undoHistoryOperation: async () => { throw new Error("Unexpected Undo"); } }),
    assertTrustedSender: trusted,
    withRendererWorkspaceOperation: (event, id, work) => withOperation(event.sender, id, "mutation retired", async (operation) => work({
      assertCurrent: () => operation.assertCurrent(),
      authorityId: operation.workspace.attachmentId, workspace: operation.workspace, capture: null,
      signal: operation.signal,
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
  const lookup = vi.fn(async (_workspace: Workspace, paths: readonly string[]) => listFiles(workspace.rootPath, { paths }));
  const readText = vi.fn(async (_workspace: Workspace, path: string) => readWorkspaceText(workspace.rootPath, path));
  const assertWritable = vi.fn((entry: Workspace) => {
    const refusal = workspaceWriteRefusal(entry.shareView);
    if (refusal) throw new Error(refusal);
  });
  const repair = vi.fn<() => Promise<void>>(async () => undefined);
  const openPath = vi.fn(async (_path: string) => "");
  const system = systemMarkedCopies(await createTestScratch("marked-copies-profile-"));
  const registered: Pick<RegistryEntry, "workspaceId" | "rootPath" | "shareView">[] = [workspace];
  const markedCopies = {
    folder: system.folder,
    copy: vi.fn<MarkedCopies["copy"]>(system.copy),
    // The mark itself is the system's; here it only has to land on the copy.
    mark: vi.fn<MarkedCopies["mark"]>(async (path) => { await stat(path); }),
  };
  const reveal = vi.fn();
  const renderPdf = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([37, 80, 68, 70]));
  const notify = vi.fn();
  const listings = new WorkspaceFileListingCache();
  const fileOwner = createWorkspaceFilesIpc<Sender, Event, Workspace, Operation>({
    app: { isPackaged: false },
    dialog: { showOpenDialog: openDialog, showSaveDialog: saveDialog }, shell: { openPath }, markedCopies,
    withRendererWorkspaceOperation: withOperation, exactRendererWorkspaceReferences: references,
    workspaceFileListings: listings, workspaceFileMutations: mutations,
    listOwnedWorkspaceFilesFor: listing, readOwnedWorkspaceTextFor: readText,
    lookupOwnedWorkspaceFilesFor: lookup,
    assertWritableWorkspace: assertWritable, shareViewFiles: shareFiles,
    listWorkspaces: () => registered, ensureOwnedProjectionCurrent: repair,
    renderHtmlToPdf: renderPdf, notifyRenderer: notify,
  });
  registerOperations<typeof workspaceFileOperations, Event, Operation>({
    handle: registerHandler,
    assertTrustedSender: trusted,
    withActiveWorkspace: (event: Event, id, message, work) => withOperation(event.sender, id, message, work),
  }, workspaceFileOperations, fileOwner);

  registerWorkspaceHeadingsIpcHandlers<Sender, Event, Workspace, Operation>({
    registerHandler, assertTrustedSender: trusted, withRendererWorkspaceOperation: withOperation, readOwnedWorkspaceTextFor: readText,
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
    workspace, registered, lookup, listings, handlers, invoke, change, openDialog, saveDialog, listing, readText, repair,
    openPath, markedCopies, reveal, renderPdf, notify, buildMenu,
    retireRenderer: () => { rendererCurrent = false; },
    retirePhysical: () => { physicalCurrent = false; },
    reenterWorkspace: () => { generation += 1; },
    setSharedScope: (scope: ShareViewWriteScope | null) => { sharedScope = scope; },
    setCanInstall: (value: boolean) => { canInstall = value; },
  };
}

describe("registered workspace file handlers", () => {
  it("moves a file through the registered move channel", async () => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "before.md"), "move me");
    await expect(h.invoke(workspaceFileOperations.moveWorkspacePath.channel, {
      workspaceId: "workspace", fromPath: "before.md", toPath: "after.md",
    })).resolves.toEqual({ path: "after.md", operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true } });
    expect(await readFile(join(h.workspace.rootPath, "after.md"), "utf8")).toBe("move me");
    await expect(readFile(join(h.workspace.rootPath, "before.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces text through the registered write-text channel", async () => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "notes.md"), "before");
    await expect(h.invoke(workspaceFileOperations.writeWorkspaceText.channel, {
      workspaceId: "workspace", relativePath: "notes.md", text: "after",
      expectedContentHash: createHash("sha256").update("before").digest("hex"),
    })).resolves.toEqual({
      status: "written", contentHash: createHash("sha256").update("after").digest("hex"),
    });
    expect(await readFile(join(h.workspace.rootPath, "notes.md"), "utf8")).toBe("after");
  });

  it("writes bytes through the registered write-asset channel", async () => {
    const h = await harness();
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(h.invoke(workspaceFileOperations.writeWorkspaceAsset.channel, {
      workspaceId: "workspace", relativePath: "assets/pixel.png", bytes,
    })).resolves.toBeUndefined();
    expect(await readFile(join(h.workspace.rootPath, "assets/pixel.png"))).toEqual(Buffer.from(bytes));
  });

  it.each(["root", "file", "subfolder"] as const)("refuses a raced %s without rolling back another writer's work", async (collision) => {
    const h = await harness();
    // Rollback deletes what it made, through the workspace trash.
    await openedLocalState(h.workspace);
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
          return CreateWorkspaceFileResult.parse(await h.invoke(workspaceFileOperations.createWorkspaceFolder.channel, payload));
        },
        createWorkspaceFile: async (payload) => {
          if (!injected && collision === "file") await inject();
          if (payload.relativePath === "app/package.json") throw new Error("later write failed");
          return CreateWorkspaceFileResult.parse(await h.invoke(workspaceFileOperations.createWorkspaceFile.channel, payload));
        },
        deleteWorkspacePath: async (payload) => {
          deleted.push(payload.relativePath);
          return DeleteWorkspacePathResult.parse(await h.invoke(workspaceFileOperations.deleteWorkspacePath.channel, payload));
        },
      },
    });
    await expect(result).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, foreignPath), "utf8")).toBe("agent work");
    expect(deleted).not.toContain(foreignPath);
    if (collision === "root") expect(deleted).toEqual([]);
    if (collision === "subfolder") expect(deleted).not.toContain("app/scripts");
    expect(await h.invoke(workspaceFileOperations.listWorkspaceFiles.channel)).toMatchObject({
      files: [{ path: foreignPath, kind: "file" }],
    });
  });

  it("keeps foreign descendants added to a created folder before rollback", async () => {
    const h = await harness();
    // Rollback deletes what it made, through the workspace trash.
    await openedLocalState(h.workspace);
    await expect(createFirstAppFiles({
      workspaceId: "workspace", files: [], folders: [],
      mutations: {
        createWorkspaceFolder: async (payload) => CreateWorkspaceFileResult.parse(
          await h.invoke(workspaceFileOperations.createWorkspaceFolder.channel, payload)),
        createWorkspaceFile: async (payload) => {
          if (payload.relativePath === "app/package.json") {
            await writeFile(join(h.workspace.rootPath, "app/scripts/agent.txt"), "agent work");
            throw new Error("later write failed");
          }
          return CreateWorkspaceFileResult.parse(await h.invoke(workspaceFileOperations.createWorkspaceFile.channel, payload));
        },
        deleteWorkspacePath: async (payload) => DeleteWorkspacePathResult.parse(
          await h.invoke(workspaceFileOperations.deleteWorkspacePath.channel, payload)),
      },
    })).rejects.toThrow("later write failed");
    expect(await readFile(join(h.workspace.rootPath, "app/scripts/agent.txt"), "utf8")).toBe("agent work");
    expect(await readdir(join(h.workspace.rootPath, "app"))).toEqual(["scripts"]);
  });

  it("registers all file, heading, and menu channels with their trust and parser order", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      workspaceFileOperations.listWorkspaceFiles.channel, workspaceFileOperations.createWorkspaceFile.channel, workspaceFileOperations.createWorkspaceFolder.channel,
      workspaceFileOperations.duplicateWorkspaceFile.channel, workspaceFileOperations.moveWorkspacePath.channel, workspaceFileOperations.deleteWorkspacePath.channel, workspaceFileOperations.undoHistoryOperation.channel, workspaceFileOperations.exportWorkspaceZip.channel,
      workspaceFileOperations.exportDocumentFile.channel, workspaceFileOperations.importWorkspaceFiles.channel, workspaceFileOperations.readWorkspaceText.channel,
      workspaceFileOperations.writeWorkspaceText.channel, workspaceFileOperations.writeWorkspaceAsset.channel, workspaceFileOperations.pickImageFiles.channel,
      workspaceFileOperations.openFileExternally.channel, workspaceFileOperations.readExternalOpen.channel,
      CHANNELS.listWorkspaceHeadings, CHANNELS.showExplorerMenu, CHANNELS.showWorkbenchMenu,
    ]);
    for (const channel of h.handlers.keys()) {
      const payload = channel === workspaceFileOperations.readWorkspaceText.channel
        ? { workspaceId: "workspace", relativePath: "notes.md" } : null;
      await expect(h.invoke(channel, payload, false)).rejects.toThrow("untrusted");
    }
    await expect(h.invoke(workspaceFileOperations.readWorkspaceText.channel, null, false)).rejects.toThrow("untrusted");
    expect(h.listing).not.toHaveBeenCalled();
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.change).not.toHaveBeenCalled();
  });

  it.each([
    ["listWorkspaceFiles", {}, "File listing stopped because this window changed workspaces."],
    ["readWorkspaceText", { relativePath: "notes.md" }, "File read stopped because this window changed workspaces."],
    ["openFileExternally", { relativePath: "notes.md" }, "External file open stopped because this window changed workspaces."],
    ["readExternalOpen", { relativePath: "notes.md" }, "External file open stopped because this window changed workspaces."],
  ] as const)("refuses a foreign workspace selector for %s", async (name, fields, message) => {
    const h = await harness();
    await expect(h.invoke(workspaceFileOperations[name].channel, { ...fields, workspaceId: "foreign" }))
      .rejects.toThrow(message);
    expect(h.listing).not.toHaveBeenCalled();
    expect(h.readText).not.toHaveBeenCalled();
    expect(h.repair).not.toHaveBeenCalled();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  describe.each(["exportWorkspaceZip", "exportDocumentFile", "pickImageFiles"] as const)("%s dialog", (name) => {
    it.each(["retireRenderer", "retirePhysical", "reenterWorkspace"] as const)(
      "rejects %s while open before returning picks or writing", async (invalidate) => {
        const h = await harness();
        const target = join(await createTestScratch("file-dialog-target-"), "out");
        const started = deferred();
        const held = deferred();
        h.saveDialog.mockImplementation(async () => {
          started.resolve(); await held.promise;
          return { canceled: false, filePath: target };
        });
        h.openDialog.mockImplementation(async () => {
          started.resolve(); await held.promise;
          return { canceled: false, filePaths: [target] };
        });
        const result = h.invoke(workspaceFileOperations[name].channel, name === "exportDocumentFile"
          ? { workspaceId: "workspace", kind: "markdown", content: "body", suggestedName: "document" }
          : { workspaceId: "workspace" });
        await started.promise;
        h[invalidate]();
        held.resolve();
        await expect(result).rejects.toThrow();
        await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(h.renderPdf).not.toHaveBeenCalled();
        expect(h.change).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the existing mutation owner and listing cache through actual registrations", async () => {
    const h = await harness();
    await expect(h.invoke(workspaceFileOperations.createWorkspaceFile.channel, {
      workspaceId: "workspace", relativePath: "notes.md", initialText: "original",
    })).resolves.toEqual({ path: "notes.md" });
    expect(await readFile(join(h.workspace.rootPath, "notes.md"), "utf8")).toBe("original");
    await expect(h.invoke(workspaceFileOperations.readWorkspaceText.channel, {
      workspaceId: "workspace", relativePath: "notes.md",
    })).resolves.toMatchObject({ text: "original", truncated: false });
    await h.invoke(workspaceFileOperations.listWorkspaceFiles.channel);
    await expect(h.invoke(workspaceFileOperations.listWorkspaceFiles.channel, { workspaceId: "workspace", allowCached: true }))
      .resolves.toMatchObject({ files: [{ path: "notes.md", kind: "file" }], cached: true });
    expect(h.listing).toHaveBeenCalledOnce();
    await h.invoke(workspaceFileOperations.listWorkspaceFiles.channel);
    expect(h.listing).toHaveBeenCalledTimes(2);
    await expect(h.invoke(workspaceFileOperations.createWorkspaceFile.channel, {
      workspaceId: "workspace", relativePath: "../outside.md", initialText: "refused",
    })).rejects.toThrow();
  });

  it.each(["retireRenderer", "retirePhysical"] as const)("rejects %s during file loading", async (invalidate) => {
    const h = await harness();
    const started = deferred();
    const held = deferred<Awaited<ReturnType<typeof h.listing>>>();
    h.listing.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(workspaceFileOperations.listWorkspaceFiles.channel);
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
      const result = h.invoke(workspaceFileOperations.importWorkspaceFiles.channel);
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
    await expect(h.invoke(workspaceFileOperations.importWorkspaceFiles.channel, {
      workspaceId: "workspace", droppedPaths: [metadata],
    })).resolves.toMatchObject({ imported: [], skipped: 1 });
    const external = await createTestScratch("native-import-");
    const path = join(external, "picked.md");
    await writeFile(path, "picked text");
    h.openDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    await expect(h.invoke(workspaceFileOperations.importWorkspaceFiles.channel)).resolves.toMatchObject({ imported: ["picked.md"], skipped: 0 });
    expect(await readFile(join(h.workspace.rootPath, "picked.md"), "utf8")).toBe("picked text");
  });

  it("keeps share imports on the canonical change route and reports pending projection", async () => {
    const h = await harness();
    h.workspace.shareView = {} as NonNullable<Workspace["shareView"]>;
    h.change.mockResolvedValue({
      status: "committed", kind: "import", projection: "pending", value: { imported: ["remote.md"], skipped: 0 },
    });
    await expect(h.invoke(workspaceFileOperations.importWorkspaceFiles.channel, {
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
    const result = h.invoke(workspaceFileOperations.exportDocumentFile.channel, {
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
    await expect(h.invoke(workspaceFileOperations.exportWorkspaceZip.channel)).resolves.toEqual({ path: zip });
    const bytes = await readFile(zip);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.includes(Buffer.from("archive text"))).toBe(true);
    const markdown = join(output, "document.md");
    h.saveDialog.mockResolvedValue({ canceled: false, filePath: markdown });
    await h.invoke(workspaceFileOperations.exportDocumentFile.channel, {
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
    await expect(h.invoke(workspaceFileOperations.pickImageFiles.channel)).resolves.toEqual({ files: [
      { name: "image.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ] });
    await writeFile(join(h.workspace.rootPath, "notes.md"), "body");
    h.repair.mockImplementation(async () => { h.retirePhysical(); });
    await expect(h.invoke(workspaceFileOperations.openFileExternally.channel, { workspaceId: "workspace", relativePath: "notes.md" })).rejects.toThrow();
    expect(h.openPath).not.toHaveBeenCalled();
  });
});

describe("opening a file externally", () => {
  const bytes = new Uint8Array([7, 1, 2, 3, 0, 255]);
  const open = (h: Awaited<ReturnType<typeof harness>>, relativePath: string) =>
    h.invoke(workspaceFileOperations.openFileExternally.channel, { workspaceId: "workspace", relativePath });

  async function expectMarkedCopy(h: Awaited<ReturnType<typeof harness>>, original: string) {
    expect(h.openPath).toHaveBeenCalledOnce();
    const opened = h.openPath.mock.calls[0]![0];
    expect(opened).not.toBe(await realpath(original));
    expect(isInside(h.markedCopies.folder, opened)).toBe(true);
    expect(basename(opened)).toBe(basename(original));
    expect(new Uint8Array(await readFile(opened))).toEqual(bytes);
    expect(h.markedCopies.mark).toHaveBeenCalledExactlyOnceWith(opened);
    expect((await stat(opened)).mode & 0o222).toBe(0);
    expect(new Uint8Array(await readFile(original))).toEqual(bytes);
  }

  async function sharedViewFile(h: Awaited<ReturnType<typeof harness>>) {
    h.workspace.shareView = {} as NonNullable<Workspace["shareView"]>;
    const original = join(h.workspace.rootPath, "notes.md");
    await writeFile(original, bytes);
    return original;
  }

  it("opens a file in a share mount as a marked copy", async () => {
    const h = await harness();
    const original = join(h.workspace.rootPath, "shared-with-me", "alex", "report.bin");
    await mkdir(dirname(original), { recursive: true });
    await writeFile(original, bytes);
    await open(h, "shared-with-me/alex/report.bin");
    await expectMarkedCopy(h, original);
  });

  it("opens a file in a standalone shared view as a marked copy", async () => {
    const h = await harness();
    const original = await sharedViewFile(h);
    await open(h, "notes.md");
    await expectMarkedCopy(h, original);
  });

  it("opens a file of a shared view nested in a standalone shared view as a marked copy", async () => {
    const h = await harness();
    h.workspace.shareView = {} as NonNullable<Workspace["shareView"]>;
    const view = join(h.workspace.rootPath, "view");
    h.registered.push({ workspaceId: "view", rootPath: view, shareView: {} as NonNullable<Workspace["shareView"]> });
    const original = join(view, "notes.md");
    await mkdir(view);
    await writeFile(original, bytes);
    await open(h, "view/notes.md");
    await expectMarkedCopy(h, original);
  });

  it("opens a link from the person's own folder into a share mount as a marked copy", async () => {
    const h = await harness();
    const shared = join(h.workspace.rootPath, "shared-with-me", "alex", "docs");
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, "plan.bin"), bytes);
    await symlink(shared, join(h.workspace.rootPath, "linked"), process.platform === "win32" ? "junction" : "dir");
    await open(h, "linked/plan.bin");
    await expectMarkedCopy(h, join(shared, "plan.bin"));
  });

  it("opens a file of a shared view inside this workspace as a marked copy", async () => {
    const h = await harness();
    const view = join(h.workspace.rootPath, "view");
    h.registered.push({ workspaceId: "view", rootPath: view, shareView: {} as NonNullable<Workspace["shareView"]> });
    const original = join(view, "notes.bin");
    await mkdir(view);
    await writeFile(original, bytes);
    await open(h, "view/notes.bin");
    await expectMarkedCopy(h, original);
  });

  it("opens a file in another workspace's share mount inside this workspace as a marked copy", async () => {
    const h = await harness();
    const inner = join(h.workspace.rootPath, "inner");
    h.registered.push({ workspaceId: "inner", rootPath: inner });
    const original = join(inner, "shared-with-me", "sam", "plan.bin");
    await mkdir(dirname(original), { recursive: true });
    await writeFile(original, bytes);
    await open(h, "inner/shared-with-me/sam/plan.bin");
    await expectMarkedCopy(h, original);
  });

  it("opens the person's own file itself, with no copy and no mark", async () => {
    const h = await harness();
    const original = join(h.workspace.rootPath, "notes.bin");
    await writeFile(original, bytes);
    await open(h, "notes.bin");
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(await realpath(original));
    expect(h.markedCopies.copy).not.toHaveBeenCalled();
    expect(h.markedCopies.mark).not.toHaveBeenCalled();
  });

  it.each([
    ["the person's own file", "notes.bin", null, false],
    ["a share mount's file", "shared-with-me/alex/notes.bin", null, true],
    ["a standalone shared view's file", "notes.bin", "view", true],
  ] as const)("answers whether %s opens as a copy the way the open does, and writes nothing", async (_case, relativePath, view, readOnlyCopy) => {
    const h = await harness();
    if (view) h.workspace.shareView = {} as NonNullable<Workspace["shareView"]>;
    const original = join(h.workspace.rootPath, relativePath);
    await mkdir(dirname(original), { recursive: true });
    await writeFile(original, bytes);
    await expect(h.invoke(workspaceFileOperations.readExternalOpen.channel, { workspaceId: "workspace", relativePath }))
      .resolves.toEqual({ readOnlyCopy });
    expect(h.repair).not.toHaveBeenCalled();
    expect(h.markedCopies.copy).not.toHaveBeenCalled();
    expect(h.openPath).not.toHaveBeenCalled();
    await open(h, relativePath);
    expect(h.markedCopies.copy).toHaveBeenCalledTimes(readOnlyCopy ? 1 : 0);
  });

  it.each(["copy", "mark"] as const)("opens nothing when the %s fails", async (step) => {
    const h = await harness();
    const original = join(h.workspace.rootPath, "shared-with-me", "alex", "report.bin");
    await mkdir(dirname(original), { recursive: true });
    await writeFile(original, bytes);
    h.markedCopies[step].mockRejectedValueOnce(new Error(`${step} refused`));
    await expect(open(h, "shared-with-me/alex/report.bin")).rejects.toThrow(`${step} refused`);
    expect(h.openPath).not.toHaveBeenCalled();
    expect(await readdir(h.markedCopies.folder)).toEqual([]);
    expect(new Uint8Array(await readFile(original))).toEqual(bytes);
  });
});

describe("registered heading handler", () => {
  it("reads repeated headings through the file owner", async () => {
    const h = await harness();
    await writeFile(join(h.workspace.rootPath, "alpha.md"), "# Alpha\n[[beta]]\n");
    await writeFile(join(h.workspace.rootPath, "beta.md"), "# Same\n\n# Same\n");

    await expect(h.invoke(workspaceFileOperations.listWorkspaceFiles.channel)).resolves.toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ path: "alpha.md" }), expect.objectContaining({ path: "beta.md" })]),
    });
    const headings = await h.invoke(CHANNELS.listWorkspaceHeadings, { workspaceId: "workspace", path: "beta.md" }) as { headings: { occurrence: number }[] };
    expect(headings.headings.map((heading) => heading.occurrence)).toEqual([0, 1]);
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

  // A workspace that does not sync still offers Share…, as the toolbar does:
  // the dialog says sharing needs sync and leads to setting it up.
  it("offers Share… on a workspace without sync, but not on the root, a mount path or a shared view", async () => {
    const h = await harness();
    expect(h.workspace.remote).toBeUndefined();
    const offersShare = async (path: string | undefined, kind: "file" | "folder" | "root") => {
      h.buildMenu.mockClear();
      await h.invoke(CHANNELS.showExplorerMenu, { workspaceId: "workspace", path, kind, pinned: false });
      return h.buildMenu.mock.calls[0]![0].some((item) => item.label === "Share…");
    };
    expect(await offersShare("notes.md", "file")).toBe(true);
    expect(await offersShare("notes", "folder")).toBe(true);
    expect(await offersShare(undefined, "root")).toBe(false);
    expect(await offersShare("shared-with-me/sam/notes.md", "file")).toBe(false);
    expect(await offersShare("shared-with-me/sam", "folder")).toBe(false);
    h.setSharedScope({ access: "edit", ended: false });
    expect(await offersShare("notes.md", "file")).toBe(false);
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
  const first = await h.invoke(workspaceFileOperations.listWorkspaceFiles.channel);
  expect(first).toMatchObject({ visibility: { status: "ready", rules: [] } });
  await mkdir(join(h.workspace.rootPath, ".dohc"), { recursive: true });
  await writeFile(join(h.workspace.rootPath, ".dohc/visibility.toml"), '[[rule]]\npath = "private.md"\nvisibility = "hidden"');
  h.listings.invalidate({ workspaceId: "workspace", paths: [".dohc/visibility.toml"], pathSetChanged: false });
  expect(await h.invoke(workspaceFileOperations.listWorkspaceFiles.channel, { workspaceId: "workspace", allowCached: true })).toMatchObject({
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
    const reading = h.invoke(workspaceFileOperations.listWorkspaceFiles.channel);
    await started.promise;
    h[invalidate]();
    verdict.resolve({ status: "ready", rules: [{ path: "A.md", visibility: "hidden" }] });
    await expect(reading).rejects.toThrow();
  } finally { spy.mockRestore(); }
 });

it("looks up one file through the registered channel without loading or replacing the workspace cache", async () => {
  const h = await harness();
  await writeFile(join(h.workspace.rootPath, "one.txt"), "one");
  await mkdir(join(h.workspace.rootPath, "folder"));
  for (const filePath of ["one.txt", "folder", "missing.txt"]) {
    const result = await h.invoke(workspaceFileOperations.listWorkspaceFiles.channel, { workspaceId: "workspace", filePath });
    expect(result).toMatchObject({ files: filePath === "one.txt" ? [{ path: "one.txt", kind: "file" }] : [] });
  }
  expect(h.listing).not.toHaveBeenCalled();
  expect(h.lookup).toHaveBeenCalledTimes(3);
  await h.invoke(workspaceFileOperations.listWorkspaceFiles.channel, { workspaceId: "workspace", allowCached: true });
  expect(h.listing).toHaveBeenCalledOnce();
});

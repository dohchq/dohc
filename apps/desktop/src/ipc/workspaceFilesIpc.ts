import { CHANNELS } from "./channels";
import { ListWorkspaceHeadingsPayload, ListWorkspaceHeadingsResult } from "./bridgeContract";
import { extractWorkspaceHeadings, workspaceHeadingRecords } from "../workspaces/workspaceHeadings";
import { basename, isAbsolute } from "node:path";
import { validateUserReadPath } from "@dohc/workspace-core";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import type { OperationHandlers } from "./operationTable";
import type { workspaceFileOperations } from "./workspaceFileOperations";
import {
  ExportDocumentFileResult,
  ExportWorkspaceZipResult,
  ImportWorkspaceFilesResult,
  ListWorkspaceFilesResult,
  type WorkspacePathListing,
  MAX_PICKED_IMAGES,
  PickImageFilesResult,
  ReadWorkspaceTextResult,
  WRITE_ASSET_MAX_BYTES,
} from "./bridgeContract";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { createExactRendererWorkspaceReferenceOwner } from "../window/exactRendererWorkspaceReference";
import type { WorkspaceFileListingCache } from "../workspaces/workspaceFileListingCache";
import type { WorkspaceFileMutationOwner } from "../workspaces/workspaceFileMutationOwner";
import {
  type ShareViewFiles,
  type ShareViewFilesTarget,
  type ShareViewFileChangeOutcome,
} from "../workspaces/shareViewFiles";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import {
  shareMountRegistryIsPresent,
  storedShareMounts,
} from "../workspaces/shareViewFilesTarget";
import { refuseImportIntoShareProjection } from "../workspaces/shareMounts";
import {
  mediaTypeForExtension,
  resolveWorkspaceFile,
  withStaleSensitiveWorkspaceOperation,
} from "../workspaces/workspaceAssets";
import {
  copyIntoWorkspace,
  importDroppedPaths,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  ZIP_TOO_LARGE_REFUSAL,
} from "../workspaces/workspaceFiles";
import { readWorkspaceListingVisibility } from "../workspaces/workspaceListingVisibility";
import { fileOrigin, markInPlace, markedCopyOf, type MarkedCopies } from "../workspaces/markedCopies";
import { collectOwnedWorkspaceZipEntries } from "../workspaces/ownedWorkspaceZip";
import { buildStoreZip, type ZipEntry } from "../workspaces/zipWriter";

type FileDialogOptions = {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
};

export function createWorkspaceFilesIpc<
  Sender,
  Event extends { sender: Sender },
  Workspace extends RegistryEntry & { attachmentId: symbol },
  Operation extends {
    workspace: Workspace;
    session: { generation: number };
    assertCurrent(): void;
  },
>(dependencies: {
  app: { readonly isPackaged: boolean };
  dialog: {
    showOpenDialog(
      options: FileDialogOptions & {
        properties: ("openFile" | "multiSelections")[];
      },
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog(
      options: FileDialogOptions,
    ): Promise<{ canceled: boolean; filePath?: string }>;
  };
  shell: { openPath(path: string): Promise<string> };
  // Where and how a file from another person becomes the copy the OS opens.
  markedCopies: MarkedCopies;
  withRendererWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  exactRendererWorkspaceReferences: ReturnType<
    typeof createExactRendererWorkspaceReferenceOwner<Sender, Workspace, Operation>
  >;
  workspaceFileListings: Pick<WorkspaceFileListingCache, "list">;
  workspaceFileMutations: WorkspaceFileMutationOwner<Event>;
  listOwnedWorkspaceFilesFor(workspace: Workspace): Promise<WorkspacePathListing>;
  lookupOwnedWorkspaceFilesFor(workspace: Workspace, paths: readonly string[]): Promise<WorkspacePathListing>;
  readOwnedWorkspaceTextFor(
    workspace: Workspace,
    path: string,
  ): Promise<ReadWorkspaceTextResult>;
  assertWritableWorkspace(workspace: Workspace): void;
  shareViewFiles: Pick<ShareViewFiles, "list" | "read" | "change" | "mayEditExternally">;
  listWorkspaces(): Pick<RegistryEntry, "workspaceId" | "rootPath" | "shareView">[];
  ensureOwnedProjectionCurrent(workspace: Workspace, path: string): Promise<void>;
  renderHtmlToPdf(html: string): Promise<Uint8Array>;
  notifyRenderer(input: { workspaceId: string }): void;
}) {
  const {
    app,
    dialog,
    shell,
    markedCopies,
    withRendererWorkspaceOperation,
    exactRendererWorkspaceReferences,
    workspaceFileListings,
    workspaceFileMutations,
    listOwnedWorkspaceFilesFor,
    lookupOwnedWorkspaceFilesFor,
    readOwnedWorkspaceTextFor,
    assertWritableWorkspace,
    shareViewFiles,
    listWorkspaces,
    ensureOwnedProjectionCurrent,
    renderHtmlToPdf,
    notifyRenderer,
  } = dependencies;
  // Native dialogs cannot be driven by Playwright, so every dialog-backed IPC
  // gets one seam of the same shape: a DOHC_TEST_* env var holding a JSON array
  // of absolute paths, honored only in an unpackaged test build. Shared so the
  // import and image-picker seams cannot drift apart in their validation.
  function testAbsolutePaths(envName: string, maxEntries: number): string[] | null {
    if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return null;
    const raw = process.env[envName];
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${envName} must be a JSON array of absolute paths`);
    }
    if (!Array.isArray(parsed) || parsed.length > maxEntries) {
      throw new Error(
        `${envName} must be an array with at most ${maxEntries} paths`,
      );
    }
    const paths: string[] = [];
    for (const entry of parsed) {
      if (
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 4096 ||
        !isAbsolute(entry)
      ) {
        throw new Error(`${envName} entries must be absolute paths`);
      }
      paths.push(entry);
    }
    return paths;
  }

  function testImportPaths(): string[] | null {
    return testAbsolutePaths("DOHC_TEST_IMPORT_PATHS", 100);
  }

  async function collectShareTargetZipEntries(input: {
    target: ShareViewFilesTarget;
    rootName: string;
    relativePath?: string;
  }): Promise<{ entries: ZipEntry[]; baseName: string }> {
    const listed = await shareViewFiles.list(input.target);
    let selectedPath: string | undefined;
    if (input.relativePath !== undefined) {
      const validated = validateUserReadPath(input.relativePath, { platform: process.platform });
      if (!validated.ok) {
        throw new Error(
          `Invalid export path (${validated.reason}): ${input.relativePath}`,
        );
      }
      selectedPath = validated.normalized;
      if (classifyEngineFilePathForRead(selectedPath, process.platform).kind === "secret") {
        throw new Error(
          `Secret files never leave the workspace in an export: ${selectedPath}`,
        );
      }
    }
    const selected = listed.files.filter(
      (file) =>
        selectedPath === undefined ||
        file.path === selectedPath ||
        file.path.startsWith(`${selectedPath}/`),
    );
    if (
      selectedPath !== undefined &&
      selected.length === 0 &&
      !(listed.folders ?? []).includes(selectedPath)
    ) {
      throw new Error(`Export path does not exist: ${selectedPath}`);
    }
    const entries: ZipEntry[] = [];
    let totalBytes = 0;
    for (const file of selected) {
      if (classifyEngineFilePathForRead(file.path, process.platform).kind === "secret") continue;
      const read = await shareViewFiles.read(input.target, {
        kind: "asset",
        path: file.path,
      });
      if (read.kind !== "asset") {
        throw new Error("Shared export read returned an invalid result.");
      }
      totalBytes += read.bytes.byteLength;
      if (
        entries.length >= MAX_ZIP_ENTRIES ||
        totalBytes > MAX_ZIP_TOTAL_BYTES
      ) {
        throw new Error(ZIP_TOO_LARGE_REFUSAL);
      }
      const archivePath =
        selectedPath === undefined
          ? file.path
          : file.path === selectedPath
            ? basename(selectedPath)
            : `${basename(selectedPath)}/${file.path.slice(selectedPath.length + 1)}`;
      entries.push({ path: archivePath, data: read.bytes });
    }
    const name =
      selectedPath === undefined ? input.rootName : basename(selectedPath);
    return {
      entries,
      baseName: name.replace(/\.[^.]+$/, "") || name,
    };
  }

  async function collectOwnedZipEntries(
    workspace: Workspace,
    relativePath?: string,
  ): Promise<{ entries: ZipEntry[]; baseName: string }> {
    return collectOwnedWorkspaceZipEntries({
      workspace,
      ...(relativePath === undefined ? {} : { relativePath }),
      collectShare: collectShareTargetZipEntries,
    });
  }

  function shareViewImportResult(
    workspaceId: string,
    outcome: ShareViewFileChangeOutcome,
  ): { imported: string[]; skipped: number; interrupted?: true } {
    if (outcome.status === "committed") {
      if (outcome.projection === "pending") notifyRenderer({ workspaceId });
      if (
        typeof outcome.value !== "object" ||
        outcome.value === null ||
        !("imported" in outcome.value) ||
        !("skipped" in outcome.value)
      ) {
        throw new Error("Shared file import returned an invalid result.");
      }
      return outcome.value as { imported: string[]; skipped: number };
    }
    notifyRenderer({ workspaceId });
    console.error("[desktop] shared file import did not finish cleanly", outcome);
    if (outcome.status === "partial") {
      const imported = outcome.effects
        .filter((effect) => effect.before === "absent" && effect.after === "present")
        .map((effect) => effect.path);
      return {
        imported,
        skipped: 0,
        interrupted: true,
      };
    }
    throw new Error(
      "dohc could not confirm which shared files were imported. Do not retry the whole import. Refresh the shared view, then choose only files that are still missing.",
    );
  }

  return {
    listWorkspaceFiles: async (input, { operation }) => {
      const workspace = operation.workspace;
      const listing = input.filePath !== undefined
        ? await lookupOwnedWorkspaceFilesFor(workspace, [input.filePath])
        : await workspaceFileListings.list({
        workspaceId: workspace.workspaceId,
        attachmentId: workspace.attachmentId,
        allowCached: input.allowCached === true,
        load: async () => await listOwnedWorkspaceFilesFor(workspace),
      });
      const visibility = await readWorkspaceListingVisibility(workspace);
      return ListWorkspaceFilesResult.parse({ ...listing, visibility });
    },

    createWorkspaceFile: (input, { event }) => workspaceFileMutations.createFile(event, input),
    createWorkspaceFolder: (input, { event }) => workspaceFileMutations.createFolder(event, input),
    duplicateWorkspaceFile: (input, {event}) => workspaceFileMutations.duplicateFile(event, input),
    moveWorkspacePath: (input, { event }) => workspaceFileMutations.movePath(event, input),
    deleteWorkspacePath: (input, { event }) => workspaceFileMutations.deletePath(event, input),
    undoHistoryOperation: (input, { event }) => workspaceFileMutations.undoHistoryOperation(event, input),
    exportWorkspaceZip: async (input, { event }) => {
      const inactiveMessage =
        "Export stopped because this window changed workspaces.";
      const workspaceReference = await exactRendererWorkspaceReferences.capture(
        event.sender,
        input.workspaceId,
        inactiveMessage,
      );
      // Gather + bound before asking where to save: an over-limit export
      // refuses without ever showing a dialog.
      const { entries, baseName } = await exactRendererWorkspaceReferences.withReference(
        event.sender,
        workspaceReference,
        inactiveMessage,
        (operation) =>
          collectOwnedZipEntries(operation.workspace, input.relativePath),
      );
      // Test seam (DOHC_TEST_PICK_PATH precedent): native save dialogs cannot
      // be driven by Playwright. Read per-invoke so a spec can repoint it.
      const testSave = process.env.DOHC_TEST_SAVE_PATH;
      let target: string | null;
      if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testSave) {
        target = testSave;
      } else {
        const result = await dialog.showSaveDialog({
          title: "Export as zip",
          defaultPath: `${baseName}.zip`,
          filters: [{ name: "Zip archive", extensions: ["zip"] }],
        });
        target = result.canceled ? null : (result.filePath ?? null);
      }
      return exactRendererWorkspaceReferences.withReference(
        event.sender,
        workspaceReference,
        inactiveMessage,
        async (operation) => {
          if (target === null) {
            return ExportWorkspaceZipResult.parse({ path: null });
          }
          const { writeFile } = await import("node:fs/promises");
          operation.assertCurrent();
          await writeFile(target, buildStoreZip(entries));
          operation.assertCurrent();
          return ExportWorkspaceZipResult.parse({ path: target });
        },
      );
    },

    // "Copy as Markdown" / "Export as HTML" / "Export as PDF" (the
    // document menu). The renderer always sends the same self-contained HTML
    // (documentExport.ts); this handler only decides where the bytes land
    // (.html verbatim, .pdf via the hidden offscreen window) — see
    // documentPdfExport.ts for the "only one export in flight" guard.
    exportDocumentFile: async (input, { event }) => {
      const inactiveMessage =
        "Export stopped because this window changed workspaces.";
      // workspaceId authorizes the caller (a real, currently-open workspace) —
      // the save target itself is intentionally outside any workspace, same as
      // exportWorkspaceZip above.
      const workspaceReference = await exactRendererWorkspaceReferences.capture(
        event.sender,
        input.workspaceId,
        inactiveMessage,
      );

      const exportKinds: Record<
        typeof input.kind,
        { extension: string; title: string; filter: { name: string; extensions: string[] } }
      > = {
        markdown: {
          extension: "md",
          title: "Export as Markdown",
          filter: { name: "Markdown document", extensions: ["md"] },
        },
        html: {
          extension: "html",
          title: "Export as HTML",
          filter: { name: "HTML document", extensions: ["html"] },
        },
        pdf: {
          extension: "pdf",
          title: "Export as PDF",
          filter: { name: "PDF document", extensions: ["pdf"] },
        },
      };
      const exportKind = exportKinds[input.kind];
      const testSave = process.env.DOHC_TEST_SAVE_PATH;
      let target: string | null;
      if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testSave) {
        target = testSave;
      } else {
        const result = await dialog.showSaveDialog({
          title: exportKind.title,
          defaultPath: `${input.suggestedName}.${exportKind.extension}`,
          filters: [exportKind.filter],
        });
        target = result.canceled ? null : (result.filePath ?? null);
      }
      return exactRendererWorkspaceReferences.withReference(
        event.sender,
        workspaceReference,
        inactiveMessage,
        async (operation) => {
          if (target === null) {
            return ExportDocumentFileResult.parse({ path: null });
          }
          const { writeFile } = await import("node:fs/promises");
          operation.assertCurrent();
          if (input.kind === "pdf") {
            const pdf = await renderHtmlToPdf(input.content);
            operation.assertCurrent();
            await writeFile(target, pdf);
          } else {
            // Markdown and HTML both arrive as the exact text to persist —
            // markdown is the raw document source, HTML the self-contained render.
            await writeFile(target, input.content, "utf8");
          }
          operation.assertCurrent();
          return ExportDocumentFileResult.parse({ path: target });
        },
      );
    },
    importWorkspaceFiles: async (input, { event }) => {
      const importInto = (
        operation: Operation,
        absolutePaths: string[],
        screenAgainstRoots: string[] | null,
      ) => {
        const workspace = operation.workspace;
        return withStaleSensitiveWorkspaceOperation(
          workspace.rootPath,
          async (lease) => {
            const currentWorkspace = operation.workspace;
            const isShareView = shareViewIsPresent(currentWorkspace.shareView);
            if (!isShareView) {
              assertWritableWorkspace(currentWorkspace);
              await refuseImportIntoShareProjection(
                workspace.rootPath,
                input.targetDir,
                storedShareMounts(currentWorkspace),
                shareMountRegistryIsPresent(currentWorkspace),
              );
              return screenAgainstRoots === null
                ? copyIntoWorkspace(
                    workspace.rootPath,
                    absolutePaths,
                    input.targetDir,
                  )
                : importDroppedPaths(
                    workspace.rootPath,
                    absolutePaths,
                    screenAgainstRoots,
                    input.targetDir,
                  );
            }
            return shareViewImportResult(
              workspace.workspaceId,
              await shareViewFiles.change(
                lease,
                { kind: "standalone", workspaceId: workspace.workspaceId },
                {
                  kind: "import",
                  absolutePaths,
                  screenAgainstRoots,
                  targetDir: input.targetDir,
                },
              ),
            );
          },
        );
      };
      // OS drag-in path: renderer-supplied absolute paths (see the trust-delta
      // note on the payload) re-validated by the drag-in screen — regular
      // files and folders, never a link or any registered workspace's .dohc
      // metadata. The
      // renderer-supplied targetDir is re-validated inside the import path
      // (resolveImportDestination) before any copy.
      const droppedPaths = input.droppedPaths;
      if (droppedPaths !== undefined) {
        return withRendererWorkspaceOperation(
          event.sender,
          input.workspaceId,
          "File import stopped because this window changed workspaces.",
          async (operation) =>
            ImportWorkspaceFilesResult.parse(
              await importInto(
                operation,
                droppedPaths,
                listWorkspaces().map((ws) => ws.rootPath),
              ),
            ),
        );
      }
      const inactiveMessage =
        "File import stopped because this window changed workspaces.";
      const workspaceReference = await exactRendererWorkspaceReferences.capture(
        event.sender,
        input.workspaceId,
        inactiveMessage,
      );
      const picked = testImportPaths();
      const result =
        picked === null
          ? await dialog.showOpenDialog({
              properties: ["openFile", "multiSelections"],
              title: "Import files into workspace",
            })
          : { canceled: false, filePaths: picked };
      return exactRendererWorkspaceReferences.withReference(
        event.sender,
        workspaceReference,
        inactiveMessage,
        async (operation) =>
          result.canceled
            ? ImportWorkspaceFilesResult.parse({ imported: [], skipped: 0 })
            : ImportWorkspaceFilesResult.parse(
                await importInto(operation, result.filePaths, null),
              ),
      );
    },

    readWorkspaceText: async (input, { operation }) => {
      return ReadWorkspaceTextResult.parse(
        await readOwnedWorkspaceTextFor(operation.workspace, input.relativePath),
      );
    },

    writeWorkspaceText: (input, { event }) => workspaceFileMutations.writeText(event, input),
    writeWorkspaceAsset: (input, { event }) => workspaceFileMutations.writeAsset(event, input),

    // `/image`: a native open dialog that starts AT THE WORKSPACE ROOT (a
    // renderer <input type="file"> cannot set a starting directory), then reads
    // the picks here and hands the renderer their bytes — one round trip into
    // the same write+insert path paste and drop already use. The picked files
    // are deliberately allowed to live anywhere on disk: this is a user-directed
    // pick, and the bytes are copied INTO the workspace by writeWorkspaceAsset,
    // which re-validates containment. The renderer never sees an absolute path.
    pickImageFiles: async (input, { event }) => {
      const inactiveMessage =
        "Image selection stopped because this window changed workspaces.";
      const workspaceReference = await exactRendererWorkspaceReferences.capture(
        event.sender,
        input.workspaceId,
        inactiveMessage,
      );
      await exactRendererWorkspaceReferences.withReference(
        event.sender,
        workspaceReference,
        inactiveMessage,
        (operation) => assertWritableWorkspace(operation.workspace),
      );

      const seam = testAbsolutePaths("DOHC_TEST_PICK_IMAGE_PATHS", MAX_PICKED_IMAGES);
      let picked: string[];
      if (seam) {
        picked = seam;
      } else {
        const result = await dialog.showOpenDialog({
          title: "Insert image",
          // The workspace directory — where a user's own images live — instead
          // of wherever the OS last happened to leave the dialog.
          defaultPath: workspaceReference.canonicalRootPath,
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"],
            },
          ],
        });
        picked = result.canceled ? [] : result.filePaths;
      }

      return exactRendererWorkspaceReferences.withReference(
        event.sender,
        workspaceReference,
        inactiveMessage,
        async (operation) => {
          assertWritableWorkspace(operation.workspace);
          const { readFile, stat } = await import("node:fs/promises");
          const files: PickImageFilesResult["files"] = [];
          for (const path of picked.slice(0, MAX_PICKED_IMAGES)) {
            try {
              const info = await stat(path);
              // Oversize picks are refused the same quiet way paste refuses them:
              // skipped with a warning, never a thrown dialog in the user's face.
              if (
                !info.isFile() ||
                info.size === 0 ||
                info.size > WRITE_ASSET_MAX_BYTES
              ) {
                console.warn(
                  `[desktop] skipping picked image "${path}" (${info.size} bytes; max ${WRITE_ASSET_MAX_BYTES}).`,
                );
                continue;
              }
              files.push({
                name: basename(path),
                mediaType: mediaTypeForExtension(path),
                bytes: new Uint8Array(await readFile(path)),
              });
            } catch (error) {
              console.warn(`[desktop] could not read picked image "${path}":`, error);
            }
          }
          return PickImageFilesResult.parse({ files });
        },
      );
    },

    openFileExternally: async (input, { operation }) => {
      // Resolve+contain first: only a real file inside the workspace can be
      // handed to the OS opener — never an arbitrary path or URL. window.open
      // remains fully denied; this is the only sanctioned external-open path.
      // A file from another person reaches the opener marked: in place when
      // the person can edit it under the share's grant, otherwise as a
      // read-only copy.
      await ensureOwnedProjectionCurrent(
        operation.workspace,
        input.relativePath,
      );
      const { realTarget, resolvedPath } = await resolveWorkspaceFile(
        operation.workspace.rootPath,
        input.relativePath,
        "read",
      );
      const origin = await fileOrigin(operation.workspace, listWorkspaces(), realTarget);
      let opened = realTarget;
      if (origin === "shared view" && await shareViewFiles.mayEditExternally(
        { kind: "standalone", workspaceId: operation.workspace.workspaceId },
        resolvedPath,
      ).catch(() => false)) {
        await markInPlace(markedCopies, realTarget);
      } else if (origin !== "own") {
        opened = await markedCopyOf(markedCopies, realTarget);
      }
      operation.assertCurrent();
      const error = await shell.openPath(opened);
      if (error) throw new Error(error);
    },
  } satisfies OperationHandlers<typeof workspaceFileOperations, Event, Operation>;
}

export function registerWorkspaceHeadingsIpcHandlers<
  Sender, Event extends { sender: Sender }, Workspace extends RegistryEntry,
  Operation extends { workspace: Workspace },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, inactiveMessage: string,
    work: (operation: Operation) => Result | Promise<Result>): Promise<Result>;
  readOwnedWorkspaceTextFor(workspace: Workspace, path: string): Promise<ReadWorkspaceTextResult>;
}): void {
  dependencies.registerHandler(CHANNELS.listWorkspaceHeadings, async (event, payload) => {
    dependencies.assertTrustedSender(event);
    const input = ListWorkspaceHeadingsPayload.parse(payload);
    return dependencies.withRendererWorkspaceOperation(event.sender, input.workspaceId,
      "Heading read stopped because this window changed workspaces.", async operation => {
        const source = await dependencies.readOwnedWorkspaceTextFor(operation.workspace, input.path);
        return ListWorkspaceHeadingsResult.parse({ headings: workspaceHeadingRecords(extractWorkspaceHeadings(source.text)) });
      });
  });
}

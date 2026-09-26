import { basename, isAbsolute } from "node:path";
import { validateUserReadPath } from "@dohc/workspace-core";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { CHANNELS } from "./channels";
import {
  ExportDocumentFilePayload,
  ExportDocumentFileResult,
  ExportWorkspaceZipPayload,
  ExportWorkspaceZipResult,
  ImportWorkspaceFilesPayload,
  ImportWorkspaceFilesResult,
  ListWorkspaceFilesPayload,
  ListWorkspaceFilesResult,
  MAX_PICKED_IMAGES,
  OpenFileExternallyPayload,
  PickImageFilesPayload,
  PickImageFilesResult,
  ReadWorkspaceTextPayload,
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
  registerHandler(
    channel: string,
    handler: (event: Event, payload: unknown) => unknown,
  ): void;
  assertTrustedSender(event: Event): void;
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
  listOwnedWorkspaceFilesFor(workspace: Workspace): Promise<ListWorkspaceFilesResult>;
  readOwnedWorkspaceTextFor(
    workspace: Workspace,
    path: string,
  ): Promise<ReadWorkspaceTextResult>;
  assertWritableWorkspace(workspace: Workspace): void;
  shareViewFiles: Pick<ShareViewFiles, "list" | "read" | "change">;
  listWorkspaces(): { rootPath: string }[];
  ensureOwnedProjectionCurrent(workspace: Workspace, path: string): Promise<void>;
  renderHtmlToPdf(html: string): Promise<Uint8Array>;
  notifyRenderer(input: { workspaceId: string }): void;
}) {
  const {
    registerHandler,
    assertTrustedSender,
    app,
    dialog,
    shell,
    withRendererWorkspaceOperation,
    exactRendererWorkspaceReferences,
    workspaceFileListings,
    workspaceFileMutations,
    listOwnedWorkspaceFilesFor,
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

  function registerListing(): void {
    registerHandler(CHANNELS.listWorkspaceFiles, async (event, payload) => {
      assertTrustedSender(event);
      const input = ListWorkspaceFilesPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "File listing stopped because this window changed workspaces.",
        async (operation) => {
          const workspace = operation.workspace;
          const listing = await workspaceFileListings.list({
            workspaceId: workspace.workspaceId,
            attachmentId: workspace.attachmentId,
            allowCached: input.allowCached === true,
            load: async () => await listOwnedWorkspaceFilesFor(workspace),
          });
          return ListWorkspaceFilesResult.parse(listing);
        },
      );
    });

    registerHandler(CHANNELS.createWorkspaceFile, workspaceFileMutations.createFile);
    registerHandler(
      CHANNELS.createWorkspaceFolder,
      workspaceFileMutations.createFolder,
    );
    registerHandler(CHANNELS.moveWorkspacePath, workspaceFileMutations.movePath);
    registerHandler(CHANNELS.deleteWorkspacePath, workspaceFileMutations.deletePath);
  }

  function registerExports(): void {
    registerHandler(CHANNELS.exportWorkspaceZip, async (event, payload) => {
      assertTrustedSender(event);
      const input = ExportWorkspaceZipPayload.parse(payload);
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
    });

    // "Copy as Markdown" / "Export as HTML" / "Export as PDF" (ViewHeader's
    // document menu). The renderer always sends the same self-contained HTML
    // (documentExport.ts); this handler only decides where the bytes land
    // (.html verbatim, .pdf via the hidden offscreen window) — see
    // documentPdfExport.ts for the "only one export in flight" guard.
    registerHandler(CHANNELS.exportDocumentFile, async (event, payload) => {
      assertTrustedSender(event);
      const input = ExportDocumentFilePayload.parse(payload);
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
    });
  }

  function registerAccess(): void {
    registerHandler(CHANNELS.importWorkspaceFiles, async (event, payload) => {
      assertTrustedSender(event);
      const input = ImportWorkspaceFilesPayload.parse(payload);
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
      // files only, never any registered workspace's .dohc metadata. The
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
    });

    // This read uses the combined helper to make the main-process workspace
    // authorization boundary explicit. Older workspace handlers keep the
    // equivalent assertTrustedSender + requireWorkspace steps separate.
    registerHandler(CHANNELS.readWorkspaceText, async (event, payload) => {
      const input = ReadWorkspaceTextPayload.parse(payload);
      assertTrustedSender(event);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "File read stopped because this window changed workspaces.",
        async (operation) =>
          ReadWorkspaceTextResult.parse(
            await readOwnedWorkspaceTextFor(
              operation.workspace,
              input.relativePath,
            ),
          ),
      );
    });

    registerHandler(CHANNELS.writeWorkspaceText, workspaceFileMutations.writeText);
    registerHandler(CHANNELS.writeWorkspaceAsset, workspaceFileMutations.writeAsset);

    // `/image`: a native open dialog that starts AT THE WORKSPACE ROOT (a
    // renderer <input type="file"> cannot set a starting directory), then reads
    // the picks here and hands the renderer their bytes — one round trip into
    // the same write+insert path paste and drop already use. The picked files
    // are deliberately allowed to live anywhere on disk: this is a user-directed
    // pick, and the bytes are copied INTO the workspace by writeWorkspaceAsset,
    // which re-validates containment. The renderer never sees an absolute path.
    registerHandler(CHANNELS.pickImageFiles, async (event, payload) => {
      assertTrustedSender(event);
      const input = PickImageFilesPayload.parse(payload);
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
    });

    registerHandler(CHANNELS.openFileExternally, async (event, payload) => {
      assertTrustedSender(event);
      const input = OpenFileExternallyPayload.parse(payload);
      await withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "External file open stopped because this window changed workspaces.",
        async (operation) => {
          // Resolve+contain first: only a real file inside the workspace can be
          // handed to the OS opener — never an arbitrary path or URL. window.open
          // remains fully denied; this is the only sanctioned external-open path.
          await ensureOwnedProjectionCurrent(
            operation.workspace,
            input.relativePath,
          );
          const { realTarget } = await resolveWorkspaceFile(
            operation.workspace.rootPath,
            input.relativePath,
            "read",
          );
          operation.assertCurrent();
          const error = await shell.openPath(realTarget);
          if (error) throw new Error(error);
        },
      );
    });
  }

  return { registerListing, registerExports, registerAccess };
}

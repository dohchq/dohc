import {
  defaultWorkspaceRoot,
  normalizeAbsolutePath,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import type {
  CreatedWorkspace,
  createWorkspaceFolder,
} from "../workspaces/createWorkspaceFolder";
import {
  AttachWorkspaceFolderPayload,
  CreateLocalWorkspacePayload,
  DefaultShareRootPayload,
  DefaultShareRootResult,
  DefaultWorkspaceRootResult,
  OpenWorkspaceRequestPayload,
  PickWorkspaceRootResult,
  SyncStatusResult,
  WorkspaceIdPayload,
  WorkspaceRegistryResult,
  WorkspaceSummary,
} from "./bridgeContract";
import { CHANNELS } from "./channels";

export function createWorkspaceRootApproval(effectiveHome: () => string) {
  // Workspace roots the main process itself produced — the default suggestion
  // and any folder the user chose through the real OS dialog. A renderer cannot
  // invent a path (e.g. ~/.ssh) it was never handed; create/attach roots must
  // be one of these or a descendant. Populated by getDefaultWorkspaceRoot and
  // pickWorkspaceRoot before the renderer can create/attach.
  const approvedRoots = new Set<string>();

  function approveRoot(rootPath: string): void {
    approvedRoots.add(normalizeAbsolutePath(rootPath));
  }

  function isApprovedRoot(normalized: string): boolean {
    for (const approved of approvedRoots) {
      // This is an exact capability-spelling check, not filesystem containment:
      // the approved root or requested workspace may not exist yet. The create
      // path realpath-checks its existing parent before it writes.
      const prefix = approved.endsWith("/") ? approved : `${approved}/`;
      if (normalized === approved || normalized.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  // Validates, canonicalizes, and confirms the root traces to a main-process
  // suggestion or dialog pick — a renderer cannot scope fs ops to a path it
  // invented. All downstream ops use the normalized root.
  function usableRoot(rootPath: string): string {
    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
    if (!check.ok) throw new Error(check.reason);
    if (!isApprovedRoot(check.normalized)) {
      throw new Error(
        "Workspace root must be chosen through dohc (the default location or the folder picker).",
      );
    }
    return check.normalized;
  }

  return { approveRoot, usableRoot };
}

export function registerWorkspaceRegistryIpcHandlers<Event>(dependencies: {
  registerHandler(
    channel: string,
    handler: (event: Event, payload: unknown) => unknown,
  ): void;
  assertTrustedSender(event: Event): void;
  app: { readonly isPackaged: boolean };
  dialog: {
    showOpenDialog(options: {
      properties: ("openDirectory" | "createDirectory")[];
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  roots: ReturnType<typeof createWorkspaceRootApproval>;
  effectiveHome(): string;
  workspaceSummaries(): WorkspaceSummary[];
  prioritizePreferredWorkspace(workspaces: WorkspaceSummary[]): WorkspaceSummary[];
  createWorkspaceFolder: typeof createWorkspaceFolder;
  // Retires every open binding for the workspace, then removes its registry
  // row. The folder on disk is left alone.
  forgetWorkspace(workspaceId: string): Promise<void>;
  showItemInFolder(path: string): void;
  openWorkspaceWindow(workspace: WorkspaceSummary): Promise<unknown>;
  openWorkspaceManager(): unknown;
  closeWindowOf(event: Event): void;
  registerPhysicalWorkspace(workspace: CreatedWorkspace): unknown;
  refreshNativeWorkspaceSurfaces(): void;
  desktopMarks: {
    mark(name: string): void;
    measureSince(name: string, start: string): unknown;
  };
}): void {
  const {
    registerHandler,
    assertTrustedSender,
    app,
    dialog,
    roots: { approveRoot, usableRoot },
    effectiveHome,
    workspaceSummaries,
    prioritizePreferredWorkspace,
    createWorkspaceFolder,
    forgetWorkspace,
    showItemInFolder,
    openWorkspaceWindow,
    openWorkspaceManager,
    closeWindowOf,
    registerPhysicalWorkspace,
    refreshNativeWorkspaceSurfaces,
    desktopMarks,
  } = dependencies;
  registerHandler(CHANNELS.pickWorkspaceRoot, async (event) => {
    assertTrustedSender(event);
    // Test seam: native dialogs cannot be driven by Playwright.
    const testPick = process.env.DOHC_TEST_PICK_PATH;
    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
      approveRoot(testPick);
      return PickWorkspaceRootResult.parse(testPick);
    }
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (picked) approveRoot(picked);
    return PickWorkspaceRootResult.parse(picked);
  });

  registerHandler(CHANNELS.getWorkspaceRegistry, (event) => {
    assertTrustedSender(event);
    return WorkspaceRegistryResult.parse({
      workspaces: prioritizePreferredWorkspace(workspaceSummaries()),
    });
  });

  registerHandler(CHANNELS.getDefaultWorkspaceRoot, (event) => {
    assertTrustedSender(event);
    const root = defaultWorkspaceRoot(effectiveHome());
    approveRoot(root);
    return DefaultWorkspaceRootResult.parse(root);
  });

  // A share opened as its own view defaults to <default root>/shared/<id>.
  // The id is already restricted to [a-z0-9-] by the share code parser, so
  // it is a safe single segment. Approving the path here is what lets the
  // renderer open the share without a folder dialog.
  registerHandler(CHANNELS.getDefaultShareRoot, (event, payload) => {
    assertTrustedSender(event);
    const input = DefaultShareRootPayload.parse(payload);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(input.shareId)) {
      throw new Error("Invalid share id.");
    }
    const root = `${defaultWorkspaceRoot(effectiveHome())}/shared/${input.shareId}`;
    approveRoot(root);
    return DefaultShareRootResult.parse(root);
  });

  registerHandler(CHANNELS.createLocalWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateLocalWorkspacePayload.parse(payload);
    desktopMarks.mark("workspace-create-start");
    const created = await createWorkspaceFolder({
      rootPath: usableRoot(input.rootPath),
      kind: input.kind,
    });
    desktopMarks.measureSince("workspace-create", "workspace-create-start");
    // Parse before register: a summary that fails the contract must never be
    // persisted into the registry, or every later registry read would throw
    // and the app would launch to a permanent blank window.
    const summary = WorkspaceSummary.parse(created);
    registerPhysicalWorkspace(created);
    refreshNativeWorkspaceSurfaces();
    return summary;
  });

  registerHandler(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
    assertTrustedSender(event);
    const input = AttachWorkspaceFolderPayload.parse(payload);
    // Adopts an existing dohc workspace (manifest identity preserved) or
    // turns the folder into a fresh personal workspace in place.
    const attached = await createWorkspaceFolder({
      rootPath: usableRoot(input.rootPath),
      kind: "personal",
    });
    // Parse-then-register (see createLocalWorkspace): a foreign manifest's
    // workspaceId is untrusted input — an oversized or non-hostname-safe id
    // must fail the attach with a visible error, not brick the registry.
    const summary = WorkspaceSummary.parse(attached);
    registerPhysicalWorkspace(attached);
    refreshNativeWorkspaceSurfaces();
    return summary;
  });

  registerHandler(CHANNELS.forgetWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    await forgetWorkspace(input.workspaceId);
    refreshNativeWorkspaceSurfaces();
  });

  registerHandler(CHANNELS.openWorkspaceWindow, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    const workspace = workspaceSummaries().find(
      (entry) => entry.workspaceId === input.workspaceId,
    );
    if (!workspace) throw new Error("That workspace is not in the registry.");
    await openWorkspaceWindow(workspace);
  });

  registerHandler(CHANNELS.openWorkspaceManager, (event) => {
    assertTrustedSender(event);
    openWorkspaceManager();
  });

  registerHandler(CHANNELS.closeThisWindow, (event) => {
    assertTrustedSender(event);
    closeWindowOf(event);
  });

  registerHandler(CHANNELS.revealWorkspaceFolder, (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    const workspace = workspaceSummaries().find(
      (entry) => entry.workspaceId === input.workspaceId,
    );
    if (!workspace) throw new Error("That workspace is not in the registry.");
    showItemInFolder(workspace.rootPath);
  });
}

export function registerOpenWorkspaceIpcHandler<
  Sender,
  Event extends { sender: Sender },
  Workspace extends CreatedWorkspace & { attachmentId: symbol },
  Operation extends {
    workspace: Workspace;
    assertCurrent(): void;
    state: { pluginRuntimes: { ensure(workspace: Workspace): Promise<unknown> } };
  },
>(dependencies: {
  registerHandler(
    channel: string,
    handler: (event: Event, payload: unknown) => unknown,
  ): void;
  assertTrustedSender(event: Event): void;
  withPhysicalWorkspaceOperation<Result>(
    workspaceId: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  rendererWorkspaceSessions: {
    open(
      sender: Sender,
      workspace: Workspace,
      documentId: string,
    ): Promise<{ isCurrent(): boolean }>;
  };
  setPreferredWorkspaceId(workspaceId: string): void;
  markWorkspaceOpened(workspaceId: string): void;
  syncStatusWithOwnedProjection(
    workspace: Workspace,
    status: SyncStatusResult,
  ): Promise<SyncStatusResult>;
  openWorkspaceActivity(operation: Operation): Promise<SyncStatusResult>;
  sharedViewOf(workspaceId: string): unknown;
}): void {
  const {
    registerHandler,
    assertTrustedSender,
    withPhysicalWorkspaceOperation,
    rendererWorkspaceSessions,
    setPreferredWorkspaceId,
    markWorkspaceOpened,
    syncStatusWithOwnedProjection,
    openWorkspaceActivity,
    sharedViewOf,
  } = dependencies;
  registerHandler(CHANNELS.openWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenWorkspaceRequestPayload.parse(payload);
    return withPhysicalWorkspaceOperation(input.workspaceId, async (operation) => {
      const workspace = operation.workspace;
      const rendererSession = await rendererWorkspaceSessions.open(
        event.sender,
        workspace,
        input.rendererDocumentId,
      );
      setPreferredWorkspaceId(workspace.workspaceId);
      const status = SyncStatusResult.parse(
        await syncStatusWithOwnedProjection(
          workspace,
          await openWorkspaceActivity(operation),
        ),
      );
      operation.assertCurrent();
      if (!rendererSession.isCurrent()) {
        throw new Error(
          "Workspace open stopped because this window changed workspaces.",
        );
      }
      // The recency stamp is a manager convenience: only a finished open
      // earns it, and a registry write refusal must not fail the open.
      try {
        markWorkspaceOpened(workspace.workspaceId);
      } catch (error) {
        console.error(
          `[desktop] could not stamp the last open of ${workspace.workspaceId}:`,
          error,
        );
      }
      if (!sharedViewOf(workspace.workspaceId)) {
        // A plugin-pipeline start failure must not fail the whole handler —
        // the workspace itself already opened. listPlugins and friends
        // separately convert a failed plugin runtime warmup into a structured
        // pluginIpcError; this is best-effort warmup, and the renderer's file
        // tree must not wait on it (fire-and-forget, like the dispatch scan in
        // openWorkspaceActivityWith).
        void withPhysicalWorkspaceOperation(workspace.workspaceId, (warmup) => {
          if (warmup.workspace.attachmentId !== workspace.attachmentId) return;
          return warmup.state.pluginRuntimes.ensure(warmup.workspace);
        }).catch((error: unknown) => {
          console.error(
            `[desktop] plugin pipeline warmup failed for ${workspace.workspaceId}:`,
            error,
          );
        });
      }
      return status;
    });
  });
}

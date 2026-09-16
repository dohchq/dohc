import { isSharedWithMePath } from "@dohc/workspace-core";
import { CHANNELS } from "./channels";
import {
  ShowExplorerMenuPayload,
  ShowExplorerMenuResult,
  ShowWorkbenchMenuPayload,
  ShowWorkbenchMenuResult,
  type ExplorerMenuCommand,
  type WorkbenchMenuCommand,
} from "./bridgeContract";
import { popupNativeMenu } from "../window/popupNativeMenu";
import type { createExactRendererWorkspaceReferenceOwner } from "../window/exactRendererWorkspaceReference";
import { explorerMenuEntries, type ExplorerMenuScope } from "../workspaces/explorerMenu";
import { storedShareMounts } from "../workspaces/shareViewFilesTarget";
import { usableShareMountRecord } from "../workspaces/shareMounts";
import { resolveWorkspaceFile } from "../workspaces/workspaceAssets";
import type { RegistryEntry } from "../workspaces/registryStore";

type NativeMenuOptions = Parameters<typeof popupNativeMenu>[0];
type NativeMenuTemplate = Parameters<NativeMenuOptions["buildFromTemplate"]>[0];

export function registerNativeMenusIpcHandlers<
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
  exactRendererWorkspaceReferences: ReturnType<
    typeof createExactRendererWorkspaceReferenceOwner<Sender, Workspace, Operation>
  >;
  sharedViewOf(workspaceId: string): ExplorerMenuScope["shareView"];
  windowForSender(sender: Sender): NativeMenuOptions["window"];
  buildFromTemplate: NativeMenuOptions["buildFromTemplate"];
  currentUpdateState(): { canInstall?: boolean };
  ensureOwnedProjectionCurrent(workspace: Workspace, path: string): Promise<void>;
  shell: { showItemInFolder(path: string): void };
}): void {
  const {
    registerHandler,
    assertTrustedSender,
    app,
    exactRendererWorkspaceReferences,
    sharedViewOf,
    windowForSender,
    buildFromTemplate,
    currentUpdateState,
    ensureOwnedProjectionCurrent,
    shell,
  } = dependencies;
  // Native explorer context menu over the closed EXPLORER_MENU_COMMANDS set:
  // main owns every label and the item structure (the renderer only names
  // what was right-clicked), and the chosen id resolves the same invoke —
  // null on dismiss. "Reveal in file manager" is performed here (containment
  // first) so no broader open-path IPC needs to exist for it.
  registerHandler(CHANNELS.showExplorerMenu, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShowExplorerMenuPayload.parse(payload);
    const inactiveMessage =
      "Explorer action stopped because this window changed workspaces.";
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );
    const menuContext = await exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      async (operation) => {
        const registryEntry = operation.workspace;
        const shareView = sharedViewOf(registryEntry.workspaceId);
        const isSharedView = shareView !== null;
        const isMountPath =
          !isSharedView && !!input.path && isSharedWithMePath(input.path);
        const mountForPath = isMountPath
          ? (() => {
              const mounts = storedShareMounts(registryEntry);
              return mounts
                .filter((mount) => usableShareMountRecord(mounts, mount))
                .find((mount) => input.path === `shared-with-me/${mount.label}`);
            })()
          : undefined;
        return {
          shareView,
          isMountPath,
          hasMountRecord: mountForPath !== undefined,
          canShare:
            !isSharedView &&
            !isMountPath &&
            !!registryEntry.remote &&
            input.kind !== "root",
        };
      },
    );

    const chosen = await (() => {
      // Test seam (DOHC_TEST_PICK_PATH precedent): a NATIVE menu cannot be
      // driven by Playwright. Read per-invoke so a spec can repoint it via
      // electronApp.evaluate between right-clicks; values outside the closed
      // tuple resolve null exactly like a dismissed menu.
      if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
        const choice = process.env.DOHC_TEST_EXPLORER_MENU_CHOICE;
        if (choice !== undefined) {
          const parsed = ShowExplorerMenuResult.safeParse(choice);
          return parsed.success ? parsed.data : null;
        }
      }
      return popupNativeMenu<ExplorerMenuCommand>({
        window: windowForSender(event.sender),
        buildFromTemplate,
        template: (item) => {
          // The menu's shape is decided by `explorerMenuEntries`, where it can be
          // driven at every level; main owns only the Electron plumbing. main
          // still owns the MENU, so a renderer cannot add an item back.
          // Share-mount paths (shared-with-me/…) are a read-only projection of
          // someone else's files. The mount root itself (shared-with-me/<label>
          // with a matching mount record) additionally offers refresh and removal.
          return explorerMenuEntries({
            kind: input.kind,
            pinned: input.pinned === true,
            isMountPath: menuContext.isMountPath,
            hasMountRecord: menuContext.hasMountRecord,
            // Sharing onward is offered nowhere in a share view or a mount:
            // someone else's files are not this account's to grant, and a share
            // needs a relay-side workspace to grant from.
            canShare: menuContext.canShare,
            shareView: menuContext.shareView,
          }).map((entry) =>
            entry.kind === "separator"
              ? { type: "separator" as const }
              : item(entry.label, entry.id),
          );
        },
      });
    })();

    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      async (operation) => {
        if (chosen === "open-externally" && input.path) {
          // Containment before the OS sees the path (resolveWorkspaceFile:
          // validate + realpath + inside-root), same rule as openFileExternally.
          await ensureOwnedProjectionCurrent(operation.workspace, input.path!);
          const { realTarget } = await resolveWorkspaceFile(
            operation.workspace.rootPath,
            input.path!,
            "read",
          );
          operation.assertCurrent();
          shell.showItemInFolder(realTarget);
        }
        return ShowExplorerMenuResult.parse(chosen);
      },
    );
  });

  registerHandler(CHANNELS.showWorkbenchMenu, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShowWorkbenchMenuPayload.parse(payload);
    const inactiveMessage =
      "Workbench menu stopped because this window changed workspaces.";
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );

    const chosen = await (() => {
      if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
        const choice = process.env.DOHC_TEST_WORKBENCH_MENU_CHOICE;
        if (choice !== undefined) {
          const parsed = ShowWorkbenchMenuResult.safeParse(choice);
          return parsed.success ? parsed.data : null;
        }
      }
      return popupNativeMenu<WorkbenchMenuCommand>({
        window: windowForSender(event.sender),
        buildFromTemplate,
        template: (item) => {
          const separator = { type: "separator" as const };
          const editRoles: NativeMenuTemplate = [
            { role: "undo" },
            { role: "redo" },
            separator,
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ];
          return input.context === "tab"
            ? [
                item("Move into New Group", "move-tab-to-new-group"),
                item("Close Editor Group", "close-editor-group", {
                  enabled: input.canCloseEditorGroup === true,
                }),
                separator,
                item("Close Tab", "close-tab"),
                item("Close Other Tabs", "close-other-tabs"),
                separator,
                item("Copy Path", "copy-path"),
                item("Show in Explorer", "show-in-explorer"),
              ]
            : input.context === "status"
              ? [
                  item("Open History", "open-history"),
                  separator,
                  item("Connect dohc Drive", "connect-cloud"),
                  item("Settings", "settings"),
                  separator,
                  item("Check for Updates…", "check-updates"),
                  item("Update and Restart", "install-update", {
                    enabled: currentUpdateState().canInstall === true,
                  }),
                  separator,
                  item("Toggle Theme", "toggle-theme"),
                ]
              : [...editRoles];
        },
      });
    })();

    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      () => ShowWorkbenchMenuResult.parse(chosen),
    );
  });
}

import { CHANNELS } from "./channels";
import {
  ShowWorkbenchMenuPayload,
  ShowWorkbenchMenuResult,
  type WorkbenchMenuCommand,
} from "./bridgeContract";
import { popupNativeMenu } from "../window/popupNativeMenu";
import type { createExactRendererWorkspaceReferenceOwner } from "../window/exactRendererWorkspaceReference";
import type { RegistryEntry } from "../workspaces/registryStore";

type NativeMenuOptions = Parameters<typeof popupNativeMenu>[0];

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
  windowForSender(sender: Sender): NativeMenuOptions["window"];
  buildFromTemplate: NativeMenuOptions["buildFromTemplate"];
  currentUpdateState(): { canInstall?: boolean };
}): void {
  const {
    registerHandler,
    assertTrustedSender,
    app,
    exactRendererWorkspaceReferences,
    windowForSender,
    buildFromTemplate,
    currentUpdateState,
  } = dependencies;

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
                  item("Connect server", "connect-cloud"),
                  item("Settings", "settings"),
                  separator,
                  item("Check for Updates…", "check-updates"),
                  item("Update and Restart", "install-update", {
                    enabled: currentUpdateState().canInstall === true,
                  }),
                  separator,
                  item("Toggle Theme", "toggle-theme"),
                ]
              : [item("Unpin", "unpin-app")];
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

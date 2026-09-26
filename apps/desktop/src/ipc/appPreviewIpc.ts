import {
  GetSitePreviewLogsPayload, GetSitePreviewLogsResult, StopSitePreviewPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { createStartSitePreviewHandler, type StartSitePreviewDependencies } from "./sitePreviewIpc";
import type { createSitePreviewLifecycle } from "../workspaces/sitePreviewLifecycle";

export function registerAppPreviewIpcHandlers<
  Sender extends { id: number },
  Event extends { sender: Sender },
  Workspace extends { workspaceId: string; rootPath: string },
  Operation extends {
    readonly workspace: Workspace;
    readonly state: { sitePreviews: Pick<ReturnType<typeof createSitePreviewLifecycle>, "status" | "release"> };
    isCurrent(): boolean;
    assertCurrent(): void;
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  senderWorkspaceAuthority: Pick<StartSitePreviewDependencies<Event, Sender, Workspace>["authority"], "requireTrustedSender">;
  appCatalog: StartSitePreviewDependencies<Event, Sender, Workspace>["catalog"];
  appPreviews: StartSitePreviewDependencies<Event, Sender, Workspace>["lifecycle"];
  isSharedView: StartSitePreviewDependencies<Event, Sender, Workspace>["isSharedView"];
  executeAppPreview: StartSitePreviewDependencies<Event, Sender, Workspace>["execute"];
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
}): void {
  const {
    registerHandler, assertTrustedSender, senderWorkspaceAuthority,
    appCatalog, appPreviews, isSharedView, executeAppPreview,
    withRendererWorkspaceOperation,
  } = dependencies;

  const appPreviewAuthority = {
    requireTrustedSender: senderWorkspaceAuthority.requireTrustedSender,
    withActiveWorkspace<Result>(
      sender: Sender,
      workspaceId: string,
      subject: string,
      action: string,
      work: (input: {
        workspace: Workspace;
        session: { isCurrent(): boolean };
      }) => Promise<Result>,
    ): Promise<Result> {
      return withRendererWorkspaceOperation(
        sender,
        workspaceId,
        `The ${subject} does not target the active workspace. Open the workspace and ${action}.`,
        (operation) =>
          work({
            workspace: operation.workspace,
            session: {
              isCurrent: operation.isCurrent,
            },
          }),
      );
    },
  };

  const startAppPreview = createStartSitePreviewHandler({
    authority: appPreviewAuthority,
    catalog: appCatalog,
    lifecycle: appPreviews,
    isSharedView,
    execute: executeAppPreview,
  });
  registerHandler(CHANNELS.startSitePreview, startAppPreview);

  registerHandler(CHANNELS.getSitePreviewLogs, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetSitePreviewLogsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "The app preview logs request does not target the active workspace. Open the workspace and try again.",
      (operation) =>
        GetSitePreviewLogsResult.parse(
          operation.state.sitePreviews.status(
            operation.workspace.workspaceId,
            input.siteRoot,
          ),
        ),
    );
  });

  registerHandler(CHANNELS.stopSitePreview, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopSitePreviewPayload.parse(payload);
    await withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "The app preview stop request does not target the active workspace. Open the workspace and try again.",
      (operation) =>
        operation.state.sitePreviews.release({
          holderId: input.holderId,
          getActiveWorkspaceId: () => {
            try {
              operation.assertCurrent();
              return operation.workspace.workspaceId;
            } catch {
              return undefined;
            }
          },
          workspaceId: operation.workspace.workspaceId,
          siteRoot: input.siteRoot,
        }),
    );
  });
}

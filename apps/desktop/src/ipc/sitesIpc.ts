import {
  ListSitesPayload,
  ListSitesResult,
  SitePackagePayload,
  SitePackageResult,
  type SitePackageInfo,
  type SitePreviewMode,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import {
  createMainIpcHandler,
  type MainIpcHandlerRecord,
} from "./mainIpcHandler";

export interface SitesIpcWorkspace {
  workspaceId: string;
}

export interface SitesIpcDependencies<
  Event,
  Sender,
  Workspace extends SitesIpcWorkspace,
> {
  authority: {
    requireTrustedSender(event: Event): Sender;
    requireActiveWorkspace(
      sender: Sender,
      workspaceId: string,
      subject: string,
    ): Workspace;
  };
  catalog: {
    list(workspace: Workspace): Promise<SitePackageInfo[]>;
    get(
      workspace: Workspace,
      path: string,
      effectiveMode: SitePreviewMode | null | undefined,
    ): Promise<SitePackageInfo | null>;
  };
}

export function createSitesIpcHandlers<
  Event,
  Sender,
  Workspace extends SitesIpcWorkspace,
>(
  dependencies: SitesIpcDependencies<Event, Sender, Workspace>,
): MainIpcHandlerRecord<Event> {
  const authorize = (sender: Sender, payload: { workspaceId: string }) =>
    dependencies.authority.requireActiveWorkspace(
      sender,
      payload.workspaceId,
      "sites request",
    );
  return {
    [CHANNELS.listSites]: createMainIpcHandler({
      requireTrustedSender: dependencies.authority.requireTrustedSender,
      parsePayload: ListSitesPayload.parse,
      authorize,
      gate: { kind: "read-only" },
      run: async (workspace) => ({
        sites: await dependencies.catalog.list(workspace),
      }),
      parseResult: ListSitesResult.parse,
    }),
    [CHANNELS.getSitePackage]: createMainIpcHandler({
      requireTrustedSender: dependencies.authority.requireTrustedSender,
      parsePayload: SitePackagePayload.parse,
      authorize,
      gate: { kind: "read-only" },
      run: (workspace, payload) =>
        dependencies.catalog.get(
          workspace,
          payload.path,
          payload.effectivePreviewMode,
        ),
      parseResult: SitePackageResult.parse,
    }),
  };
}

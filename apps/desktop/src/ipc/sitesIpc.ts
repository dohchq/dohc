import type { OwnedSiteCatalog } from "../workspaces/ownedSiteCatalog";
import {
  ListSitesPayload,
  ListSitesResult,
  SitePackagePayload,
  SitePackageResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";

type SitesIpcHandler<Event, Result = unknown> = (
  event: Event,
  payload: unknown,
) => Promise<Result>;

type SitesIpcHandlerRecord<Event> = Readonly<
  Record<string, SitesIpcHandler<Event>>
>;

export interface SitesIpcDependencies<Event, Sender, Workspace> {
  authority: {
    requireTrustedSender(event: Event): Sender;
    requireActiveWorkspace(
      sender: Sender,
      workspaceId: string,
      subject: string,
    ): Workspace;
  };
  catalog: OwnedSiteCatalog<Workspace>;
}

export function createSitesIpcHandlers<
  Event,
  Sender,
  Workspace,
>(
  dependencies: SitesIpcDependencies<Event, Sender, Workspace>,
): SitesIpcHandlerRecord<Event> {
  const handle = <
    Payload extends { workspaceId: string },
    RawResult,
    Result,
  >(input: {
    parse(payload: unknown): Payload;
    run(workspace: Workspace, payload: Payload): Promise<RawResult>;
    validate(result: RawResult): Result;
  }): SitesIpcHandler<Event, Result> =>
    async (event, rawPayload) => {
      const sender = dependencies.authority.requireTrustedSender(event);
      const payload = input.parse(rawPayload);
      const workspace = dependencies.authority.requireActiveWorkspace(
        sender,
        payload.workspaceId,
        "sites request",
      );
      const result = await input.run(workspace, payload);
      return input.validate(result);
    };

  return {
    [CHANNELS.listSites]: handle({
      parse: ListSitesPayload.parse,
      run: async (workspace) => ({
        sites: await dependencies.catalog.list(workspace),
      }),
      validate: ListSitesResult.parse,
    }),
    [CHANNELS.getSitePackage]: handle({
      parse: SitePackagePayload.parse,
      run: (workspace, payload) =>
        dependencies.catalog.get(
          workspace,
          payload.path,
          payload.effectivePreviewMode,
        ),
      validate: SitePackageResult.parse,
    }),
  };
}

import { isSharedWithMePath } from "@dohc/workspace-core";
import type { OwnedSiteCatalog } from "../workspaces/ownedSiteCatalog";
import {
  requireExactSiteRoot,
  type SitePackageInfo,
} from "../workspaces/sitePackage";
import type {
  SitePreviewExecution,
  createSitePreviewLifecycle,
} from "../workspaces/sitePreviewLifecycle";
import {
  StartSitePreviewPayload,
  StartSitePreviewResult,
  type SitePreviewMode,
} from "./bridgeContract";

type SitePreviewResultBody = Omit<
  StartSitePreviewResult,
  "url" | "exited"
>;

export type SitePreviewExecutionInput = {
  workspaceId: string;
  workspaceRoot: string;
  site: SitePackageInfo;
  mode: SitePreviewMode;
  isCurrent: () => boolean;
  signal: AbortSignal;
  sharedView: boolean;
};

interface SitePreviewRendererSession {
  isCurrent(): boolean;
}

export interface StartSitePreviewDependencies<
  Event,
  Sender extends { id: number },
  Workspace extends { workspaceId: string; rootPath: string },
> {
  authority: {
    requireTrustedSender(event: Event): Sender;
    withActiveWorkspace<Result>(
      sender: Sender,
      workspaceId: string,
      subject: string,
      action: string,
      work: (input: {
        workspace: Workspace;
        session: SitePreviewRendererSession;
      }) => Promise<Result>,
    ): Promise<Result>;
  };
  catalog: OwnedSiteCatalog<Workspace>;
  lifecycle: Pick<ReturnType<typeof createSitePreviewLifecycle>, "start">;
  isSharedView(workspaceId: string): boolean;
  execute(
    input: SitePreviewExecutionInput,
  ): Promise<SitePreviewExecution<SitePreviewResultBody>>;
}

function assertPreviewModeAllowed(
  sharedView: boolean,
  siteRoot: string,
  mode: SitePreviewMode,
): void {
  if (mode !== "static" && sharedView) {
    throw new Error(
      "Live and built app previews run the app's own code, so they're disabled in a shared view. Use the static preview.",
    );
  }
  if (mode !== "static" && isSharedWithMePath(siteRoot)) {
    throw new Error(
      "Apps opened from shared-with-me use the static preview. Copy it into your own files to run dev or build commands.",
    );
  }
}

export function createStartSitePreviewHandler<
  Event,
  Sender extends { id: number },
  Workspace extends { workspaceId: string; rootPath: string },
>(
  dependencies: StartSitePreviewDependencies<Event, Sender, Workspace>,
): (event: Event, payload: unknown) => Promise<StartSitePreviewResult> {
  return async (event, rawPayload) => {
    const sender = dependencies.authority.requireTrustedSender(event);
    const payload = StartSitePreviewPayload.parse(rawPayload);
    return dependencies.authority.withActiveWorkspace(
      sender,
      payload.workspaceId,
      "app preview request",
      "start the preview again",
      async ({ workspace, session }) => {
        const isCurrent = () => session.isCurrent();
        return StartSitePreviewResult.parse(
          await dependencies.lifecycle.start<SitePreviewResultBody>({
            senderId: sender.id,
            workspaceId: payload.workspaceId,
            siteRoot: payload.siteRoot,
            isCurrent,
            prepare: async () => {
              const sharedView = dependencies.isSharedView(workspace.workspaceId);
              assertPreviewModeAllowed(sharedView, payload.siteRoot, payload.mode);
              const site = requireExactSiteRoot(
                await dependencies.catalog.get(
                  workspace,
                  payload.siteRoot,
                  payload.mode,
                ),
                payload.siteRoot,
              );
              return (signal) =>
                dependencies.execute({
                  workspaceId: workspace.workspaceId,
                  workspaceRoot: workspace.rootPath,
                  site,
                  mode: payload.mode,
                  isCurrent,
                  signal,
                  sharedView,
                });
            },
          }),
        );
      },
    );
  };
}

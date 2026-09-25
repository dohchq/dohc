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
  StartSitePreviewAnswer,
  StartSitePreviewPayload,
  type StartSitePreviewResult,
  type SitePreviewMode,
} from "./bridgeContract";

export type SitePreviewResultBody = Omit<
  StartSitePreviewResult,
  "url" | "exited" | "generation"
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
  lifecycle: Pick<
    ReturnType<typeof createSitePreviewLifecycle<SitePreviewResultBody>>,
    "acquire"
  >;
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
): (event: Event, payload: unknown) => Promise<StartSitePreviewAnswer> {
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
        return StartSitePreviewAnswer.parse(
          await dependencies.lifecycle.acquire({
            holderId: payload.holderId,
            senderId: sender.id,
            workspaceId: payload.workspaceId,
            siteRoot: payload.siteRoot,
            mode: payload.mode,
            restart: payload.restart,
            isCurrent,
            // The start's own check, not this window's: a start another
            // window also holds outlives this one.
            prepare: async (startIsCurrent) => {
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
                  isCurrent: startIsCurrent,
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

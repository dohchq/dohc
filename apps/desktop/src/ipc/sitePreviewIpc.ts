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

export interface StartSitePreviewDependencies<
  Event,
  Sender extends { id: number; isDestroyed(): boolean },
  Workspace extends { workspaceId: string; rootPath: string },
> {
  authority: {
    requireTrustedSender(event: Event): Sender;
    requireActiveWorkspace(
      sender: Sender,
      workspaceId: string,
      subject: string,
      action: string,
    ): Workspace;
  };
  catalog: OwnedSiteCatalog<Workspace>;
  lifecycle: Pick<ReturnType<typeof createSitePreviewLifecycle>, "start">;
  rendererGeneration(senderId: number): number;
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
      "Live and built site previews run the site's own code, so they're disabled in a shared view. Use the static preview.",
    );
  }
  if (mode !== "static" && isSharedWithMePath(siteRoot)) {
    throw new Error(
      "Sites opened from shared-with-me use the static preview. Copy it into your own files to run dev or build commands.",
    );
  }
}

export function createStartSitePreviewHandler<
  Event,
  Sender extends { id: number; isDestroyed(): boolean },
  Workspace extends { workspaceId: string; rootPath: string },
>(
  dependencies: StartSitePreviewDependencies<Event, Sender, Workspace>,
): (event: Event, payload: unknown) => Promise<StartSitePreviewResult> {
  return async (event, rawPayload) => {
    const sender = dependencies.authority.requireTrustedSender(event);
    const payload = StartSitePreviewPayload.parse(rawPayload);
    const generation = dependencies.rendererGeneration(sender.id);
    const isCurrent = () =>
      !sender.isDestroyed() &&
      dependencies.rendererGeneration(sender.id) === generation;

    return StartSitePreviewResult.parse(
      await dependencies.lifecycle.start<SitePreviewResultBody>({
        senderId: sender.id,
        workspaceId: payload.workspaceId,
        siteRoot: payload.siteRoot,
        isCurrent,
        prepare: async () => {
          const workspace = dependencies.authority.requireActiveWorkspace(
            sender,
            payload.workspaceId,
            "Site preview request",
            "start the preview again",
          );
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
  };
}

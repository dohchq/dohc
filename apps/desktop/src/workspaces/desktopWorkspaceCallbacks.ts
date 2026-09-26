import type { WatcherEvent } from "@dohc/workspace-core";
import type { createChatDispatchService } from "../agents/chatDispatchService";
import type { WorkspaceActivityScope } from "../ipc/workspaceActivityBroadcast";
import type { PluginWorkspaceRuntimes } from "../plugins/pluginWorkspaceRuntimes";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { RegistryEntry } from "./registryStore";
import type { WorkspaceActivityOptions } from "./workspaceActivity";
import type {
  createWorkspaceAuthorityOwner,
  WorkspaceAuthorityLease,
} from "./workspaceAuthorityOwner";

type WatcherRuntime = NonNullable<
  ReturnType<PluginWorkspaceRuntimes<CreatedWorkspace>["current"]>
>;

export interface DesktopWorkspaceCallbacksDependencies<State> {
  findWorkspace(workspaceId: string): RegistryEntry | null | undefined;
  requireWorkspaceAuthority(workspaceId: string): WorkspaceAuthorityLease<RegistryEntry, State>;
  notifyRenderer(scope?: WorkspaceActivityScope): void;
  readonly workspaceAuthorities: Pick<
    ReturnType<typeof createWorkspaceAuthorityOwner<RegistryEntry, State>>,
    "withAuthority"
  >;
  readonly pluginWorkspaceRuntimes: {
    current(workspaceId: string): Pick<WatcherRuntime, "handleWatcherEvents"> | undefined;
  };
  readonly chatDispatchService: Pick<ReturnType<typeof createChatDispatchService>, "scanWorkspace">;
  collectionAutomationsOf(state: State): { handleWatcherEvents(events: readonly WatcherEvent[]): void };
}

export function createDesktopWorkspaceCallbacks<State>(
  dependencies: DesktopWorkspaceCallbacksDependencies<State>,
) {
  const { findWorkspace, requireWorkspaceAuthority, notifyRenderer } = dependencies;

  function withWorkspaceAttachment<Result>(
    workspace: { workspaceId: string; attachmentId?: symbol },
    work: (lease: WorkspaceAuthorityLease<RegistryEntry, State>) => Result,
  ): Result | undefined {
    if (!findWorkspace(workspace.workspaceId)) return undefined;
    let lease: WorkspaceAuthorityLease<RegistryEntry, State>;
    try {
      lease = requireWorkspaceAuthority(workspace.workspaceId);
    } catch {
      return undefined;
    }
    try {
      if (
        workspace.attachmentId !== undefined &&
        lease.binding.attachmentId !== workspace.attachmentId
      ) {
        return undefined;
      }
      return work(lease);
    } finally {
      lease.release();
    }
  }

  function withWorkspaceAttachmentAsync<Result>(
    workspace: { workspaceId: string; attachmentId?: symbol },
    work: (lease: WorkspaceAuthorityLease<RegistryEntry, State>) => Result | Promise<Result>,
  ): Promise<Result> {
    return dependencies.workspaceAuthorities.withAuthority(workspace.workspaceId, (lease) => {
      if (
        workspace.attachmentId !== undefined &&
        lease.binding.attachmentId !== workspace.attachmentId
      ) {
        throw new Error("This callback belongs to a retired workspace authority.");
      }
      return work(lease);
    });
  }

  function createRelayOnChange(workspace: { workspaceId: string; rootPath: string; attachmentId?: symbol }) {
    return () => {
      withWorkspaceAttachment(workspace, () => {
        notifyRenderer({ workspaceId: workspace.workspaceId });
        void withWorkspaceAttachmentAsync(workspace, () =>
          dependencies.chatDispatchService.scanWorkspace(workspace.workspaceId),
        ).catch((error) => {
          console.error("[desktop] relay dispatch scan:", error);
        });
      });
    };
  }

  const onWatcherBatch: NonNullable<WorkspaceActivityOptions["onWatcherBatch"]> = (workspace, events) => {
    withWorkspaceAttachment(workspace, (lease) => {
      dependencies.collectionAutomationsOf(lease.state).handleWatcherEvents(events);
      dependencies.pluginWorkspaceRuntimes.current(workspace.workspaceId)
        ?.handleWatcherEvents(events);
    });
  };

  return { withWorkspaceAttachment, withWorkspaceAttachmentAsync, createRelayOnChange, onWatcherBatch };
}

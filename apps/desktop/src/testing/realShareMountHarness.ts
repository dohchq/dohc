import { readdir } from "node:fs/promises";
import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import type { LiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { createPresencePollRegistry } from "../collab/presencePollRegistry";
import { CHANNELS } from "../ipc/channels";
import { registerRelaySharesIpcHandlers } from "../ipc/relaySharesIpc";
import { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import type { ShareMountRecord } from "../workspaces/registryStore";
import {
  createShareMountCommands,
  type ShareMountCommands,
} from "../workspaces/shareMountCommands";
import {
  assertRealMountRoot,
  shareViewFilesMountProjection,
} from "../workspaces/shareMounts";
import { createShareSkipRecorder } from "../workspaces/shareSkipRecorder";
import {
  createShareViewFiles,
  type ShareViewFiles,
} from "../workspaces/shareViewFiles";
import { resolveRegisteredShareViewFilesTarget } from "../workspaces/shareViewFilesTarget";
import { fetchShareViewInfo } from "../workspaces/shareViewInfo";
import { withExclusiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import { createCaptureLiveStores } from "../workspaces/workspaceEngineCaptureLiveStore";
import { createWorkspaceFileMutationOwner } from "../workspaces/workspaceFileMutationOwner";

// Registry persistence and renderer notifications are local ports. Mount commands,
// projection, file admission, relay requests, and engine storage use their owners.
export function createRealShareMountHarness(input: {
  daemon: LiveDaemonWorkspace;
  relay: SyncRelayConnection;
  recipientEmail: string;
}) {
  const workspace = {
    ...input.daemon.workspace,
    shareMounts: [] as ShareMountRecord[],
  };
  const received = createReceivedShareEngineAccess({
    sessions: () => input.daemon.sessions,
    relayClient: () => input.daemon.relay,
    createStores: createCaptureLiveStores,
  });
  const assertCurrent = () => undefined;
  const unexpected = (): never => {
    throw new Error("Unexpected dependency call");
  };
  const logError = (message: string, error: unknown) => console.error(message, error);
  const closeRelayWorkspace = (workspaceId: string) =>
    input.daemon.relay.closeWorkspace(workspaceId);
  const commands: ShareMountCommands<typeof workspace> = createShareMountCommands({
    readMounts: () => workspace.shareMounts,
    writeMounts: (_workspaceId, mounts) => { workspace.shareMounts = mounts; },
    loadCredentials: async () => ({
      relayUrl: input.relay.baseUrl, token: input.relay.token, email: input.recipientEmail,
    }),
    fetchInfo: (relay, shareId) => fetchShareViewInfo({ relay, shareId }),
    listDirectory: (path) => readdir(path).catch(() => []),
    withWorkspaceOperation: (root, run) =>
      withExclusiveWorkspaceOperation(root, (_markChanged, lease) => run(lease)),
    files: () => files,
    projectionFor: shareViewFilesMountProjection,
    closeRelayWorkspace,
    workspaceSummary: () => workspace,
    refreshNativeWorkspaceSurfaces: () => undefined,
    notifyRenderer: () => undefined,
    logError,
  });
  const files: ShareViewFiles = createShareViewFiles({
    resolveTarget: (target) => resolveRegisteredShareViewFilesTarget(workspace, target),
    openStore: (target) => received.storeFor({
      engineWorkspaceId: target.storeWorkspaceId, rootPath: target.rootPath,
    }),
    resolveRelay: async () => input.relay,
    pull: (target, relay, pull) => received.relayFor({
      engineWorkspaceId: target.storeWorkspaceId, rootPath: target.rootPath, relay,
    }).pullShareView({ shareId: target.shareId, ...pull }),
    recordRefusals: async (target, refusals) => {
      await createShareSkipRecorder({
        current: () => workspace.shareMounts.find((mount) => mount.shareId === target.shareId),
        persist: (next) => {
          workspace.shareMounts = workspace.shareMounts.map((mount) =>
            mount.shareId === target.shareId ? next : mount,
          );
        },
      })(refusals);
    },
    markEnded: async (target) => {
      workspace.shareMounts = workspace.shareMounts.map((mount) =>
        mount.shareId === target.shareId ? { ...mount, ended: true } : mount,
      );
    },
    retireTarget: (target) => closeRelayWorkspace(target.storeWorkspaceId),
    assertProjectionRoot: async (target) => {
      if (!target.mountLabel) throw new Error("Missing mount label");
      await assertRealMountRoot(target.schedulingRootPath, target.mountLabel);
    },
    createMount: (owner, target) => commands.filesLifecycle.createMount(owner, target),
    removeMount: (owner, target) => commands.filesLifecycle.removeMount(owner, target),
  });
  const mutations = createWorkspaceFileMutationOwner({
    assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_event, workspaceId, work) => {
      if (workspaceId !== workspace.workspaceId) throw new Error("Wrong host workspace");
      return work({
        authorityId: workspace.attachmentId, workspace, capture: null,
        yDocSessions: { withDocumentUnowned: unexpected, markDeletedUnderPath: unexpected },
      });
    },
    shareViewFiles: files,
    trashItem: unexpected,
    notifyRenderer: () => undefined,
    logError,
  });
  type Event = { sender: { id: number } };
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  registerRelaySharesIpcHandlers({
    registerHandler: (channel, handler) => { handlers.set(channel, handler); },
    assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: unexpected,
    remoteForWorkspace: unexpected,
    currentCredentialGeneration: unexpected,
    currentCredentials: unexpected,
    warmCredentialCache: unexpected,
    relayShareJson: unexpected,
    relayShareJsonWithCredentials: unexpected,
    relayShareErrorCopy: unexpected,
    relayShareDiscussionActivityPolls: createPresencePollRegistry(),
  });
  return {
    workspace,
    mount: (shareCode: string) => commands.mount({ workspace, shareCode, assertCurrent }),
    refresh: () => commands.refresh({ workspace, assertCurrent }),
    unmount: (shareId: string) => commands.unmount({ workspace, shareId, assertCurrent }),
    writeText: (relativePath: string) => mutations.writeText(undefined, {
      workspaceId: workspace.workspaceId, relativePath, text: "defaced",
      expectedContentHash: "0".repeat(64),
    }),
    reshare: async (path: string) => {
      const handler = handlers.get(CHANNELS.createRelayShare);
      if (!handler) throw new Error("Missing create-share handler");
      return handler({ sender: { id: 1 } }, {
        workspaceId: workspace.workspaceId, recipientEmail: "third-party@dohc.test",
        access: "view", paths: [path],
      });
    },
  };
}

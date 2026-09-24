import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { JoinedSharedChannel, RegistryEntry } from "./registryStore";
import type { WorkspaceAuthorityLease, WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import type { createReceivedShareEngineAccess } from "./receivedShareEngineAccess";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import {
  createPassCoverageReporter,
  joinedSharedChannelForTarget,
  relayFetchWithTimeout,
  RELAY_FETCH_TIMEOUT_MS,
  SHARED_CHANNEL_SYNC_PASS_ROWS,
  syncJoinedSharedChannels,
} from "./sharedChannels";
import { joinedChannelMatchesCredentials } from "./chatRelayIdentity";
import { runInWorkspaceAuthorityLane } from "./workspaceAuthorityLane";

interface SharedChannelSyncState {
  operationLanes: Map<string, Promise<void>>;
  sharedChannelSyncCursor: string | null;
}

// What one pass did. Freshness callers read `unrefreshed`. The DM sync reads
// `pushed` and `changed`: only a pass that moved ops gives the cloud engine
// follow-up work, and queueing one after an idle pass restarts the relay
// debounce, whose change event refreshes Chats, which runs the DM sync again.
export interface SharedChannelPassOutcome {
  // Live rows this pass did not leave fresh.
  unrefreshed: number;
  // True when the pass sent local ops to the relay.
  pushed: boolean;
  // True when a pull applied new ops.
  changed: boolean;
}

function idlePass(unrefreshed: number): SharedChannelPassOutcome {
  return { unrefreshed, pushed: false, changed: false };
}

export function createDesktopSharedChannelSync<
  State extends SharedChannelSyncState,
  RendererOperation extends WorkspaceAuthorityOperation<RegistryEntry, State>,
>(dependencies: {
  workspaceAuthorities: {
    withAuthority<Result>(
      workspaceId: string,
      work: (lease: WorkspaceAuthorityLease<RegistryEntry, State>) => Result | Promise<Result>,
    ): Promise<Result>;
  };
  findWorkspace(workspaceId: string): RegistryEntry | null;
  warmCredentialCache(): Promise<void>;
  currentCredentialGeneration(): number;
  currentCredentials(): CloudCredentials | null;
  normalizeServerUrl(url: string): string;
  receivedShareEngine: {
    relayForRegistered(
      input: Parameters<ReturnType<typeof createReceivedShareEngineAccess>["relayForRegistered"]>[0],
    ): Pick<EngineRelayWorkspaceClient, "pullSharedChannel" | "pushSharedChannel">;
  };
  setWorkspaceSharedChannels(workspaceId: string, channels: JoinedSharedChannel[]): unknown;
  notifyRenderer(input: { workspaceId: string }): void;
  projectPendingChatBookmarksAfterPull(workspaceId: string): Promise<void>;
  linkedChatStoreFor(
    workspace: EngineWorkspace | WorkspaceAuthorityLease<RegistryEntry, State>,
  ): Parameters<typeof joinedSharedChannelForTarget>[0]["store"];
}) {
  type AuthorityLease = WorkspaceAuthorityLease<RegistryEntry, State>;
  type Operation = WorkspaceAuthorityOperation<RegistryEntry, State>;
  const {
    workspaceAuthorities,
    findWorkspace,
    warmCredentialCache,
    currentCredentialGeneration,
    currentCredentials,
    normalizeServerUrl,
    receivedShareEngine,
    setWorkspaceSharedChannels,
    notifyRenderer,
    projectPendingChatBookmarksAfterPull,
    linkedChatStoreFor,
  } = dependencies;
  const reportSharedChannelPassCoverage = createPassCoverageReporter((message) =>
    console.info(message),
  );

  // Resolves to the live rows this pass did not reach, so an awaited caller can
  // say so in its own response.
  async function syncWorkspaceSharedChannels(
    workspaceId: string,
    priorityChannelWireId?: string,
  ): Promise<number> {
    const outcome = await workspaceAuthorities.withAuthority(workspaceId, (lease) =>
      runInWorkspaceAuthorityLane(lease, "shared-channels", () =>
        runSharedChannelSyncPass(lease, priorityChannelWireId),
      ),
    );
    return outcome.unrefreshed;
  }

  function runRendererSharedChannelPass(
    operation: RendererOperation,
    priorityChannelWireId?: string,
  ): Promise<SharedChannelPassOutcome> {
    return runInWorkspaceAuthorityLane(operation, "shared-channels", () =>
      runSharedChannelSyncPass(operation, priorityChannelWireId),
    );
  }

  async function syncRendererWorkspaceSharedChannels(
    operation: RendererOperation,
    priorityChannelWireId?: string,
  ): Promise<number> {
    return (await runRendererSharedChannelPass(operation, priorityChannelWireId)).unrefreshed;
  }

  // A pass triggered by a write must cover the share that was written, whatever
  // the rotation would have reached. The trigger knows the chat target,
  // not the share, so resolve it here through the same registry lookup the write
  // gate uses. An unresolved target simply syncs without a priority.
  async function syncSharedChannelsForChatTarget(
    workspaceId: string,
    target?: { channelId: string } | { threadId: string },
  ): Promise<number> {
    const entry = findWorkspace(workspaceId);
    if (!entry) return 0;
    return workspaceAuthorities.withAuthority(workspaceId, async (lease) => {
      lease.assertCurrent();
      if (!target) return await syncWorkspaceSharedChannels(workspaceId);
      let joinedChannel: JoinedSharedChannel | null;
      try {
        joinedChannel = await joinedSharedChannelForTarget({
          workspaceId,
          sharedChannels: entry.sharedChannels,
          store: linkedChatStoreFor(lease),
          target,
        });
        lease.assertCurrent();
      } catch {
        // The lookup failed. That says nothing about the target, so an ordinary
        // pass is safer than treating the channel as local.
        return await syncWorkspaceSharedChannels(workspaceId);
      }
      if (!joinedChannel || joinedChannel.ended === true) return 0;
      return await syncWorkspaceSharedChannels(
        workspaceId,
        joinedChannel.channelWireId,
      );
    });
  }

  async function syncRendererSharedChannelsForChatTarget(
    operation: RendererOperation,
    target?: { channelId: string } | { threadId: string },
  ): Promise<SharedChannelPassOutcome> {
    operation.assertCurrent();
    const workspace = operation.workspace;
    if (!target) return runRendererSharedChannelPass(operation);
    let joinedChannel: JoinedSharedChannel | null;
    try {
      joinedChannel = await joinedSharedChannelForTarget({
        workspaceId: workspace.workspaceId,
        sharedChannels: workspace.sharedChannels,
        store: linkedChatStoreFor(workspace),
        target,
      });
      operation.assertCurrent();
    } catch {
      return runRendererSharedChannelPass(operation);
    }
    if (!joinedChannel || joinedChannel.ended === true) return idlePass(0);
    return runRendererSharedChannelPass(
      operation,
      joinedChannel.channelWireId,
    );
  }

  // A pass with no rows to cover left nothing behind. Clearing the remainder this
  // workspace last reported keeps a returning partial pass from being deduped
  // against a report from before the rows went away.
  function reportSharedChannelPassCoveredEverything(workspaceId: string): void {
    reportSharedChannelPassCoverage({
      workspaceId,
      live: 0,
      uncovered: 0,
      passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,
    });
  }

  async function runSharedChannelSyncPass(
    authority: AuthorityLease | Operation,
    priorityChannelWireId?: string,
  ): Promise<SharedChannelPassOutcome> {
    const binding = "binding" in authority ? authority.binding : null;
    const operation: Operation | null =
      binding === null ? (authority as Operation) : null;
    const workspaceId = operation
      ? operation.workspace.workspaceId
      : binding!.workspaceId;
    let requestCredentialGeneration: number | null = null;
    const assertRequestCurrent = (): void => {
      authority.assertCurrent();
      if (
        operation &&
        requestCredentialGeneration !== null &&
        currentCredentialGeneration() !== requestCredentialGeneration
      ) {
        throw new Error("Your server session changed. Try again.");
      }
    };
    // Live rows this pass is responsible for. A pass that dies before finishing —
    // or never starts, because the account is signed out — refreshed none of them,
    // and must say so rather than report a clean sweep. Seeded before the
    // credential work so a rejection there still knows the count.
    let liveRows = 0;
    try {
      authority.assertCurrent();
      const current = operation ? operation.workspace : findWorkspace(workspaceId);
      const entry = current
        ? {
            ...current,
            attachmentId: operation
              ? operation.workspace.attachmentId
              : binding!.attachmentId,
            rootPath: operation
              ? current.rootPath
              : binding!.canonicalRootPath,
          }
        : null;
      // The registry, unfiltered: the pass needs a row's place even after the row
      // stops being syncable, or a revoked cursor sends the rotation back to the
      // front. Only `channels` below is filtered down to the work set.
      const registryOrder = entry?.sharedChannels ?? [];
      const channels = registryOrder.filter((channel) => !channel.ended);
      if (!entry || channels.length === 0) {
        reportSharedChannelPassCoveredEverything(workspaceId);
        return idlePass(0);
      }
      liveRows = channels.length;
      await warmCredentialCache();
      requestCredentialGeneration = currentCredentialGeneration();
      assertRequestCurrent();
      const syncCredentials = currentCredentials();
      // Signed out, or signed in to a server this workspace does not sync with:
      // the rows are joined and none of them got refreshed.
      if (!syncCredentials?.relayUrl) return idlePass(liveRows);
      const relayUrl = syncCredentials.relayUrl;
      // A joined channel syncs only for the relay account that joined it.
      const matching = channels.filter((channel) =>
        joinedChannelMatchesCredentials(channel, syncCredentials),
      );
      // No row belongs to this account's relay, so no row is in this pass's remit
      // — nothing was left behind by a bound, and nothing can be.
      if (matching.length === 0) {
        reportSharedChannelPassCoveredEverything(workspaceId);
        return idlePass(0);
      }
      liveRows = matching.length;
      const relay = {
        baseUrl: normalizeServerUrl(relayUrl),
        token: syncCredentials.token,
        fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
      };
      const daemonRelay = receivedShareEngine.relayForRegistered({
        ...entry,
        relay,
      });
      const result = await syncJoinedSharedChannels({
        rootDir: entry.rootPath,
        workspaceId: entry.workspaceId,
        relay,
        channels: matching,
        registryOrder,
        passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,
        resumeAfterChannelWireId:
          authority.state.sharedChannelSyncCursor ?? undefined,
        priorityChannelWireId,
        pull: async (input) => {
          assertRequestCurrent();
          const pulled = await daemonRelay.pullSharedChannel({
            shareId: input.shareId,
            channelWireId: input.channelWireId,
          });
          assertRequestCurrent();
          return pulled;
        },
        push: async (input) => {
          assertRequestCurrent();
          const pushed = await daemonRelay.pushSharedChannel({
            shareId: input.shareId,
            channelWireId: input.channelWireId,
          });
          assertRequestCurrent();
          return pushed;
        },
      });
      assertRequestCurrent();
      if (result.resumeAfterChannelWireId === null) {
        authority.state.sharedChannelSyncCursor = null;
      } else {
        authority.state.sharedChannelSyncCursor = result.resumeAfterChannelWireId;
      }
      // Rows this pass did not leave fresh: the ones the rotation never reached,
      // plus the ones it reached and could not sync.
      const unrefreshed = result.uncovered + result.failedRows;
      reportSharedChannelPassCoverage({
        workspaceId,
        live: matching.length,
        uncovered: unrefreshed,
        passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,
      });
      if (result.endedShareIds.length > 0 || result.readOnlyShareIds.length > 0) {
        const ended = new Set(result.endedShareIds);
        // A read-write grant that turned out read-only on push (flipped or
        // recorded stale) downgrades the registry row too: the renderer's
        // composer honesty keys off `joined.access`, and a corrected row stops
        // every future pass from re-attempting the same doomed push.
        const readOnly = new Set(result.readOnlyShareIds);
        assertRequestCurrent();
        setWorkspaceSharedChannels(
          workspaceId,
          ((operation ? operation.workspace : findWorkspace(workspaceId))
            ?.sharedChannels ?? []).map((channel) => {
            if (ended.has(channel.shareId)) return { ...channel, ended: true };
            if (readOnly.has(channel.shareId)) return { ...channel, access: "read-only" as const };
            return channel;
          }),
        );
        assertRequestCurrent();
      }
      if (result.changed || result.endedShareIds.length > 0 || result.readOnlyShareIds.length > 0) {
        assertRequestCurrent();
        notifyRenderer({ workspaceId });
      }
      if (result.changed) {
        assertRequestCurrent();
        await projectPendingChatBookmarksAfterPull(workspaceId);
        assertRequestCurrent();
      }
      return { unrefreshed, pushed: result.pushed, changed: result.changed };
    } catch (error) {
      if (operation) assertRequestCurrent();
      console.error(`[desktop] shared channel sync failed for ${workspaceId}:`, error);
      return idlePass(liveRows);
    }
  }

  return {
    syncWorkspaceSharedChannels,
    syncRendererWorkspaceSharedChannels,
    syncSharedChannelsForChatTarget,
    syncRendererSharedChannelsForChatTarget,
  };
}

import { CHANNELS } from "./channels";
import {
  ShareChatChannelPayload, ShareChatChannelResult,
  ListChatChannelSharesPayload, ListChatChannelSharesResult,
  JoinSharedChannelPayload, JoinSharedChannelResult,
  LeaveSharedChannelPayload, DismissShareSkipsPayload,
} from "./bridgeContract";
import {
  awaitCredentialGeneration, chatShareSessionKey,
  createListJoinedSharedChannelsIpcHandler, readRelayChatShareLanes, RelaySessionError,
} from "../mainChatIpcHandlers";
import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { ShareUnavailableError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import type { RegistryEntry, JoinedSharedChannel } from "../workspaces/registryStore";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { EngineRelayWorkspaceClient } from "../workspaces/engineRelayClient";
import { credentialScopedOperation, requireCredentials } from "../workspaces/credentialScopedOperation";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import {
  endJoinedChannel, relayFetchWithTimeout, RELAY_FETCH_TIMEOUT_MS, scopeJoinedChannels,
} from "../workspaces/sharedChannels";
import {
  requireShareableChatChannel, resolveDmKinds, shareIdsToWithholdFromOrdinaryInvites,
  type DmPeekResult,
} from "../workspaces/dmChats";
import {
  liveSharedChannelHoldersByShareId, otherLiveSharedChannelHolder,
  otherLiveSharedChannelHolderByWireId, reserveAndPullSharedChannel,
} from "../workspaces/dmRequests";
import { fetchSharedChannelInfo, type SharedChannelInfo } from "../workspaces/sharedChannelInfo";
import { runInWorkspaceAuthorityLane } from "../workspaces/workspaceAuthorityLane";
import { shareMountRecordsForId } from "../workspaces/shareMounts";
import { storedShareMounts } from "../workspaces/shareViewFilesTarget";

export function registerSharedChannelsIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Workspace extends RegistryEntry & { readonly attachmentId: symbol },
  Operation extends {
    readonly workspace: Workspace;
    readonly state: { operationLanes: Map<string, Promise<void>> };
    assertCurrent(): void;
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  requireEngineCapture(workspace: Workspace, feature: "Chats"): Promise<{ workspace: RegistryEntry }>;
  assertWritableWorkspace(workspace: RegistryEntry): void;
  linkedChatStoreFor(workspace: RegistryEntry): Pick<DesktopLinkedChatStore, "listChannels" | "getChannelWireId">;
  remoteForWorkspace(workspace: RegistryEntry): Promise<{
    credentials: CloudCredentials; credentialGeneration: number;
  }>;
  currentCredentialGeneration(): number;
  currentCredentials(): CloudCredentials | null;
  warmCredentialCache(): Promise<void>;
  relayShareJsonWithCredentials<Result>(
    credentials: CloudCredentials, path: string, init?: RequestInit,
  ): Promise<Result>;
  listWorkspaces(): RegistryEntry[];
  setWorkspaceSharedChannels(workspaceId: string, channels: JoinedSharedChannel[]): unknown;
  relayClientForWorkspace(input: {
    workspaceId: string; rootPath: string; attachmentId?: symbol;
    relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
  }): Pick<EngineRelayWorkspaceClient, "pullSharedChannel">;
  projectPendingChatBookmarksAfterPull(workspaceId: string): Promise<void>;
  normalizeServerUrl(url: string): string;
  peekedReceivedGrantKinds: Map<string, "dm" | "not-dm">;
  peekReceivedGrantKindForShare(relay: SyncRelayConnection, shareId: string): Promise<DmPeekResult>;
  acknowledgeWorkspaceShareSkips(workspaceId: string, shareId: string | undefined, generation: number): unknown;
  notifyRenderer(input: { workspaceId: string }): void;
  // Mounts a group's folder under shared-with-me, the way a pasted share
  // code does. Joining a group is one action: the channel, then its folder.
  unmountShareFolder(input: {
    workspace: Workspace; shareId: string; assertCurrent(): void;
  }): Promise<{ folderLeft?: true }>;
  mountShareFolder(input: {
    workspace: Workspace; shareId: string; relayUrl: string; labelHint: string; assertCurrent(): void;
  }): Promise<unknown>;
}) {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation,
    requireEngineCapture, assertWritableWorkspace, linkedChatStoreFor, remoteForWorkspace,
    currentCredentialGeneration, currentCredentials, warmCredentialCache,
    relayShareJsonWithCredentials, listWorkspaces, setWorkspaceSharedChannels,
    relayClientForWorkspace, projectPendingChatBookmarksAfterPull, normalizeServerUrl,
    peekedReceivedGrantKinds, peekReceivedGrantKindForShare, acknowledgeWorkspaceShareSkips,
    notifyRenderer, mountShareFolder, unmountShareFolder,
  } = dependencies;

  // --- Shared channels (MU-C4) --------------------------------------------
  // A chat-channel grant shares a whole channel (threads/messages/reactions)
  // with another account, read-write by default. The relay owns every
  // security decision (membership, authorship, channel scoping, revocation);
  // these handlers only address grants and move the member-side sync.

  registerHandler(CHANNELS.shareChatChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShareChatChannelPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        assertWritableWorkspace(workspace);
        const store = linkedChatStoreFor(workspace);
        const channel = await requireShareableChatChannel({
          workspaceId: workspace.workspaceId,
          channelId: input.channelId,
          store,
        });
        operation.assertCurrent();
        const wireId = await store.getChannelWireId({
          workspaceId: workspace.workspaceId,
          channelId: input.channelId,
        });
        operation.assertCurrent();
        if (!wireId) throw new Error("This channel can't be shared yet.");
        // "general" is every workspace's personal default channel — the same wire
        // id everywhere by design, so sharing it would merge strangers' personal
        // chats. Refuse with a way forward.
        if (wireId === GENERAL_CHANNEL_WIRE_ID) {
          throw new Error(
            "The general channel is personal to each workspace. Create a channel to share it.",
          );
        }
        if (
          workspace.sharedChannels?.some(
            (channel) => channel.channelWireId === wireId,
          )
        ) {
          throw new Error(
            "This channel was shared with you — ask the person who shared it to add more people.",
          );
        }
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(workspace);
        operation.assertCurrent();
        const created = await awaitCredentialGeneration({
          capturedGeneration: credentialGeneration,
          currentGeneration: () => currentCredentialGeneration(),
          run: () => {
            operation.assertCurrent();
            return relayShareJsonWithCredentials<{ shareId: string }>(
              credentials,
              `/sync/${encodeURIComponent(workspace.workspaceId)}/shares`,
              {
                method: "POST",
                // A channel with a folder is a group: one grant covers
                // the channel and the folder together.
                body: JSON.stringify({
                  recipientEmail: input.recipientEmail,
                  channelWireId: wireId,
                  ...(channel.folderPath ? { paths: [channel.folderPath] } : {}),
                  ...(input.access ? { access: input.access } : {}),
                }),
              },
            );
          },
        });
        operation.assertCurrent();
        return ShareChatChannelResult.parse({ shareId: created.shareId });
      },
    );
  });

  // What this machine joined, for the channels the caller named. The grant
  // side lives on the relay; this side does not, so asking it costs no network
  // — and a caller that needs only this must not wait on a relay that may
  // never answer.
  //
  // The scope is a required argument, not a filter a caller may skip: the
  // registry array grows with every channel this workspace has ever joined,
  // and an unscoped answer would carry that history to the renderer. The write
  // gate is unaffected — assertSharedChannelWritable reads the whole array
  // here in main and never crosses IPC at all.
  function joinedChannelAnswers(
    workspace: RegistryEntry,
    channelWireIds: readonly string[],
  ) {
    return scopeJoinedChannels(workspace.sharedChannels ?? [], channelWireIds);
  }

  registerHandler(
    CHANNELS.listJoinedSharedChannels,
    createListJoinedSharedChannelsIpcHandler({
      assertTrustedSender,
      withWorkspaceOperation: (event, workspaceId, work) =>
        withRendererWorkspaceOperation(
          event.sender,
          workspaceId,
          "Sharing stopped because this window changed workspaces.",
          work,
        ),
      answerJoinedChannels: joinedChannelAnswers,
    }),
  );

  function shareIdsClaimedByOtherWorkspaces(workspaceId: string): Set<string> {
    const claimed = new Set<string>();
    for (const [shareId, holders] of liveSharedChannelHoldersByShareId(
      listWorkspaces(),
    )) {
      if ([...holders].some((holder) => holder !== workspaceId)) claimed.add(shareId);
    }
    return claimed;
  }

  function otherWorkspaceHoldingShare(
    shareId: string,
    workspaceId: string,
  ): { workspaceId: string; rootPath: string } | null {
    return otherLiveSharedChannelHolder({
      workspaces: listWorkspaces(),
      shareId,
      workspaceId,
    });
  }

  function otherWorkspaceHoldingWireId(
    channelWireId: string,
    workspaceId: string,
  ): { workspaceId: string; rootPath: string } | null {
    return otherLiveSharedChannelHolderByWireId({
      workspaces: listWorkspaces(),
      channelWireId,
      workspaceId,
    });
  }

  function assertShareNotHeldElsewhere(
    shareId: string,
    workspaceId: string,
    channelWireId?: string,
  ): void {
    const holder =
      otherWorkspaceHoldingShare(shareId, workspaceId) ??
      (channelWireId
        ? otherWorkspaceHoldingWireId(channelWireId, workspaceId)
        : null);
    if (!holder) return;
    const workspaceName =
      holder.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
    throw new Error(
      `This conversation already lives in ${workspaceName}. Open that workspace to continue.`,
    );
  }

  function reserveAndPullSharedChannelForWorkspace(input: {
    operation: Operation;
    assertCurrent?: () => void;
    relay: SyncRelayConnection;
    shareId: string;
    recipientUserId: string;
    relayUrl: string;
    preWrite?: (info: SharedChannelInfo) => void;
  }): Promise<JoinedSharedChannel> {
    const workspace = input.operation.workspace;
    const assertCurrent = input.assertCurrent ?? input.operation.assertCurrent;
    return reserveAndPullSharedChannel({
      relay: input.relay,
      shareId: input.shareId,
      workspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      recipientUserId: input.recipientUserId,
      relayUrl: input.relayUrl,
      preWrite: input.preWrite,
      readSharedChannels: () => {
        assertCurrent();
        return input.operation.workspace.sharedChannels ?? [];
      },
      writeSharedChannels: (workspaceId, channels) => {
        if (workspaceId !== workspace.workspaceId) {
          throw new Error("Shared channel write targeted a different workspace.");
        }
        assertCurrent();
        setWorkspaceSharedChannels(workspaceId, channels);
        assertCurrent();
      },
      fetchInfo: async (request) => {
        assertCurrent();
        const info = await fetchSharedChannelInfo(request);
        assertCurrent();
        return info;
      },
      pull: async ({ workspaceId, rootPath, relay, shareId, channelWireId }) => {
        assertCurrent();
        if (
          workspaceId !== workspace.workspaceId ||
          rootPath !== workspace.rootPath
        ) {
          throw new Error("Shared channel pull targeted a different workspace.");
        }
        const result = await relayClientForWorkspace({
          workspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath,
          attachmentId: workspace.attachmentId,
          relay,
        }).pullSharedChannel({
          shareId,
          channelWireId,
        });
        assertCurrent();
        return result;
      },
      serialize: (workspaceId, run) => {
        if (workspaceId !== workspace.workspaceId) {
          throw new Error("Shared channel work targeted a different workspace.");
        }
        return runInWorkspaceAuthorityLane(
          { state: input.operation.state, assertCurrent },
          "shared-channels",
          run,
        );
      },
      afterPull: async (workspaceId) => {
        if (workspaceId !== workspace.workspaceId) {
          throw new Error("Shared channel pull targeted a different workspace.");
        }
        assertCurrent();
        await projectPendingChatBookmarksAfterPull(workspaceId);
        assertCurrent();
      },
    });
  }

  registerHandler(CHANNELS.listChatChannelShares, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelSharesPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        // Relay-side listings need a signed-in session; without one the local
        // joined set still answers (their local copies keep working offline), and
        // the relay side reports signed-out or unreachable instead of posing as
        // an empty listing.
        //
        // One credentials snapshot serves both the fetch and the session key, so
        // the key always names the session the request actually used — a login
        // or switch landing mid-flight cannot drift them apart.
        await warmCredentialCache();
        operation.assertCurrent();
        const credentials = currentCredentials();
        const shareCredentialGeneration = currentCredentialGeneration();
        const { assertCurrent: assertCurrentShareSession } = credentialScopedOperation({
          assertCurrent: operation.assertCurrent,
          capturedGeneration: shareCredentialGeneration,
          currentGeneration: () => currentCredentialGeneration(),
        });
        const shareIdsClaimedElsewhere = shareIdsClaimedByOtherWorkspaces(
          workspace.workspaceId,
        );
        const relay = await readRelayChatShareLanes({
          fetchListing: async () => {
            if (!credentials) {
              throw new RelaySessionError("Sign in to dohc Cloud first.");
            }
            assertCurrentShareSession();
            const listing = await relayShareJsonWithCredentials<{
              granted?: Array<Record<string, unknown>>;
              received?: Array<Record<string, unknown>>;
            }>(credentials, "/sync/shares");
            assertCurrentShareSession();
            const receivedShareIds = Array.isArray(listing.received)
              ? listing.received.flatMap((row) => {
                  const selector = row.selector as
                    | { kind?: unknown }
                    | undefined;
                  return selector?.kind === "chat-channel" &&
                    typeof row.shareId === "string"
                    ? [row.shareId]
                    : [];
                })
              : [];
            // This adds bounded relay reads only for uncached grants. The one-time
            // cost closes the request-gate window before the first syncDms poll.
            await resolveDmKinds({
              shareIds: receivedShareIds,
              cache: peekedReceivedGrantKinds,
              peekKind: async (shareId) => {
                assertCurrentShareSession();
                const kind = await peekReceivedGrantKindForShare(
                  {
                    baseUrl: normalizeServerUrl(credentials.relayUrl!),
                    token: credentials.token,
                    fetch: relayFetchWithTimeout(
                      RELAY_FETCH_TIMEOUT_MS,
                    ),
                  },
                  shareId,
                );
                assertCurrentShareSession();
                return kind;
              },
            });
            assertCurrentShareSession();
            for (const shareId of shareIdsToWithholdFromOrdinaryInvites({
              shareIds: receivedShareIds,
              cache: peekedReceivedGrantKinds,
            })) {
              shareIdsClaimedElsewhere.add(shareId);
            }
            return listing;
          },
          workspaceId: workspace.remote ? workspace.workspaceId : null,
          shareIdsClaimedElsewhere,
        });
        assertCurrentShareSession();
        // The caller's channels plus the invitations this answer is about to hand
        // it. The sharing surface shows both, and for each invitation it decides
        // whether this workspace has already joined that channel — a question it
        // cannot ask in advance, because this call is what tells it the invitation
        // exists. Read after the relay await, so a sync pass that ended a row
        // during it is reflected rather than missed.
        const shownWireIds = [
          ...input.channelWireIds,
          ...(relay.state === "answered"
            ? relay.received.map((row) => row.channelWireId)
            : []),
        ];
        return ListChatChannelSharesResult.parse({
          joined: joinedChannelAnswers(operation.workspace, shownWireIds),
          sessionKey:
            relay.state === "signed-out"
              ? null
              : chatShareSessionKey(credentials),
          relay,
        });
      },
    );
  });

  // The joined channel's name, for the folder's label. A replicated channel
  // keeps the originating store's channel id, which is its wire id. The
  // channel was just pulled, so it is in the store; if the pull brought
  // nothing yet, the label falls back to the granter.
  async function groupFolderName(workspace: RegistryEntry, channelWireId: string): Promise<string> {
    const channels = await linkedChatStoreFor(workspace).listChannels({ workspaceId: workspace.workspaceId });
    return channels.find((channel) => channel.id === channelWireId)?.name ?? "";
  }

  registerHandler(CHANNELS.joinSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = JoinSharedChannelPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Joining stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        if (shareViewIsPresent(workspace.shareView)) {
          throw new Error(
            "Shared views are read-only — join channels from a workspace you own.",
          );
        }
        await warmCredentialCache();
        operation.assertCurrent();
        const joinCredentials = requireCredentials(currentCredentials());
        const joinCredentialGeneration = currentCredentialGeneration();
        if (!joinCredentials.relayUrl) {
          throw new Error(
            "Reconnect dohc Cloud with a sync relay URL, then try again.",
          );
        }
        // Capture the credentials before the awaits below (CodeRabbit Data
        // Integrity): currentCredentials() can change during fetch/pull (logout,
        // relay switch) — re-reading it afterwards can crash on null or pin the
        // joined channel to the wrong relay. The join is atomic against the
        // credentials it started with.
        const joinedRelayUrl = joinCredentials.relayUrl;
        const joinedRecipientUserId = joinCredentials.userId;
        const { assertCurrent: assertCurrentJoinSession } = credentialScopedOperation({
          assertCurrent: operation.assertCurrent,
          capturedGeneration: joinCredentialGeneration,
          currentGeneration: () => currentCredentialGeneration(),
        });
        const relay = {
          baseUrl: normalizeServerUrl(joinedRelayUrl),
          token: joinCredentials.token,
          // Same timeout wrapper runSharedChannelSyncPass uses (:973): an
          // unresponsive relay must abort the join's fetch/pull instead of leaving
          // the renderer's "Joining…" button stuck forever.
          fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
        };
        let joined: JoinedSharedChannel;
        // Filled by preWrite. Held in an object so the closure's assignment
        // survives TypeScript's narrowing of a plain `let`.
        const grant: { info: SharedChannelInfo | null } = { info: null };
        try {
          joined = await reserveAndPullSharedChannelForWorkspace({
            operation,
            assertCurrent: assertCurrentJoinSession,
            relay,
            shareId: input.shareId,
            recipientUserId: joinedRecipientUserId,
            relayUrl: joinedRelayUrl,
            preWrite: (info) => {
              grant.info = info;
            },
          });
          assertCurrentJoinSession();
        } catch (error) {
          assertCurrentJoinSession();
          if (error instanceof ShareUnavailableError) {
            throw new Error("That shared channel isn't available anymore.");
          }
          throw error;
        }
        // A group's folder follows its channel. The channel is joined and
        // its row written, so a folder that cannot be added leaves the chat
        // usable and says what is missing. The mount re-reads and adopts the
        // session itself, which advances the credential generation, so after
        // it only workspace liveness is checked here.
        if (
          grant.info?.kind === "group" &&
          shareMountRecordsForId(storedShareMounts(operation.workspace), input.shareId).length === 0
        ) {
          const labelHint = await groupFolderName(operation.workspace, joined.channelWireId);
          assertCurrentJoinSession();
          try {
            await mountShareFolder({
              workspace: operation.workspace,
              shareId: input.shareId,
              relayUrl: joinedRelayUrl,
              labelHint,
              assertCurrent: operation.assertCurrent,
            });
          } catch (error) {
            operation.assertCurrent();
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Joined the group's chat, but its folder could not be added. ${reason}`);
          }
          operation.assertCurrent();
        }
        return JoinSharedChannelResult.parse({
          joined: { ...joined, ended: false },
        });
      },
    );
  });

  // Member-initiated leave: purely local — the channel stops syncing and its
  // rows stay readable. Keep an ended tombstone so participant provenance and
  // the read-only write gate survive after live grant data is gone. Shared by
  // leaveSharedChannel and leaveDm — a DM's accepted row IS a
  // JoinedSharedChannel row in the same registry, so ending it is the same
  // operation regardless of which surface asked.
  function endWorkspaceJoinedChannel(
    operation: Operation,
    shareId: string,
  ): void {
    const workspace = operation.workspace;
    operation.assertCurrent();
    setWorkspaceSharedChannels(
      workspace.workspaceId,
      endJoinedChannel(workspace.sharedChannels ?? [], shareId),
    );
    operation.assertCurrent();
  }

  registerHandler(CHANNELS.leaveSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveSharedChannelPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Leaving stopped because this window changed workspaces.",
      async (operation) => {
        endWorkspaceJoinedChannel(operation, input.shareId);
        if (shareMountRecordsForId(storedShareMounts(operation.workspace), input.shareId).length > 0) {
          let folderLeft = false;
          try {
            folderLeft = (await unmountShareFolder({
              workspace: operation.workspace, shareId: input.shareId, assertCurrent: operation.assertCurrent,
            })).folderLeft === true;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Left the group, but its folder could not be removed. ${reason}`);
          }
          if (folderLeft) {
            throw new Error(
              "Left the group, but its folder could not be removed. Remove it under Settings, Shared folders.",
            );
          }
        }
        return undefined;
      },
    );
  });

  // Record that the user has seen a share's skipped ops.
  //
  // It does not delete them. The cursor has already committed past those ops,
  // so this record is the only remaining evidence of what is missing —
  // deleting it behind a one-click control would be an irreversible change
  // with no reverse path and no warning. Acknowledging hides the warning,
  // keeps the coordinates for diagnosis, and lets a later refusal (a higher
  // generation) raise it again on its own.
  registerHandler(CHANNELS.dismissShareSkips, async (event, payload) => {
    assertTrustedSender(event);
    const input = DismissShareSkipsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Share warning update stopped because this window changed workspaces.",
      (operation) => {
        const workspace = operation.workspace;
        if (
          input.shareId === undefined &&
          !shareViewIsPresent(workspace.shareView)
        ) {
          throw new Error("This workspace is not a shared view.");
        }
        if (
          input.shareId !== undefined &&
          shareMountRecordsForId(
            storedShareMounts(workspace),
            input.shareId,
          ).length === 0
        ) {
          throw new Error("That share is not mounted in this workspace.");
        }
        operation.assertCurrent();
        acknowledgeWorkspaceShareSkips(
          workspace.workspaceId,
          input.shareId,
          input.generation,
        );
        operation.assertCurrent();
        notifyRenderer({ workspaceId: workspace.workspaceId });
      },
    );
  });

  return {
    assertShareNotHeldElsewhere,
    reserveAndPullSharedChannelForWorkspace,
    endWorkspaceJoinedChannel,
  };
}

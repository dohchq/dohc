import { join } from "node:path";
import {
  AcceptDmPayload, AcceptDmResult, DeclineDmPayload, RequestDmAgainPayload,
  SyncDmsPayload, SyncDmsResult, StartDmPayload, StartDmResult, LeaveDmPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { chatMessageForIpc } from "./chatsIpc";
import type { createChatScopeCapability } from "./chatScope";
import {
  dmChannelNameFor, grantDmRecipients, listDmRecords, matchDmChannelByRecipients,
  parseDmRecipients, peekReceivedGrantKind, runningThread,
  type DmPeekResult, type DmRecordInfo, type ShareLogPage,
} from "../workspaces/dmChats";
import { clearDeclinedDm, declineDm, readDeclinedDms } from "../workspaces/dmRequestStore";
import {
  classifyDmRequests, classifyDmRequestsWithFallback, type LastKnownDmRequestLanesCache,
  isShareAcceptedInWorkspace, liveSharedChannelHoldersByShareId, liveSharedChannelHoldersByWireId,
  markLeftInLastKnownLanes, withholdDmsInRequestLanes,
} from "../workspaces/dmRequests";
import { credentialScopedOperation, requireCredentials } from "../workspaces/credentialScopedOperation";
import { resolveWorkspaceRelayAuthorId, type ChatRelayIdentityTarget } from "../workspaces/chatRelayIdentity";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { relayFetchWithTimeout, RELAY_FETCH_TIMEOUT_MS } from "../workspaces/sharedChannels";
import { ShareUnavailableError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import type { RegistryEntry, JoinedSharedChannel } from "../workspaces/registryStore";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";

// Peek a received chat-channel grant's kind without mutating the local store.
// The share-log GET paginates raw rows before the
// share filter, so the peek must PAGE through nextCursor until the first
// served op (the channel.create bootstrap) appears — reading only the first
// page is a permanent false negative on any log with an earlier filtered op
// (e.g. workspace.init). Paging + capping lives in peekReceivedGrantKind.
export function peekReceivedGrantKindForShare(
  relay: SyncRelayConnection,
  shareId: string,
): Promise<DmPeekResult> {
  const base = relay.baseUrl.replace(/\/+$/u, "");
  return peekReceivedGrantKind({
    fetchPage: async (since) => {
      const response = await (relay.fetch ?? fetch)(
        `${base}/sync/shares/${encodeURIComponent(shareId)}/log?since=${since}&limit=200`,
        { headers: { authorization: `Bearer ${relay.token}` } },
      );
      if (!response.ok) return null;
      return (await response.json().catch(() => null)) as ShareLogPage | null;
    },
  });
}

export function registerDirectMessagesIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: RegistryEntry;
    readonly state: { lastKnownDmRequestLanes: LastKnownDmRequestLanesCache };
    assertCurrent(): void;
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  requireEngineCapture(workspace: RegistryEntry, feature: "Chats"): Promise<{
    workspace: RegistryEntry; capture: WorkspaceEngineCapture;
  }>;
  assertWritableWorkspace(workspace: RegistryEntry): void;
  linkedChatStoreFor(workspace: RegistryEntry): DesktopLinkedChatStore;
  warmCredentialCache(): Promise<void>;
  currentCredentials(): CloudCredentials | null;
  currentCredentialGeneration(): number;
  remoteForWorkspace(workspace: RegistryEntry): Promise<{
    credentials: CloudCredentials; credentialGeneration: number;
  }>;
  relayShareJsonWithCredentials<Result>(
    credentials: CloudCredentials, path: string, init?: RequestInit,
  ): Promise<Result>;
  normalizeServerUrl(url: string): string;
  listWorkspaces(): RegistryEntry[];
  stateDir(): string;
  peekedReceivedGrantKinds: Map<string, "dm" | "not-dm">;
  syncRendererSharedChannelsForChatTarget(operation: Operation, target?: ChatRelayIdentityTarget): Promise<unknown>;
  assertShareNotHeldElsewhere(shareId: string, workspaceId: string, channelWireId?: string): void;
  reserveAndPullSharedChannelForWorkspace(input: {
    operation: Operation; assertCurrent?: () => void; relay: SyncRelayConnection;
    shareId: string; recipientUserId: string; relayUrl: string;
    preWrite?: (info: { channelWireId: string }) => void;
  }): Promise<JoinedSharedChannel>;
  endWorkspaceJoinedChannel(operation: Operation, shareId: string): void;
  chatScope: Pick<ReturnType<typeof createChatScopeCapability>, "resolveChatFileReferences">;
  localUserDisplayName(): string;
  activity: { queueCloudSync(workspaceId: string): void };
  chatDispatchService: { scanWorkspace(workspaceId: string): Promise<unknown> };
}) {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation, requireEngineCapture,
    assertWritableWorkspace, linkedChatStoreFor, warmCredentialCache, currentCredentials,
    currentCredentialGeneration, remoteForWorkspace, relayShareJsonWithCredentials,
    normalizeServerUrl, listWorkspaces, stateDir, peekedReceivedGrantKinds,
    syncRendererSharedChannelsForChatTarget, assertShareNotHeldElsewhere,
    reserveAndPullSharedChannelForWorkspace, endWorkspaceJoinedChannel,
    localUserDisplayName, activity, chatDispatchService,
  } = dependencies;
  const { resolveChatFileReferences } = dependencies.chatScope;

  // --- Direct messages (WS-MU-C3) ------------------------------------------
  // A DM is a `kind:"dm"` channel plus one MU-C4 chat-channel grant per
  // participant, riding the shared-channel lane. The whole surface is gated on
  // collaboration: signed out / no relay ⇒ available:false and the renderer
  // shows nothing. Authorization lives at the relay. This layer lists
  // requests, accepts them into a workspace, and displays established DMs.

  function dmRecordForIpc(dm: DmRecordInfo) {
    return {
      channelId: dm.channelId,
      channelWireId: dm.channelWireId,
      name: dm.name,
      peerLabel: dm.peerLabel,
      role: dm.role,
      shareId: dm.shareId,
      threadId: dm.threadId,
      unreadCount: dm.unreadCount,
      connected: dm.connected,
    };
  }

  // The account-level declined-request file spans every workspace. Accepted
  // DMs live only in the chosen workspace's shared-channel registry.
  function dmRequestFile(): string {
    return join(stateDir(), "dohc-dm-requests.json");
  }

  // Reconcile DM state with the relay and return the workspace's DM list.
  // Called by the renderer on Chats mount + a gentle poll while visible; the
  // network part degrades silently offline (local list still serves).
  registerHandler(CHANNELS.syncDms, async (event, payload) => {
    assertTrustedSender(event);
    const input = SyncDmsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Chats stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        await warmCredentialCache();
        operation.assertCurrent();
        const syncCredentials = currentCredentials();
        const syncCredentialGeneration = currentCredentialGeneration();
        const { assertCurrent: assertCurrentDmSyncSession } = credentialScopedOperation({
          assertCurrent: operation.assertCurrent,
          capturedGeneration: syncCredentialGeneration,
          currentGeneration: () => currentCredentialGeneration(),
        });
        const relay = syncCredentials?.relayUrl
          ? {
              baseUrl: normalizeServerUrl(syncCredentials.relayUrl),
              token: syncCredentials.token,
              fetch: relayFetchWithTimeout(
                RELAY_FETCH_TIMEOUT_MS,
              ),
            }
          : null;
        const store = linkedChatStoreFor(workspace);
        const { pending, declined } =
          await classifyDmRequestsWithFallback({
            workspaceId: workspace.workspaceId,
            cache: operation.state.lastKnownDmRequestLanes,
            // The cache belongs to this physical attachment. The credential
            // generation guard also prevents an old account's in-flight
            // classify from repopulating it after a session transition.
            credentialGeneration: () => currentCredentialGeneration(),
            classify: async () => {
              if (!relay || !syncCredentials) {
                throw new Error("DM sync is unavailable: not signed in.");
              }
              assertCurrentDmSyncSession();
              const listing = await relayShareJsonWithCredentials<{
                received?: Array<{
                  shareId?: unknown;
                  granterEmail?: unknown;
                  selector?: { kind?: unknown; channelWireId?: unknown };
                }>;
              }>(syncCredentials, "/sync/shares");
              assertCurrentDmSyncSession();
              // Re-derived on every call, not a snapshot taken once:
              // classifyDmRequests calls this twice around its async peek.
              return classifyDmRequests({
                received: listing.received ?? [],
                kindCache: peekedReceivedGrantKinds,
                peekKind: async (shareId) => {
                  assertCurrentDmSyncSession();
                  const kind = await peekReceivedGrantKindForShare(
                    relay,
                    shareId,
                  );
                  assertCurrentDmSyncSession();
                  return kind;
                },
                holdersByShareId: () => {
                  assertCurrentDmSyncSession();
                  return liveSharedChannelHoldersByShareId(listWorkspaces());
                },
                holdersByWireId: () => {
                  assertCurrentDmSyncSession();
                  return liveSharedChannelHoldersByWireId(listWorkspaces());
                },
                declinedShareIds: readDeclinedDms(dmRequestFile()),
              });
            },
          });
        assertCurrentDmSyncSession();
        if (relay) {
          try {
            // Push the member's local ops, pull everyone else's, for the joined
            // DMs (and other shared channels) this bounded pass reaches.
            await syncRendererSharedChannelsForChatTarget(
              operation,
              input.openChannelId
                ? { channelId: input.openChannelId }
                : undefined,
            );
            assertCurrentDmSyncSession();
            // The cloud engine owns its work after this request queues it. Do
            // not extend the renderer operation into that durable process.
            activity.queueCloudSync(workspace.workspaceId);
          } catch (error) {
            assertCurrentDmSyncSession();
            // Offline degradation: the local DM list still serves and the next
            // pass retries.
            console.error(
              `[desktop] DM sync failed for ${workspace.rootPath}:`,
              error,
            );
          }
        }
        assertCurrentDmSyncSession();
        const dms = await listDmRecords({
          workspaceId: workspace.workspaceId,
          store,
          sharedChannels: operation.workspace.sharedChannels ?? [],
        });
        assertCurrentDmSyncSession();
        const requestShareIds = new Set(
          [...pending, ...declined].map((row) => row.shareId),
        );
        // Fresh, after classify resolves — not reused from before it, which
        // could be stale by the time the withhold decision needs it.
        const holdersByShareId = liveSharedChannelHoldersByShareId(
          listWorkspaces(),
        );
        const holdersByWireId = liveSharedChannelHoldersByWireId(
          listWorkspaces(),
        );
        return SyncDmsResult.parse({
          available: relay !== null,
          dms: withholdDmsInRequestLanes({
            dms,
            requestShareIds,
            holdersByShareId,
            holdersByWireId,
            workspaceId: workspace.workspaceId,
          }).map(dmRecordForIpc),
          pending,
          declined,
        });
      },
    );
  });

  registerHandler(CHANNELS.acceptDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = AcceptDmPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Accepting stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        if (shareViewIsPresent(workspace.shareView)) {
          throw new Error(
            "Shared views are read-only — add this conversation to a workspace you own.",
          );
        }

        assertShareNotHeldElsewhere(input.shareId, workspace.workspaceId);
        const acceptedHere = isShareAcceptedInWorkspace(
          workspace.sharedChannels ?? [],
          input.shareId,
        );
        if (!acceptedHere) {
          if (peekedReceivedGrantKinds.get(input.shareId) !== "dm") {
            throw new Error(
              "dohc could not find that message request. Wait for Chats to refresh, then try again.",
            );
          }
          await warmCredentialCache();
          operation.assertCurrent();
          const acceptCredentials = requireCredentials(currentCredentials());
          const acceptCredentialGeneration = currentCredentialGeneration();
          if (!acceptCredentials.relayUrl) {
            throw new Error(
              "Reconnect your server to refresh its connection settings, then try again.",
            );
          }
          const acceptedRelayUrl = acceptCredentials.relayUrl;
          const { assertCurrent: assertCurrentAcceptSession } = credentialScopedOperation({
            assertCurrent: operation.assertCurrent,
            capturedGeneration: acceptCredentialGeneration,
            currentGeneration: () => currentCredentialGeneration(),
          });
          const relay = {
            baseUrl: normalizeServerUrl(acceptedRelayUrl),
            token: acceptCredentials.token,
            fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
          };
          // Two open Chats views can accept the same account-wide request
          // concurrently; only the first may reserve it.
          assertShareNotHeldElsewhere(input.shareId, workspace.workspaceId);
          try {
            await reserveAndPullSharedChannelForWorkspace({
              operation,
              assertCurrent: assertCurrentAcceptSession,
              relay,
              shareId: input.shareId,
              recipientUserId: acceptCredentials.userId,
              relayUrl: acceptedRelayUrl,
              preWrite: (info) => {
                assertCurrentAcceptSession();
                assertShareNotHeldElsewhere(
                  input.shareId,
                  workspace.workspaceId,
                  info.channelWireId,
                );
              },
            });
            assertCurrentAcceptSession();
          } catch (error) {
            assertCurrentAcceptSession();
            if (error instanceof ShareUnavailableError) {
              throw new Error(
                "That conversation isn't available anymore. Ask the sender to message you again.",
              );
            }
            // The reservation row is the write gate. Once it exists, a pull
            // failure is not an accept failure; the local DM check below tells
            // whether enough data landed to open the conversation.
            if (
              !isShareAcceptedInWorkspace(
                operation.workspace.sharedChannels ?? [],
                input.shareId,
              )
            ) {
              throw error;
            }
          }
        }

        operation.assertCurrent();
        // Acceptance succeeded, so obsolete decline-marker cleanup is
        // best-effort. It is account-scoped and owns no workspace authority.
        void clearDeclinedDm(dmRequestFile(), input.shareId);
        const dm = (
          await listDmRecords({
            workspaceId: workspace.workspaceId,
            store: linkedChatStoreFor(workspace),
            sharedChannels: operation.workspace.sharedChannels ?? [],
          })
        ).find((record) => record.shareId === input.shareId);
        operation.assertCurrent();
        if (!dm) {
          throw new Error(
            "dohc added the conversation but could not open it. Open it from Direct messages.",
          );
        }
        return AcceptDmResult.parse({ dm: dmRecordForIpc(dm) });
      },
    );
  });

  registerHandler(CHANNELS.declineDm, (event, payload) => {
    assertTrustedSender(event);
    const input = DeclineDmPayload.parse(payload);
    if (!declineDm(dmRequestFile(), input.shareId)) {
      throw new Error("dohc could not save this choice. Try again.");
    }
    return undefined;
  });

  registerHandler(CHANNELS.requestDmAgain, (event, payload) => {
    assertTrustedSender(event);
    const input = RequestDmAgainPayload.parse(payload);
    if (!clearDeclinedDm(dmRequestFile(), input.shareId)) {
      throw new Error("dohc could not save this choice. Try again.");
    }
    return undefined;
  });

  // The DM surface's reverse path for placement: ends the same row
  // leaveSharedChannel ends. The next syncDms poll's classifyDmRequests finds
  // no live holder for this shareId, so the conversation reappears as a
  // request and can be accepted into any workspace, including this one.
  registerHandler(CHANNELS.leaveDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveDmPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Leaving stopped because this window changed workspaces.",
      (operation) => {
        const workspace = operation.workspace;
        const leftRow = (workspace.sharedChannels ?? []).find(
          (channel) => channel.shareId === input.shareId,
        );
        endWorkspaceJoinedChannel(operation, input.shareId);
        operation.assertCurrent();
        // The leave is locally knowable without the relay. Keep this physical
        // attachment's fallback lanes consistent with the registry write.
        markLeftInLastKnownLanes(
          operation.state.lastKnownDmRequestLanes,
          workspace.workspaceId,
          {
            shareId: input.shareId,
            granterEmail: leftRow?.granterEmail ?? null,
          },
        );
        return undefined;
      },
    );
  });

  // Start (or continue) a DM: dedupe by recipient set, ensure one live grant
  // per recipient, and send the first message into the single running thread.
  registerHandler(CHANNELS.startDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartDmPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Starting a direct message stopped because this window changed workspaces.",
      async (operation) => {
        // A DM needs the full collaboration surface: a signed-in relay session
        // and a synced workspace. The exact operation supplies the canonical
        // physical root used by both the local engine and relay work.
        const workspace = operation.workspace;
        assertWritableWorkspace(workspace);
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(workspace);
        operation.assertCurrent();
        const {
          assertCurrent: assertCurrentDmSession,
          run: awaitCurrentDmSession,
        } = credentialScopedOperation({
          assertCurrent: operation.assertCurrent,
          capturedGeneration: credentialGeneration,
          currentGeneration: () => currentCredentialGeneration(),
        });
        const { capture } = await requireEngineCapture(workspace, "Chats");
        assertCurrentDmSession();
        const authorUserId = resolveWorkspaceRelayAuthorId(
          workspace,
          credentials,
        );
        if (!credentials.relayUrl || !authorUserId) {
          throw new Error("Sign in to your server to start a direct message.");
        }
        const recipients = parseDmRecipients(input.recipients);
        const selfEmail = credentials.email.toLowerCase();
        if (selfEmail && recipients.includes(selfEmail)) {
          throw new Error(
            "A direct message needs a recipient other than yourself.",
          );
        }
        // Resolve mentions before creating/granting a DM so an invalid or stale
        // heading cannot leave behind a partially initialized conversation.
        const attachments = await awaitCurrentDmSession(() =>
          resolveChatFileReferences(
            workspace,
            capture.fileObjectIdForPath,
            input.fileReferences,
          ),
        );
        const store = linkedChatStoreFor(workspace);
        // A DM's identity is its live grant recipient set, not its display
        // name. Enumerate live chat-channel grants once for deduplication and
        // for deciding which recipients still need a grant.
        const shares = await awaitCurrentDmSession(() =>
          relayShareJsonWithCredentials<{
            granted?: Array<{
              recipientEmail?: string | null;
              revokedAtMs?: number | null;
              selector?: { kind?: string; channelWireId?: string };
            }>;
          }>(credentials, "/sync/shares"),
        );
        const liveGrantEmailsByWire = new Map<string, Set<string>>();
        for (const row of shares.granted ?? []) {
          if (
            (row.revokedAtMs ?? null) !== null ||
            row.selector?.kind !== "chat-channel" ||
            typeof row.selector.channelWireId !== "string" ||
            typeof row.recipientEmail !== "string"
          ) {
            continue;
          }
          const wire = row.selector.channelWireId;
          const set = liveGrantEmailsByWire.get(wire) ?? new Set<string>();
          set.add(row.recipientEmail.toLowerCase());
          liveGrantEmailsByWire.set(wire, set);
        }
        // Starting a DM with the same live recipient set opens the existing one.
        const dmChannels = (
          await awaitCurrentDmSession(() =>
            store.listChannels({ workspaceId: workspace.workspaceId }),
          )
        ).filter((channel) => channel.kind === "dm");
        const dmChannelWires = await Promise.all(
          dmChannels.map(async (channel) => ({
            id: channel.id,
            wireId:
              (await awaitCurrentDmSession(() =>
                store.getChannelWireId({
                  workspaceId: workspace.workspaceId,
                  channelId: channel.id,
                }),
              )) ?? channel.id,
          })),
        );
        assertCurrentDmSession();
        const matchedId = matchDmChannelByRecipients({
          recipients,
          channels: dmChannelWires,
          liveGrantEmailsByWire,
        });
        let channelId = matchedId;
        if (!channelId) {
          channelId = (
            await awaitCurrentDmSession(() =>
              store.createChannel({
                workspaceId: workspace.workspaceId,
                name: dmChannelNameFor(recipients),
                kind: "dm",
              }),
            )
          ).id;
        }
        const wireId =
          (await awaitCurrentDmSession(() =>
            store.getChannelWireId({
              workspaceId: workspace.workspaceId,
              channelId,
            }),
          )) ?? channelId;
        // Grant the full recipient set before the first message mutation.
        // grantDmRecipients revokes grants created by this call if setup or
        // commit fails.
        const covered = liveGrantEmailsByWire.get(wireId) ?? new Set<string>();
        let threads: Awaited<ReturnType<typeof store.listChannelThreads>> = [];
        const message = await grantDmRecipients({
          recipients,
          covered,
          createGrant: async (email) => {
            assertCurrentDmSession();
            const created = await relayShareJsonWithCredentials<{
              shareId?: string;
            }>(
              credentials,
              `/sync/${encodeURIComponent(workspace.workspaceId)}/shares`,
              {
                method: "POST",
                body: JSON.stringify({
                  recipientEmail: email,
                  channelWireId: wireId,
                  access: "read-write",
                }),
              },
            );
            // The helper records this id before its next currentness check, so
            // retirement during POST still rolls the grant back.
            return typeof created.shareId === "string" ? created.shareId : null;
          },
          // Compensating cleanup uses the captured relay session even when
          // forward authority is stale, so retirement cannot strand a partial
          // recipient set.
          revokeGrant: async (shareId) => {
            await relayShareJsonWithCredentials(
              credentials,
              `/sync/shares/${encodeURIComponent(shareId)}/revoke`,
              { method: "POST" },
            );
          },
          assertCurrent: assertCurrentDmSession,
          beforeCommit: async () => {
            threads = await awaitCurrentDmSession(() =>
              store.listChannelThreads({
                workspaceId: workspace.workspaceId,
                channelId,
              }),
            );
          },
          commit: async () => {
            const running = runningThread(threads);
            const author = {
              kind: "human" as const,
              displayName: localUserDisplayName(),
            };
            return running
              ? store.sendMessage({
                  workspaceId: workspace.workspaceId,
                  threadId: running.thread.id,
                  author,
                  authorUserId,
                  body: input.body,
                  ...(attachments.length > 0 ? { attachments } : {}),
                })
              : (
                  await store.startChannelThread({
                    workspaceId: workspace.workspaceId,
                    channelId,
                    author,
                    authorUserId,
                    body: input.body,
                    ...(attachments.length > 0 ? { attachments } : {}),
                  })
                ).message;
          },
        });
        assertCurrentDmSession();
        if (!message) throw new Error("Could not start that direct message.");
        // These durable owners take over only after exact request admission.
        assertCurrentDmSession();
        activity.queueCloudSync(workspace.workspaceId);
        assertCurrentDmSession();
        void chatDispatchService
          .scanWorkspace(workspace.workspaceId)
          .catch((error) => {
            console.error("[desktop] local chat dispatch scan:", error);
          });
        assertCurrentDmSession();
        const dm = (
          await awaitCurrentDmSession(() =>
            listDmRecords({
              workspaceId: workspace.workspaceId,
              store,
              sharedChannels: operation.workspace.sharedChannels ?? [],
            }),
          )
        ).find((candidate) => candidate.channelId === channelId);
        if (!dm) throw new Error("Could not start that direct message.");
        return StartDmResult.parse({
          dm: dmRecordForIpc(dm),
          message: chatMessageForIpc(message),
        });
      },
    );
  });
}

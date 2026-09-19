import { randomUUID } from "node:crypto";
import { CHANNELS } from "./channels";
import {
  ListShareProposalsPayload, ListShareProposalsResult,
  ReadShareProposalChangesPayload, ReadShareProposalChangesResult,
  ReadShareProposalFileContentPayload, ReadShareProposalFileContentResult,
  SettleShareProposalPayload, SettleShareProposalResult,
  SubmitShareChangesPayload, resolveSubmitShareChangesResult,
  ListMyShareChangesPayload, ListMyShareChangesResult,
  WithdrawShareChangesPayload, WithdrawShareChangesResult,
} from "./bridgeContract";
import {
  assertShareProposalGranter, requireShareViewMembership, requireShareViewProposalScope,
  sameShareViewProposalScope, shareProposalOpPath, type ShareViewProposalScope,
} from "../workspaces/shareProposals";
import { requireCredentials } from "../workspaces/credentialScopedOperation";
import { workspaceRemoteMatchesCredentials } from "../workspaces/chatRelayIdentity";
import { relayUrlsMatch } from "../workspaces/syncCode";
import { assertShareChangesJournalable } from "../workspaces/shareViewRecords";
import { relayFetchWithTimeout, RELAY_FETCH_TIMEOUT_MS } from "../workspaces/sharedChannels";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "../workspaces/workspaceTextLimits";
import type { ShareProposal, ShareProposalOp, SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { ShareViewSelector } from "../workspaces/shareViewInfo";
import type { WorkspaceTextReadResult, withStaleSensitiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import type { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import type {
  listMyShareProposals, listShareProposals, readShareProposal, readShareProposalOp,
  settleShareProposal, withdrawShareProposal,
} from "../workspaces/shareProposalRelay";

export function registerShareProposalsIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: RegistryEntry & { readonly attachmentId: symbol };
    assertCurrent(): void;
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, inactiveMessage: string,
    work: (operation: Operation) => Promise<Result>): Promise<Result>;
  warmCredentialCache(): Promise<void>;
  currentCredentials(): CloudCredentials | null;
  currentCredentialGeneration(): number;
  normalizeServerUrl(url: string): string;
  isRecordValue(value: unknown): value is Record<string, unknown>;
  readOwnedWorkspaceTextFor(workspace: Operation["workspace"], path: string): Promise<WorkspaceTextReadResult>;
  activity: { queueCloudSync(workspaceId: string): void };
  listShareProposals: typeof listShareProposals;
  readShareProposal: typeof readShareProposal;
  readShareProposalOp: typeof readShareProposalOp;
  settleShareProposal: typeof settleShareProposal;
  listMyShareProposals: typeof listMyShareProposals;
  withdrawShareProposal: typeof withdrawShareProposal;
  withStaleSensitiveWorkspaceOperation: typeof withStaleSensitiveWorkspaceOperation;
  shareViewFiles: Pick<ShareViewFiles, "reconcile">;
  receivedShareEngine: Pick<ReturnType<typeof createReceivedShareEngineAccess>, "relayFor">;
}): void {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation,
    warmCredentialCache, currentCredentials, currentCredentialGeneration, normalizeServerUrl,
    isRecordValue, readOwnedWorkspaceTextFor, activity, listShareProposals, readShareProposal,
    readShareProposalOp, settleShareProposal, listMyShareProposals, withdrawShareProposal,
    withStaleSensitiveWorkspaceOperation, shareViewFiles, receivedShareEngine,
  } = dependencies;
  // ---- Share changes ----
  //
  // Two lanes, and a workspace is only ever in one of them. The GRANTER lane
  // reads and settles the changes a recipient sent for a workspace this
  // machine owns; the RECIPIENT lane sends, lists, and takes back this
  // machine's own changes from inside an edit-level share view. Each refuses
  // the other's workspace before it reaches the relay, so a renderer that
  // names the wrong workspace gets a refusal here rather than a generic 404
  // from a route it should never have addressed.
  //
  // Neither lane trusts a client-supplied share id. The renderer names a
  // workspace; the registry answers which share that workspace is, and at
  // what level.

  interface ShareProposalGranterScope {
    readonly workspaceId: string;
    readonly attachmentId: symbol;
    readonly rootPath: string;
    relay: SyncRelayConnection;
    credentialGeneration: number;
  }

  function sameShareProposalGranterScope(
    left: ShareProposalGranterScope,
    right: ShareProposalGranterScope,
  ): boolean {
    return (
      left.workspaceId === right.workspaceId &&
      left.attachmentId === right.attachmentId &&
      left.rootPath === right.rootPath &&
      left.relay.baseUrl === right.relay.baseUrl &&
      left.relay.token === right.relay.token &&
      left.credentialGeneration === right.credentialGeneration
    );
  }

  function withShareProposalGranterOperation<Result>(
    sender: Sender,
    workspaceId: string,
    work: (scope: {
      resolve(): ShareProposalGranterScope;
      assert(scope: ShareProposalGranterScope): void;
      readText(path: string): ReturnType<typeof readOwnedWorkspaceTextFor>;
      queueCloudSync(): void;
    }) => Promise<Result>,
  ): Promise<Result> {
    return withRendererWorkspaceOperation(
      sender,
      workspaceId,
      "Share changes stopped because this window changed workspaces.",
      async (operation) => {
        await warmCredentialCache();
        operation.assertCurrent();
        const resolve = (): ShareProposalGranterScope => {
          operation.assertCurrent();
          const workspace = operation.workspace;
          assertShareProposalGranter(workspace.shareView);
          const remote = workspace.remote;
          if (!remote) throw new Error("Sync this workspace before sharing.");
          const credentials = requireCredentials(currentCredentials());
          if (!workspaceRemoteMatchesCredentials(remote, credentials)) {
            if (
              normalizeServerUrl(credentials.serverUrl) !==
              normalizeServerUrl(remote.serverUrl)
            ) {
              throw new Error("Sign in to the cloud server this workspace uses.");
            }
            throw new Error("Sign in to the account that synced this workspace.");
          }
          if (!credentials.relayUrl) {
            throw new Error(
              "Reconnect your server to refresh its connection settings, then try again.",
            );
          }
          return {
            workspaceId: workspace.workspaceId,
            attachmentId: workspace.attachmentId,
            rootPath: workspace.rootPath,
            relay: {
              baseUrl: normalizeServerUrl(credentials.relayUrl),
              token: credentials.token,
              fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
            },
            credentialGeneration: currentCredentialGeneration(),
          };
        };
        return await work({
          resolve,
          assert(scope) {
            if (!sameShareProposalGranterScope(scope, resolve())) {
              throw new Error(
                "Share changes stopped because this workspace's cloud binding changed.",
              );
            }
          },
          readText: (path) => readOwnedWorkspaceTextFor(operation.workspace, path),
          queueCloudSync: () => {
            operation.assertCurrent();
            activity.queueCloudSync(operation.workspace.workspaceId);
          },
        });
      },
    );
  }

  // The RECIPIENT lane's scope. The pinned grant and the share id come from
  // `shareProposals.ts`, and the caller states which rule applies: sending
  // needs the edit level, while listing and withdrawing what was already sent
  // need only membership — a reverse path a downgrade removes is not one.
  //
  // What is left here is the session, which must be signed in and on the
  // share's ORIGIN relay. The refresh skips a session on another relay because
  // it runs on a cadence; this refuses, because a person pressed a button and
  // is owed an answer.
  interface ShareProposalRecipientScope {
    workspaceId: string;
    attachmentId: symbol;
    rootPath: string;
    shareId: string;
    grant: ShareViewSelector;
    relay: SyncRelayConnection;
    credentialGeneration: number;
  }

  function withShareProposalRecipientOperation<Result>(
    sender: Sender,
    workspaceId: string,
    resolveScope: (shareView: unknown) => ShareViewProposalScope,
    work: (scope: {
      resolve(): ShareProposalRecipientScope;
      assert(scope: ShareProposalRecipientScope): void;
    }) => Promise<Result>,
  ): Promise<Result> {
    const sameScope = (
      left: ShareProposalRecipientScope,
      right: ShareProposalRecipientScope,
    ): boolean =>
      left.workspaceId === right.workspaceId &&
      left.attachmentId === right.attachmentId &&
      left.rootPath === right.rootPath &&
      left.shareId === right.shareId &&
      sameShareViewProposalScope(left, right) &&
      left.relay.baseUrl === right.relay.baseUrl &&
      left.relay.token === right.relay.token &&
      left.credentialGeneration === right.credentialGeneration;
    return withRendererWorkspaceOperation(
      sender,
      workspaceId,
      "Share changes stopped because this window changed workspaces.",
      async (operation) => {
        await warmCredentialCache();
        operation.assertCurrent();
        const resolve = (): ShareProposalRecipientScope => {
          operation.assertCurrent();
          const workspace = operation.workspace;
          const proposalScope = resolveScope(workspace.shareView);
          const credentials = currentCredentials();
          if (!credentials?.relayUrl) {
            throw new Error("Sign in to your server first.");
          }
          const shareRelayUrl = isRecordValue(workspace.shareView)
            ? workspace.shareView.relayUrl
            : undefined;
          if (
            typeof shareRelayUrl === "string" &&
            !relayUrlsMatch(credentials.relayUrl, shareRelayUrl)
          ) {
            throw new Error("Sign in to the cloud server this share came from.");
          }
          return {
            workspaceId: workspace.workspaceId,
            attachmentId: workspace.attachmentId,
            rootPath: workspace.rootPath,
            ...proposalScope,
            relay: {
              baseUrl: normalizeServerUrl(credentials.relayUrl),
              token: credentials.token,
              fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
            },
            credentialGeneration: currentCredentialGeneration(),
          };
        };
        return await work({
          resolve,
          assert(scope) {
            if (!sameScope(scope, resolve())) {
              throw new Error("Share changes stopped because this shared view changed.");
            }
          },
        });
      },
    );
  }

  // The after content of one proposed change. Owner-scoped: the blob was
  // uploaded into this workspace's storage, so the granter reads it back
  // through the blob route its own sync already uses.
  //
  // Tolerant, exactly as the current side is. A change this surface cannot
  // PREVIEW is still a change the granter has to answer, and failing the read
  // would take the Decline button with it — leaving the granter unable to say
  // no to something they cannot see.
  async function shareProposalIncomingText(
    relay: SyncRelayConnection,
    workspaceId: string,
    op: ShareProposalOp,
  ): Promise<string | null> {
    // A delete has no after side, and binary content is not something a text
    // diff can show. Both are "no incoming text", which the review states.
    if (op.operation === "delete" || !op.afterBlobSha256) return null;
    if (op.afterContentKind !== "text") return null;
    try {
      const response = await (relay.fetch ?? fetch)(
        `${relay.baseUrl}/sync/${encodeURIComponent(workspaceId)}/blobs/` +
          encodeURIComponent(op.afterBlobSha256),
        { headers: { authorization: `Bearer ${relay.token}` } },
      );
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      // The bound the CONTRACT enforces on this very field, not a larger one
      // from somewhere else. `incomingText` is validated by
      // `WORKSPACE_EDITOR_TEXT`, so text over that bound would make the whole
      // response fail to parse — and one unreadable file would take every
      // other file in the review down with it. This is also the bound the
      // current side already answers with (`readWorkspaceText` truncates at
      // it and reads as no preview), so the two sides agree.
      if (bytes.byteLength > WORKSPACE_TEXT_EDITOR_MAX_BYTES) return null;
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  // The opened proposal's file rows, from ops that name a path. An op naming
  // none describes no file this surface can show, and is left out rather than
  // rendered as a blank row. Only the review builds these; the polled listing
  // carries counts.
  function shareProposalFileRows(
    proposal: ShareProposal,
  ): Array<{ op: ShareProposalOp; path: string }> {
    return proposal.ops.flatMap((op) => {
      const path = shareProposalOpPath(op);
      return path ? [{ op, path }] : [];
    });
  }

  registerHandler(CHANNELS.listShareProposals, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListShareProposalsPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const proposals = await listShareProposals({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
        });
        operation.assert(scope);
        return ListShareProposalsResult.parse({
          proposals: proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            shareId: proposal.shareId,
            proposedByEmail: proposal.proposedByEmail,
            createdAtMs: proposal.createdAtMs,
            ops: proposal.ops,
          })),
        });
      },
    );
  });

  registerHandler(CHANNELS.readShareProposalChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadShareProposalChangesPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const proposal = await readShareProposal({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
          proposalId: input.proposalId,
        });
        operation.assert(scope);
        return ReadShareProposalChangesResult.parse({
          proposedByEmail: proposal.proposedByEmail,
          files: shareProposalFileRows(proposal).map(({ op, path }) => ({
            opIndex: op.opIndex,
            path,
            operation: op.operation,
            drifted: op.drifted,
            afterByteLength: op.afterByteLength,
          })),
        });
      },
    );
  });

  registerHandler(CHANNELS.readShareProposalFileContent, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadShareProposalFileContentPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const op = await readShareProposalOp({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
          proposalId: input.proposalId,
          opIndex: input.opIndex,
        });
        operation.assert(scope);
        const currentText =
          op.currentPath === null
            ? null
            : await operation.readText(op.currentPath).then(
                (read) => (read.truncated ? null : read.text),
                () => null,
              );
        operation.assert(scope);
        const incomingText = await shareProposalIncomingText(
          scope.relay,
          scope.workspaceId,
          op,
        );
        operation.assert(scope);
        return ReadShareProposalFileContentResult.parse({
          currentText,
          incomingText,
        });
      },
    );
  });

  registerHandler(CHANNELS.settleShareProposal, async (event, payload) => {
    assertTrustedSender(event);
    const input = SettleShareProposalPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const settled = await settleShareProposal({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
          proposalId: input.proposalId,
          decision: input.decision,
        });
        operation.assert(scope);
        if (settled.state !== "accepted" && settled.state !== "declined") {
          throw new Error("Those changes are no longer open. Refresh, then try again.");
        }
        if (settled.state === "accepted") operation.queueCloudSync();
        return SettleShareProposalResult.parse({ state: settled.state });
      },
    );
  });

  registerHandler(CHANNELS.submitShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = SubmitShareChangesPayload.parse(payload);
    // Sending needs the edit level.
    return withShareProposalRecipientOperation(
      event.sender,
      input.workspaceId,
      requireShareViewProposalScope,
      async (operation) => {
        const beforeReconcile = operation.resolve();
        const reconciled = await withStaleSensitiveWorkspaceOperation(
          beforeReconcile.rootPath,
          (lease) =>
            shareViewFiles.reconcile(
              lease,
              {
                kind: "standalone",
                workspaceId: beforeReconcile.workspaceId,
              },
              "settle",
            ),
        );
        operation.assert(beforeReconcile);
        const scope = operation.resolve();
        if (reconciled.kind !== "settle") {
          throw new Error("Shared file settlement returned an invalid result.");
        }
        if (reconciled.collisionRecordQuarantined) {
          throw new Error(
            "dohc found a damaged shared file recovery record. Refresh shared files. Then send your changes again.",
          );
        }
        assertShareChangesJournalable(reconciled.unjournalablePaths);
        // The engine owns the submit: it reads this replica's own journal, so it
        // has to be the process holding the store.
        const result = await resolveSubmitShareChangesResult(
          reconciled.capturedPaths + reconciled.repairedPaths,
          () =>
            receivedShareEngine.relayFor({
              engineWorkspaceId: scope.workspaceId,
              rootPath: scope.rootPath,
              attachmentId: scope.attachmentId,
              relay: scope.relay,
            }).submitShareProposal({
              shareId: scope.shareId,
              grantedSelector: scope.grant,
              // PR3a mints a fresh key per submit. It makes the relay's idempotency
              // hold for a retry inside one submit (blobs, then the POST), not for
              // a second press: a second press sends whatever is pending then,
              // which is a second set of changes and a second proposal.
              submitId: randomUUID(),
            }),
        );
        operation.assert(scope);
        return result;
      },
    );
  });

  registerHandler(CHANNELS.listMyShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListMyShareChangesPayload.parse(payload);
    // SEEING what was already sent needs membership only: a downgrade must
    // not hide the changes it can no longer add to.
    return withShareProposalRecipientOperation(
      event.sender,
      input.workspaceId,
      requireShareViewMembership,
      async (operation) => {
        const scope = operation.resolve();
        const proposals = await listMyShareProposals({
          relay: scope.relay,
          shareId: scope.shareId,
        });
        operation.assert(scope);
        return ListMyShareChangesResult.parse({
          proposals: proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            state: proposal.state,
            createdAtMs: proposal.createdAtMs,
            files: proposal.ops,
          })),
        });
      },
    );
  });

  registerHandler(CHANNELS.withdrawShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = WithdrawShareChangesPayload.parse(payload);
    // Taking back needs membership only, for the same reason.
    return withShareProposalRecipientOperation(
      event.sender,
      input.workspaceId,
      requireShareViewMembership,
      async (operation) => {
        const scope = operation.resolve();
        const settled = await withdrawShareProposal({
          relay: scope.relay,
          shareId: scope.shareId,
          proposalId: input.proposalId,
        });
        operation.assert(scope);
        if (settled.state !== "withdrawn") {
          // The granter settled it first. Saying "withdrawn" here would tell the
          // recipient their changes are back when the granter already has them.
          throw new Error(
            "Those changes were already answered. Refresh to see the result.",
          );
        }
        return WithdrawShareChangesResult.parse({ state: settled.state });
      },
    );
  });

}

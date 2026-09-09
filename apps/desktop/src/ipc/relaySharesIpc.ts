import {
  CreateRelaySharePayload,
  CreateRelayShareResult,
  GetRelayReceivedSharePayload,
  GetRelayReceivedShareResult,
  ListRelaySharesResult,
  RelayShareReceivedRow,
  RevokeRelaySharePayload,
  AddRelayShareLinkPayload,
  AddRelayShareLinkResult,
  AppendRelayShareDiscussionPayload,
  AppendRelayShareDiscussionResult,
  BlockRelayShareDiscussionPrincipalPayload,
  BlockRelayShareDiscussionPrincipalResult,
  CancelRelayShareDiscussionActivityPayload,
  CreateRelayShareLinkPayload,
  CreateRelayShareLinkResult,
  DeleteRelayShareDiscussionMessagePayload,
  DeleteRelayShareDiscussionMessageResult,
  ListRelayShareDiscussionPayload,
  ListRelayShareDiscussionResult,
  ListRelayShareLinksPayload,
  ListRelayShareLinksResult,
  PauseRelayShareDiscussionPayload,
  PauseRelayShareDiscussionResult,
  PollRelayShareDiscussionActivityPayload,
  PollRelayShareDiscussionActivityResult,
  PromoteRelayShareGrantPayload,
  PromoteRelayShareGrantResult,
  RelayShareDiscussionAppendResponse,
  RelayShareDiscussionActivityResponse,
  RelayShareDiscussionBlockResponse,
  RelayShareDiscussionDeleteResponse,
  RelayShareDiscussionPageResponse,
  RelayShareDiscussionPauseResponse,
  RelayShareGrantPromotionResponse,
  RelayShareGrantRevokeResponse,
  RelayShareLinkCreateResponse,
  RelayShareLinkDependentConflict,
  RelayShareLinkEndResponse,
  RelayShareLinkListResponse,
  RelayShareLinkRotateResponse,
  RelayShareLinkRetuneNarrowResponse,
  RelayShareLinkRetuneWidenResponse,
  RetuneRelayShareLinkPayload,
  RetuneRelayShareLinkResult,
  ResumeRelayShareDiscussionPayload,
  ResumeRelayShareDiscussionResult,
  RotateRelayShareLinkPayload,
  RotateRelayShareLinkResult,
  RevokeRelayShareGrantPayload,
  RevokeRelayShareGrantResult,
  RevokeRelayShareLinkPayload,
  RevokeRelayShareLinkResult,
  UnblockRelayShareDiscussionPrincipalPayload,
  UnblockRelayShareDiscussionPrincipalResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import {OwnerRestoreRequest, OwnerRestoreActionResponse} from "./ownerRestoreContract";
import { createOwnerRelayShareHandler } from "./ownerRelayShareHandler";
import { awaitCredentialGeneration, RelaySessionError } from "../mainChatIpcHandlers";
import { requireCredentials } from "../workspaces/credentialScopedOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { pathShareLanes } from "../workspaces/relayShareLanes";
import { buildShareCode } from "../workspaces/syncCode";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type { createPresencePollRegistry } from "../collab/presencePollRegistry";

const RELAY_SHARE_DISCUSSION_ACTIVITY_POLL_SAFETY_MS = 35_000;

interface RelayShareRequest {
  <Result>(credentials: CloudCredentials, path: string, init: RequestInit | undefined, options: {retainRestoreConflict: true}): Promise<Result>;
  <Result>(
    credentials: CloudCredentials,
    path: string,
    init?: RequestInit,
  ): Promise<Result>;
  <Result>(
    credentials: CloudCredentials,
    path: string,
    init: RequestInit | undefined,
    options: { retainDependentSetConflict: true },
  ): Promise<
    | { kind: "success"; body: Result }
    | { kind: "dependents-changed"; body: unknown; status: number }
  >;
  <Result>(
    credentials: CloudCredentials,
    path: string,
    init: RequestInit | undefined,
    options: { retainNotFound: true },
  ): Promise<{ kind: "success"; body: Result } | { kind: "missing" }>;
}

export function registerRelaySharesIpcHandlers<
  Sender extends { id: number },
  Event extends { sender: Sender },
  Workspace extends { workspaceId: string; shareView?: unknown },
  Operation extends { workspace: Workspace; assertCurrent(): void },
>(dependencies: {
  registerHandler(
    channel: string,
    handler: (event: Event, payload: unknown) => unknown,
  ): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  remoteForWorkspace(workspace: Workspace): Promise<{
    credentials: CloudCredentials;
    credentialGeneration: number;
  }>;
  currentCredentialGeneration(): number;
  currentCredentials(): CloudCredentials | null;
  warmCredentialCache(): Promise<void>;
  relayShareJson<Result>(path: string, init?: RequestInit): Promise<Result>;
  relayShareJsonWithCredentials: RelayShareRequest;
  relayShareErrorCopy(
    status: number,
    data: { error?: string; code?: string } | null,
  ): string;
  relayShareDiscussionActivityPolls: Pick<
    ReturnType<typeof createPresencePollRegistry>,
    "begin" | "cancel"
  >;
}): void {
  const {
    registerHandler,
    assertTrustedSender,
    withRendererWorkspaceOperation,
    remoteForWorkspace,
    currentCredentialGeneration,
    currentCredentials,
    warmCredentialCache,
    relayShareJson,
    relayShareJsonWithCredentials,
    relayShareErrorCopy,
    relayShareDiscussionActivityPolls,
  } = dependencies;
  const ownerRelayShareHandler = createOwnerRelayShareHandler<
    Sender,
    Workspace,
    Operation,
    CloudCredentials
  >({
    withWorkspaceOperation: withRendererWorkspaceOperation,
    remoteForWorkspace,
    credentialGeneration: currentCredentialGeneration,
  });
  const assertOriginalWorkspace = (workspace: Workspace): void => {
    if (shareViewIsPresent(workspace.shareView)) {
      throw new Error(
        "This is a shared view — only the original workspace can be shared.",
      );
    }
  };

  registerHandler(CHANNELS.ownerRestore, async (event, payload) => {
    assertTrustedSender(event);
    const input = OwnerRestoreRequest.parse(payload);
    return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
      const prefix = `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/live-restores`;
      let path: string, body: unknown;
      if (input.action === "options") {
        path = `${prefix}/options`; body = {path: input.path, ...(input.beforeCursor === undefined ? {} : {beforeCursor: input.beforeCursor}),
          ...(input.grantCursor === undefined ? {} : {grantCursor: input.grantCursor})};
      } else if (input.action === "plan") {
        if (input.document.workspaceId !== input.workspaceId) throw new Error("The restore belongs to another workspace.");
        path = `${prefix}/plan`; body = {document: input.document, shareId: input.shareId, grantId: input.grantId,
          restorePointCursor: input.restorePointCursor, restorePointReceiptDigest: input.restorePointReceiptDigest};
      } else if (input.action === "begin") {
        if (input.intent.document.workspaceId !== input.workspaceId) throw new Error("The restore belongs to another workspace.");
        path = prefix; body = {intent: input.intent};
      } else {
        path = `${prefix}/${encodeURIComponent(input.operationId)}${input.action === "status" ? "" : `/${input.action}`}`;
        body = input.action === "status" ? undefined : input.action === "confirm" ? {proposalDigest: input.proposalDigest} : {};
      }
      const raw = await session.run(() => relayShareJsonWithCredentials<unknown>(credentials, path,
        body === undefined ? undefined : {method: "POST", body: JSON.stringify(body)}, {retainRestoreConflict: true}));
      const result = OwnerRestoreActionResponse[input.action].parse(raw);
      const coordinate = "status" in result ? result.status : "intent" in result ? result.intent : result;
      if ("document" in coordinate && coordinate.document.workspaceId !== input.workspaceId) throw new Error("The restore response belongs to another workspace.");
      if ("operationId" in input && "operationId" in coordinate && coordinate.operationId !== input.operationId) throw new Error("The restore response belongs to another operation.");
      const documentKey = (value: {workspaceId: string; mainVersionId: string; objectId: string; lineageClaimId: string}) =>
        JSON.stringify([value.workspaceId, value.mainVersionId, value.objectId, value.lineageClaimId]);
      if (input.action === "options" && "path" in result && result.path !== input.path) throw new Error("The restore response belongs to another file.");
      if (input.action === "plan" && "intent" in result && (
        documentKey(result.intent.document) !== documentKey(input.document) || result.intent.shareId !== input.shareId || result.intent.grantId !== input.grantId ||
        result.intent.restorePointCursor !== input.restorePointCursor || result.intent.restorePointReceiptDigest !== input.restorePointReceiptDigest)) {
        throw new Error("The selected restore point or access changed. Review it again.");
      }
      if (input.action === "begin" && "intent" in result && JSON.stringify(result.intent) !== JSON.stringify(input.intent)) {
        throw new Error("The restore response belongs to another operation.");
      }
      if ("status" in result && result.status.operationId !== result.status.intent.operationId) throw new Error("The restore status changed. Review it again.");
      if (input.action === "review" && "result" in result && result.result && "binding" in result.result &&
        (result.result.operationId !== input.operationId || result.result.workspaceId !== input.workspaceId ||
          documentKey(result.result.binding) !== documentKey(result.status.document))) throw new Error("The restore review belongs to another file.");
      return result;
    }, assertOriginalWorkspace);
  });

  // ---- Relay shares ----

  // Grant side: create a share on the SYNC RELAY for a synced workspace.
  // Selector validation (secret refusal, traversal, caps) is server-side —
  // the relay is the security boundary; this handler only adds product copy.
  registerHandler(CHANNELS.createRelayShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateRelaySharePayload.parse(payload);
    if (!input.paths?.length && !input.versionId) {
      throw new Error("Pick a file, folder, or version to share.");
    }
    // No transitive sharing: mounted shares are someone else's files. The
    // relay's selector validation refuses reserved paths anyway (the
    // authoritative gate); this adds the honest product copy.
    if (input.paths?.some((path) => isSharedWithMePath(path))) {
      throw new Error(
        "This came to you through a share — copy it into your own files to share it onward.",
      );
    }
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const workspace = operation.workspace;
        const created = await session.run(() =>
          relayShareJsonWithCredentials<{ shareId: string }>(
            credentials,
            `/sync/${encodeURIComponent(workspace.workspaceId)}/shares`,
            {
              method: "POST",
              body: JSON.stringify({
                recipientEmail: input.recipientEmail,
                access: input.access,
                ...(input.paths ? { paths: input.paths } : {}),
                ...(input.versionId ? { versionId: input.versionId } : {}),
              }),
            },
          ),
        );
        const shareCode = buildShareCode({
          shareId: created.shareId,
          relayUrl: credentials.relayUrl!,
        });
        return CreateRelayShareResult.parse({
          shareId: created.shareId,
          shareCode,
          recipientEmail: input.recipientEmail,
        });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.listRelayShares, async (event) => {
    assertTrustedSender(event);
    const result = await relayShareJson<{
      granted: Array<Record<string, unknown>>;
      received?: Array<Record<string, unknown>>;
    }>("/sync/shares");
    const relayUrl = currentCredentials()?.relayUrl;
    const withCode = (row: Record<string, unknown>) => ({
      ...row,
      shareCode: buildShareCode({
        shareId: String(row.shareId),
        relayUrl: relayUrl!,
      }),
    });
    // The two managers split this listing; see relayShareLanes for why a
    // damaged row stays in the granted lane.
    const lanes = pathShareLanes(result);
    const granted = lanes.granted.map(withCode);
    const received = lanes.received.map(withCode);
    return ListRelaySharesResult.parse({ granted, received });
  });

  registerHandler(CHANNELS.getRelayReceivedShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetRelayReceivedSharePayload.parse(payload);
    await warmCredentialCache();
    const credentials = requireCredentials(currentCredentials(), RelaySessionError);
    const credentialGeneration = currentCredentialGeneration();
    const result = await awaitCredentialGeneration({
      capturedGeneration: credentialGeneration,
      currentGeneration: currentCredentialGeneration,
      run: () =>
        relayShareJsonWithCredentials<unknown>(
          credentials,
          `/sync/shares/${encodeURIComponent(input.shareId)}`,
          undefined,
          { retainNotFound: true },
        ),
    });
    if (result.kind === "missing") {
      return GetRelayReceivedShareResult.parse({ found: false });
    }
    const body = result.body;
    const received = RelayShareReceivedRow.parse({
      ...(body !== null && typeof body === "object" && !Array.isArray(body)
        ? body
        : {}),
      shareCode: buildShareCode({
        shareId: input.shareId,
        relayUrl: credentials.relayUrl!,
      }),
    });
    if (received.shareId !== input.shareId) {
      throw new Error("Invalid exact received share response.");
    }
    return GetRelayReceivedShareResult.parse({ found: true, share: received });
  });

  registerHandler(CHANNELS.revokeRelayShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeRelaySharePayload.parse(payload);
    await relayShareJson(
      `/sync/shares/${encodeURIComponent(input.shareId)}/revoke`,
      {
        method: "POST",
      },
    );
    return undefined;
  });

  registerHandler(CHANNELS.createRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateRelayShareLinkPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/links`,
            {
              method: "POST",
              body: JSON.stringify(
                "paths" in input
                  ? { paths: input.paths, access: input.access }
                  : { versionId: input.versionId, access: input.access },
              ),
            },
          ),
        );
        const parsed = RelayShareLinkCreateResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return CreateRelayShareLinkResult.parse(parsed.data);
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.addRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = AddRelayShareLinkPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/${encodeURIComponent(input.shareId)}/links`,
            {
              method: "POST",
              body: JSON.stringify({ access: input.access }),
            },
          ),
        );
        const parsed = RelayShareLinkCreateResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return AddRelayShareLinkResult.parse(parsed.data);
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.listRelayShareLinks, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListRelayShareLinksPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() => {
          const path = `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/links`;
          const query = new URLSearchParams();
          if (input.cursor) query.set("cursor", input.cursor);
          if (input.independentGrantCursor) {
            query.set("independentGrantCursor", input.independentGrantCursor);
          }
          return relayShareJsonWithCredentials<unknown>(
            credentials,
            `${path}${query.size > 0 ? `?${query.toString()}` : ""}`,
          );
        });
        const parsed = RelayShareLinkListResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return ListRelayShareLinksResult.parse(parsed.data);
      },
    );
  });

  registerHandler(CHANNELS.retuneRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = RetuneRelayShareLinkPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/links/${encodeURIComponent(input.grantId)}/retune`,
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: operation.workspace.workspaceId,
                access: input.access,
                expectedDependentGrantIds: input.expectedDependentGrantIds,
              }),
            },
            { retainDependentSetConflict: true },
          ),
        );
        if (relayResult.kind === "dependents-changed") {
          const conflict = RelayShareLinkDependentConflict.safeParse(
            relayResult.body,
          );
          if (!conflict.success) {
            throw new Error(relayShareErrorCopy(relayResult.status, null));
          }
          return RetuneRelayShareLinkResult.parse({
            outcome: "dependents-changed",
            dependents: conflict.data.dependents,
          });
        }
        if (input.access === "comment") {
          const widened = RelayShareLinkRetuneWidenResponse.safeParse(
            relayResult.body,
          );
          if (!widened.success) {
            throw new Error(relayShareErrorCopy(500, null));
          }
          return RetuneRelayShareLinkResult.parse({
            outcome: "widened",
            url: widened.data.url,
          });
        }
        const narrowed = RelayShareLinkRetuneNarrowResponse.safeParse(
          relayResult.body,
        );
        if (!narrowed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return RetuneRelayShareLinkResult.parse({ outcome: "narrowed" });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.rotateRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = RotateRelayShareLinkPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/links/${encodeURIComponent(input.grantId)}/rotate`,
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: operation.workspace.workspaceId,
                expectedDependentGrantIds: input.expectedDependentGrantIds,
              }),
            },
            { retainDependentSetConflict: true },
          ),
        );
        if (relayResult.kind === "dependents-changed") {
          const conflict = RelayShareLinkDependentConflict.safeParse(
            relayResult.body,
          );
          if (!conflict.success) {
            throw new Error(relayShareErrorCopy(relayResult.status, null));
          }
          return RotateRelayShareLinkResult.parse({
            outcome: "dependents-changed",
            dependents: conflict.data.dependents,
          });
        }
        const rotated = RelayShareLinkRotateResponse.safeParse(relayResult.body);
        if (!rotated.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return RotateRelayShareLinkResult.parse({
          outcome: "rotated",
          url: rotated.data.url,
        });
      },
    );
  });

  registerHandler(CHANNELS.revokeRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeRelayShareLinkPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/revoke`,
            {
              method: "POST",
              body: JSON.stringify({
                grantId: input.grantId,
                workspaceId: operation.workspace.workspaceId,
                expectedDependentGrantIds: input.expectedDependentGrantIds,
              }),
            },
            { retainDependentSetConflict: true },
          ),
        );
        if (relayResult.kind === "dependents-changed") {
          const conflict = RelayShareLinkDependentConflict.safeParse(
            relayResult.body,
          );
          if (!conflict.success) {
            throw new Error(relayShareErrorCopy(relayResult.status, null));
          }
          return RevokeRelayShareLinkResult.parse({
            outcome: "dependents-changed",
            dependents: conflict.data.dependents,
          });
        }
        const ended = RelayShareLinkEndResponse.safeParse(relayResult.body);
        if (!ended.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return RevokeRelayShareLinkResult.parse({ outcome: "ended" });
      },
    );
  });

  registerHandler(CHANNELS.listRelayShareDiscussion, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListRelayShareDiscussionPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() => {
          const path = `/sync/shares/${encodeURIComponent(input.shareId)}/discussion`;
          return relayShareJsonWithCredentials<unknown>(
            credentials,
            `${path}?workspaceId=${encodeURIComponent(operation.workspace.workspaceId)}&direction=${input.direction}${input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ""}`,
          );
        });
        const parsed = RelayShareDiscussionPageResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return ListRelayShareDiscussionResult.parse({
          activityRevision: parsed.data.activityRevision,
          linkCommentsPaused: parsed.data.linkCommentsPaused,
          messages: parsed.data.messages,
          nextCursor: parsed.data.nextCursor,
        });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(
    CHANNELS.pollRelayShareDiscussionActivity,
    async (event, payload) => {
      assertTrustedSender(event);
      const input = PollRelayShareDiscussionActivityPayload.parse(payload);
      const poll = relayShareDiscussionActivityPolls.begin(
        event.sender.id,
        input.pollId,
        JSON.stringify([input.workspaceId, input.shareId]),
      );
      const safety = setTimeout(
        () => poll.abort(),
        RELAY_SHARE_DISCUSSION_ACTIVITY_POLL_SAFETY_MS,
      );
      try {
        return await withRendererWorkspaceOperation(
          event.sender,
          input.workspaceId,
          "Sharing stopped because this window changed workspaces.",
          async (operation) => {
            operation.assertCurrent();
            if (shareViewIsPresent(operation.workspace.shareView)) {
              throw new Error(
                "This is a shared view — only the original workspace can be shared.",
              );
            }
            const { credentials, credentialGeneration } =
              await remoteForWorkspace(operation.workspace);
            operation.assertCurrent();
            if (poll.signal.aborted) throw new Error("aborted");
            const relayResult = await awaitCredentialGeneration({
              capturedGeneration: credentialGeneration,
              currentGeneration: currentCredentialGeneration,
              run: () => {
                operation.assertCurrent();
                const path = `/sync/shares/${encodeURIComponent(input.shareId)}/discussion/activity`;
                return relayShareJsonWithCredentials<unknown>(
                  credentials,
                  `${path}?workspaceId=${encodeURIComponent(operation.workspace.workspaceId)}&since=${input.since}&hold=${input.hold}&limit=${input.limit}`,
                  { signal: poll.signal },
                );
              },
            });
            operation.assertCurrent();
            if (poll.signal.aborted) throw new Error("aborted");
            const parsed =
              RelayShareDiscussionActivityResponse.safeParse(relayResult);
            if (!parsed.success) {
              throw new Error(relayShareErrorCopy(500, null));
            }
            operation.assertCurrent();
            if (currentCredentialGeneration() !== credentialGeneration) {
              throw new Error("Your dohc Cloud session changed. Try again.");
            }
            if (poll.signal.aborted) throw new Error("aborted");
            return PollRelayShareDiscussionActivityResult.parse({
              latestRevision: parsed.data.latestRevision,
              cursorRevision: parsed.data.cursorRevision,
              hasMore: parsed.data.hasMore,
              messages: parsed.data.messages,
              principals: parsed.data.principals,
              linkCommentsPaused: parsed.data.linkCommentsPaused,
            });
          },
        );
      } finally {
        clearTimeout(safety);
        poll.release();
      }
    },
  );

  registerHandler(
    CHANNELS.cancelRelayShareDiscussionActivity,
    (event, payload) => {
      assertTrustedSender(event);
      const input = CancelRelayShareDiscussionActivityPayload.parse(payload);
      relayShareDiscussionActivityPolls.cancel(event.sender.id, input.pollId);
      return undefined;
    },
  );

  registerHandler(CHANNELS.appendRelayShareDiscussion, async (event, payload) => {
    assertTrustedSender(event);
    const input = AppendRelayShareDiscussionPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/discussion`,
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: operation.workspace.workspaceId,
                body: input.body,
                idempotencyKey: input.idempotencyKey,
              }),
            },
          ),
        );
        const parsed = RelayShareDiscussionAppendResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return AppendRelayShareDiscussionResult.parse({
          message: parsed.data.message,
        });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(
    CHANNELS.deleteRelayShareDiscussionMessage,
    async (event, payload) => {
      assertTrustedSender(event);
      const input = DeleteRelayShareDiscussionMessagePayload.parse(payload);
      return ownerRelayShareHandler(
        event.sender,
        input.workspaceId,
        async (operation, credentials, session) => {
          const relayResult = await session.run(() =>
            relayShareJsonWithCredentials<unknown>(
              credentials,
              `/sync/shares/${encodeURIComponent(input.shareId)}/discussion/moderation`,
              {
                method: "POST",
                body: JSON.stringify({
                  workspaceId: operation.workspace.workspaceId,
                  action: "delete",
                  messageId: input.messageId,
                }),
              },
            ),
          );
          const parsed =
            RelayShareDiscussionDeleteResponse.safeParse(relayResult);
          if (!parsed.success) {
            throw new Error(relayShareErrorCopy(500, null));
          }
          return DeleteRelayShareDiscussionMessageResult.parse({
            message: parsed.data.message,
          });
        },
        assertOriginalWorkspace,
      );
    },
  );

  registerHandler(
    CHANNELS.blockRelayShareDiscussionPrincipal,
    async (event, payload) => {
      assertTrustedSender(event);
      const input = BlockRelayShareDiscussionPrincipalPayload.parse(payload);
      return ownerRelayShareHandler(
        event.sender,
        input.workspaceId,
        async (operation, credentials, session) => {
          const relayResult = await session.run(() =>
            relayShareJsonWithCredentials<unknown>(
              credentials,
              `/sync/shares/${encodeURIComponent(input.shareId)}/discussion/moderation`,
              {
                method: "POST",
                body: JSON.stringify({
                  workspaceId: operation.workspace.workspaceId,
                  action: "block",
                  principalId: input.principalId,
                }),
              },
            ),
          );
          const parsed = RelayShareDiscussionBlockResponse.safeParse(relayResult);
          if (!parsed.success || !parsed.data.blocked) {
            throw new Error(relayShareErrorCopy(500, null));
          }
          return BlockRelayShareDiscussionPrincipalResult.parse({
            blocked: true,
          });
        },
        assertOriginalWorkspace,
      );
    },
  );

  registerHandler(
    CHANNELS.unblockRelayShareDiscussionPrincipal,
    async (event, payload) => {
      assertTrustedSender(event);
      const input = UnblockRelayShareDiscussionPrincipalPayload.parse(payload);
      return ownerRelayShareHandler(
        event.sender,
        input.workspaceId,
        async (operation, credentials, session) => {
          const relayResult = await session.run(() =>
            relayShareJsonWithCredentials<unknown>(
              credentials,
              `/sync/shares/${encodeURIComponent(input.shareId)}/discussion/moderation`,
              {
                method: "POST",
                body: JSON.stringify({
                  workspaceId: operation.workspace.workspaceId,
                  action: "unblock",
                  principalId: input.principalId,
                }),
              },
            ),
          );
          const parsed = RelayShareDiscussionBlockResponse.safeParse(relayResult);
          if (!parsed.success || parsed.data.blocked) {
            throw new Error(relayShareErrorCopy(500, null));
          }
          return UnblockRelayShareDiscussionPrincipalResult.parse({
            blocked: false,
          });
        },
        assertOriginalWorkspace,
      );
    },
  );

  registerHandler(CHANNELS.pauseRelayShareDiscussion, async (event, payload) => {
    assertTrustedSender(event);
    const input = PauseRelayShareDiscussionPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/discussion/moderation`,
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: operation.workspace.workspaceId,
                action: "pause",
              }),
            },
          ),
        );
        const parsed = RelayShareDiscussionPauseResponse.safeParse(relayResult);
        if (!parsed.success || !parsed.data.linkCommentsPaused) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return PauseRelayShareDiscussionResult.parse({
          linkCommentsPaused: true,
        });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.resumeRelayShareDiscussion, async (event, payload) => {
    assertTrustedSender(event);
    const input = ResumeRelayShareDiscussionPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/discussion/moderation`,
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: operation.workspace.workspaceId,
                action: "resume",
              }),
            },
          ),
        );
        const parsed = RelayShareDiscussionPauseResponse.safeParse(relayResult);
        if (!parsed.success || parsed.data.linkCommentsPaused) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return ResumeRelayShareDiscussionResult.parse({
          linkCommentsPaused: false,
        });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.promoteRelayShareGrant, async (event, payload) => {
    assertTrustedSender(event);
    const input = PromoteRelayShareGrantPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/grants/${encodeURIComponent(input.grantId)}/promote`,
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: operation.workspace.workspaceId,
                expectedParentGrantId: input.expectedParentGrantId,
                expectedParentGeneration: input.expectedParentGeneration,
              }),
            },
          ),
        );
        const parsed = RelayShareGrantPromotionResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return PromoteRelayShareGrantResult.parse({
          grantId: parsed.data.grantId,
          access: parsed.data.access,
          generation: parsed.data.generation,
          status: parsed.data.status,
          revokedAtMs: parsed.data.revokedAtMs,
          parentGrantId: parsed.data.parentGrantId,
        });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.revokeRelayShareGrant, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeRelayShareGrantPayload.parse(payload);
    return ownerRelayShareHandler(
      event.sender,
      input.workspaceId,
      async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          relayShareJsonWithCredentials<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(input.shareId)}/grants/${encodeURIComponent(input.grantId)}/revoke`,
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: operation.workspace.workspaceId,
              }),
            },
          ),
        );
        const parsed = RelayShareGrantRevokeResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return RevokeRelayShareGrantResult.parse({
          grantId: parsed.data.grantId,
          access: parsed.data.access,
          generation: parsed.data.generation,
          status: parsed.data.status,
          revokedAtMs: parsed.data.revokedAtMs,
          parentGrantId: parsed.data.parentGrantId,
        });
      },
      assertOriginalWorkspace,
    );
  });

}

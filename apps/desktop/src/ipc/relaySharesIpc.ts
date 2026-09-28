import {
  ListOwnerLiveDocumentsPayload,
  ListOwnerLiveRefusalsPayload,
  OwnerLiveRefusalsResult,
  RetryOwnerLiveSharePayload,
  OwnerLiveDocument,
  OwnerLiveDocumentsResult,
  OwnerLiveDocumentActionPayload,
  CreateRelaySharePayload,
  CreateRelayShareResult,
  GetRelayReceivedSharePayload,
  GetRelayReceivedShareResult,
  ListRelaySharesResult,
  RelayShareReceivedRow,
  RevokeRelaySharePayload,
  RevokeRelayShareResult,
  RelayShareRevokeResponse,
  RelayShareUndoResponse,
  UndoRelaySharePayload,
  UndoRelayShareResult,
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
import { z } from "zod";
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
const liveDocumentStatus = OwnerLiveDocument.omit({canResume: true}).strip();
const activeLiveDocuments = z.object({ok: z.literal(true), documents: z.array(liveDocumentStatus.extend({
  status: z.enum(["ready", "preparing", "paused", "unavailable"]),
})).max(64)});
const retiredLiveDocuments = z.object({ok: z.literal(true), documents: z.array(liveDocumentStatus.extend({
  status: z.literal("retired"),
})).max(64), nextCursor: OwnerLiveDocumentsResult.shape.nextCursor});

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
  ): Promise<{ kind: "success"; body: Result } | { kind: "missing"; removed: boolean }>;
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
  // A grant changed on the relay. Null when the change names no workspace.
  sharesChanged(workspaceId: string | null): void;
  // An authenticated account listing, applied to this machine's received
  // shares so a share the owner restored resumes.
  reconcileReceivedShares(listing: unknown): void;
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
    sharesChanged,
    reconcileReceivedShares,
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
  // A relay call that can change who holds a grant on the workspace. The
  // share roster refreshes as soon as the relay answers, before any check
  // that this window is still current, because the change happened anyway.
  const changingGrants = <Result>(workspaceId: string, call: () => Promise<Result>) =>
    async (): Promise<Result> => {
      const result = await call();
      sharesChanged(workspaceId);
      return result;
    };
  const assertOriginalWorkspace = (workspace: Workspace): void => {
    if (shareViewIsPresent(workspace.shareView)) {
      throw new Error(
        "This is a shared view — only the original workspace can be shared.",
      );
    }
  };

  registerHandler(CHANNELS.listOwnerLiveDocuments, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListOwnerLiveDocumentsPayload.parse(payload);
    return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
      const path = `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/live-host`;
      const after = input.retiredAfter === undefined ? "" : `&after=${encodeURIComponent(input.retiredAfter)}`;
      const [active, retired] = await session.run(() => Promise.all([
        relayShareJsonWithCredentials<unknown>(credentials, path),
        relayShareJsonWithCredentials<unknown>(credentials, `${path}?retired=1${after}`),
      ]));
      const current = activeLiveDocuments.parse(active);
      const stopped = retiredLiveDocuments.parse(retired);
      if (stopped.nextCursor !== null && (stopped.nextCursor !== stopped.documents.at(-1)?.path ||
        stopped.nextCursor === input.retiredAfter)) {
        throw new Error("The live document list changed. Refresh the list and try again.");
      }
      // Concurrent list reads may see a document in both sets. The current
      // enrollment wins; all bindings and server-only credentials stay in main.
      const documents = new Map([...stopped.documents, ...current.documents].map(document => [document.path, {
        ...document, canResume: !document.reason && (document.status === "retired" || document.status === "paused"),
      }]));
      return OwnerLiveDocumentsResult.parse({documents: [...documents.values()], nextCursor: stopped.nextCursor});
    }, assertOriginalWorkspace);
  });

  registerHandler(CHANNELS.listOwnerLiveRefusals, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListOwnerLiveRefusalsPayload.parse(payload);
    return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
      const after = input.after === undefined ? "" : `&after=${encodeURIComponent(input.after)}`;
      const result = await session.run(() => relayShareJsonWithCredentials<unknown>(credentials,
        `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/live-host?refusals=1${after}`));
      const response = OwnerLiveRefusalsResult.extend({ok: z.literal(true)}).parse(result);
      if (response.nextCursor !== null && response.nextCursor === input.after) {
        throw new Error("The live document list changed. Refresh the list and try again.");
      }
      return OwnerLiveRefusalsResult.parse({refusals: response.refusals, nextCursor: response.nextCursor});
    }, assertOriginalWorkspace);
  });

  registerHandler(CHANNELS.retryOwnerLiveShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = RetryOwnerLiveSharePayload.parse(payload);
    return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
      const result = await session.run(() => relayShareJsonWithCredentials<unknown>(credentials,
        `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/live-host`, {
          method: "POST", body: JSON.stringify({shareId: input.shareId, retry: true}),
        }));
      const response = activeLiveDocuments.parse(result);
      if (response.documents.some(document => document.status === "unavailable" || document.status === "paused")) {
        throw new Error("Some documents could not start live editing. Refresh the list and try again.");
      }
    }, assertOriginalWorkspace);
  });

  for (const [channel, stop] of [[CHANNELS.stopOwnerLiveDocument, true], [CHANNELS.resumeOwnerLiveDocument, false]] as const) {
    registerHandler(channel, async (event, payload) => {
      assertTrustedSender(event);
      const input = OwnerLiveDocumentActionPayload.parse(payload);
      return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
        const result = await session.run(() => relayShareJsonWithCredentials<unknown>(credentials,
          `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/live-host`, {
            method: stop ? "DELETE" : "POST",
            body: JSON.stringify(stop ? {path: input.path, retire: true} : {path: input.path}),
          }));
        const response = z.object({ok: z.literal(true), path: z.literal(input.path),
          status: stop ? z.literal("retired") : z.enum(["ready", "preparing", "unavailable"])}).parse(result);
        if (response.status === "unavailable") throw new Error("This document could not resume live editing. Refresh the list and try again.");
      }, assertOriginalWorkspace);
    });
  }

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
        const created = await session.run(changingGrants(workspace.workspaceId, () =>
          relayShareJsonWithCredentials<{ shareId: string; grantId: string; browserInvitationUrl?: string }>(
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
        ));
        const shareCode = buildShareCode({
          shareId: created.shareId,
          relayUrl: credentials.relayUrl!,
        });
        return CreateRelayShareResult.parse({
          shareId: created.shareId,
          grantId: created.grantId,
          browserInvitationUrl: created.browserInvitationUrl,
          shareCode,
          recipientEmail: input.recipientEmail,
        });
      },
      assertOriginalWorkspace,
    );
  });

  registerHandler(CHANNELS.listRelayShares, async (event) => {
    assertTrustedSender(event);
    await warmCredentialCache();
    const capturedGeneration = currentCredentialGeneration();
    const result = await awaitCredentialGeneration({
      capturedGeneration, currentGeneration: currentCredentialGeneration,
      run: () => relayShareJson<{
        granted: Array<Record<string, unknown>>;
        received?: Array<Record<string, unknown>>;
        removed?: unknown;
      }>("/sync/shares"),
    });
    reconcileReceivedShares(result);
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
    return ListRelaySharesResult.parse({ granted, received, removed: result.removed });
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
      if (!result.removed) return GetRelayReceivedShareResult.parse({ found: false });
      return GetRelayReceivedShareResult.parse({
        found: false, removed: { message: "The owner removed your access." },
      });
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
    const relayResult = await relayShareJson<unknown>(
      `/sync/shares/${encodeURIComponent(input.shareId)}/revoke`,
      {
        method: "POST",
      },
    );
    sharesChanged(null);
    const parsed = RelayShareRevokeResponse.safeParse(relayResult);
    if (!parsed.success) {
      throw new Error(relayShareErrorCopy(500, null));
    }
    return RevokeRelayShareResult.parse({ undo: parsed.data.undo });
  });

  // Restores what a removal ended, from the receipt the removal returned.
  // The same account transport as the removal, so the Undo on a notice works
  // after the dialog that removed it has closed and names no workspace.
  registerHandler(CHANNELS.undoRelayShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = UndoRelaySharePayload.parse(payload);
    const relayResult = await relayShareJson<unknown>(
      `/sync/shares/${encodeURIComponent(input.shareId)}/undo`,
      {
        method: "POST",
        body: JSON.stringify({ undoId: input.undoId }),
      },
    );
    sharesChanged(null);
    const parsed = RelayShareUndoResponse.safeParse(relayResult);
    if (!parsed.success || parsed.data.shareId !== input.shareId) {
      throw new Error(relayShareErrorCopy(500, null));
    }
    return UndoRelayShareResult.parse({ shareId: parsed.data.shareId });
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
        // A new level applies to the link's dependents too.
        const relayResult = await session.run(changingGrants(operation.workspace.workspaceId, () =>
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
        ));
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
        const widened = RelayShareLinkRetuneWidenResponse.safeParse(
          relayResult.body,
        );
        if (widened.success) {
          if (widened.data.access !== input.access) {
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
        if (!narrowed.success || narrowed.data.access !== input.access) {
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
        // Ending a link ends its dependents.
        const relayResult = await session.run(changingGrants(operation.workspace.workspaceId, () =>
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
        ));
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
        return RevokeRelayShareLinkResult.parse({ outcome: "ended", undo: ended.data.undo });
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
              throw new Error("Your server session changed. Try again.");
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
        const relayResult = await session.run(changingGrants(operation.workspace.workspaceId, () =>
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
        ));
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
        const relayResult = await session.run(changingGrants(operation.workspace.workspaceId, () =>
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
        ));
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
          undo: parsed.data.undo,
        });
      },
      assertOriginalWorkspace,
    );
  });

}

import type {AppBackendRoute} from "./appBackendRoutes";
import type {DatasetRoute} from "./datasetRoutes";
import type {DatasetReplicaRoute} from "./datasetReplicaRoutes";
import type {LinkAppPublicationRoute} from "./linkAppPublicationRoutes";
import type {LinkAppCollectionRoute} from "./appCollectionRoutes";
import type {OwnerAppPublicationRoute} from "./ownerAppPublicationRoutes";
import type {OwnerAppResponseRoute} from "./ownerAppResponseRoutes";
import type {OwnerRestoreRoute} from "./ownerRestoreRoutes";
import {MAX_HELD_OBJECT_ID_CHARS, type HeldDocumentRoute} from "./heldDocumentRoutes";
import type {LinkChatRoute} from "./linkChatRoutes";
import type {LinkReadRoute} from "./linkReadRoutes";
import type {NoticeRoute} from "./noticeRoutes";
import {isAutomationHostPath, parseAutomationHostAction, type AutomationHostRoute} from "./automationHostRoutes";
import {isAutomationServerPath, parseAutomationServerAction, type AutomationServerRoute} from "./automationServerRoutes";
import {parseAutomationPressAction, type AutomationPressRoute} from "./automationPressRoutes";
import type {WorkspaceBlobRoute} from "./workspaceBlobRoutes";
import type {WorkspaceReplicationRoute} from "./workspaceReplicationRoutes";
import type {WorkspaceShareCreationRoute, ShareGrantTransitionRoute} from "./shareGrantRoutes";
import type {ShareInventoryRoute} from "./shareInventoryRoutes";
import type {NamedShareTransportRoute} from "./namedShareTransportRoutes";
import type {ShareProposalRoute, WorkspaceProposalRoute} from "./proposalRoutes";
import type {CollectionWriteRoute, OwnerCollectionWriteRoute} from "./collectionWriteRoutes";
import {parseShareId, parseString, parseWorkspaceId, relayPathSegments} from "./requestInputs";
import {notFound} from "./errors";
import {MAX_ORIGIN_ID_CHARS} from "./wireLimits";
import {MAX_SHARE_PROPOSAL_OPS} from "@dohc/security-contract/share-proposal-bound";

type SyncRelayRoute =
  | AppBackendRoute
  | DatasetRoute
  | { route: "named-dataset"; shareId: string; datasetId?: string; action: "list" | "describe" | "invoke" | "upload" | "file" | "press" }
  | DatasetReplicaRoute
  | LinkAppPublicationRoute
  | LinkAppCollectionRoute
  | OwnerAppPublicationRoute
  | OwnerAppResponseRoute
  | OwnerRestoreRoute
  | HeldDocumentRoute
  | { route: "link-exchange" }
  | { route: "link-refresh" }
  | { route: "link-handoff" }
  | { route: "link-redeem" }
  | LinkReadRoute
  | { route: "link-discussion" }
  | { route: "link-discussion-activity" }
  | LinkChatRoute
  | { route: "link-collection-writes" }
  | { route: "workspaces" }
  | NoticeRoute
  | AutomationHostRoute
  | AutomationServerRoute
  | AutomationPressRoute
  | WorkspaceBlobRoute
  | WorkspaceReplicationRoute
  | { route: "keys"; workspaceId: string }
  | WorkspaceShareCreationRoute
  | ShareInventoryRoute
  | ShareGrantTransitionRoute
  | NamedShareTransportRoute
  | { route: "share-discussion"; shareId: string }
  | { route: "share-discussion-activity"; shareId: string }
  | { route: "share-discussion-moderation"; shareId: string }
  | ShareProposalRoute
  | CollectionWriteRoute
  | OwnerCollectionWriteRoute
  | WorkspaceProposalRoute
  | { route: "presence"; workspaceId: string }
  | { route: "share-presence"; shareId: string };

export function parseRoute(request: Pick<Request, "url">): SyncRelayRoute {
  const parts = relayPathSegments(new URL(request.url).pathname);
  if (parts[0] === "sync" && parts[1] === "link" && parts[2] === "app-publications") {
    if (parts.length === 3) return {route: "link-app-publication"};
    const publicationId = parts[3];
    if (!publicationId || !/^[0-9a-f]{64}$/.test(publicationId)) throw notFound();
    if (parts.length === 4) return {route: "link-app-publication", publicationId};
    if (parts.length === 5 && parts[4] === "collection") return {route: "link-app-collection", publicationId};
    if (parts.length === 6 && parts[4] === "backend" && (parts[5] === "invoke" || parts[5] === "upload" || parts[5] === "file" || parts[5] === "attempt")) {
      return {route:"app-backend", publicationId, action:parts[5]};
    }
    if (parts.length === 6 && parts[4] === "blobs" && /^[0-9a-f]{64}$/.test(parts[5]!)) {
      return {route: "link-app-publication", publicationId, sha256: parts[5]};
    }
    throw notFound();
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-exchange") {
    return { route: "link-exchange" };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-refresh") {
    return { route: "link-refresh" };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-handoff") {
    return { route: "link-handoff" };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-redeem") {
    return { route: "link-redeem" };
  }
  if (parts.length === 3 && parts[0] === "sync" && parts[1] === "link") {
    if (parts[2] === "share") return { route: "link-share" };
    if (parts[2] === "current") return { route: "link-current" };
    if (parts[2] === "log") return { route: "link-log" };
    if (parts[2] === "discussion") return { route: "link-discussion" };
    if (parts[2] === "collection-writes") return { route: "link-collection-writes" };
  }
  if (
    parts.length === 4 &&
    parts[0] === "sync" &&
    parts[1] === "link" &&
    parts[2] === "discussion" &&
    parts[3] === "activity"
  ) {
    return { route: "link-discussion-activity" };
  }
  if (parts.length === 4 && parts[0] === "sync" && parts[1] === "link" && parts[2] === "chat") {
    if (parts[3] === "channels") return { route: "link-chat-channels" };
    if (parts[3] === "messages") return { route: "link-chat-messages" };
  }
  if (
    parts.length === 4 &&
    parts[0] === "sync" &&
    parts[1] === "link" &&
    parts[2] === "blobs"
  ) {
    return { route: "link-blob", sha256: parts[3]! };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "workspaces") {
    return { route: "workspaces" };
  }
  if (parts[0] !== "sync" || !parts[1]) throw notFound();
  // "notices" is reserved as a workspace id (parseWorkspaceId), like "shares".
  if (parts[1] === "notices") {
    if (parts.length === 2) return { route: "notices" };
    if (parts.length === 3 && parts[2] === "marks") return { route: "notice-marks" };
    throw notFound();
  }
  // "/sync/shares/..." is the share-scoped namespace; "shares" is reserved as
  // a workspace id (parseWorkspaceId) so the two can never collide.
  if (parts[1] === "shares") {
    if (parts.length === 2) return { route: "shares-list" };
    const shareId = parseShareId(parts[2]);
    if (parts[3] === "datasets") {
      if (parts.length === 4) return { route: "named-dataset", shareId, action: "list" };
      const datasetId = parts[4];
      if (!datasetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(datasetId)) throw notFound();
      if (parts.length === 5) return { route: "named-dataset", shareId, datasetId, action: "describe" };
      if (parts.length === 6 && ["invoke", "upload", "file", "press"].includes(parts[5]!)) return { route: "named-dataset", shareId, datasetId, action: parts[5] as "invoke" | "upload" | "file" | "press" };
      throw notFound();
    }
    if (parts.length === 3) return { route: "share", shareId };
    if (parts.length === 4 && parts[3] === "access") return { route: "share-access", shareId };
    if (parts.length === 4 && parts[3] === "undo") return { route: "share-undo", shareId };
    if (parts.length === 4 && parts[3] === "revoke") return { route: "share-revoke", shareId };
    if (parts.length === 6 && parts[3] === "links" && parts[5] === "rotate") {
      return {
        route: "share-link-rotate",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 6 && parts[3] === "links" && parts[5] === "retune") {
      return {
        route: "share-link-retune",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 6 && parts[3] === "grants" && parts[5] === "promote") {
      return {
        route: "share-grant-promote",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 6 && parts[3] === "grants" && parts[5] === "revoke") {
      return {
        route: "share-grant-revoke",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 4 && parts[3] === "log") return { route: "share-log", shareId };
    if (parts.length === 4 && parts[3] === "discussion") {
      return { route: "share-discussion", shareId };
    }
    if (
      parts.length === 5 &&
      parts[3] === "discussion" &&
      parts[4] === "activity"
    ) {
      return { route: "share-discussion-activity", shareId };
    }
    if (
      parts.length === 5 &&
      parts[3] === "discussion" &&
      parts[4] === "moderation"
    ) {
      return { route: "share-discussion-moderation", shareId };
    }
    if (parts.length === 4 && parts[3] === "presence") return { route: "share-presence", shareId };
    if (parts.length === 5 && parts[3] === "blobs" && parts[4]) {
      return { route: "share-blob", shareId, sha256: parts[4] };
    }
    if (parts.length === 4 && parts[3] === "proposals") {
      return { route: "share-proposals", shareId };
    }
    if (parts.length === 4 && parts[3] === "collection-writes") {
      return { route: "share-collection-writes", shareId };
    }
    if (parts.length === 4 && parts[3] === "automation-presses") {
      return { route: "share-automation-presses", shareId };
    }
    if (parts.length === 6 && parts[3] === "proposals" && parts[5] === "withdraw") {
      return {
        route: "share-proposal-withdraw",
        shareId,
        proposalId: parseShareId(parts[4]),
      };
    }
    throw notFound();
  }
  const workspaceId = parseWorkspaceId(parts[1]);
  if (parts[2] === "datasets") {
    if (parts.length === 3) return {route:"dataset", workspaceId, action:"list"};
    const datasetId = parts[3];
    if (!datasetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(datasetId)) throw notFound();
    if (parts.length === 6 && parts[4] === "replica" && ["capture","page","blob"].includes(parts[5]!)) return {route:"dataset-replica",workspaceId,datasetId,action:parts[5] as DatasetReplicaRoute["action"]};
    if (parts.length === 6 && parts[4] === "imports" && /^[A-Za-z0-9_-]{1,128}$/.test(parts[5]!)) return {route: "dataset", workspaceId, datasetId, action: "import", transferId: parts[5]};
    if (parts.length === 4) return {route:"dataset", workspaceId, datasetId, action:"describe"};
    if (parts.length === 5 && ["press","activate","artifacts","invoke","prepare-migration","approve-migration","discard-migration","migration-preview-page","permissions","upload","file","history","history-revision","export","lifecycle","archive","restore","pending-attempts","reconcile-attempt","cancel-attempt","delete-preview","delete","deletion-status"].includes(parts[4]!)) return {route:"dataset", workspaceId, datasetId, action:parts[4] as DatasetRoute["action"]};
    if (parts.length === 5 && parts[4] === "grants") return {route:"dataset", workspaceId, datasetId, action:"grant"};
    if (parts.length === 5 && parts[4] === "binding") return {route:"dataset", workspaceId, datasetId, action:"binding"};
    throw notFound();
  }
  if (parts[2] === "automation-presses" && parts.length <= 4) {
    const action = parseAutomationPressAction(parts[3]);
    if (!action) throw notFound();
    return { route: "automation-presses", workspaceId, action };
  }
  if (isAutomationServerPath(parts)) {
    const action = parseAutomationServerAction(parts[3]);
    if (!action) throw notFound();
    return { route: "automation-server", workspaceId, action };
  }
  if (isAutomationHostPath(parts)) {
    const action = parseAutomationHostAction(parts[3]);
    if (!action) throw notFound();
    return { route: "automation-host", workspaceId, action };
  }
  if (parts[2] === "collection-writes" && parts.length === 4) {
    return { route: "owner-collection-writes", workspaceId, grantId: parseShareId(parts[3]) };
  }
  if(parts[2]==="app-responses" && parts.length===4)return {route:"owner-app-responses",workspaceId,grantId:parseShareId(parts[3])};
  if (parts[2] === "app-publications") {
    if (parts.length === 3) return {route: "owner-app-publication", workspaceId, action: "publish"};
    const publicationId = parts[3];
    if (!publicationId || !/^[0-9a-f]{64}$/.test(publicationId)) throw notFound();
    if (parts.length === 4) return {route: "owner-app-publication", workspaceId, publicationId, action: "read"};
    if (parts.length === 5 && parts[4] === "withdraw") return {route: "owner-app-publication", workspaceId, publicationId, action: "withdraw"};
    if (parts.length === 5 && parts[4] === "reactivate") return {route: "owner-app-publication", workspaceId, publicationId, action: "reactivate"};
    if (parts.length === 5 && parts[4] === "collection-approval") return {route: "owner-app-publication", workspaceId, publicationId, action: "collection-approval"};
    if (parts.length === 6 && parts[4] === "backend" &&
        (parts[5] === "activate" || parts[5] === "invoke" || parts[5] === "upload" || parts[5] === "file" || parts[5] === "attempt" ||
         parts[5] === "descriptor" || parts[5] === "summary")) {
      return {route:"app-backend",workspaceId,publicationId,action:parts[5]};
    }
    if (parts.length === 7 && parts[4] === "backend" && parts[5] === "blobs" && /^[0-9a-f]{64}$/.test(parts[6]!)) {
      return {route:"app-backend",workspaceId,publicationId,action:"blob",sha256:parts[6]};
    }
    throw notFound();
  }
  if (parts[2] === "held-documents") {
    if (parts.length === 3) return {route: "held-documents", workspaceId};
    if (parts.length === 4) return {route: "held-documents", workspaceId, objectId: parseString(parts[3], "objectId", MAX_HELD_OBJECT_ID_CHARS)};
    if (parts.length === 5 && (parts[4] === "markdown" || parts[4] === "contributions")) {
      return {route: "held-documents", workspaceId, objectId: parseString(parts[3], "objectId", MAX_HELD_OBJECT_ID_CHARS), read: parts[4]};
    }
    throw notFound();
  }
  if (parts[2] === "live-restores") {
    if (parts.length === 3) return {route: "owner-restore", workspaceId, action: "begin"};
    if (parts.length === 4 && (parts[3] === "plan" || parts[3] === "options")) return {route: "owner-restore", workspaceId, action: parts[3]};
    const operationId = parseString(parts[3], "operationId", 512);
    if (parts.length === 4) return {route: "owner-restore", workspaceId, operationId, action: "status"};
    const action = parts[4];
    if (parts.length === 5 && (action === "prepare" || action === "review" || action === "confirm")) {
      return {route: "owner-restore", workspaceId, operationId, action};
    }
    throw notFound();
  }
  if (parts.length === 4 && parts[2] === "blobs" && parts[3] === "have") {
    return { route: "blob-have", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "blobs" && parts[3]) {
    return { route: "blob", workspaceId, sha256: parts[3] };
  }
  if (parts.length === 4 && parts[2] === "maintenance" && parts[3] === "gc") {
    return { route: "gc", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "log") {
    return { route: "log", workspaceId };
  }
  if (parts.length === 5 && parts[2] === "log") {
    const originId = parseString(parts[3], "originId", MAX_ORIGIN_ID_CHARS);
    const originSeq = Number(parts[4]);
    if (!Number.isSafeInteger(originSeq) || originSeq < 0) throw notFound();
    return { route: "log-coordinate", workspaceId, originId, originSeq };
  }
  if (parts.length === 3 && parts[2] === "bootstrap") {
    return { route: "bootstrap", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "epoch") {
    return { route: "epoch", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "presence") {
    return { route: "presence", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "keys") {
    return { route: "keys", workspaceId };
  }
  if (parts.length === 7 && parts[2] === "shares" && parts[4] === "grants" && parts[6] === "copy") {
    return { route: "share-copy", workspaceId, shareId: parseShareId(parts[3]), grantId: parseShareId(parts[5]) };
  }
  if (parts.length === 3 && parts[2] === "shares") {
    return { route: "shares-create", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "shares" && parts[3] === "links") {
    return { route: "share-link-create-atomic", workspaceId };
  }
  if (parts.length === 5 && parts[2] === "shares" && parts[4] === "links") {
    return {
      route: "share-link-create",
      workspaceId,
      shareId: parseShareId(parts[3]),
    };
  }
  if (parts.length === 3 && parts[2] === "proposals") {
    return { route: "workspace-proposals", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "proposals") {
    return {
      route: "workspace-proposal",
      workspaceId,
      proposalId: parseShareId(parts[3]),
    };
  }
  if (parts.length === 6 && parts[2] === "proposals" && parts[4] === "ops") {
    return {
      route: "workspace-proposal-op",
      workspaceId,
      proposalId: parseShareId(parts[3]),
      opIndex: parseOpIndex(parts[5]),
    };
  }
  if (
    parts.length === 5 &&
    parts[2] === "proposals" &&
    (parts[4] === "accept" || parts[4] === "decline")
  ) {
    return {
      route: "workspace-proposal-settle",
      workspaceId,
      proposalId: parseShareId(parts[3]),
      decision: parts[4],
    };
  }
  throw notFound();
}

// A path segment naming an op's position in its proposal. Anything that is not
// a plain in-range index addresses no op, so it is the same generic 404 every
// other unresolvable lookup gives.
function parseOpIndex(value: string | undefined): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,6})$/.test(value)) {
    throw notFound();
  }
  const index = Number(value);
  if (index >= MAX_SHARE_PROPOSAL_OPS) throw notFound();
  return index;
}

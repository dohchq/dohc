import { randomUUID } from "node:crypto";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import {
  INBOX_COLLECTION_PATH,
  INBOX_COLLECTION_YAML,
  INBOX_SCHEMA_PATH,
} from "@dohc/workspace-contracts/inbox";
import {
  formatIncomingWebhookRecord,
  parseIncomingWebhookContentType,
} from "@dohc/workspace-contracts/incoming-webhooks";
import { cutText } from "@dohc/workspace-contracts/names";
import {
  AUTOMATION_SERVER_INSTALL_ID,
  NOTICE_BODY_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
} from "@dohc/workspace-contracts/relay";
import { COLLECTION_SCHEMA_FILE } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";

export interface IncomingWebhookDrainAdapter {
  getActiveVersion(input: { workspaceId: string }): Promise<{ id: string } | null>;
  readTextFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): Promise<{ objectId: string; text: string | null } | null>;
  writeTextFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    text: string;
    publish?: boolean;
    createOnly?: boolean;
    requestId?: string;
    metadata: { origin: "api"; summary: string };
    author?: {
      kind: "automation";
      automationId: string;
      onBehalfOf?: string;
      depth: number;
    };
  }): Promise<unknown>;
  getCollectionRecord(input: {
    collectionPath: string;
    recordId: string;
    historyLimit: number;
  }): Promise<{ record: { path: string } }>;
}

export interface IncomingWebhookDrainContext {
  readonly storage: SyncRelayStorage;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly installId?: string;
  readonly leaseId?: string;
  readonly adapter: IncomingWebhookDrainAdapter;
  readonly currentGeneration: () => number | null;
  readonly nowMs: () => number;
  readonly hold: () => (() => void) | null;
  readonly sync?: () => Promise<void>;
  readonly isRecordPublished?: (recordPath: string) => boolean;
  readonly onWritten: () => void;
  readonly onError: (context: string, error: unknown) => void;
}

export interface IncomingWebhookDrainResult {
  readonly settled: number;
  readonly progressed: boolean;
}

const SHARE_PAUSE_REASON =
  "Paused because this Collection or a parent folder was shared. Incoming webhooks deliver only to private Collections.";

function sanitizeNoticeText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

function parseStoredHeaders(headersJson: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(headersJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function drainIncomingWebhooksForWorkspace(
  context: IncomingWebhookDrainContext,
): Promise<IncomingWebhookDrainResult> {
  const installId = context.installId ?? AUTOMATION_SERVER_INSTALL_ID;
  const leaseId = context.leaseId ?? randomUUID();
  let settledCount = 0;
  let progressed = false;

  const handleAuthorityFailure = (
    claimed: {
      readonly webhookId: string;
      readonly deliveryId: string;
      readonly acceptedGeneration: number;
      readonly acceptedLeaseId: string;
    },
    reason: "fenced" | "delivery-changed" | "paused" | "shared" | "missing",
  ): "stop" | "continue" => {
    if (reason === "fenced") return "stop";
    progressed = true;
    if (reason === "delivery-changed") return "continue";
    const pauseReason = reason === "shared" ? SHARE_PAUSE_REASON : "Webhook is paused.";
    context.storage.settleIncomingWebhookDelivery({
      workspaceId: context.workspaceId,
      webhookId: claimed.webhookId,
      deliveryId: claimed.deliveryId,
      installId,
      generation: claimed.acceptedGeneration,
      leaseId: claimed.acceptedLeaseId,
      state: "paused",
      error: pauseReason,
      ...(reason === "shared" ? { pauseWebhookReason: pauseReason } : {}),
      nowMs: context.nowMs(),
    });
    return "continue";
  };

  for (;;) {
    const generation = context.currentGeneration();
    if (generation === null) return { settled: settledCount, progressed };

    const claimed = context.storage.claimNextIncomingWebhookDelivery({
      workspaceId: context.workspaceId,
      ownerUserId: context.ownerUserId,
      installId,
      generation,
      leaseId,
      nowMs: context.nowMs(),
    });
    if (claimed === null) return { settled: settledCount, progressed };

    const releaseHold = context.hold();
    if (releaseHold === null) {
      context.storage.releaseAcceptedIncomingWebhookDelivery({
        workspaceId: context.workspaceId,
        deliveryId: claimed.deliveryId,
        installId,
        generation: claimed.acceptedGeneration,
        leaseId: claimed.acceptedLeaseId,
        nowMs: context.nowMs(),
      });
      return { settled: settledCount, progressed };
    }
    try {
      const version = await context.adapter.getActiveVersion({
        workspaceId: context.workspaceId,
      });
      if (version === null) {
        context.storage.releaseAcceptedIncomingWebhookDelivery({
          workspaceId: context.workspaceId,
          deliveryId: claimed.deliveryId,
          installId,
          generation: claimed.acceptedGeneration,
          leaseId: claimed.acceptedLeaseId,
          nowMs: context.nowMs(),
        });
        return { settled: settledCount, progressed };
      }

      const authBeforeSchema = context.storage.verifyIncomingWebhookPublicationAuthority({
        workspaceId: context.workspaceId,
        ownerUserId: context.ownerUserId,
        webhookId: claimed.webhookId,
        deliveryId: claimed.deliveryId,
        installId,
        generation: claimed.acceptedGeneration,
        leaseId: claimed.acceptedLeaseId,
      });
      if (!authBeforeSchema.ok) {
        if (handleAuthorityFailure(claimed, authBeforeSchema.reason) === "stop") {
          return { settled: settledCount, progressed };
        }
        continue;
      }

      const collectionPath = authBeforeSchema.collectionPath;
      const schemaPath = `${collectionPath}/${COLLECTION_SCHEMA_FILE}`;
      const webhookAuthor = {
        kind: "automation" as const,
        automationId: `webhook:${claimed.webhookId}`,
        onBehalfOf: context.ownerUserId,
        depth: claimed.chainDepth,
      };

      let schemaFile = await context.adapter.readTextFile({
        workspaceId: context.workspaceId,
        versionId: version.id,
        path: schemaPath,
      });
      let boundCollectionId: string | null = null;

      if (schemaFile === null) {
        if (collectionPath === INBOX_COLLECTION_PATH && authBeforeSchema.collectionId === null) {
          const authBeforeInbox = context.storage.verifyIncomingWebhookPublicationAuthority({
            workspaceId: context.workspaceId,
            ownerUserId: context.ownerUserId,
            webhookId: claimed.webhookId,
            deliveryId: claimed.deliveryId,
            installId,
            generation: claimed.acceptedGeneration,
            leaseId: claimed.acceptedLeaseId,
          });
          if (!authBeforeInbox.ok) {
            if (handleAuthorityFailure(claimed, authBeforeInbox.reason) === "stop") {
              return { settled: settledCount, progressed };
            }
            continue;
          }
          try {
            await context.adapter.writeTextFile({
              workspaceId: context.workspaceId,
              versionId: version.id,
              path: INBOX_SCHEMA_PATH,
              text: INBOX_COLLECTION_YAML,
              publish: true,
              createOnly: true,
              requestId: `incoming-webhook-inbox-init:${context.workspaceId}`,
              author: webhookAuthor,
              metadata: {
                origin: "api",
                summary: "Created Inbox collection for incoming webhook",
              },
            });
          } catch {
            // Concurrent Inbox creation — re-read below to confirm.
          }
          schemaFile = await context.adapter.readTextFile({
            workspaceId: context.workspaceId,
            versionId: version.id,
            path: INBOX_SCHEMA_PATH,
          });
          if (schemaFile === null) {
            throw new Error("Could not create Inbox/collection.yaml for incoming webhook.");
          }
          boundCollectionId = schemaFile.objectId;
        } else {
          const reason = "Paused because the target Collection no longer exists.";
          progressed = true;
          context.storage.settleIncomingWebhookDelivery({
            workspaceId: context.workspaceId,
            webhookId: claimed.webhookId,
            deliveryId: claimed.deliveryId,
            installId,
            generation: claimed.acceptedGeneration,
            leaseId: claimed.acceptedLeaseId,
            state: "paused",
            error: reason,
            pauseWebhookReason: reason,
            nowMs: context.nowMs(),
          });
          continue;
        }
      } else if (
        authBeforeSchema.collectionId !== null &&
        schemaFile.objectId !== authBeforeSchema.collectionId
      ) {
        const reason = "Paused because the target Collection was replaced or moved.";
        progressed = true;
        context.storage.settleIncomingWebhookDelivery({
          workspaceId: context.workspaceId,
          webhookId: claimed.webhookId,
          deliveryId: claimed.deliveryId,
          installId,
          generation: claimed.acceptedGeneration,
          leaseId: claimed.acceptedLeaseId,
          state: "paused",
          error: reason,
          pauseWebhookReason: reason,
          nowMs: context.nowMs(),
        });
        continue;
      } else if (authBeforeSchema.collectionId === null) {
        boundCollectionId = schemaFile.objectId;
      }

      const recordId = derivedRecordId(`webhook:${claimed.deliveryId}`);
      const existingRecord = await context.adapter
        .getCollectionRecord({
          collectionPath,
          recordId,
          historyLimit: 0,
        })
        .catch(() => null);

      let recordPath: string;
      if (existingRecord !== null) {
        recordPath = existingRecord.record.path;
      } else {
        const authBeforeWrite = context.storage.verifyIncomingWebhookPublicationAuthority({
          workspaceId: context.workspaceId,
          ownerUserId: context.ownerUserId,
          webhookId: claimed.webhookId,
          deliveryId: claimed.deliveryId,
          installId,
          generation: claimed.acceptedGeneration,
          leaseId: claimed.acceptedLeaseId,
        });
        if (!authBeforeWrite.ok) {
          if (handleAuthorityFailure(claimed, authBeforeWrite.reason) === "stop") {
            return { settled: settledCount, progressed };
          }
          continue;
        }
        if (context.currentGeneration() !== claimed.acceptedGeneration) {
          return { settled: settledCount, progressed };
        }

        const contentType = parseIncomingWebhookContentType(claimed.contentType) ?? "text/plain";
        const bodyText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
          claimed.payloadBytes,
        );
        const formatted = formatIncomingWebhookRecord({
          recordId,
          deliveryId: claimed.deliveryId,
          webhookName: claimed.webhookName,
          contentType,
          headers: parseStoredHeaders(claimed.headersJson),
          bodyText,
          receivedAtMs: claimed.createdAtMs,
        });
        recordPath = `${collectionPath}/${formatted.filename}`;

        try {
          await context.adapter.writeTextFile({
            workspaceId: context.workspaceId,
            versionId: version.id,
            path: recordPath,
            text: formatted.markdown,
            publish: true,
            createOnly: true,
            requestId: `incoming-webhook:${claimed.deliveryId}`,
            author: webhookAuthor,
            metadata: {
              origin: "api",
              summary: `Incoming webhook: ${formatted.title}`,
            },
          });
        } catch (writeError) {
          const createdDuringRace = await context.adapter
            .getCollectionRecord({
              collectionPath,
              recordId,
              historyLimit: 0,
            })
            .catch(() => null);
          if (createdDuringRace === null) {
            throw writeError;
          }
          recordPath = createdDuringRace.record.path;
        }
      }

      // Recheck authority after the async engine write before syncing or settling.
      const authAfterWrite = context.storage.verifyIncomingWebhookPublicationAuthority({
        workspaceId: context.workspaceId,
        ownerUserId: context.ownerUserId,
        webhookId: claimed.webhookId,
        deliveryId: claimed.deliveryId,
        installId,
        generation: claimed.acceptedGeneration,
        leaseId: claimed.acceptedLeaseId,
      });
      if (!authAfterWrite.ok) {
        if (handleAuthorityFailure(claimed, authAfterWrite.reason) === "stop") {
          return { settled: settledCount, progressed };
        }
        continue;
      }

      // Push the replica's write to the relay log BEFORE marking the delivery settled so a
      // concurrent View share refused at log admission never leaves a false 'settled' status.
      if (context.sync) {
        await context.sync();
        if (context.isRecordPublished && !context.isRecordPublished(recordPath)) {
          const authAfterSync = context.storage.verifyIncomingWebhookPublicationAuthority({
            workspaceId: context.workspaceId,
            ownerUserId: context.ownerUserId,
            webhookId: claimed.webhookId,
            deliveryId: claimed.deliveryId,
            installId,
            generation: claimed.acceptedGeneration,
            leaseId: claimed.acceptedLeaseId,
          });
          if (!authAfterSync.ok) {
            if (handleAuthorityFailure(claimed, authAfterSync.reason) === "stop") {
              return { settled: settledCount, progressed };
            }
            continue;
          }
          throw new Error("Incoming webhook record was not published to the sync server.");
        }
      }

      if (
        context.storage.settleIncomingWebhookDelivery({
          workspaceId: context.workspaceId,
          webhookId: claimed.webhookId,
          deliveryId: claimed.deliveryId,
          installId,
          generation: claimed.acceptedGeneration,
          leaseId: claimed.acceptedLeaseId,
          state: "settled",
          recordPath,
          boundCollectionId,
          nowMs: context.nowMs(),
        })
      ) {
        settledCount += 1;
        progressed = true;
        context.onWritten();
      } else {
        progressed = true;
      }
    } catch (error) {
      context.onError(`deliver incoming webhook in workspace "${context.workspaceId}"`, error);
      const now = context.nowMs();
      const rawMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = sanitizeNoticeText(rawMessage) || "Failed to deliver incoming webhook.";
      const attempt = context.storage.recordFailedIncomingWebhookAttempt({
        workspaceId: context.workspaceId,
        deliveryId: claimed.deliveryId,
        installId,
        generation: claimed.acceptedGeneration,
        leaseId: claimed.acceptedLeaseId,
        error: errorMessage,
        nowMs: now,
      });
      if (attempt.outcome === "failed") {
        try {
          context.storage.postNotice({
            noticeId: `incoming-webhook-failed:${claimed.deliveryId}`,
            recipientUserId: context.ownerUserId,
            reach: { workspaceId: context.workspaceId },
            kind: "automation-failed",
            title: cutText(
              `Incoming webhook "${sanitizeNoticeText(claimed.webhookName) || "Webhook"}" failed to deliver`,
              NOTICE_TITLE_MAX_CHARS,
            ),
            body: cutText(
              `Delivery ${claimed.deliveryId} failed after ${attempt.attemptCount} attempts: ${errorMessage} Resend from the source or inspect this webhook in Settings.`,
              NOTICE_BODY_MAX_CHARS,
            ),
            target: {
              path: claimed.collectionPath,
            },
            originInstallId: "sync-relay",
            senderUserId: context.ownerUserId,
            senderLabel: "dohc server",
            nowMs: now,
          });
        } catch {
          // Notice persistence errors must never disrupt the webhook drain loop.
        }
      }
      if (attempt.outcome !== "ignored") {
        progressed = true;
      }
      continue;
    } finally {
      releaseHold();
    }
  }
}

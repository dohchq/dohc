import { parentPort, workerData } from "node:worker_threads";
import {
  openSyncRelayStorage,
  type OpenSyncRelayStorageOptions,
} from "./storage";

export type RecipientBudgetRaceOperation =
  | {
      kind: "named";
      shareId: string;
      authorUserId: string;
      displayName: string;
      body: string;
      idempotencyKey: string;
      createdAtMs: number;
    }
  | {
      kind: "link";
      capabilityHash: string;
      profileTokenHash: string;
      claimedName: string;
      body: string;
      idempotencyKey: string;
      createdAtMs: number;
    };

export interface RecipientBudgetRaceWorkerData {
  dbPath: string;
  idPrefix: string;
  options: Pick<
    OpenSyncRelayStorageOptions,
    | "discussionMessageRateLimit"
    | "discussionLifetimeMessageLimit"
    | "discussionNonOwnerShareRowLimit"
  >;
  operation: RecipientBudgetRaceOperation;
}

const data = workerData as RecipientBudgetRaceWorkerData;
let id = 0;
const storage = openSyncRelayStorage(data.dbPath, {
  ...data.options,
  newDiscussionId: () => `${data.idPrefix}-${++id}`,
});

parentPort?.postMessage({ kind: "ready" });
parentPort?.once("message", (message: unknown) => {
  if (message !== "go") return;
  try {
    const result = data.operation.kind === "named"
      ? storage.appendAuthenticatedDiscussionMessage({
          shareId: data.operation.shareId,
          authorUserId: data.operation.authorUserId,
          displayName: data.operation.displayName,
          body: data.operation.body,
          idempotencyKey: data.operation.idempotencyKey,
          createdAtMs: data.operation.createdAtMs,
          guard: () => "recipient",
        })
      : storage.appendLinkDiscussionMessage({
          capabilityHash: data.operation.capabilityHash,
          profileTokenHash: data.operation.profileTokenHash,
          claimedName: data.operation.claimedName,
          body: data.operation.body,
          idempotencyKey: data.operation.idempotencyKey,
          createdAtMs: data.operation.createdAtMs,
        });
    parentPort?.postMessage({ kind: "result", result });
  } catch (error) {
    parentPort?.postMessage({
      kind: "error",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  } finally {
    storage.close();
  }
});

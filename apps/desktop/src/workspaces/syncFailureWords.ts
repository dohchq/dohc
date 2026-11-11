import type { CloudSyncFailure } from "./relaySyncEngine";

// The engine stops receiving once changes waiting on a record's open conflict
// reach their limit. Its refusal is three sentences, then the counts in
// parentheses for a report.
const CONFLICT_WAIT_LIMIT = "DaemonRefusalError: conflict-wait-limit: ";
const CONFLICT_WAIT_LIMIT_END = "Resolve the conflict to receive changes again.";

// A failed sync pass, as both a person and an agent read it: a stable code and
// one account of it. Neither claims this computer's copy is saved.
export function syncFailureWords(failure: Pick<CloudSyncFailure, "cause" | "detail">): {
  code: CloudSyncFailure["cause"] | "conflict-wait-limit";
  message: string;
} {
  if (failure.cause === "claim-refused") return { code: failure.cause, message: failure.detail };
  if (failure.detail.startsWith(CONFLICT_WAIT_LIMIT)) {
    const sentences = failure.detail.slice(CONFLICT_WAIT_LIMIT.length);
    const end = sentences.indexOf(CONFLICT_WAIT_LIMIT_END);
    return {
      code: "conflict-wait-limit",
      message: end < 0 ? sentences : sentences.slice(0, end + CONFLICT_WAIT_LIMIT_END.length),
    };
  }
  return {
    code: failure.cause,
    message: failure.cause === "server-busy" ? "The server is busy. dohc keeps trying to sync this workspace."
      : failure.cause === "server-unreachable" ? "dohc could not reach the server."
      : "dohc could not sync this workspace.",
  };
}

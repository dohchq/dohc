import { isDeepStrictEqual } from "node:util";
import {
  parseLiveObjectBinding,
  type LiveObjectBinding,
} from "@dohc/live-session-contract/live-object-binding";
import { parseHostControlIdentifier } from "@dohc/live-session-contract/host-control";
import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  parseLiveUpdateReceipt,
  type LiveUpdateReceipt,
} from "@dohc/live-session-contract/live-update-admission";

interface NativeRestoreFence {
  point: { journalCursor: number; receiptDigest: string };
  operationId: string;
  relayDatabaseNamespace: string;
  oldBinding: LiveObjectBinding;
  hostId: string;
  newFence: number;
  origin: { kind: "bootstrap" | "owner"; id: string };
  terminal: LiveUpdateReceipt | null;
  appliedSequence: number;
}
interface NativeRestoreFenceReceipt {
  operation: NativeRestoreFence;
  localHeadSequence: number;
  recordedAtMs: number;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new TypeError("Invalid native restore fields.");
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError("Invalid native restore integer.");
  return value;
}
function parseNativeRestoreFence(value: unknown): NativeRestoreFence {
  const row = record(value, [
    "point",
    "operationId",
    "relayDatabaseNamespace",
    "oldBinding",
    "hostId",
    "newFence",
    "origin",
    "terminal",
    "appliedSequence",
  ]);
  const oldBinding = parseLiveObjectBinding(row.oldBinding),
    newFence = integer(row.newFence),
    origin = record(row.origin, ["kind", "id"]);
  if (
    oldBinding.restoreFenceGeneration === Number.MAX_SAFE_INTEGER ||
    newFence !== oldBinding.restoreFenceGeneration + 1 ||
    (origin.kind !== "bootstrap" && origin.kind !== "owner")
  )
    throw new TypeError("Invalid native restore fence.");
  const point = record(row.point, ["journalCursor", "receiptDigest"]);
  return {
    point: {
      journalCursor: integer(point.journalCursor),
      receiptDigest: parseLiveUpdateDigest(point.receiptDigest),
    },
    operationId: parseLiveUpdateIdentifier(row.operationId),
    relayDatabaseNamespace: parseLiveUpdateIdentifier(row.relayDatabaseNamespace),
    oldBinding,
    hostId: parseHostControlIdentifier(row.hostId),
    newFence,
    origin: { kind: origin.kind, id: parseLiveUpdateIdentifier(origin.id) },
    terminal: row.terminal === null ? null : parseLiveUpdateReceipt(row.terminal),
    appliedSequence: integer(row.appliedSequence),
  };
}
function parseNativeRestoreFenceReceipt(value: unknown): NativeRestoreFenceReceipt {
  const row = record(value, ["operation", "localHeadSequence", "recordedAtMs"]),
    operation = parseNativeRestoreFence(row.operation);
  const localHeadSequence = integer(row.localHeadSequence);
  if (localHeadSequence < operation.appliedSequence)
    throw new TypeError("Native restore head precedes its acknowledged cut.");
  return { operation, localHeadSequence, recordedAtMs: integer(row.recordedAtMs) };
}

/**
 * The host's terminal end of a restore cancelled after its fence committed:
 * the fence, its stopped binding at the new generation, and the accepted
 * endpoint the fence froze.
 */
export interface NativeRestoreCancellationReceipt {
  fence: NativeRestoreFenceReceipt;
  binding: LiveObjectBinding;
  endpoint: {
    terminalReceipt: LiveUpdateReceipt | null;
    eventCount: number;
    historyEvidenceDigest: string;
  };
  recordedAtMs: number;
}
export function parseNativeRestoreCancellationReceipt(
  value: unknown,
): NativeRestoreCancellationReceipt {
  const row = record(value, ["fence", "binding", "endpoint", "recordedAtMs"]),
    fence = parseNativeRestoreFenceReceipt(row.fence);
  const binding = parseLiveObjectBinding(row.binding),
    endpoint = record(row.endpoint, ["terminalReceipt", "eventCount", "historyEvidenceDigest"]);
  const terminalReceipt =
    endpoint.terminalReceipt === null ? null : parseLiveUpdateReceipt(endpoint.terminalReceipt);
  const eventCount = integer(endpoint.eventCount),
    operation = fence.operation;
  if (
    typeof endpoint.historyEvidenceDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(endpoint.historyEvidenceDigest) ||
    !isDeepStrictEqual(binding, {
      ...operation.oldBinding,
      restoreFenceGeneration: operation.newFence,
    }) ||
    !isDeepStrictEqual(terminalReceipt, operation.terminal) ||
    (eventCount === 0) !== (terminalReceipt === null)
  ) {
    throw new TypeError("Invalid native restore cancellation.");
  }
  return {
    fence,
    binding,
    endpoint: {
      terminalReceipt,
      eventCount,
      historyEvidenceDigest: endpoint.historyEvidenceDigest,
    },
    recordedAtMs: integer(row.recordedAtMs),
  };
}

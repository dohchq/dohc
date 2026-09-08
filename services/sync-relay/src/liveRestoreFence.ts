import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseHostControlIdentifier } from "@dohc/live-session-contract/host-control";
import { parseLiveUpdateIdentifier, parseLiveUpdateReceipt, type LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";

export interface NativeRestoreFence {
  operationId: string;
  relayDatabaseNamespace: string;
  oldBinding: LiveObjectBinding;
  hostId: string;
  newFence: number;
  origin: {kind: "bootstrap" | "owner"; id: string};
  terminal: LiveUpdateReceipt | null;
  appliedSequence: number;
}
export interface NativeRestoreFenceReceipt {
  operation: NativeRestoreFence;
  localHeadSequence: number;
  recordedAtMs: number;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError("Invalid native restore fields.");
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid native restore integer.");
  return value;
}
export function parseNativeRestoreFence(value: unknown): NativeRestoreFence {
  const row = record(value, ["operationId", "relayDatabaseNamespace", "oldBinding", "hostId", "newFence", "origin", "terminal", "appliedSequence"]);
  const oldBinding = parseLiveObjectBinding(row.oldBinding), newFence = integer(row.newFence), origin = record(row.origin, ["kind", "id"]);
  if (oldBinding.restoreFenceGeneration === Number.MAX_SAFE_INTEGER || newFence !== oldBinding.restoreFenceGeneration + 1 ||
    (origin.kind !== "bootstrap" && origin.kind !== "owner")) throw new TypeError("Invalid native restore fence.");
  return {operationId: parseLiveUpdateIdentifier(row.operationId), relayDatabaseNamespace: parseLiveUpdateIdentifier(row.relayDatabaseNamespace),
    oldBinding, hostId: parseHostControlIdentifier(row.hostId), newFence,
    origin: {kind: origin.kind, id: parseLiveUpdateIdentifier(origin.id)},
    terminal: row.terminal === null ? null : parseLiveUpdateReceipt(row.terminal), appliedSequence: integer(row.appliedSequence)};
}
export function parseNativeRestoreFenceReceipt(value: unknown): NativeRestoreFenceReceipt {
  const row = record(value, ["operation", "localHeadSequence", "recordedAtMs"]), operation = parseNativeRestoreFence(row.operation);
  const localHeadSequence = integer(row.localHeadSequence);
  if (localHeadSequence < operation.appliedSequence) throw new TypeError("Native restore head precedes its acknowledged cut.");
  return {operation, localHeadSequence, recordedAtMs: integer(row.recordedAtMs)};
}

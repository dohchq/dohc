import {DEFAULT_MAX_BLOB_BYTES} from "@dohc/workspace-engine-client/daemon";

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...fields].sort().join()) {
    throw new TypeError("Invalid private sync configuration.");
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError("Invalid private sync limit.");
  return value;
}

export function parseNativeLiveSyncConfig(value: unknown, aggregateBytes: number) {
  if (value === undefined) return undefined;
  const row = record(value, ["policy", "workingReserveBytes"]);
  const input = record(row.policy, ["maxClientVectorBytes", "maxHostVectorBytes", "maxOutputBytes", "maxReadBytes"]);
  const policy = Object.freeze({
    maxClientVectorBytes: integer(input.maxClientVectorBytes, DEFAULT_MAX_BLOB_BYTES),
    maxHostVectorBytes: integer(input.maxHostVectorBytes, DEFAULT_MAX_BLOB_BYTES),
    maxOutputBytes: integer(input.maxOutputBytes, DEFAULT_MAX_BLOB_BYTES),
    maxReadBytes: integer(input.maxReadBytes),
  });
  const workingReserveBytes = integer(row.workingReserveBytes);
  const reservation = policy.maxClientVectorBytes * 9 + policy.maxHostVectorBytes * 10 +
    policy.maxReadBytes * 2 + policy.maxOutputBytes * 2 + workingReserveBytes + 643_576 * 2;
  if (policy.maxClientVectorBytes > policy.maxReadBytes || policy.maxHostVectorBytes > policy.maxOutputBytes ||
    !Number.isSafeInteger(reservation) || reservation > integer(aggregateBytes)) throw new TypeError("Invalid native sync aggregate budget.");
  return Object.freeze({policy, workingReserveBytes});
}

export function parseOwnerLiveSyncConfig(value: unknown, aggregateBytes: number, maxFrameBytes: number) {
  if (value === undefined) return undefined;
  const row = record(value, ["maxClientVectorBytes", "maxOutputBytes"]);
  const maxClientVectorBytes = integer(row.maxClientVectorBytes, DEFAULT_MAX_BLOB_BYTES);
  const maxOutputBytes = integer(row.maxOutputBytes, DEFAULT_MAX_BLOB_BYTES);
  const reservation = maxClientVectorBytes * 3 + maxOutputBytes * 3 + integer(maxFrameBytes);
  if (maxOutputBytes < 3 || !Number.isSafeInteger(reservation) || reservation > integer(aggregateBytes)) throw new TypeError("Invalid owner sync aggregate budget.");
  return Object.freeze({maxClientVectorBytes, maxOutputBytes});
}

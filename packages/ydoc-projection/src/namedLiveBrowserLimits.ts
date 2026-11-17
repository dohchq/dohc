import { createLiveFrameSession } from "@dohc/live-session-contract/live-frame";
import type { NamedLiveProviderLimits } from "@dohc/ydoc-projection/named-live-provider";

// The limits a server sends with a named or owner live connection. This module stays free of the provider and the
// transport, so a phone app can check the limits without bundling either.

export interface NamedLiveBrowserLimits {
  provider: NamedLiveProviderLimits;
  maxHttpResponseBytes: number;
  maxSocketBufferedBytes: number;
  connectTimeoutMs: number;
  sendTimeoutMs: number;
  drainPollMs: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> =>
  record(value) && Object.keys(value).sort().join(",") === keys;

const shaped = (value: unknown) =>
  exact(
    value,
    "connectTimeoutMs,drainPollMs,maxHttpResponseBytes,maxSocketBufferedBytes,provider,sendTimeoutMs",
  ) && exact(value.provider, "frames,maxDeliveryAttempts,maxPendingUpdateBytes,maxPendingUpdates");

export function parseNamedLiveBrowserLimits(value: unknown): NamedLiveBrowserLimits {
  // A JSON copy, as Hermes has no structuredClone. The input and the copy must both have the shape, so a toJSON can't
  // add a key the check never saw. The checks below read only the copy.
  let copy: unknown;
  try {
    copy = shaped(value) ? JSON.parse(JSON.stringify(value)) : undefined;
  } catch {
    copy = undefined;
  }
  if (!shaped(copy)) throw new TypeError("Invalid browser transport limits.");
  const limits = copy as unknown as NamedLiveBrowserLimits;
  for (const number of [
    limits.maxHttpResponseBytes,
    limits.maxSocketBufferedBytes,
    limits.connectTimeoutMs,
    limits.sendTimeoutMs,
    limits.drainPollMs,
  ]) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647)
      throw new TypeError("Invalid browser transport limits.");
  }
  for (const number of [
    limits.provider.maxPendingUpdateBytes,
    limits.provider.maxPendingUpdates,
    limits.provider.maxDeliveryAttempts,
  ]) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new TypeError("Invalid browser transport limits.");
  }
  createLiveFrameSession("client", limits.provider.frames).close();
  if (limits.maxSocketBufferedBytes < limits.provider.frames.receive.maxFrameBytes)
    throw new TypeError("Socket capacity cannot hold a frame.");
  return limits;
}

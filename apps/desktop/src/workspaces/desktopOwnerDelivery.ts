import {openSync, readSync, closeSync} from "node:fs";
import {isAbsolute} from "node:path";
import {createLiveFrameSession, type LiveFrameSessionPolicy} from "@dohc/live-session-contract/live-frame";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {canonicalRelayUrl} from "./syncCode";
import type {OwnerYDocDrainResult} from "./ownerYDocOutbox";

export interface DesktopOwnerDeliveryDocument {
  binding: LiveObjectBinding;
  outboxId: string;
  relayDatabaseNamespace: string;
  shareId: string;
}
export interface DesktopOwnerDeliveryConfig {
  nativeConfigPath: string;
  nativeClient: {aggregateBytes: number; maxUploads: number};
  relayUrl: string;
  frames: LiveFrameSessionPolicy;
  attemptTimeoutMs: number;
  retryDelayMs: number;
  documents: DesktopOwnerDeliveryDocument[];
}

function fields(input: unknown, expected: string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== expected.sort().join()) throw new TypeError("Invalid private owner delivery configuration.");
}
function delay(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) throw new TypeError("Invalid owner delivery interval.");
  return value as number;
}

/** Targets existing native outboxes. This does not enroll a document or create authority. */
export function parseDesktopOwnerDeliveryConfig(value: unknown): DesktopOwnerDeliveryConfig {
  fields(value, ["version", "nativeConfigPath", "nativeClient", "relayUrl", "frames", "attemptTimeoutMs", "retryDelayMs", "documents"]);
  const relayUrl = typeof value.relayUrl === "string" ? canonicalRelayUrl(value.relayUrl) : null;
  if (value.version !== 1 || !relayUrl || !Array.isArray(value.documents) || value.documents.length === 0) throw new TypeError("Invalid owner delivery targets.");
  const frames = structuredClone(value.frames) as LiveFrameSessionPolicy;
  createLiveFrameSession("client", frames).close();
  if (typeof value.nativeConfigPath !== "string" || !isAbsolute(value.nativeConfigPath)) throw new TypeError("Native owner ingress configuration path must be absolute.");
  fields(value.nativeClient, ["aggregateBytes", "maxUploads"]);
  const nativeClient = {aggregateBytes: value.nativeClient.aggregateBytes as number, maxUploads: value.nativeClient.maxUploads as number};
  if (!Number.isSafeInteger(nativeClient.aggregateBytes) || nativeClient.aggregateBytes < 1 ||
    !Number.isSafeInteger(nativeClient.maxUploads) || nativeClient.maxUploads < 1) throw new TypeError("Invalid native owner client budget.");
  const documents = value.documents.map(raw => {
    fields(raw, ["binding", "outboxId", "relayDatabaseNamespace", "shareId"]);
    const binding = parseLiveObjectBinding(raw.binding);
    if (binding.mainVersionId !== "main") throw new TypeError("Owner delivery requires main.");
    return {binding, outboxId: parseLiveUpdateIdentifier(raw.outboxId), relayDatabaseNamespace: parseLiveUpdateIdentifier(raw.relayDatabaseNamespace), shareId: parseLiveUpdateIdentifier(raw.shareId)};
  });
  const ids = documents.map(document => JSON.stringify([document.binding.workspaceId, document.outboxId]));
  if (new Set(ids).size !== ids.length) throw new TypeError("Duplicate owner delivery target.");
  return {nativeConfigPath: value.nativeConfigPath, nativeClient, relayUrl, frames, documents, attemptTimeoutMs: delay(value.attemptTimeoutMs), retryDelayMs: delay(value.retryDelayMs)};
}

export function readDesktopOwnerDeliveryConfig(path: string): DesktopOwnerDeliveryConfig {
  if (!isAbsolute(path)) throw new TypeError("Owner delivery configuration path must be absolute.");
  const bytes = Buffer.alloc(1_048_577), fd = openSync(path, "r");
  let offset = 0;
  try {while (offset < bytes.length) {const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count;}}
  finally {closeSync(fd);}
  if (offset === bytes.length) throw new TypeError("Owner delivery configuration exceeds its byte limit.");
  return parseDesktopOwnerDeliveryConfig(JSON.parse(bytes.subarray(0, offset).toString("utf8")));
}

/** One bounded native/network pass at a time, rotated across existing targets. */
export function startDesktopOwnerDelivery(options: {
  config: DesktopOwnerDeliveryConfig;
  runPass(document: DesktopOwnerDeliveryDocument, signal: AbortSignal): Promise<OwnerYDocDrainResult>;
  onError(error: unknown): void;
}) {
  const config = structuredClone(options.config), lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined, next = 0;
  function schedule(delayMs: number) {if (!lifetime.signal.aborted) {timer = setTimeout(run, delayMs); timer.unref();}}
  function run() {
    timer = undefined;
    if (lifetime.signal.aborted || active) return;
    const document = config.documents[next]!; next = (next + 1) % config.documents.length;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.attemptTimeoutMs)]);
    let result: OwnerYDocDrainResult = "retry";
    active = Promise.resolve().then(() => options.runPass(document, signal)).then(value => {result = value;})
      .catch(error => {if (!lifetime.signal.aborted) {try {options.onError(error);} catch { /* Logging cannot abandon retry scheduling. */ }}})
      .finally(() => {active = undefined; schedule(result === "acknowledged" ? 0 : config.retryDelayMs);});
  }
  schedule(0);
  return {
    async stop(): Promise<void> {lifetime.abort(); clearTimeout(timer); await active;},
  };
}

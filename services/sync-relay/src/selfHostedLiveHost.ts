import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {realpathSync, statSync} from "node:fs";
import {isAbsolute, join, resolve} from "node:path";
import {tmpdir} from "node:os";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {SyncRelayStorage} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {ServiceHostEnrollment} from "./storage/serviceHostEnrollment";
import {deriveServiceHostBearer} from "./serviceHostCredential";
import {observeRelayWrites, type LiveHostChanges} from "./relayWriteChanges";
import {readServiceLiveHostConfig, startServiceLiveHost} from "./serviceLiveHost";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {discoverServiceHostDocuments} from "./serviceHostEnrollmentRoutes";

type Host = Awaited<ReturnType<typeof startServiceLiveHost>>;
function canonicalPath(value: string, directory: boolean): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error("Self-host paths must be absolute and canonical.");
  const actual = realpathSync(value);
  const same = process.platform === "win32" ? actual.toLowerCase() === value.toLowerCase() : actual === value;
  if (!same || (directory ? !statSync(value).isDirectory() : !statSync(value).isFile())) throw new Error("Self-host path is unavailable.");
  return actual;
}

/** Owns the sole service daemon; account requests can select documents, never native paths or credentials. */
export async function startSelfHostedLiveHost(options: {
  storage: SyncRelayStorage; history: LiveJournalHistoryAuthority; root: string; engineExecutable: string;
  relayOrigin: string; key: Uint8Array; frameChanges: LiveHostChanges;
  startHost?: typeof startServiceLiveHost;
  onError?(error: unknown): void;
}) {
  const {storage, history} = options, profile = selfHostLiveProfile();
  const root = canonicalPath(options.root, true), engineExecutable = canonicalPath(options.engineExecutable, false);
  const relay = new URL(options.relayOrigin);
  if (relay.protocol !== "https:" || relay.origin !== options.relayOrigin || options.key.byteLength < 32) throw new Error("Self-host live editing requires its public HTTPS origin and a private key.");
  const hostId = `self-host-${history.namespace}`, instanceId = "self-host-service";
  const provision = storage.provisionLiveHostControl({mode: "service", hostId, updatedAtMs: Date.now(), guard: storage.captureStanding()});
  if (!provision.ok || provision.snapshot.transition) throw new Error("Self-host live editing requires its provisioned service host. Existing device hosts must use the host transition procedure.");
  let current: Host | undefined, closing = false, active: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let signature = "", lastError: unknown, requested = false;
  let discoveryCursor: {workspaceId: string; shareId: string} | undefined;
  let writeGeneration = 1, scanGeneration = 0, scannedGeneration = 0;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, storage.unavailable]);
  const valid = (row: ServiceHostEnrollment) => row.enabled && storage.workspaceIsOwnedBy(row.workspaceId, row.ownerUserId) &&
    storage.verifyWorkspaceIdentity(row) === "matched" && storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: row.path}) === row.objectId;
  const selection = () => storage.listServiceHostEnrollments().filter(valid);
  const selectionSignature = (rows: readonly ServiceHostEnrollment[]) => JSON.stringify(rows.map(({workspaceId, path, shareId, ownerUserId, replicationEpoch, streamIdentity, credentialNonce}) =>
    ({workspaceId, path, shareId, ownerUserId, replicationEpoch, streamIdentity, credentialNonce})));
  function schedule() {
    if (closing || signal.aborted) return;
    requested = true;
    if (!timer && !active) {
      timer = setTimeout(() => { timer = undefined; active = reconcile().finally(() => {active = undefined; if (requested) schedule();}); }, 100);
      timer.unref();
    }
  }
  async function stopCurrent() {
    const previous = current; current = undefined;
    if (previous) await previous.close();
  }
  async function reconcile() {
    requested = false;
    try {
      signal.throwIfAborted();
      if (discoveryCursor || scannedGeneration !== writeGeneration) {
        if (!discoveryCursor) scanGeneration = writeGeneration;
        discoveryCursor = discoverServiceHostDocuments(storage, options.onError, discoveryCursor) ?? undefined;
        if (!discoveryCursor) scannedGeneration = scanGeneration;
      }
      const rows = selection(), next = selectionSignature(rows);
      if (next === signature && (rows.length === 0 || (current && !current.invalidated.aborted))) {
        lastError = undefined;
        return;
      }
      const grouped = new Map<string, ServiceHostEnrollment>();
      for (const row of rows) if (!grouped.has(row.workspaceId)) grouped.set(row.workspaceId, row);
      const workspaces = [];
      for (const row of grouped.values()) {
        const directory = join(root, createHash("sha256").update(JSON.stringify([history.namespace, row.workspaceId, row.replicationEpoch, row.streamIdentity])).digest("hex"));
        await mkdir(directory, {recursive: true, mode: 0o700});
        const workspaceRoot = canonicalPath(directory, true);
        workspaces.push({root: workspaceRoot, workspaceId: row.workspaceId, maxRegistrations: 64,
          ordinaryReplication: {relay: {baseUrl: relay.origin, bearerToken: deriveServiceHostBearer(row, {key: options.key, namespace: history.namespace})},
            identity: {kind: "join", replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity}, maxPagesPerPull: 8}});
      }
      signal.throwIfAborted();
      if (next !== selectionSignature(selection())) {schedule(); return;}
      if (rows.length === 0) {
        await stopCurrent(); signature = next; lastError = undefined;
        if (next !== selectionSignature(selection())) schedule();
        return;
      }
      const temporary = await mkdtemp(join(tmpdir(), "dohc-self-host-config-"));
      try {
        const configPath = join(temporary, "service.json");
        await writeFile(configPath, JSON.stringify({version: 1, engineExecutable, hostId, instanceId, workspaces,
          ...profile.service, activation: {...profile.service.activation, targets: rows.map(({workspaceId, path, shareId}) => ({workspaceId, path, shareId}))}}), {flag: "wx", mode: 0o600});
        signal.throwIfAborted();
        readServiceLiveHostConfig(configPath);
        if (next !== selectionSignature(selection())) {schedule(); return;}
        await stopCurrent();
        signal.throwIfAborted();
        if (next !== selectionSignature(selection())) {schedule(); return;}
        current = await (options.startHost ?? startServiceLiveHost)({configPath, storage, history, frameChanges: options.frameChanges, signal});
        current.invalidated.addEventListener("abort", schedule, {once: true});
        signature = next; lastError = undefined;
      } finally {await rm(temporary, {recursive: true, force: true});}
    } catch (error) {
      if (!signal.aborted) {lastError = error; options.onError?.(error);}
    }
  }
  const stopWatching = observeRelayWrites(storage, () => {writeGeneration++; schedule();});
  const retry = setInterval(schedule, 2_000); retry.unref();
  schedule();
  return {
    current: () => current,
    ready(document: LiveDocumentKey) {return current?.isDocumentReady(document) ?? false;},
    get unavailable() {return signal.aborted || lastError !== undefined;},
    reconcile: schedule,
    async close() {
      if (closing) return;
      closing = true; lifetime.abort(); stopWatching(); clearInterval(retry); clearTimeout(timer);
      await active; await stopCurrent();
    },
  };
}

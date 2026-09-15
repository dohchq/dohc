import {openSync,readSync,closeSync} from "node:fs";
import {isAbsolute} from "node:path";
import {EngineClient,DEFAULT_MAX_BLOB_BYTES} from "@dohc/workspace-engine-client/daemon";
import {connectDeviceHost,parseDeviceHostCredential,parseOwnerLiveSyncConfig,type ExistingOwnerDeviceConfig} from "@dohc/sync-relay/device-host";
import {DEVICE_CONTROL_PATH,parseDeviceControlLimits} from "@dohc/live-session-contract/device-control";

interface DesktopOwnerHostConfig {
  nativeConfigPath: string;
  url: string;
  credential: ReturnType<typeof parseDeviceHostCredential>;
  control: ReturnType<typeof parseDeviceControlLimits>;
  workspaceIds: string[];
  reconnectDelayMs: number;
  transport: Omit<ExistingOwnerDeviceConfig,"client"|"workspaces"|"ownerFor">;
}

function readBoundedFile(path: string,limit: number,message: string): Buffer {
  const buffer = Buffer.alloc(limit+1), fd = openSync(path,"r");
  let length = 0;
  try {
    while (length < buffer.length) {
      const read = readSync(fd,buffer,length,buffer.length-length,null);
      if (!read) break;
      length += read;
    }
  } finally {closeSync(fd);}
  if (length > limit) throw new Error(message);
  return buffer.subarray(0,length);
}

export function readDesktopOwnerHostConfig(path: string): DesktopOwnerHostConfig {
  if (!isAbsolute(path)) throw new Error("Owner host configuration path must be absolute.");
  const bytes = readBoundedFile(path,1_048_576,"Owner host configuration is too large.");
  const input = JSON.parse(bytes.toString("utf8"));
  if (!input || Object.keys(input).sort().join() !== "control,credentialPath,nativeConfigPath,reconnectDelayMs,transport,url,version,workspaceIds" || input.version !== 1 ||
    typeof input.nativeConfigPath !== "string" || !isAbsolute(input.nativeConfigPath) || typeof input.credentialPath !== "string" || !isAbsolute(input.credentialPath) ||
    typeof input.url !== "string" || !Array.isArray(input.workspaceIds) || !input.workspaceIds.length || input.workspaceIds.some((id: unknown) => typeof id !== "string" || !id) ||
    new Set(input.workspaceIds).size !== input.workspaceIds.length || !Number.isSafeInteger(input.reconnectDelayMs) || input.reconnectDelayMs < 1 || input.reconnectDelayMs > 2_147_483_647) throw new Error("Invalid private owner host configuration.");
  let url: URL;
  try {url = new URL(input.url);} catch {throw new Error("Invalid private owner host URL.");}
  if (url.protocol !== "wss:" || url.username || url.password || url.pathname !== DEVICE_CONTROL_PATH || url.search || url.hash) {
    throw new Error("Invalid private owner host URL.");
  }
  const credentialBytes = readBoundedFile(input.credentialPath,16_384,"Owner host credential is too large.");
  const transport = input.transport;
  const control = parseDeviceControlLimits(input.control);
  const fields = ["aggregateBytes","maxAdoptionBytes","maxAdoptionEvents","maxFrameBytes","maxQueuedBytes","maxRegistrations","maxUploads","requestDeadlineMs"];
  if (!transport || Object.keys(transport).filter(field => field !== "maxRestoreBytes" && field !== "sync").sort().join() !== fields.join() ||
    fields.some(field => !Number.isSafeInteger(transport[field]) || transport[field] < 1) || transport.requestDeadlineMs > 2_147_483_647 ||
    transport.maxFrameBytes < 1_048_576 || transport.maxFrameBytes > 16_777_216 ||
    transport.maxQueuedBytes < Math.max(control.maxPayloadBytes + 16, transport.maxFrameBytes + 36) ||
    transport.maxAdoptionBytes * 3 + transport.maxFrameBytes * 4 > transport.aggregateBytes ||
    (transport.maxRestoreBytes !== undefined && (!Number.isSafeInteger(transport.maxRestoreBytes) || transport.maxRestoreBytes < 5 || transport.maxRestoreBytes > DEFAULT_MAX_BLOB_BYTES ||
      transport.maxRestoreBytes * 5 + transport.maxFrameBytes * 4 > transport.aggregateBytes))) throw new Error("Invalid private owner host transport budget.");
  const sync = parseOwnerLiveSyncConfig(transport.sync, transport.aggregateBytes - transport.maxFrameBytes * 3, transport.maxFrameBytes);
  return {nativeConfigPath: input.nativeConfigPath,url: url.href,workspaceIds: input.workspaceIds,reconnectDelayMs: input.reconnectDelayMs,
    transport: {...transport, sync},credential: parseDeviceHostCredential(JSON.parse(credentialBytes.toString("utf8"))),control};
}

/** Connects only the desktop's current daemon generation and opened workspace handles. */
export function startDesktopOwnerHost(options: {
  config: DesktopOwnerHostConfig;
  ownerFor: ExistingOwnerDeviceConfig["ownerFor"];
  bindings(): Promise<{client: EngineClient; workspaces: ExistingOwnerDeviceConfig["workspaces"]; assertCurrent(): void}>;
  onError(error: unknown): void;
}) {
  let stopped = false, connection: ReturnType<typeof connectDeviceHost> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  const connect = async () => {
    try {
      const bound = await options.bindings();
      if (stopped) return;
      bound.assertCurrent();
      let connected: ReturnType<typeof connectDeviceHost> | undefined;
      const assertCurrent = () => {
        try {bound.assertCurrent();}
        catch (error) {connected?.stop(); throw error;}
      };
      const ownerFor: ExistingOwnerDeviceConfig["ownerFor"] = binding => {
        assertCurrent(); const owner = options.ownerFor(binding);
        return {...owner,assertCurrent() {assertCurrent(); owner.assertCurrent();}};
      };
      connected = connectDeviceHost({url: options.config.url,credential: options.config.credential,limits: options.config.control,
        onRegistered: assertCurrent,existingOwner: {...options.config.transport,...bound,ownerFor}});
      connection = connected;
      await connected.closed;
    } catch (error) { if (!stopped) options.onError(error); }
    if (!stopped) {retry = setTimeout(() => {void connect();},options.config.reconnectDelayMs); retry.unref();}
  };
  void connect();
  return {stop() {stopped = true; clearTimeout(retry); connection?.stop();}};
}

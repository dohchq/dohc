import {readFileSync} from "node:fs";
import {isAbsolute} from "node:path";
import {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {connectDeviceHost,parseDeviceHostCredential,type ExistingOwnerDeviceConfig} from "@dohc/sync-relay/device-host";
import {parseDeviceControlLimits} from "@dohc/live-session-contract/device-control";

interface DesktopOwnerHostConfig {
  nativeConfigPath: string;
  url: string;
  credential: ReturnType<typeof parseDeviceHostCredential>;
  control: ReturnType<typeof parseDeviceControlLimits>;
  workspaceIds: string[];
  reconnectDelayMs: number;
  transport: Omit<ExistingOwnerDeviceConfig,"client"|"workspaces"|"ownerFor">;
}

export function readDesktopOwnerHostConfig(path: string): DesktopOwnerHostConfig {
  if (!isAbsolute(path)) throw new Error("Owner host configuration path must be absolute.");
  const bytes = readFileSync(path);
  if (bytes.length > 1_048_576) throw new Error("Owner host configuration is too large.");
  const input = JSON.parse(bytes.toString("utf8"));
  if (!input || Object.keys(input).sort().join() !== "control,credentialPath,nativeConfigPath,reconnectDelayMs,transport,url,version,workspaceIds" || input.version !== 1 ||
    typeof input.nativeConfigPath !== "string" || !isAbsolute(input.nativeConfigPath) || typeof input.credentialPath !== "string" || !isAbsolute(input.credentialPath) ||
    typeof input.url !== "string" || !Array.isArray(input.workspaceIds) || !input.workspaceIds.length || input.workspaceIds.some((id: unknown) => typeof id !== "string" || !id) ||
    new Set(input.workspaceIds).size !== input.workspaceIds.length || !Number.isSafeInteger(input.reconnectDelayMs) || input.reconnectDelayMs < 1) throw new Error("Invalid private owner host configuration.");
  const credentialBytes = readFileSync(input.credentialPath);
  if (credentialBytes.length > 16_384) throw new Error("Owner host credential is too large.");
  const transport = input.transport;
  const fields = ["aggregateBytes","maxAdoptionBytes","maxAdoptionEvents","maxFrameBytes","maxQueuedBytes","maxRegistrations","maxUploads","requestDeadlineMs"];
  if (!transport || Object.keys(transport).sort().join() !== fields.join() || fields.some(field => !Number.isSafeInteger(transport[field]) || transport[field] < 1)) throw new Error("Invalid private owner host transport budget.");
  return {nativeConfigPath: input.nativeConfigPath,url: input.url,workspaceIds: input.workspaceIds,reconnectDelayMs: input.reconnectDelayMs,
    transport,credential: parseDeviceHostCredential(JSON.parse(credentialBytes.toString("utf8"))),control: parseDeviceControlLimits(input.control)};
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

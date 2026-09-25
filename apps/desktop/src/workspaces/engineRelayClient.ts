import { runInKeyedLane } from "../keyedLane";
import {
  RelayApiVersionError,
  RelayConflictError,
  RelayKeyEnvelopeMissingError,
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  RelayUnreachableError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  SharedFileReadOnlyError,
  type CommitRelayCursorResult,
  type MaterializeRelayPullPage,
  type ProbeRelayWorkspaceResult,
  type RelayWorkspaceIdentity,
  type PullSharedChannelResult,
  MAX_REPORTED_REFUSALS,
  type RecordShareViewIdentityResult,
  type PullShareViewResult,
  type ShareViewRefusal,
  type SharingDeclined,
  type OwnerAdmissionPending,
  type PullWorkspaceFromRelayResult,
  type PushSharedChannelResult,
  type PushWorkspaceToRelayResult,
  type RecoverRelayOriginResult,
  type SubmitShareProposalResult,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import {
  DaemonRefusalError,
  decodeKeyEnvelopeResult,
  KEY_ENVELOPE_METHOD,
  WorkspaceDaemonRequester,
  type JsonValue,
  type KeyEnvelopeDownloadResult,
  type KeyEnvelopeUploadResult,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import type { EngineDaemonClient } from "@dohc/workspace-engine-client/daemon";
import {
  EngineWorkspaceSessions,
  type EngineDaemonClientSource,
  type EngineWorkspace,
} from "@dohc/workspace-engine-client/daemon";

export class MixedRelayTransportError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string, message: string) {
    super(`Relay transport for workspace ${workspaceId} is locked: ${message}`);
    this.name = "MixedRelayTransportError";
    this.workspaceId = workspaceId;
  }
}

interface RelayOpenConfiguration {
  [key: string]: JsonValue | undefined;
  baseUrl: string;
  bearerToken: string;
  allowInsecureLoopbackForTests?: boolean;
}

interface RelayRoute {
  readonly baseUrl: string;
  readonly locations: Map<string, RelayOpenConfiguration>;
}

function normalizedRelayUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

export const INSECURE_LOOPBACK_RELAY_TEST_ENV =
  "DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY";

const LOOPBACK_RELAY_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Single owner of the e2e escape hatch for the daemon's HTTPS-only relay
 * transport: true only when the explicit test env flag is "1" And the relay
 * URL is plain http to a loopback host. Everything else (flag unset, https,
 * non-loopback host, unparseable URL) keeps the secure default.
 */
export function allowInsecureLoopbackRelayForTests(
  relayBaseUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env[INSECURE_LOOPBACK_RELAY_TEST_ENV] !== "1") return false;
  let url: URL;
  try {
    url = new URL(relayBaseUrl);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_RELAY_HOSTNAMES.has(url.hostname);
}

/**
 * Process-lifetime authority for the relay origin used by a logical
 * workspace. A live route can refresh its bearer token, but it cannot change
 * origin. A legitimate relay change releases the route only after its daemon
 * workspace session has closed.
 */
export class RelayTransportRouteGuard {
  private readonly routes = new Map<string, RelayRoute>();

  bind(input: {
    workspaceId: string;
    rootPath: string;
    relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
    allowInsecureLoopbackForTests?: boolean;
  }): void {
    const baseUrl = normalizedRelayUrl(input.relay.baseUrl);
    const existing = this.routes.get(input.workspaceId);
    if (existing && existing.baseUrl !== baseUrl) {
      throw new MixedRelayTransportError(
        input.workspaceId,
        "already belongs to a different relay origin",
      );
    }
    const route =
      existing ??
      {
        baseUrl,
        locations: new Map<string, RelayOpenConfiguration>(),
      };
    if (!existing) this.routes.set(input.workspaceId, route);
    route.locations.set(input.rootPath, {
      baseUrl,
      bearerToken: input.relay.token,
      ...(input.allowInsecureLoopbackForTests
        ? { allowInsecureLoopbackForTests: true }
        : {}),
    });
  }

  isBound(workspaceId: string): boolean {
    return this.routes.has(workspaceId);
  }

  releaseWorkspace(workspaceId: string): void {
    this.routes.delete(workspaceId);
  }

  releaseLocation(workspaceId: string, rootPath: string): void {
    const route = this.routes.get(workspaceId);
    if (!route) return;
    route.locations.delete(rootPath);
    if (route.locations.size === 0) this.routes.delete(workspaceId);
  }

  workspaceIds(): string[] {
    return [...this.routes.keys()];
  }

  relayForOpen(
    workspaceId: string,
    rootPath: string,
  ): RelayOpenConfiguration | null {
    return this.routes.get(workspaceId)?.locations.get(rootPath) ?? null;
  }
}

class RelayConfiguredDaemonClient implements EngineDaemonClient {
  // Preserve the optional request and event capabilities used by workspace sessions.
  readonly cancelRequest?: EngineDaemonClient["cancelRequest"];
  readonly onBlob?: EngineDaemonClient["onBlob"];
  readonly onEvent?: EngineDaemonClient["onEvent"];

  get helloAck(): EngineDaemonClient["helloAck"] {
    return this.client.helloAck;
  }

  constructor(
    private readonly client: EngineDaemonClient,
    private readonly routes: RelayTransportRouteGuard,
  ) {
    if (client.cancelRequest) this.cancelRequest = client.cancelRequest.bind(client);
    if (client.onBlob) this.onBlob = client.onBlob.bind(client);
    if (client.onEvent) this.onEvent = client.onEvent.bind(client);
  }

  async sendRequest(request: Request): Promise<Response> {
    if (request.method !== "workspace.open") {
      return await this.client.sendRequest(request);
    }
    const params = resultRecord(request.params, "workspace.open params");
    const rootPath = stringField(params, "rootDir", "workspace.open params");
    const workspaceId = stringField(
      params,
      "workspaceId",
      "workspace.open params",
    );
    const relay = this.routes.relayForOpen(workspaceId, rootPath);
    return await this.client.sendRequest({
      ...request,
      params: relay ? { ...params, relay } : params,
    });
  }

  close(): void {
    this.client.close();
  }
}

/**
 * Stable proxy identity per daemon generation. EngineWorkspaceSessions uses
 * client object identity to detect sidecar restarts, so wrapping on every read
 * would force a needless re-open for every operation.
 */
export class RelayConfiguredDaemonClientSource
  implements EngineDaemonClientSource
{
  private readonly wrappers = new WeakMap<
    EngineDaemonClient,
    RelayConfiguredDaemonClient
  >();

  constructor(
    private readonly source: EngineDaemonClientSource,
    private readonly routes: RelayTransportRouteGuard,
  ) {}

  currentClient(): EngineDaemonClient {
    const client = this.source.currentClient();
    const existing = this.wrappers.get(client);
    if (existing) return existing;
    const wrapper = new RelayConfiguredDaemonClient(client, this.routes);
    this.wrappers.set(client, wrapper);
    return wrapper;
  }
}

function resultRecord(
  value: JsonValue,
  label: string,
): Record<string, JsonValue | undefined> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Rust engine ${label} must be an object.`);
  }
  return value;
}

function stringField(
  value: Record<string, JsonValue | undefined>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Rust engine ${label}.${key} must be a string.`);
  }
  return field;
}

function numberField(
  value: Record<string, JsonValue | undefined>,
  key: string,
  label: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`Rust engine ${label}.${key} must be a non-negative integer.`);
  }
  return field;
}

// A field the engine states as a string OR as an explicit null, where null is
// a real answer and not an absence. Strict on both sides: an empty string, a
// missing key and any other type are all refused, because reading one of them
// as null invents an answer the engine did not give.
function nullableStringField(
  value: Record<string, JsonValue | undefined>,
  key: string,
  label: string,
): string | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Rust engine ${label}.${key} must be a string or null.`);
  }
  return field;
}

function booleanField(
  value: Record<string, JsonValue | undefined>,
  key: string,
  label: string,
): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`Rust engine ${label}.${key} must be a boolean.`);
  }
  return field;
}

function assertRelayPullProgress(
  label: string,
  previousCursor: number | null,
  nextCursor: number,
  hasMore: boolean,
): void {
  if (hasMore && previousCursor !== null && nextCursor <= previousCursor) {
    throw new Error(`Rust engine ${label} pagination made no progress.`);
  }
}

function changedPaths(
  value: JsonValue | undefined,
  label: string,
  allowSecret: true,
): Array<{
  versionId: string;
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary" | "secret";
}>;
function changedPaths(
  value: JsonValue | undefined,
  label: string,
  allowSecret?: false,
): Array<{
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary";
}>;
function changedPaths(
  value: JsonValue | undefined,
  label: string,
  allowSecret = false,
): Array<{
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary" | "secret";
}> {
  if (!Array.isArray(value)) {
    throw new Error(`Rust engine ${label}.changedPaths must be an array.`);
  }
  return value.map((entry, index) => {
    const record = resultRecord(entry, `${label}.changedPaths[${index}]`);
    const versionId = allowSecret
      ? stringField(record, "versionId", `${label}.changedPaths[${index}]`)
      : undefined;
    const path = stringField(record, "path", `${label}.changedPaths[${index}]`);
    const operation = record.operation;
    const contentKind = record.contentKind;
    if (operation !== "write" && operation !== "delete") {
      throw new Error(
        `Rust engine ${label}.changedPaths[${index}].operation is invalid.`,
      );
    }
    if (
      contentKind !== "text" &&
      contentKind !== "binary" &&
      !(allowSecret && contentKind === "secret")
    ) {
      throw new Error(
        `Rust engine ${label}.changedPaths[${index}].contentKind is invalid.`,
      );
    }
    return {
      ...(versionId !== undefined ? { versionId } : {}),
      path,
      operation,
      contentKind,
    };
  });
}

// The refusals a share-view page reports. Strict: a malformed entry throws
// rather than being dropped, because a dropped refusal is the silent skip this
// exists to end.
function shareViewRefusals(
  value: JsonValue | undefined,
  label: string,
): Array<{
  originId: string;
  originSeq: number;
  opKind: string;
  code: string;
  detail: string;
}> {
  if (!Array.isArray(value)) {
    throw new Error(`Rust engine ${label}.refusals must be an array.`);
  }
  return value.map((entry, index) => {
    const at = `${label}.refusals[${index}]`;
    const record = resultRecord(entry, at);
    return {
      originId: stringField(record, "originId", at),
      originSeq: numberField(record, "originSeq", at),
      opKind: stringField(record, "opKind", at),
      code: stringField(record, "code", at),
      detail: stringField(record, "detail", at),
    };
  });
}

function ownerAdmissionPending(value: unknown): OwnerAdmissionPending[] {
  if (!Array.isArray(value)) throw new Error("Rust engine sync.push.ownerAdmissionPending must be an array.");
  return value.map(item => {
    const row = resultRecord(item, "sync.push.ownerAdmissionPending");
    const text = (key: string) => stringField(row, key, "sync.push.ownerAdmissionPending");
    return {workspaceId: text("workspaceId"), originId: text("originId"), originSeq: numberField(row, "originSeq", "sync.push.ownerAdmissionPending"),
      versionId: text("versionId"), objectId: text("objectId"), path: text("path")};
  });
}

function sharingDeclined(
  value: JsonValue | undefined,
  label: string,
): SharingDeclined[] {
  if (!Array.isArray(value)) {
    throw new Error(`Rust engine ${label}.sharingDeclined must be an array.`);
  }
  return value.map((entry, index) => {
    const at = `${label}.sharingDeclined[${index}]`;
    const record = resultRecord(entry, at);
    return {
      path: stringField(record, "path", at),
      constraint: stringField(record, "constraint", at),
      limitBytes: numberField(record, "limitBytes", at),
      observedBytes: numberField(record, "observedBytes", at),
    };
  });
}

function pendingCursor(
  value: JsonValue | undefined,
  label: string,
): Record<string, JsonValue | undefined> {
  const cursor = resultRecord(value ?? null, `${label}.pendingCursor`);
  stringField(cursor, "kind", `${label}.pendingCursor`);
  stringField(cursor, "token", `${label}.pendingCursor`);
  return cursor;
}

const SYNC_PASS_METHODS: ReadonlySet<string> = new Set([
  "sync.push",
  "sync.pull",
  "sync.commitCursor",
  "sync.recoverOrigin",
]);

function translateRelayError(method: string, error: unknown): never {
  if (!(error instanceof DaemonRefusalError)) throw error;
  if (error.wireCode === "AUTH_FAILED") throw new RelayUnauthorizedError();
  if (error.wireCode === "PROTOCOL_VERSION_UNSUPPORTED") {
    if (error.message === "relay-api-version-too-old") throw new RelayApiVersionError("app");
    if (error.message === "relay-api-version-too-new") throw new RelayApiVersionError("server");
  }
  if (error.wireCode === "SHARE_UNAVAILABLE") {
    throw new ShareUnavailableError();
  }
  if (error.wireCode === "CONFLICT") throw new RelayConflictError();
  if (error.wireCode === "KEY_ENVELOPE_MISSING") {
    throw new RelayKeyEnvelopeMissingError();
  }
  if (error.wireCode === "WORKSPACE_UNAVAILABLE") {
    if (method.startsWith("share.")) throw new ShareUnavailableError();
    // Only the sync pass names this cause today; the enable and join flows
    // keep their own reading of an unavailable workspace.
    if (SYNC_PASS_METHODS.has(method) && error.message === "relay-unreachable") {
      throw new RelayUnreachableError();
    }
    throw new RelayWorkspaceUnavailableError();
  }
  if (
    (method === "sync.push" || method === "sync.pull") &&
    error.wireCode === "INVALID_PARAMS" &&
    error.message === "relay-origin-diverged"
  ) {
    throw new RelayOriginDivergedError();
  }
  if (
    method === "share.channel.push" &&
    error.wireCode === "INVALID_PARAMS" &&
    error.message === "share-read-only"
  ) {
    throw new SharedChannelReadOnlyError();
  }
  // The same relay refusal, one noun over. The relay answers one code
  // for both — that is the anti-fingerprinting property — so the method, not
  // the code, decides which noun the reader sees. Proposal submission is a
  // file-share operation, so this reads as the file.
  if (
    method === "share.proposal.submit" &&
    error.wireCode === "INVALID_PARAMS" &&
    error.message === "share-read-only"
  ) {
    throw new SharedFileReadOnlyError();
  }
  throw error;
}

export interface EngineRelayWorkspaceClient {
  push(): Promise<PushWorkspaceToRelayResult>;
  pull(
    materializePage: MaterializeRelayPullPage,
  ): Promise<PullWorkspaceFromRelayResult>;
  commitCursor(
    cursor: Record<string, JsonValue | undefined>,
  ): Promise<CommitRelayCursorResult>;
  recoverOrigin(): Promise<RecoverRelayOriginResult>;
  claim(): Promise<void>;
  bootstrapJoinIdentity(
    identity: RelayWorkspaceIdentity | null,
    initialize?: () => Promise<void>,
  ): Promise<void>;
  probe(): Promise<ProbeRelayWorkspaceResult>;
  uploadKeyEnvelope(input: {
    envelopeJson: string;
    ifMatch?: string;
  }): Promise<KeyEnvelopeUploadResult>;
  downloadKeyEnvelope(): Promise<KeyEnvelopeDownloadResult>;
  pullSharedChannel(input: {
    shareId: string;
    channelWireId: string;
    // Called after each page whose ops the engine applied. The engine commits
    // a page before the next one is requested, so a caller learns of applied
    // ops even when a later page fails.
    onApplied?: () => void;
  }): Promise<PullSharedChannelResult>;
  pushSharedChannel(input: {
    shareId: string;
    channelWireId: string;
  }): Promise<PushSharedChannelResult>;
  pullShareView(input: {
    shareId: string;
    // The selector the relay stated for this share, pinned on first read.
    // Required, because the engine has no unscoped pull: a caller that cannot
    // resolve a selector must skip its refresh, not widen it.
    grantedSelector: {
      paths: readonly string[];
      versionId: string | null;
      access: ShareAccess;
    };
    // Called with each page's refusals BEFORE that page's cursor is
    // committed. A refusal is a durable fact — the commit moves permanently
    // past the op — so it has to be recorded first, or a later page that
    // fails takes the earlier page's reasons with it while its cursor stays
    // committed.
    recordRefusals?: (refusals: ShareViewRefusal[]) => Promise<void>;
    // Called with each page's changed paths before that page's cursor is
    // committed, so callers can persist collision exclusions first.
    recordCollisions?: (paths: readonly string[]) => Promise<void>;
    // Called after the page is applied but before any collision work or cursor
    // advance. A received-share projection can therefore persist recovery
    // debt for every applied page, even if fetching a later page fails.
    recordChangedPaths?: (paths: readonly string[]) => Promise<void>;
  }): Promise<PullShareViewResult>;
  // Give an Edit share view the sync identity its proposal lane needs. Run at
  // open and on refresh. The engine writes the row once and later calls answer
  // "already-recorded".
  //
  // Takes the pinned selector and no share id. `sync_identity` is per
  // WORKSPACE and a share view mirrors exactly one share, so the id it would
  // carry decides nothing. The selector admits only Edit because only that
  // level can submit a document proposal.
  //
  // The identity components are minted by the ENGINE, the same way sync.claim
  // mints its own. The origin is a REPLICA id — the relay namespaces this
  // recipient's ops as `share:<shareId>:<originId>` — so it must never be the
  // recipient's user id, which two of their devices would share. Minting it
  // engine-side is also what makes a refresh safe: the durable row is the
  // record, so nothing here has to remember an id between calls.
  recordShareViewIdentity(input: {
    grantedSelector: {
      paths: readonly string[];
      versionId: string | null;
      access: ShareAccess;
    };
  }): Promise<RecordShareViewIdentityResult>;

  // This replica's own edits of the shared files, offered to the
  // granter to accept or decline. Takes the same pinned selector, for the
  // same reason, and the engine offers nothing below `edit`.
  submitShareProposal(input: {
    shareId: string;
    grantedSelector: {
      paths: readonly string[];
      versionId: string | null;
      access: ShareAccess;
    };
    // The idempotency key for one submit. The caller owns it so a retry of
    // the same intent answers with the proposal the relay already holds
    // instead of opening a second one.
    submitId: string;
  }): Promise<SubmitShareProposalResult>;
}

export interface EngineRelayClientOptions {
  sessions: EngineWorkspaceSessions;
  routes: RelayTransportRouteGuard;
  /** Closes the captured binding without re-entering this client's request lane. */
  closeWorkspaceBinding?(workspace: EngineWorkspace): Promise<void>;
  allowInsecureLoopbackForTests?: boolean;
  requestDeadlineMs?: number;
}

const DEFAULT_RELAY_REQUEST_DEADLINE_MS = 30_000;

export class EngineRelayClient {
  private readonly sessions: EngineWorkspaceSessions;
  private readonly routes: RelayTransportRouteGuard;
  private readonly closeWorkspaceBinding: (workspace: EngineWorkspace) => Promise<void>;
  private readonly allowInsecureLoopbackForTests: boolean;
  private readonly requestDeadlineMs: number;
  private readonly activeLocations = new Map<string | symbol, string>();
  private readonly boundWorkspaces = new Map<string | symbol, EngineWorkspace>();
  private readonly lanes = new Map<string | symbol, Promise<void>>();

  constructor(options: EngineRelayClientOptions) {
    this.sessions = options.sessions;
    this.routes = options.routes;
    this.closeWorkspaceBinding = options.closeWorkspaceBinding ??
      (workspace => this.sessions.closeWorkspaceBinding(workspace).catch(() => undefined));
    this.allowInsecureLoopbackForTests =
      options.allowInsecureLoopbackForTests === true;
    this.requestDeadlineMs =
      options.requestDeadlineMs ?? DEFAULT_RELAY_REQUEST_DEADLINE_MS;
  }

  bind(input: {
    workspaceId: string;
    rootPath: string;
    attachmentId?: symbol;
    shareMount?: true;
    relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
  }): EngineRelayWorkspaceClient {
    const workspace: EngineWorkspace = {
      workspaceId: input.workspaceId,
      rootPath: input.rootPath,
      ...(input.attachmentId !== undefined
        ? { attachmentId: input.attachmentId }
        : {}),
      ...(input.shareMount === true ? { shareMount: true } : {}),
    };
    this.routes.bind({
      ...input,
      allowInsecureLoopbackForTests:
        this.allowInsecureLoopbackForTests ||
        allowInsecureLoopbackRelayForTests(input.relay.baseUrl),
    });
    if (workspace.shareMount === true) {
      this.sessions.rememberShareMount({ ...workspace, shareMount: true });
    }
    const workspaceKey = this.workspaceKey(workspace);
    this.boundWorkspaces.set(workspaceKey, workspace);
    const connectionKey = `${input.rootPath}\u0000${input.relay.token}`;
    const requestFor = async (
      targetWorkspace: EngineWorkspace,
      method: string,
      params: Record<string, JsonValue | undefined>,
    ): Promise<JsonValue> =>
      await runInKeyedLane(this.lanes, workspaceKey, async () => {
        if (this.activeLocations.get(workspaceKey) !== connectionKey) {
          await this.closeWorkspaceBinding(workspace);
          this.activeLocations.set(workspaceKey, connectionKey);
        }
        try {
          return await this.sessions.run(
            targetWorkspace,
            async ({ client, workspace: handle }) => {
              this.retainBoundWorkspace(workspaceKey, workspace);
              const requester = new WorkspaceDaemonRequester(client);
              return await requester.request(method, params, {
                workspace: handle,
                deadlineMs: this.requestDeadlineMs,
              });
            },
            { retryTransportErrors: true },
          );
        } catch (error) {
          translateRelayError(method, error);
        }
      });
    const request = async (
      method: string,
      params: Record<string, JsonValue | undefined>,
    ): Promise<JsonValue> => await requestFor(workspace, method, params);
    const bootstrapRequest = async (
      method: string,
      params: Record<string, JsonValue | undefined>,
    ): Promise<JsonValue> =>
      await requestFor(
        { ...workspace, captureMode: "none" },
        method,
        params,
      );

    const commitCursor = async (
      cursor: Record<string, JsonValue | undefined>,
    ): Promise<CommitRelayCursorResult> => {
      const result = resultRecord(
        await request("sync.commitCursor", {
          workspaceId: workspace.workspaceId,
          pendingCursor: cursor,
        }),
        "sync.commitCursor",
      );
      if (!booleanField(result, "committed", "sync.commitCursor")) {
        throw new Error("Rust engine sync.commitCursor did not commit.");
      }
      return {
        sharingDeclined: sharingDeclined(
          result.sharingDeclined,
          "sync.commitCursor",
        ),
      };
    };

    const appendDeclines = (
      target: SharingDeclined[],
      source: readonly SharingDeclined[],
    ): void => {
      const remaining = MAX_REPORTED_REFUSALS - target.length;
      if (remaining > 0) target.push(...source.slice(0, remaining));
    };

    const claimWith = async (
      requester: typeof request,
    ): Promise<void> => {
      const result = resultRecord(
        await requester("sync.claim", { workspaceId: workspace.workspaceId }),
        "sync.claim",
      );
      if (!booleanField(result, "claimed", "sync.claim")) {
        throw new Error("Rust engine sync.claim did not claim the workspace.");
      }
    };
    const claim = async (): Promise<void> => await claimWith(request);

    const adoptJoinIdentity = async (
      identity: RelayWorkspaceIdentity,
      requester: typeof request,
    ): Promise<void> => {
      const result = resultRecord(
        await requester("sync.adoptJoinIdentity", {
          workspaceId: workspace.workspaceId,
          replicationEpoch: identity.replicationEpoch,
          streamIdentity: identity.streamIdentity,
        }),
        "sync.adoptJoinIdentity",
      );
      if (!booleanField(result, "adopted", "sync.adoptJoinIdentity")) {
        throw new Error(
          "Rust engine sync.adoptJoinIdentity did not adopt the relay identity.",
        );
      }
    };

    return {
      push: async () => {
        const result = resultRecord(
          await request("sync.push", { workspaceId: workspace.workspaceId }),
          "sync.push",
        );
        return {
          pushed: numberField(result, "pushed", "sync.push"),
          // The daemon owns all origin selection; desktop callers only consume
          // the count, so no origin identifiers cross the process boundary.
          originsPushed: [],
          ownerAdmissionPending: ownerAdmissionPending(result.ownerAdmissionPending),
          sharingDeclined: sharingDeclined(
            result.sharingDeclined,
            "sync.push",
          ),
        };
      },
      pull: async (materializePage) => {
        let fetched = 0;
        let applied = 0;
        let skipped = 0;
        let conflictsOpened = 0;
        let nextCursor = 0;
        let previousCursor: number | null = null;
        const declines: SharingDeclined[] = [];
        const changed = new Map<
          string,
          {
            versionId: string;
            path: string;
            operation: "write" | "delete";
            contentKind: "text" | "binary" | "secret";
          }
        >();
        for (;;) {
          const result = resultRecord(
            await request("sync.pull", { workspaceId: workspace.workspaceId }),
            "sync.pull",
          );
          const cursor = pendingCursor(result.pendingCursor, "sync.pull");
          const pageCursor = numberField(result, "nextCursor", "sync.pull");
          const hasMore = booleanField(result, "hasMore", "sync.pull");
          assertRelayPullProgress(
            "sync.pull",
            previousCursor,
            pageCursor,
            hasMore,
          );
          previousCursor = pageCursor;
          nextCursor = pageCursor;
          fetched += numberField(result, "fetched", "sync.pull");
          applied += numberField(result, "applied", "sync.pull");
          skipped += numberField(result, "skipped", "sync.pull");
          conflictsOpened += numberField(
            result,
            "conflictsOpened",
            "sync.pull",
          );
          appendDeclines(
            declines,
            sharingDeclined(result.sharingDeclined, "sync.pull"),
          );
          const pageChangedPaths = changedPaths(
            result.changedPaths,
            "sync.pull",
            true,
          );
          for (const path of pageChangedPaths) {
            changed.set(`${path.versionId}\0${path.path}`, path);
          }
          await materializePage(pageChangedPaths);
          appendDeclines(declines, (await commitCursor(cursor)).sharingDeclined);
          if (!hasMore) break;
        }
        return {
          fetched,
          applied,
          skipped,
          conflictsOpened,
          sharingDeclined: declines,
          fastForwardedPaths: [...changed.values()],
          nextCursor,
        };
      },
      commitCursor,
      recoverOrigin: async () => {
        const result = resultRecord(
          await request("sync.recoverOrigin", {
            workspaceId: workspace.workspaceId,
          }),
          "sync.recoverOrigin",
        );
        return {
          oldOriginId: stringField(
            result,
            "oldOriginId",
            "sync.recoverOrigin",
          ),
          newOriginId: stringField(
            result,
            "newOriginId",
            "sync.recoverOrigin",
          ),
          sharedPrefixLength: numberField(
            result,
            "sharedPrefixLength",
            "sync.recoverOrigin",
          ),
          preservedOps: numberField(
            result,
            "preservedOps",
            "sync.recoverOrigin",
          ),
        };
      },
      claim,
      bootstrapJoinIdentity: async (identity, initialize) => {
        try {
          if (identity === null) {
            await claimWith(bootstrapRequest);
          } else {
            await adoptJoinIdentity(identity, bootstrapRequest);
          }
          // Join-only initialization shares the capture-free binding. This
          // lets the product download and install a wrapped workspace key
          // before capture opens and before the first pull materializes files.
          await initialize?.();
        } finally {
          // The bootstrap session is intentionally capture-free. Close it so
          // activity.open creates the ordinary captured session only after the
          // authoritative coordinate is durable. Keep the relay route: the
          // first ordinary pull reopens this same client through it.
          await runInKeyedLane(this.lanes, workspaceKey, async () => {
            await this.sessions.closeWorkspace(workspace);
          });
        }
      },
      probe: async () => {
        const result = resultRecord(
          await request("sync.probe", { workspaceId: workspace.workspaceId }),
          "sync.probe",
        );
        return { hasContent: booleanField(result, "hasContent", "sync.probe") };
      },
      uploadKeyEnvelope: async ({ envelopeJson, ifMatch }) =>
        decodeKeyEnvelopeResult(
          KEY_ENVELOPE_METHOD.upload,
          await request(KEY_ENVELOPE_METHOD.upload, {
            workspaceId: workspace.workspaceId,
            envelopeJson,
            ...(ifMatch === undefined ? {} : { ifMatch }),
          }),
        ),
      downloadKeyEnvelope: async () =>
        decodeKeyEnvelopeResult(
          KEY_ENVELOPE_METHOD.download,
          await request(KEY_ENVELOPE_METHOD.download, {
            workspaceId: workspace.workspaceId,
          }),
        ),
      pullSharedChannel: async ({ shareId, channelWireId, onApplied }) => {
        let fetched = 0;
        let applied = 0;
        let skipped = 0;
        let nextCursor = 0;
        let previousCursor: number | null = null;
        for (;;) {
          const result = resultRecord(
            await request("share.channel.pull", {
              workspaceId: workspace.workspaceId,
              shareId,
              channelWireId,
            }),
            "share.channel.pull",
          );
          const pageCursor = numberField(
            result,
            "nextCursor",
            "share.channel.pull",
          );
          const hasMore = booleanField(
            result,
            "hasMore",
            "share.channel.pull",
          );
          assertRelayPullProgress(
            "share.channel.pull",
            previousCursor,
            pageCursor,
            hasMore,
          );
          previousCursor = pageCursor;
          nextCursor = pageCursor;
          const pageApplied = numberField(result, "applied", "share.channel.pull");
          fetched += numberField(result, "fetched", "share.channel.pull");
          applied += pageApplied;
          skipped += numberField(result, "skipped", "share.channel.pull");
          if (pageApplied > 0) onApplied?.();
          if (!hasMore) break;
        }
        return {
          fetched,
          applied,
          skipped,
          nextCursor,
        };
      },
      pushSharedChannel: async ({ shareId, channelWireId }) => {
        const result = resultRecord(
          await request("share.channel.push", {
            workspaceId: workspace.workspaceId,
            shareId,
            channelWireId,
          }),
          "share.channel.push",
        );
        return {
          pushed: numberField(result, "pushed", "share.channel.push"),
        };
      },
      recordShareViewIdentity: async ({ grantedSelector }) => {
        const result = resultRecord(
          await request("share.view.recordIdentity", {
            workspaceId: workspace.workspaceId,
            grantedSelector: {
              paths: [...grantedSelector.paths],
              versionId: grantedSelector.versionId,
              access: grantedSelector.access,
            },
          }),
          "share.view.recordIdentity",
        );
        const identity = stringField(result, "identity", "share.view.recordIdentity");
        // Fail closed on an answer this build cannot read: an unknown state
        // is not a narrower one, and reporting it as recorded would claim a
        // row nobody checked.
        if (
          identity !== "recorded" &&
          identity !== "already-recorded" &&
          identity !== "not-required"
        ) {
          throw new Error(
            `Rust engine share.view.recordIdentity returned an unknown identity state: ${identity}`,
          );
        }
        return { identity };
      },
      submitShareProposal: async ({ shareId, grantedSelector, submitId }) => {
        const result = resultRecord(
          await request("share.proposal.submit", {
            workspaceId: workspace.workspaceId,
            shareId,
            grantedSelector: {
              paths: [...grantedSelector.paths],
              versionId: grantedSelector.versionId,
              access: grantedSelector.access,
            },
            submitId,
          }),
          "share.proposal.submit",
        );
        const submitted = numberField(
          result,
          "submitted",
          "share.proposal.submit",
        );
        const proposalId = nullableStringField(
          result,
          "proposalId",
          "share.proposal.submit",
        );
        // The two fields state one fact between them: a proposal exists, and
        // it holds these changes. Either half alone is a result no caller can
        // act on — an id with nothing in it, or changes with nothing to show
        // the sender or to withdraw.
        if ((proposalId === null) !== (submitted === 0)) {
          throw new Error(
            "Rust engine share.proposal.submit disagreed with itself about " +
              "whether it opened a proposal.",
          );
        }
        return {
          submitted,
          proposalId,
          skippedOutsideShare: numberField(
            result,
            "skippedOutsideShare",
            "share.proposal.submit",
          ),
          morePending: booleanField(result, "morePending", "share.proposal.submit"),
        };
      },
      pullShareView: async ({
        shareId,
        grantedSelector,
        recordRefusals,
        recordCollisions,
        recordChangedPaths,
      }) => {
        let fetched = 0;
        let applied = 0;
        let skipped = 0;
        let refusalCount = 0;
        const refusals: Array<{
          originId: string;
          originSeq: number;
          opKind: string;
          code: string;
          detail: string;
        }> = [];
        let nextCursor = 0;
        let previousCursor: number | null = null;
        let finalCursor: Record<string, JsonValue | undefined> | null = null;
        const changed = new Map<
          string,
          {
            path: string;
            operation: "write" | "delete";
            contentKind: "text" | "binary";
          }
        >();
        for (;;) {
          const result = resultRecord(
            await request("share.view.pull", {
              workspaceId: workspace.workspaceId,
              shareId,
              // Every dimension, always. Dropping the paths leaves a grant
              // that selects everything under a version; dropping the version
              // leaves one the engine refuses outright; dropping the level
              // leaves one the engine cannot read and refuses too.
              grantedSelector: {
                paths: [...grantedSelector.paths],
                versionId: grantedSelector.versionId,
                access: grantedSelector.access,
              },
            }),
            "share.view.pull",
          );
          const cursor = pendingCursor(
            result.pendingCursor,
            "share.view.pull",
          );
          const pageCursor = numberField(
            result,
            "nextCursor",
            "share.view.pull",
          );
          const hasMore = booleanField(
            result,
            "hasMore",
            "share.view.pull",
          );
          assertRelayPullProgress(
            "share.view.pull",
            previousCursor,
            pageCursor,
            hasMore,
          );
          previousCursor = pageCursor;
          nextCursor = pageCursor;
          fetched += numberField(result, "fetched", "share.view.pull");
          applied += numberField(result, "applied", "share.view.pull");
          skipped += numberField(result, "skipped", "share.view.pull");
          // Every page's refusals, not just the last: a share can go stale on
          // a page the caller never sees the end of.
          const pageRefusals = shareViewRefusals(
            result.refusals,
            "share.view.pull",
          );
          refusalCount += pageRefusals.length;
          // Bounded: the durable record holds every reason (it is written
          // below, before this page's cursor commits), so this aggregate only
          // has to carry enough to log and to show. Without the cap a relay
          // that refuses on every page grows this array with its log.
          for (const refusal of pageRefusals) {
            if (refusals.length >= MAX_REPORTED_REFUSALS) break;
            refusals.push(refusal);
          }
          // Record before the commit below. Once that cursor is committed the
          // pull never offers these ops again, so a throw on a later page must
          // not be able to take the reason with it.
          if (pageRefusals.length > 0) await recordRefusals?.(pageRefusals);
          const pageChangedPaths = changedPaths(
            result.changedPaths,
            "share.view.pull",
          );
          if (pageChangedPaths.length > 0) {
            const paths = pageChangedPaths.map((path) => path.path);
            await recordChangedPaths?.(paths);
            await recordCollisions?.(paths);
          }
          for (const path of pageChangedPaths) {
            changed.set(path.path, path);
          }
          if (!hasMore) {
            finalCursor = cursor;
            break;
          }
          await commitCursor(cursor);
        }
        if (!finalCursor) {
          throw new Error(
            "Rust engine share.view.pull returned no final cursor.",
          );
        }
        return {
          fetched,
          applied,
          skipped,
          refusals,
          refusalCount,
          changedPaths: [...changed.values()],
          nextCursor,
          // Share-view pulls do not surface `sharingDeclined` (out of scope
          // for share views) — discard the richer relay-cursor result the
          // shared `commitCursor` closure now returns.
          commitCursor: async () => {
            await commitCursor(finalCursor);
          },
        };
      },
    };
  }

  async closeWorkspace(workspace: string | EngineWorkspace): Promise<void> {
    const workspaceId =
      typeof workspace === "string" ? workspace : workspace.workspaceId;
    const workspaceKey = this.workspaceKey(workspace);
    await runInKeyedLane(this.lanes, workspaceKey, async () => {
      const registered = this.boundWorkspaces.get(workspaceKey);
      const descriptor =
        registered ?? (typeof workspace === "string" ? null : workspace);
      await this.sessions.closeWorkspace(descriptor ?? workspace);
      this.activeLocations.delete(workspaceKey);
      if (this.boundWorkspaces.get(workspaceKey) === registered) {
        this.boundWorkspaces.delete(workspaceKey);
      }
      if (
        descriptor !== null &&
        !this.hasBoundLocation(workspaceId, descriptor.rootPath)
      ) {
        this.routes.releaseLocation(workspaceId, descriptor.rootPath);
      }
      if (!this.hasBoundWorkspace(workspaceId)) {
        this.routes.releaseWorkspace(workspaceId);
      }
    });
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.boundWorkspaces.values()].map(async (workspace) => {
        await this.closeWorkspace(workspace);
      }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Rust engine relay sessions did not all close.",
      );
    }
  }

  private workspaceKey(workspace: string | EngineWorkspace): string | symbol {
    return typeof workspace === "string"
      ? workspace
      : (workspace.attachmentId ?? workspace.workspaceId);
  }

  private hasBoundWorkspace(workspaceId: string): boolean {
    return [...this.boundWorkspaces.values()].some(
      (workspace) => workspace.workspaceId === workspaceId,
    );
  }

  private retainBoundWorkspace(
    workspaceKey: string | symbol,
    workspace: EngineWorkspace,
  ): void {
    this.boundWorkspaces.set(workspaceKey, workspace);
    for (const [candidateKey, candidate] of this.boundWorkspaces) {
      if (
        candidateKey === workspaceKey ||
        candidate.workspaceId !== workspace.workspaceId
      ) {
        continue;
      }
      this.boundWorkspaces.delete(candidateKey);
      this.activeLocations.delete(candidateKey);
      if (!this.hasBoundLocation(candidate.workspaceId, candidate.rootPath)) {
        this.routes.releaseLocation(candidate.workspaceId, candidate.rootPath);
      }
    }
  }

  private hasBoundLocation(workspaceId: string, rootPath: string): boolean {
    return [...this.boundWorkspaces.values()].some(
      (workspace) =>
        workspace.workspaceId === workspaceId &&
        workspace.rootPath === rootPath,
    );
  }
}

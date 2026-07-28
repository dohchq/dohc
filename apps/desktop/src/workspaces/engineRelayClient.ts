import {
  RelayConflictError,
  RelayKeyEnvelopeMissingError,
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  probeRelayWorkspace,
  type PendingConflictResolve,
  type ProbeRelayWorkspaceResult,
  type PullSharedChannelResult,
  type PullShareViewResult,
  type PullWorkspaceFromRelayResult,
  type PushSharedChannelResult,
  type PushWorkspaceToRelayResult,
  type RecoverRelayOriginResult,
  type SyncRelayConnection,
} from "@dohc/workspace-engine";
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
import type {
  EngineDaemonClient,
} from "./engineDaemonLifecycle";
import {
  EngineWorkspaceSessions,
  type EngineDaemonClientSource,
  type EngineWorkspace,
} from "./engineWorkspaceSessions";

export type RelayTransportMode = "typescript" | "daemon";

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
  readonly mode: RelayTransportMode;
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
 * transport: true only when the explicit test env flag is "1" AND the relay
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
 * Process-lifetime authority for the relay implementation used by a logical
 * workspace + relay origin. A live route can refresh its bearer token, but it
 * cannot mix implementations or origins. A legitimate relay change releases
 * the route only after its daemon workspace session has closed.
 */
export class RelayTransportRouteGuard {
  private readonly routes = new Map<string, RelayRoute>();

  bind(input: {
    workspaceId: string;
    rootPath: string;
    relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
    mode: RelayTransportMode;
    allowInsecureLoopbackForTests?: boolean;
  }): void {
    const baseUrl = normalizedRelayUrl(input.relay.baseUrl);
    const existing = this.routes.get(input.workspaceId);
    if (existing && existing.mode !== input.mode) {
      throw new MixedRelayTransportError(
        input.workspaceId,
        `already uses ${existing.mode}; refusing ${input.mode}`,
      );
    }
    if (existing && existing.baseUrl !== baseUrl) {
      throw new MixedRelayTransportError(
        input.workspaceId,
        "already belongs to a different relay origin",
      );
    }
    const route =
      existing ??
      {
        mode: input.mode,
        baseUrl,
        locations: new Map<string, RelayOpenConfiguration>(),
      };
    if (!existing) this.routes.set(input.workspaceId, route);
    if (input.mode === "daemon") {
      route.locations.set(input.rootPath, {
        baseUrl,
        bearerToken: input.relay.token,
        ...(input.allowInsecureLoopbackForTests
          ? { allowInsecureLoopbackForTests: true }
          : {}),
      });
    }
  }

  modeFor(workspaceId: string): RelayTransportMode | null {
    return this.routes.get(workspaceId)?.mode ?? null;
  }

  releaseWorkspace(
    workspaceId: string,
    expectedMode?: RelayTransportMode,
  ): void {
    if (
      expectedMode !== undefined &&
      this.routes.get(workspaceId)?.mode !== expectedMode
    ) {
      return;
    }
    this.routes.delete(workspaceId);
  }

  workspaceIds(): string[] {
    return [...this.routes.keys()];
  }

  relayForOpen(
    workspaceId: string,
    rootPath: string,
  ): RelayOpenConfiguration | null {
    const route = this.routes.get(workspaceId);
    if (!route || route.mode !== "daemon") return null;
    return route.locations.get(rootPath) ?? null;
  }
}

export async function probeWorkspaceRelay(
  routes: RelayTransportRouteGuard,
  input: {
    workspaceId: string;
    relay: SyncRelayConnection;
  },
): Promise<ProbeRelayWorkspaceResult> {
  routes.bind({
    ...input,
    rootPath: `relay-probe:${input.workspaceId}`,
    mode: "typescript",
  });
  try {
    return await probeRelayWorkspace(input);
  } finally {
    // Mode-conditional cleanup cannot tear down a daemon route that replaced
    // the transient probe route while its HTTP request was in flight.
    routes.releaseWorkspace(input.workspaceId, "typescript");
  }
}

class RelayConfiguredDaemonClient implements EngineDaemonClient {
  // Only workspace.open needs decorating; every other capability of the inner
  // client must survive the wrap. These are optional on EngineDaemonClient, so
  // forward conditionally — a wrapper that swallows onEvent reads as "no event
  // delivery" and permanently pins the renderer to the non-engine editor.
  readonly cancelRequest?: EngineDaemonClient["cancelRequest"];
  readonly onBlob?: EngineDaemonClient["onBlob"];
  readonly onEvent?: EngineDaemonClient["onEvent"];
  readonly waitForExit?: EngineDaemonClient["waitForExit"];

  constructor(
    private readonly client: EngineDaemonClient,
    private readonly routes: RelayTransportRouteGuard,
  ) {
    if (client.cancelRequest) this.cancelRequest = client.cancelRequest.bind(client);
    if (client.onBlob) this.onBlob = client.onBlob.bind(client);
    if (client.onEvent) this.onEvent = client.onEvent.bind(client);
    if (client.waitForExit) this.waitForExit = client.waitForExit.bind(client);
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
    const decorated: Request = {
      ...request,
      params: relay ? { ...params, relay } : params,
    };
    try {
      return await this.client.sendRequest(decorated);
    } catch (error) {
      // S1's byte-identical shared session layer carries the later
      // dispatch-recovery open option. RPC-E's deny-unknown-fields open shape
      // predates it. Retry only this rejected open without the later option;
      // a merged daemon that supports the option succeeds above and preserves
      // the false value (running dispatch claims survive a sidecar rebind).
      const refusal =
        typeof error === "object" &&
        error !== null &&
        "wireError" in error &&
        typeof error.wireError === "object" &&
        error.wireError !== null
          ? error.wireError
          : null;
      if (
        relay &&
        refusal &&
        "code" in refusal &&
        refusal.code === "INVALID_PARAMS" &&
        "recoverRunningDispatches" in params
      ) {
        const { recoverRunningDispatches: _laterOpenOption, ...openParams } =
          params;
        return await this.client.sendRequest({
          ...request,
          params: { ...openParams, relay },
        });
      }
      throw error;
    }
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
): Array<{
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary";
}> {
  if (!Array.isArray(value)) {
    throw new Error(`Rust engine ${label}.changedPaths must be an array.`);
  }
  return value.map((entry, index) => {
    const record = resultRecord(entry, `${label}.changedPaths[${index}]`);
    const path = stringField(record, "path", `${label}.changedPaths[${index}]`);
    const operation = record.operation;
    const contentKind = record.contentKind;
    if (operation !== "write" && operation !== "delete") {
      throw new Error(
        `Rust engine ${label}.changedPaths[${index}].operation is invalid.`,
      );
    }
    if (contentKind !== "text" && contentKind !== "binary") {
      throw new Error(
        `Rust engine ${label}.changedPaths[${index}].contentKind is invalid.`,
      );
    }
    return { path, operation, contentKind };
  });
}

function pendingResolves(
  value: JsonValue | undefined,
): PendingConflictResolve[] {
  if (!Array.isArray(value)) {
    throw new Error("Rust engine sync.pull.pendingResolves must be an array.");
  }
  return value.map((entry, index) => {
    const record = resultRecord(
      entry,
      `sync.pull.pendingResolves[${index}]`,
    );
    const remoteConflictId = stringField(
      record,
      "remoteConflictId",
      `sync.pull.pendingResolves[${index}]`,
    );
    const localConflictId =
      typeof record.localConflictId === "string"
        ? record.localConflictId
        : null;
    const path = typeof record.path === "string" ? record.path : null;
    const reason = stringField(
      record,
      "reason",
      `sync.pull.pendingResolves[${index}]`,
    );
    return { remoteConflictId, localConflictId, path, reason };
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

function translateRelayError(method: string, error: unknown): never {
  if (!(error instanceof DaemonRefusalError)) throw error;
  if (error.wireCode === "AUTH_FAILED") throw new RelayUnauthorizedError();
  if (error.wireCode === "SHARE_UNAVAILABLE") {
    throw new ShareUnavailableError();
  }
  if (error.wireCode === "CONFLICT") throw new RelayConflictError();
  if (error.wireCode === "KEY_ENVELOPE_MISSING") {
    throw new RelayKeyEnvelopeMissingError();
  }
  if (error.wireCode === "WORKSPACE_UNAVAILABLE") {
    if (method.startsWith("share.")) throw new ShareUnavailableError();
    throw new RelayWorkspaceUnavailableError();
  }
  if (
    method === "sync.push" &&
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
  throw error;
}

export interface EngineRelayWorkspaceClient {
  push(): Promise<PushWorkspaceToRelayResult>;
  pull(): Promise<PullWorkspaceFromRelayResult>;
  commitCursor(cursor: Record<string, JsonValue | undefined>): Promise<void>;
  recoverOrigin(): Promise<RecoverRelayOriginResult>;
  claim(): Promise<void>;
  probe(): Promise<ProbeRelayWorkspaceResult>;
  uploadKeyEnvelope(input: {
    envelopeJson: string;
    ifMatch?: string;
  }): Promise<KeyEnvelopeUploadResult>;
  downloadKeyEnvelope(): Promise<KeyEnvelopeDownloadResult>;
  pullSharedChannel(input: {
    shareId: string;
    channelWireId: string;
  }): Promise<PullSharedChannelResult>;
  pushSharedChannel(input: {
    shareId: string;
    channelWireId: string;
  }): Promise<PushSharedChannelResult>;
  pullShareView(input: {
    shareId: string;
    pathPrefix?: string;
  }): Promise<PullShareViewResult>;
}

export interface EngineRelayClientOptions {
  sessions: EngineWorkspaceSessions;
  routes: RelayTransportRouteGuard;
  allowInsecureLoopbackForTests?: boolean;
  requestDeadlineMs?: number;
}

const DEFAULT_RELAY_REQUEST_DEADLINE_MS = 30_000;

export class EngineRelayClient {
  private readonly sessions: EngineWorkspaceSessions;
  private readonly routes: RelayTransportRouteGuard;
  private readonly allowInsecureLoopbackForTests: boolean;
  private readonly requestDeadlineMs: number;
  private readonly activeLocations = new Map<string, string>();
  private readonly workspaceTails = new Map<string, Promise<void>>();

  constructor(options: EngineRelayClientOptions) {
    this.sessions = options.sessions;
    this.routes = options.routes;
    this.allowInsecureLoopbackForTests =
      options.allowInsecureLoopbackForTests === true;
    this.requestDeadlineMs =
      options.requestDeadlineMs ?? DEFAULT_RELAY_REQUEST_DEADLINE_MS;
  }

  bind(input: {
    workspaceId: string;
    rootPath: string;
    relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
  }): EngineRelayWorkspaceClient {
    this.routes.bind({
      ...input,
      mode: "daemon",
      allowInsecureLoopbackForTests:
        this.allowInsecureLoopbackForTests ||
        allowInsecureLoopbackRelayForTests(input.relay.baseUrl),
    });
    const workspace = {
      workspaceId: input.workspaceId,
      rootPath: input.rootPath,
    };
    const connectionKey = `${input.rootPath}\u0000${input.relay.token}`;
    const request = async (
      method: string,
      params: Record<string, JsonValue | undefined>,
    ): Promise<JsonValue> =>
      await this.serialize(workspace.workspaceId, async () => {
        if (this.activeLocations.get(workspace.workspaceId) !== connectionKey) {
          await this.sessions
            .closeWorkspace(workspace.workspaceId)
            .catch(() => undefined);
          this.activeLocations.set(workspace.workspaceId, connectionKey);
        }
        try {
          return await this.sessions.run(
            workspace,
            async ({ client, workspace: handle }) => {
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

    const commitCursor = async (
      cursor: Record<string, JsonValue | undefined>,
    ): Promise<void> => {
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
        };
      },
      pull: async () => {
        let fetched = 0;
        let applied = 0;
        let skipped = 0;
        let conflictsOpened = 0;
        let nextCursor = 0;
        let previousCursor: number | null = null;
        let finalCursor: Record<string, JsonValue | undefined> | null = null;
        const resolves: PendingConflictResolve[] = [];
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
          resolves.push(...pendingResolves(result.pendingResolves));
          for (const path of changedPaths(result.changedPaths, "sync.pull")) {
            changed.set(path.path, path);
          }
          if (!hasMore) {
            finalCursor = cursor;
            break;
          }
          await commitCursor(cursor);
        }
        if (!finalCursor) {
          throw new Error("Rust engine sync.pull returned no final cursor.");
        }
        return {
          fetched,
          applied,
          skipped,
          conflictsOpened,
          pendingConflictResolves: resolves.length,
          pendingResolves: resolves,
          fastForwardedPaths: [...changed.values()],
          nextCursor,
          commitFetchCursor: async () => await commitCursor(finalCursor),
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
      claim: async () => {
        const result = resultRecord(
          await request("sync.claim", { workspaceId: workspace.workspaceId }),
          "sync.claim",
        );
        if (!booleanField(result, "claimed", "sync.claim")) {
          throw new Error("Rust engine sync.claim did not claim the workspace.");
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
      pullSharedChannel: async ({ shareId, channelWireId }) => {
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
          fetched += numberField(result, "fetched", "share.channel.pull");
          applied += numberField(result, "applied", "share.channel.pull");
          skipped += numberField(result, "skipped", "share.channel.pull");
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
      pullShareView: async ({ shareId, pathPrefix = "" }) => {
        let fetched = 0;
        let applied = 0;
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
              pathPrefix,
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
          for (const path of changedPaths(
            result.changedPaths,
            "share.view.pull",
          )) {
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
          changedPaths: [...changed.values()],
          nextCursor,
          commitCursor: async () => await commitCursor(finalCursor),
        };
      },
    };
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.serialize(workspaceId, async () => {
      await this.sessions.closeWorkspace(workspaceId);
      this.activeLocations.delete(workspaceId);
      this.routes.releaseWorkspace(workspaceId);
    });
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.routes.workspaceIds().map(async (workspaceId) => {
        await this.closeWorkspace(workspaceId);
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

  private serialize<T>(
    workspaceId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.workspaceTails.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(run, run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceTails.set(workspaceId, settled);
    void settled.then(() => {
      if (this.workspaceTails.get(workspaceId) === settled) {
        this.workspaceTails.delete(workspaceId);
      }
    });
    return result;
  }
}

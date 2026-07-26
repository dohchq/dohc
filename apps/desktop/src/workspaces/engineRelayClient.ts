import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
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
  WorkspaceDaemonRequester,
  type JsonValue,
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

/**
 * Process-lifetime authority for the relay implementation used by a logical
 * workspace. A route can refresh its bearer token and can be opened at a
 * temporary probe root, but it can never change relay origin or implementation.
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

  relayForOpen(
    workspaceId: string,
    rootPath: string,
  ): RelayOpenConfiguration | null {
    const route = this.routes.get(workspaceId);
    if (!route || route.mode !== "daemon") return null;
    return route.locations.get(rootPath) ?? null;
  }
}

class RelayConfiguredDaemonClient implements EngineDaemonClient {
  constructor(
    private readonly client: EngineDaemonClient,
    private readonly routes: RelayTransportRouteGuard,
  ) {}

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
  if (error.wireCode === "WORKSPACE_UNAVAILABLE") {
    if (method.startsWith("share.")) throw new ShareUnavailableError();
    throw new RelayWorkspaceUnavailableError();
  }
  // The daemon surface currently collapses relay origin divergence into
  // INVALID_PARAMS. sync.push has a fixed desktop-owned parameter shape, so
  // this method-specific translation preserves the existing recovery flow
  // without treating arbitrary INVALID_PARAMS from other methods as divergence.
  if (method === "sync.push" && error.wireCode === "INVALID_PARAMS") {
    throw new RelayOriginDivergedError();
  }
  if (
    method === "share.channel.push" &&
    error.wireCode === "INVALID_PARAMS"
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
      allowInsecureLoopbackForTests: this.allowInsecureLoopbackForTests,
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
          await this.sessions.closeWorkspace(workspace.workspaceId);
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
        const result = resultRecord(
          await request("sync.pull", { workspaceId: workspace.workspaceId }),
          "sync.pull",
        );
        const cursor = pendingCursor(result.pendingCursor, "sync.pull");
        const resolves = pendingResolves(result.pendingResolves);
        return {
          fetched: numberField(result, "fetched", "sync.pull"),
          applied: numberField(result, "applied", "sync.pull"),
          skipped: numberField(result, "skipped", "sync.pull"),
          conflictsOpened: numberField(
            result,
            "conflictsOpened",
            "sync.pull",
          ),
          pendingConflictResolves: resolves.length,
          pendingResolves: resolves,
          fastForwardedPaths: changedPaths(result.changedPaths, "sync.pull"),
          nextCursor: numberField(result, "nextCursor", "sync.pull"),
          commitFetchCursor: async () => await commitCursor(cursor),
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
      pullSharedChannel: async ({ shareId, channelWireId }) => {
        const result = resultRecord(
          await request("share.channel.pull", {
            workspaceId: workspace.workspaceId,
            shareId,
            channelWireId,
          }),
          "share.channel.pull",
        );
        return {
          fetched: numberField(result, "fetched", "share.channel.pull"),
          applied: numberField(result, "applied", "share.channel.pull"),
          skipped: numberField(result, "skipped", "share.channel.pull"),
          nextCursor: numberField(
            result,
            "nextCursor",
            "share.channel.pull",
          ),
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
        const result = resultRecord(
          await request("share.view.pull", {
            workspaceId: workspace.workspaceId,
            shareId,
            pathPrefix,
          }),
          "share.view.pull",
        );
        const cursor = pendingCursor(result.pendingCursor, "share.view.pull");
        return {
          fetched: numberField(result, "fetched", "share.view.pull"),
          applied: numberField(result, "applied", "share.view.pull"),
          changedPaths: changedPaths(result.changedPaths, "share.view.pull"),
          nextCursor: numberField(
            result,
            "nextCursor",
            "share.view.pull",
          ),
          commitCursor: async () => await commitCursor(cursor),
        };
      },
    };
  }

  async probeEphemeral(input: {
    workspaceId: string;
    relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
  }): Promise<ProbeRelayWorkspaceResult> {
    const rootPath = await mkdtemp(join(tmpdir(), "dohc-relay-probe-"));
    try {
      const markerDirectory = join(rootPath, ".dohc", "engine");
      await mkdir(markerDirectory, { recursive: true });
      await writeFile(
        join(markerDirectory, "SHADOW_CLONE"),
        randomBytes(32).toString("hex"),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      return await this.bind({ ...input, rootPath }).probe();
    } finally {
      await this.sessions.closeWorkspace(input.workspaceId).catch(() => undefined);
      this.activeLocations.delete(input.workspaceId);
      await rm(rootPath, { recursive: true, force: true });
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

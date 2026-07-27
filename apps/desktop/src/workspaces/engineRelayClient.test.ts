import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonRefusalError,
  type JsonValue,
  Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  RelayOriginDivergedError,
  SharedChannelReadOnlyError,
} from "@dohc/workspace-engine";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDaemonClient } from "./engineDaemonLifecycle";
import {
  EngineRelayClient,
  MixedRelayTransportError,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
  relayTransportModeForRoot,
} from "./engineRelayClient";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";
import { refreshSharedViewOnce } from "./sharedView";

class MockDaemon implements EngineDaemonClient {
  readonly requests: Request[] = [];

  constructor(
    private readonly override?: (request: Request) => JsonValue | undefined,
  ) {}

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    const overridden = this.override?.(request);
    if (overridden !== undefined) {
      return { id: request.id, result: overridden };
    }
    const result = (() => {
      switch (request.method) {
        case "workspace.open":
          return { workspace: "ws-mock" };
        case "workspace.close":
          return { closed: true };
        case "sync.push":
          return {
            status: "complete",
            pushed: 3,
            fetched: 0,
            applied: 0,
            skipped: 0,
            conflictsOpened: 0,
            hasMore: false,
            nextCursor: null,
            pendingCursor: null,
            changedPaths: [],
            pendingResolves: [],
          };
        case "sync.pull":
          return {
            status: "complete",
            pushed: 0,
            fetched: 4,
            applied: 2,
            skipped: 2,
            conflictsOpened: 1,
            hasMore: false,
            nextCursor: 9,
            pendingCursor: { kind: "relay", token: "cursor-9" },
            changedPaths: [
              {
                path: "notes/plan.md",
                operation: "write",
                contentKind: "text",
              },
            ],
            pendingResolves: [
              {
                remoteConflictId: "remote-conflict",
                localConflictId: "local-conflict",
                path: "notes/plan.md",
                reason: "stale-head",
              },
            ],
          };
        case "sync.commitCursor":
          return { committed: true };
        case "sync.recoverOrigin":
          return {
            oldOriginId: "origin-old",
            newOriginId: "origin-new",
            sharedPrefixLength: 5,
            preservedOps: 2,
          };
        case "sync.claim":
          return { claimed: true };
        case "sync.probe":
          return { hasContent: true };
        case "share.channel.pull":
          return {
            fetched: 7,
            applied: 5,
            refused: 1,
            skipped: 2,
            hasMore: false,
            nextCursor: 11,
          };
        case "share.channel.push":
          return { pushed: 6 };
        case "share.view.pull":
          return {
            fetched: 2,
            applied: 0,
            skipped: 2,
            hasMore: false,
            nextCursor: 13,
            changedPaths: [],
            pendingCursor: { kind: "shareView", token: "share-cursor-13" },
          };
        default:
          throw new Error(`Unexpected mock daemon method: ${request.method}`);
      }
    })();
    return { id: request.id, result };
  }

  close(): void {}
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function harness(daemon = new MockDaemon()) {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-relay-client-unit-"));
  roots.push(rootPath);
  const routes = new RelayTransportRouteGuard();
  const source = new RelayConfiguredDaemonClientSource(
    { currentClient: () => daemon },
    routes,
  );
  const sessions = new EngineWorkspaceSessions(source, {
    transportRebindAttempts: 1,
  });
  const live = new EngineRelayClient({
    sessions,
    routes,
    requestDeadlineMs: 1_000,
  });
  const relay = { baseUrl: "https://relay.test/", token: "secret-token" };
  const client = live.bind({
    workspaceId: "workspace-a",
    rootPath,
    relay,
  });
  return { rootPath, daemon, routes, sessions, live, relay, client };
}

function expectStatefulRequestsScoped(requests: Request[]): void {
  for (const request of requests) {
    if (request.method === "workspace.open") continue;
    expect(
      request.workspace,
      `MUTATION: ${request.method} must retain its daemon workspace handle`,
    ).toBe("ws-mock");
  }
}

describe("EngineRelayClient", () => {
  it("routes push, pull, cursor commit, recover, claim, and probe through one daemon session", async () => {
    const { daemon, sessions, client } = await harness();

    await expect(client.push()).resolves.toEqual({
      pushed: 3,
      originsPushed: [],
    });
    const pull = await client.pull();
    expect(pull).toMatchObject({
      fetched: 4,
      applied: 2,
      skipped: 2,
      conflictsOpened: 1,
      nextCursor: 9,
      fastForwardedPaths: [
        {
          path: "notes/plan.md",
          operation: "write",
          contentKind: "text",
        },
      ],
      pendingResolves: [
        {
          remoteConflictId: "remote-conflict",
          localConflictId: "local-conflict",
        },
      ],
    });
    await pull.commitFetchCursor();
    await expect(client.recoverOrigin()).resolves.toEqual({
      oldOriginId: "origin-old",
      newOriginId: "origin-new",
      sharedPrefixLength: 5,
      preservedOps: 2,
    });
    await expect(client.claim()).resolves.toBeUndefined();
    await expect(client.probe()).resolves.toEqual({ hasContent: true });

    const open = daemon.requests.find(
      (request) => request.method === "workspace.open",
    );
    expect(open?.params).toMatchObject({
      workspaceId: "workspace-a",
      relay: {
        baseUrl: "https://relay.test",
        bearerToken: "secret-token",
      },
    });
    expect(daemon.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "sync.push",
      "sync.pull",
      "sync.commitCursor",
      "sync.recoverOrigin",
      "sync.claim",
      "sync.probe",
    ]);
    expectStatefulRequestsScoped(daemon.requests);
    expect(
      daemon.requests
        .filter((request) => request.method.startsWith("sync."))
        .map((request) => ({ method: request.method, params: request.params })),
    ).toEqual([
      { method: "sync.push", params: { workspaceId: "workspace-a" } },
      { method: "sync.pull", params: { workspaceId: "workspace-a" } },
      {
        method: "sync.commitCursor",
        params: {
          workspaceId: "workspace-a",
          pendingCursor: { kind: "relay", token: "cursor-9" },
        },
      },
      {
        method: "sync.recoverOrigin",
        params: { workspaceId: "workspace-a" },
      },
      { method: "sync.claim", params: { workspaceId: "workspace-a" } },
      { method: "sync.probe", params: { workspaceId: "workspace-a" } },
    ]);
    await sessions.closeAll();
  });

  it("routes shared-channel pull and push through daemon RPC", async () => {
    const { daemon, sessions, client } = await harness();

    await expect(
      client.pullSharedChannel({
        shareId: "share-channel",
        channelWireId: "wire-channel",
      }),
    ).resolves.toEqual({
      fetched: 7,
      applied: 5,
      skipped: 2,
      nextCursor: 11,
    });
    await expect(
      client.pushSharedChannel({
        shareId: "share-channel",
        channelWireId: "wire-channel",
      }),
    ).resolves.toEqual({ pushed: 6 });
    expect(daemon.requests.map((request) => request.method)).toContain(
      "share.channel.pull",
    );
    expect(daemon.requests.map((request) => request.method)).toContain(
      "share.channel.push",
    );
    expectStatefulRequestsScoped(daemon.requests);
    expect(
      daemon.requests
        .filter((request) => request.method.startsWith("share.channel."))
        .map((request) => ({ method: request.method, params: request.params })),
    ).toEqual([
      {
        method: "share.channel.pull",
        params: {
          workspaceId: "workspace-a",
          shareId: "share-channel",
          channelWireId: "wire-channel",
        },
      },
      {
        method: "share.channel.push",
        params: {
          workspaceId: "workspace-a",
          shareId: "share-channel",
          channelWireId: "wire-channel",
        },
      },
    ]);
    await sessions.closeAll();
  });

  it("refreshes a share view and commits its opaque daemon cursor", async () => {
    const { rootPath, daemon, sessions, client, relay } = await harness();
    const outcome = await refreshSharedViewOnce({
      rootDir: rootPath,
      workspaceId: "workspace-a",
      relay,
      shareId: "share-view",
      pull: async (input) =>
        await client.pullShareView({ shareId: input.shareId }),
    });

    expect(outcome).toEqual({ status: "unchanged", changedPaths: 0 });
    expect(daemon.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "share.view.pull",
      "sync.commitCursor",
    ]);
    expect(
      daemon.requests.find(
        (request) => request.method === "sync.commitCursor",
      )?.params,
    ).toMatchObject({
      pendingCursor: { kind: "shareView", token: "share-cursor-13" },
    });
    expectStatefulRequestsScoped(daemon.requests);
    expect(
      daemon.requests.find(
        (request) => request.method === "share.view.pull",
      )?.params,
    ).toEqual({
      workspaceId: "workspace-a",
      shareId: "share-view",
      pathPrefix: "",
    });
    await sessions.closeAll();
  });

  it("keeps fresh roots on TypeScript until a valid shadow clone exists", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "dohc-relay-mode-unit-"));
    roots.push(rootPath);

    expect(
      relayTransportModeForRoot(rootPath),
      "MUTATION: routing a marker-less join to the daemon makes workspace.open fail",
    ).toBe("typescript");
    expect(
      relayTransportModeForRoot(null),
      "MUTATION: a daemon preflight has no relay identity to present",
    ).toBe("typescript");
    const markerDirectory = join(rootPath, ".dohc", "engine");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(join(markerDirectory, "SHADOW_CLONE"), "forged");
    expect(relayTransportModeForRoot(rootPath)).toBe("typescript");
    await writeFile(join(markerDirectory, "SHADOW_CLONE"), "a".repeat(64));
    expect(relayTransportModeForRoot(rootPath)).toBe("daemon");
  });

  it("drains every daemon pull page before reporting synchronization complete", async () => {
    let workspacePulls = 0;
    let channelPulls = 0;
    let viewPulls = 0;
    const daemon = new MockDaemon((request) => {
      if (request.method === "sync.pull") {
        workspacePulls += 1;
        const first = workspacePulls === 1;
        return {
          status: "complete",
          pushed: 0,
          fetched: first ? 2 : 3,
          hasMore: first,
          applied: first ? 1 : 2,
          skipped: 1,
          conflictsOpened: first ? 1 : 0,
          nextCursor: first ? 4 : 7,
          pendingCursor: {
            kind: "relay",
            token: first ? "cursor-4" : "cursor-7",
          },
          changedPaths: [
            {
              path: first ? "first.md" : "second.md",
              operation: "write",
              contentKind: "text",
            },
          ],
          pendingResolves: [],
        };
      }
      if (request.method === "share.channel.pull") {
        channelPulls += 1;
        return {
          fetched: 1,
          hasMore: channelPulls === 1,
          applied: 1,
          refused: 0,
          skipped: 0,
          nextCursor: channelPulls,
        };
      }
      if (request.method === "share.view.pull") {
        viewPulls += 1;
        const first = viewPulls === 1;
        return {
          fetched: 1,
          hasMore: first,
          applied: 1,
          skipped: 0,
          nextCursor: viewPulls,
          changedPaths: [
            {
              path: first ? "view-first.md" : "view-second.md",
              operation: "write",
              contentKind: "text",
            },
          ],
          pendingCursor: {
            kind: "shareView",
            token: first ? "view-cursor-1" : "view-cursor-2",
          },
        };
      }
      return undefined;
    });
    const { client, sessions } = await harness(daemon);

    const workspace = await client.pull();
    expect(workspace).toMatchObject({
      fetched: 5,
      applied: 3,
      skipped: 2,
      conflictsOpened: 1,
      nextCursor: 7,
      fastForwardedPaths: [
        expect.objectContaining({ path: "first.md" }),
        expect.objectContaining({ path: "second.md" }),
      ],
    });
    expect(
      workspacePulls,
      "MUTATION: stopping after the first hasMore page strands remote data",
    ).toBe(2);
    expect(
      daemon.requests.filter(
        (request) => request.method === "sync.commitCursor",
      ),
    ).toHaveLength(1);
    await workspace.commitFetchCursor();
    expect(
      daemon.requests.filter(
        (request) => request.method === "sync.commitCursor",
      ),
    ).toHaveLength(2);

    await expect(
      client.pullSharedChannel({
        shareId: "share-channel",
        channelWireId: "wire-channel",
      }),
    ).resolves.toMatchObject({ fetched: 2, applied: 2, nextCursor: 2 });
    expect(channelPulls).toBe(2);

    const view = await client.pullShareView({ shareId: "share-view" });
    expect(view).toMatchObject({
      fetched: 2,
      applied: 2,
      nextCursor: 2,
      changedPaths: [
        expect.objectContaining({ path: "view-first.md" }),
        expect.objectContaining({ path: "view-second.md" }),
      ],
    });
    expect(viewPulls).toBe(2);
    await view.commitCursor();
    await sessions.closeAll();
  });

  it("does not reinterpret unrelated INVALID_PARAMS as recovery outcomes", async () => {
    let originMarker = false;
    let readOnlyMarker = false;
    const daemon = new MockDaemon((request) => {
      if (request.method === "sync.push") {
        throw new DaemonRefusalError(
          {
            code: "INVALID_PARAMS",
            message: originMarker
              ? "relay-origin-diverged"
              : "invalid-sync-contract",
            retry: "no",
          },
          new Error("refused"),
        );
      }
      if (request.method === "share.channel.push") {
        throw new DaemonRefusalError(
          {
            code: "INVALID_PARAMS",
            message: readOnlyMarker ? "share-read-only" : "payload-too-large",
            retry: "no",
          },
          new Error("refused"),
        );
      }
      return undefined;
    });
    const { client, sessions } = await harness(daemon);

    await expect(client.push()).rejects.toBeInstanceOf(DaemonRefusalError);
    originMarker = true;
    await expect(client.push()).rejects.toBeInstanceOf(
      RelayOriginDivergedError,
    );
    await expect(
      client.pushSharedChannel({
        shareId: "share-channel",
        channelWireId: "wire-channel",
      }),
    ).rejects.toBeInstanceOf(DaemonRefusalError);
    readOnlyMarker = true;
    await expect(
      client.pushSharedChannel({
        shareId: "share-channel",
        channelWireId: "wire-channel",
      }),
    ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
    await sessions.closeAll();
  });

  it("continues after a connection-change close failure", async () => {
    let closeFailures = 1;
    const daemon = new MockDaemon((request) => {
      if (request.method === "workspace.close" && closeFailures > 0) {
        closeFailures -= 1;
        throw new Error("injected close failure");
      }
      return undefined;
    });
    const { rootPath, live, relay, sessions } = await harness(daemon);
    const first = live.bind({
      workspaceId: "workspace-close-retry",
      rootPath,
      relay,
    });
    await first.push();
    const refreshed = live.bind({
      workspaceId: "workspace-close-retry",
      rootPath,
      relay: { ...relay, token: "refreshed-token" },
    });

    await expect(refreshed.push()).resolves.toMatchObject({ pushed: 3 });
    expect(
      daemon.requests.filter(
        (request) =>
          request.method === "workspace.open" &&
          request.params &&
          typeof request.params === "object" &&
          !Array.isArray(request.params) &&
          request.params.workspaceId === "workspace-close-retry",
      ),
    ).toHaveLength(2);
    await sessions.closeAll();
  });

  it("allows a relay change after clean teardown without weakening transport locking", async () => {
    const { rootPath, daemon, live, routes } = await harness();
    const first = live.bind({
      workspaceId: "workspace-switch",
      rootPath,
      relay: { baseUrl: "https://relay-a.test", token: "token-a" },
    });
    await first.push();
    expect(() =>
      live.bind({
        workspaceId: "workspace-switch",
        rootPath,
        relay: { baseUrl: "https://relay-b.test", token: "token-b" },
      }),
    ).toThrow(MixedRelayTransportError);

    await live.closeWorkspace("workspace-switch");
    expect(routes.modeFor("workspace-switch")).toBeNull();
    const switched = live.bind({
      workspaceId: "workspace-switch",
      rootPath,
      relay: { baseUrl: "https://relay-b.test", token: "token-b" },
    });
    await expect(switched.push()).resolves.toMatchObject({ pushed: 3 });
    const opens = daemon.requests.filter(
      (request) =>
        request.method === "workspace.open" &&
        request.params &&
        typeof request.params === "object" &&
        !Array.isArray(request.params) &&
        request.params.workspaceId === "workspace-switch",
    );
    expect(opens.at(-1)?.params).toMatchObject({
      relay: {
        baseUrl: "https://relay-b.test",
        bearerToken: "token-b",
      },
    });
    await live.closeWorkspace("workspace-switch");
  });

  it("locks a workspace to one transport and relay origin despite caller mutation", async () => {
    const { rootPath } = await harness();
    const routes = new RelayTransportRouteGuard();
    const relay = {
      baseUrl: "https://relay-a.test/",
      token: "token-a",
    };
    routes.bind({
      workspaceId: "workspace-locked",
      rootPath,
      relay,
      mode: "daemon",
    });

    // Mutating the caller-owned object cannot mutate the copied route.
    relay.baseUrl = "https://relay-b.test";
    relay.token = "token-b";
    expect(routes.modeFor("workspace-locked")).toBe("daemon");
    expect(() =>
      routes.bind({
        workspaceId: "workspace-locked",
        rootPath,
        relay,
        mode: "typescript",
      }),
    ).toThrow(MixedRelayTransportError);
    expect(() =>
      routes.bind({
        workspaceId: "workspace-locked",
        rootPath,
        relay,
        mode: "daemon",
      }),
    ).toThrow("different relay origin");
  });
});

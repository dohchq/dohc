import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Request,
  Response,
} from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDaemonClient } from "./engineDaemonLifecycle";
import {
  EngineRelayClient,
  MixedRelayTransportError,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";
import { refreshSharedViewOnce } from "./sharedView";

class MockDaemon implements EngineDaemonClient {
  readonly requests: Request[] = [];

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
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
            nextCursor: 11,
          };
        case "share.channel.push":
          return { pushed: 6 };
        case "share.view.pull":
          return {
            fetched: 2,
            applied: 0,
            skipped: 2,
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

async function harness() {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-relay-client-unit-"));
  roots.push(rootPath);
  const daemon = new MockDaemon();
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
    await sessions.closeAll();
  });

  it("uses a disposable shadow root for a pre-creation probe", async () => {
    const { daemon, live, relay } = await harness();

    await expect(
      live.probeEphemeral({ workspaceId: "workspace-probe", relay }),
    ).resolves.toEqual({ hasContent: true });
    const open = daemon.requests.find(
      (request) =>
        request.method === "workspace.open" &&
        request.params &&
        typeof request.params === "object" &&
        !Array.isArray(request.params) &&
        request.params.workspaceId === "workspace-probe",
    );
    expect(open?.params).toMatchObject({
      relay: {
        baseUrl: "https://relay.test",
        bearerToken: "secret-token",
      },
    });
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

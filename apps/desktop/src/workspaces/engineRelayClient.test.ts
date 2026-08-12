import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DaemonRefusalError,
  type JsonValue,
  Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  MAX_REPORTED_REFUSALS,
  RelayOriginDivergedError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
} from "@dohc/workspace-contracts/relay";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineRequestError,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import {
  allowInsecureLoopbackRelayForTests,
  EngineRelayClient,
  INSECURE_LOOPBACK_RELAY_TEST_ENV,
  MixedRelayTransportError,
  probeWorkspaceRelay,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import {
  createMountDirectory,
  refreshShareMountOnce,
  relayTargetForShareMount,
} from "./shareMounts";
import { syncJoinedSharedChannels } from "./sharedChannels";
import { refreshSharedViewOnce } from "./sharedView";

// Every test in this file pulls with the selector its share record pins. The
// damaged-record path has its own tests in sharedView.test.ts. This is a REAL
// selector — no paths and no version selects nothing at all, which the engine
// refuses.
const PINNED_SELECTOR = { paths: ["docs"], versionId: null };
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";

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
            sharingDeclined: [],
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
            sharingDeclined: [],
          };
        case "sync.commitCursor":
          return { committed: true, sharingDeclined: [] };
        case "sync.recoverOrigin":
          return {
            oldOriginId: "origin-old",
            newOriginId: "origin-new",
            sharedPrefixLength: 5,
            preservedOps: 2,
          };
        case "sync.claim":
          return { claimed: true };
        case "sync.adoptJoinIdentity":
          return { adopted: true };
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
            refusals: [],
            refusalCount: 0,
            hasMore: false,
            nextCursor: 13,
            changedPaths: [],
            pendingCursor: { kind: "shareView", token: "share-cursor-13" },
          };
        case "versions.ensureMain":
          return {
            id: "main",
            workspaceId: "workspace-a",
            kind: "main",
            name: "Main",
            createdAtMs: 1,
          };
        case "versionedText.list":
          return { files: [], nextAfterPath: null };
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
  const rootPath = await createTestScratch("dohc-relay-client-unit-");
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
      sharingDeclined: [],
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
    expect(open?.params).not.toHaveProperty("captureMode");
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

  it("carries sharing declines from every workspace pull page", async () => {
    let pulls = 0;
    const daemon = new MockDaemon((request) => {
      if (request.method !== "sync.pull") return undefined;
      pulls += 1;
      return {
        status: "complete",
        pushed: 0,
        fetched: 1,
        applied: 1,
        skipped: 0,
        conflictsOpened: 0,
        hasMore: pulls === 1,
        nextCursor: pulls,
        pendingCursor: { kind: "relay", token: `cursor-${pulls}` },
        changedPaths: [],
        refusals: [],
        sharingDeclined: [
          {
            path: pulls === 1 ? "notes/first.md" : "notes/second.md",
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limitBytes: 20,
            observedBytes: 20 + pulls,
          },
        ],
      };
    });
    const { sessions, client } = await harness(daemon);

    const pull = await client.pull();

    expect(
      pull.sharingDeclined,
      "the desktop client must not discard the engine's actionable declines",
    ).toEqual([
      {
        path: "notes/first.md",
        constraint: "MAX_YDOC_UPDATE_BYTES",
        limitBytes: 20,
        observedBytes: 21,
      },
      {
        path: "notes/second.md",
        constraint: "MAX_YDOC_UPDATE_BYTES",
        limitBytes: 20,
        observedBytes: 22,
      },
    ]);
    await sessions.closeAll();
  });

  it("carries the canonical path for an empty-probe push enrollment decline", async () => {
    const daemon = new MockDaemon((request) => {
      if (request.method !== "sync.push") return undefined;
      return {
        status: "complete",
        pushed: 0,
        sharingDeclined: [
          {
            path: "notes/oversized.md",
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limitBytes: 20,
            observedBytes: 21,
          },
        ],
      };
    });
    const { sessions, client } = await harness(daemon);

    await expect(client.push()).resolves.toEqual({
      pushed: 0,
      originsPushed: [],
      sharingDeclined: [
        {
          path: "notes/oversized.md",
          constraint: "MAX_YDOC_UPDATE_BYTES",
          limitBytes: 20,
          observedBytes: 21,
        },
      ],
    });
    await sessions.closeAll();
  });

  it("rejects a sharing decline without a canonical path", async () => {
    const daemon = new MockDaemon((request) => {
      if (request.method !== "sync.push") return undefined;
      return {
        status: "complete",
        pushed: 0,
        sharingDeclined: [
          {
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limitBytes: 20,
            observedBytes: 21,
          },
        ],
      };
    });
    const { sessions, client } = await harness(daemon);

    await expect(client.push()).rejects.toThrow(
      "Rust engine sync.push.sharingDeclined[0].path must be a string.",
    );
    await sessions.closeAll();
  });

  it("adds a cursor-commit enrollment decline to the completed pull", async () => {
    const daemon = new MockDaemon((request) => {
      if (request.method === "sync.pull") {
        return {
          status: "complete",
          pushed: 0,
          fetched: 0,
          applied: 0,
          skipped: 0,
          conflictsOpened: 0,
          hasMore: false,
          nextCursor: 0,
          pendingCursor: { kind: "relay", token: "cursor-enrollment" },
          changedPaths: [],
          sharingDeclined: [],
        };
      }
      if (request.method === "sync.commitCursor") {
        return {
          committed: true,
          sharingDeclined: [
            {
              path: "notes/commit.md",
              constraint: "MAX_YDOC_UPDATE_BYTES",
              limitBytes: 20,
              observedBytes: 22,
            },
          ],
        };
      }
      return undefined;
    });
    const { sessions, client } = await harness(daemon);

    const pull = await client.pull();
    await pull.commitFetchCursor();

    expect(pull.sharingDeclined).toEqual([
      {
        path: "notes/commit.md",
        constraint: "MAX_YDOC_UPDATE_BYTES",
        limitBytes: 20,
        observedBytes: 22,
      },
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

  it("claims only an unset relay identity and adopts an established identity", async () => {
    const { daemon, sessions, client } = await harness();

    await expect(client.bootstrapJoinIdentity(null)).resolves.toBeUndefined();
    await expect(
      client.bootstrapJoinIdentity({
        replicationEpoch: "epoch-relay",
        streamIdentity: "stream-relay",
      }),
    ).resolves.toBeUndefined();

    expect(
      daemon.requests
        .filter((request) =>
          ["sync.claim", "sync.adoptJoinIdentity"].includes(request.method),
        )
        .map((request) => ({ method: request.method, params: request.params })),
    ).toEqual([
      { method: "sync.claim", params: { workspaceId: "workspace-a" } },
      {
        method: "sync.adoptJoinIdentity",
        params: {
          workspaceId: "workspace-a",
          replicationEpoch: "epoch-relay",
          streamIdentity: "stream-relay",
        },
      },
    ]);
    expect(daemon.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "sync.claim",
      "workspace.close",
      "workspace.open",
      "sync.adoptJoinIdentity",
      "workspace.close",
    ]);
    for (const request of daemon.requests.filter(
      (request) => request.method === "workspace.open",
    )) {
      expect(request.params).toMatchObject({ captureMode: "none" });
    }
    await sessions.closeAll();
  });

  it("orders join identity bootstrap before registration and activity capture", async () => {
    const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const bootstrap = source.indexOf(
      "await daemonRelay.bootstrapJoinIdentity(probe.identity);",
    );
    const registration = source.indexOf(
      "registerWorkspace({ ...created, joinBootstrapPending: true });",
      bootstrap,
    );
    const activityOpen = source.indexOf(
      "await openWorkspaceActivity(created",
      bootstrap,
    );
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(registration).toBeGreaterThan(bootstrap);
    expect(activityOpen).toBeGreaterThan(registration);
  });

  it("refreshes a share view and commits its opaque daemon cursor", async () => {
    const { rootPath, daemon, sessions, client, relay } = await harness();
    const store = createCaptureLiveStores(
      { workspaceId: "workspace-a", rootPath },
      sessions,
    ).store;
    const outcome = await refreshSharedViewOnce({
      rootDir: rootPath,
      workspaceId: "workspace-a",
      relay,
      shareId: "share-view",
      store,
      pinnedSelector: PINNED_SELECTOR,
      recordRefusals: async () => undefined,
      pull: async (input) =>
        await client.pullShareView({
          shareId: input.shareId,
          grantedSelector: input.grantedSelector,
        }),
    });

    expect(outcome).toEqual({
      status: "unchanged",
      changedPaths: 0,
      refusedOps: 0,
      refusedDetail: null,
    });
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
      grantedSelector: { paths: ["docs"], versionId: null },
    });
    await sessions.closeAll();
  });

  // Both dimensions of the accepted selector reach the engine intact. Dropping
  // either one widens the grant: no paths reads as "the whole workspace", and
  // no version reads as "any version's fork".
  it("sends the accepted selector's paths AND version to the engine", async () => {
    const { rootPath, daemon, sessions, client, relay } = await harness();
    const store = createCaptureLiveStores(
      { workspaceId: "workspace-a", rootPath },
      sessions,
    ).store;
    await refreshSharedViewOnce({
      rootDir: rootPath,
      workspaceId: "workspace-a",
      relay,
      shareId: "share-view",
      store,
      pinnedSelector: { paths: ["docs"], versionId: "v1" },
      recordRefusals: async () => undefined,
      pull: async (input) =>
        await client.pullShareView({
          shareId: input.shareId,
          grantedSelector: input.grantedSelector,
        }),
    });

    expect(
      daemon.requests.find(
        (request) => request.method === "share.view.pull",
      )?.params,
      "MUTATION: dropping either dimension on the wire widens the accepted grant",
    ).toEqual({
      workspaceId: "workspace-a",
      shareId: "share-view",
      grantedSelector: { paths: ["docs"], versionId: "v1" },
    });
    await sessions.closeAll();
  });

  // The engine SKIPS an op it refuses and keeps pulling, so the refusal is the
  // only signal that the share stopped carrying part of what the granter
  // shares. It must survive the wire, and it must survive PAGING: a refusal on
  // an early page is exactly the one a caller would otherwise never see.
  it("carries every page's share-view refusals through to the caller", async () => {
    let pulls = 0;
    const daemon = new MockDaemon((request) => {
      if (request.method !== "share.view.pull") return undefined;
      pulls += 1;
      const first = pulls === 1;
      return {
        fetched: 1,
        applied: 0,
        skipped: 1,
        refusals: [
          {
            originId: "origin-granter",
            originSeq: first ? 4 : 9,
            opKind: "moment.append",
            code: "share-boundary-violation",
            detail: first
              ? "replicated moment is outside the share boundary: the share granted version main, the relay offered version version-other"
              : "replicated moment is outside the share boundary: its versionId is not one the relay could have issued: a version id is non-empty, unpadded, and at most 128 UTF-16 code units; the relay offered 130 UTF-16 code units",
          },
        ],
        hasMore: first,
        nextCursor: pulls,
        changedPaths: [],
        pendingCursor: { kind: "shareView", token: `share-cursor-${pulls}` },
      };
    });
    const { sessions, client } = await harness(daemon);

    const pull = await client.pullShareView({
      shareId: "share-view",
      grantedSelector: { paths: ["docs"], versionId: null },
    });

    expect(
      pull.refusals.map((refusal) => refusal.originSeq),
      "MUTATION: keeping only the last page's refusals loses the earlier ones entirely",
    ).toEqual([4, 9]);
    expect(pull.skipped).toBe(2);
    expect(pull.refusals[0].detail).toContain("version-other");
    expect(pull.refusals[1].detail).toContain("130 UTF-16 code units");
    await sessions.closeAll();
  });

  // The durable record holds every reason — each page reaches the recorder
  // before its cursor commits — so the in-memory aggregate only has to carry
  // enough to log and to show. A relay that refuses on every page must not be
  // able to grow it with its log; the paging loop has no page limit of its own.
  it("bounds the refusals it accumulates in memory while counting them all", async () => {
    const pages = MAX_REPORTED_REFUSALS + 5;
    let pulls = 0;
    const daemon = new MockDaemon((request) => {
      if (request.method !== "share.view.pull") return undefined;
      pulls += 1;
      return {
        fetched: 1,
        applied: 0,
        skipped: 1,
        refusals: [
          {
            originId: "origin-granter",
            originSeq: pulls,
            opKind: "moment.append",
            code: "share-boundary-violation",
            detail: `refused ${pulls}`,
          },
        ],
        hasMore: pulls < pages,
        nextCursor: pulls,
        changedPaths: [],
        pendingCursor: { kind: "shareView", token: `share-cursor-${pulls}` },
      };
    });
    const { sessions, client } = await harness(daemon);
    let recorded = 0;

    const pull = await client.pullShareView({
      shareId: "share-view",
      grantedSelector: { paths: ["docs"], versionId: null },
      recordRefusals: async (refusals) => {
        recorded += refusals.length;
      },
    });

    expect(
      pull.refusals.length,
      "MUTATION: an unbounded aggregate lets a relay grow memory in proportion to its log",
    ).toBe(MAX_REPORTED_REFUSALS);
    // The count is still the truth, and every page still reached the record.
    expect(pull.refusalCount).toBe(pages);
    expect(recorded).toBe(pages);
    await sessions.closeAll();
  });

  // The pull commits each intermediate page's cursor as it goes. So an early
  // page's refusals must be RECORDED BEFORE that commit: if a later page
  // fails, the retry starts past the refused op and the only remaining record
  // of why that content is missing is the one written here.
  it("records a page's refusals before committing its cursor, even when a later page fails", async () => {
    let pulls = 0;
    const daemon = new MockDaemon((request) => {
      if (request.method !== "share.view.pull") return undefined;
      pulls += 1;
      if (pulls > 1) throw new Error("relay went away mid-page");
      return {
        fetched: 1,
        applied: 0,
        skipped: 1,
        refusals: [
          {
            originId: "origin-granter",
            originSeq: 4,
            opKind: "moment.append",
            code: "share-boundary-violation",
            detail: "the share granted version main, the relay offered version version-other",
          },
        ],
        hasMore: true,
        nextCursor: 1,
        changedPaths: [],
        pendingCursor: { kind: "shareView", token: "share-cursor-1" },
      };
    });
    const { sessions, client } = await harness(daemon);
    const recorded: string[] = [];

    await expect(
      client.pullShareView({
        shareId: "share-view",
        grantedSelector: { paths: ["docs"], versionId: null },
        recordRefusals: async (refusals) => {
          recorded.push(...refusals.map((refusal) => refusal.detail));
        },
      }),
    ).rejects.toThrow();

    expect(
      recorded,
      "MUTATION: recording after the commit loses the reason while the cursor stays past the op",
    ).toEqual([
      "the share granted version main, the relay offered version version-other",
    ]);
    await sessions.closeAll();
  });

  it("materializes a share view through the injected daemon store", async () => {
    const body = "read from daemon";
    const daemon = new MockDaemon((request) => {
      if (request.method === "share.view.pull") {
        return {
          fetched: 1,
          applied: 1,
          skipped: 0,
          refusals: [],
          refusalCount: 0,
          hasMore: false,
          nextCursor: 14,
          changedPaths: [
            { path: "notes/daemon.md", operation: "write", contentKind: "text" },
          ],
          pendingCursor: { kind: "shareView", token: "share-cursor-14" },
        };
      }
      if (request.method === "versions.ensureMain") {
        return {
          id: "main",
          workspaceId: "workspace-a",
          kind: "main",
          name: "Main",
          createdAtMs: 1,
        };
      }
      if (request.method === "versionedText.read") {
        return {
          workspaceId: "workspace-a",
          versionId: "main",
          objectId: "object-daemon",
          path: "notes/daemon.md",
          contentKind: "text",
          text: body,
          byteLength: Buffer.byteLength(body),
          blobSha256: "0".repeat(64),
          sha256: "0".repeat(64),
          updatedAtMs: 2,
          latestMomentId: "moment-daemon",
          metadataOrigin: "sync",
          metadataSummary: null,
          metadataCorrelationId: null,
        };
      }
      return undefined;
    });
    const { rootPath, sessions, client, relay } = await harness(daemon);
    const store = createCaptureLiveStores(
      { workspaceId: "workspace-a", rootPath },
      sessions,
    ).store;

    await expect(
      refreshSharedViewOnce({
        rootDir: rootPath,
        workspaceId: "workspace-a",
        relay,
        shareId: "share-view",
        store,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        pull: async (input) =>
          await client.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
          }),
      }),
    ).resolves.toEqual({
      status: "updated",
      changedPaths: 1,
      refusedOps: 0,
      refusedDetail: null,
    });

    expect(await readFile(join(rootPath, "notes/daemon.md"), "utf8")).toBe(body);
    expect(daemon.requests.map((request) => request.method)).toContain(
      "versionedText.read",
    );
    await sessions.closeAll();
  });

  it("opens a share mount's nested store and pulls it through the daemon", async () => {
    const { rootPath, daemon, routes, sessions, live, relay } = await harness();
    const mount = { shareId: "share-mounted", label: "alex" };
    await createMountDirectory(rootPath, mount.label);
    const target = relayTargetForShareMount("workspace-a", rootPath, mount);
    const mountRelay = live.bind({ ...target, relay });

    await expect(
      refreshShareMountOnce({
        hostWorkspaceId: "workspace-a",
        hostRoot: rootPath,
        mount,
        relay,
        openStore: (workspace) =>
          createCaptureLiveStores(workspace, sessions).store,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        pull: async (input) =>
          await mountRelay.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
          }),
      }),
    ).resolves.toEqual({
      status: "unchanged",
      changedPaths: 0,
      refusedOps: 0,
      refusedDetail: null,
    });

    expect(routes.modeFor(target.workspaceId)).toBe("daemon");
    expect(
      daemon.requests.find(
        (request) =>
          request.method === "workspace.open" &&
          request.params &&
          typeof request.params === "object" &&
          !Array.isArray(request.params) &&
          request.params.workspaceId === target.workspaceId,
      )?.params,
    ).toMatchObject({
      rootDir: target.rootPath,
      workspaceId: target.workspaceId,
      captureMode: "none",
    });
    expect(
      daemon.requests.find(
        (request) => request.method === "share.view.pull",
      )?.params,
    ).toMatchObject({
      workspaceId: target.workspaceId,
      shareId: mount.shareId,
    });
    // The mount OWNS its nested store, so its close must be the last thing it
    // does — after sync.commitCursor. `some(...)` would not prove that: the
    // relay client forces its own workspace.close before the pull when it
    // rebinds, so a mount that never closed its store would still pass.
    expect(daemon.requests.at(-1)?.method).toBe("workspace.close");
    await sessions.closeAll();
  });

  it("translates a revoked daemon share and lets the shared-view consumer report ended", async () => {
    const daemon = new MockDaemon((request) => {
      if (
        request.method === "share.view.pull" ||
        request.method === "share.channel.pull"
      ) {
        throw new EngineRequestError(request.id, {
          code: "SHARE_UNAVAILABLE",
          message: "workspace operation failed",
          retry: "no",
        });
      }
      return undefined;
    });
    const { rootPath, client, relay, sessions } = await harness(daemon);
    const store = createCaptureLiveStores(
      { workspaceId: "workspace-a", rootPath },
      sessions,
    ).store;

    await expect(
      client.pullShareView({
        shareId: "share-revoked",
        grantedSelector: { paths: ["docs"], versionId: null },
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
    await expect(
      refreshSharedViewOnce({
        rootDir: rootPath,
        workspaceId: "workspace-a",
        relay,
        shareId: "share-revoked",
        store,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        pull: async (input) =>
          await client.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
          }),
      }),
    ).resolves.toEqual({
      status: "ended",
      changedPaths: 0,
      refusedOps: 0,
      refusedDetail: null,
    });
    const revokedRows = [
      {
        shareId: "channel-revoked",
        channelWireId: "wire-revoked",
        access: "read-only" as const,
        granterEmail: "owner@example.com",
        relayUrl: relay.baseUrl,
        recipientUserId: "member-1",
      },
    ];
    await expect(
      syncJoinedSharedChannels({
        rootDir: rootPath,
        workspaceId: "workspace-a",
        relay,
        passRows: 1,
        registryOrder: revokedRows,
        channels: revokedRows,
        pull: async (input) =>
          await client.pullSharedChannel({
            shareId: input.shareId,
            channelWireId: input.channelWireId,
          }),
        push: async (input) =>
          await client.pushSharedChannel({
            shareId: input.shareId,
            channelWireId: input.channelWireId,
          }),
      }),
    ).resolves.toMatchObject({ endedShareIds: ["channel-revoked"] });
    await sessions.closeAll();
  });

  it("binds a marker-less rooted workspace to the daemon before session preparation", async () => {
    const { daemon, routes, sessions } = await harness();

    expect(
      routes.modeFor("workspace-a"),
      "MUTATION: a rooted workspace must never bind the legacy TypeScript relay",
    ).toBe("daemon");
    expect(
      daemon.requests,
      "bind must not require workspace preparation or workspace.open",
    ).toEqual([]);
    await sessions.closeAll();
  });

  it("allows a rooted daemon bind after a rootless probe route is released", async () => {
    const rootPath = await createTestScratch("dohc-relay-probe-route-");
    roots.push(rootPath);
    const routes = new RelayTransportRouteGuard();
    let finishProbe!: (response: globalThis.Response) => void;
    const pendingProbe = new Promise<globalThis.Response>((resolve) => {
      finishProbe = resolve;
    });
    const relay = {
      baseUrl: "https://relay.test",
      token: "secret-token",
      fetch: async () => await pendingProbe,
    };
    const probe = probeWorkspaceRelay(routes, {
      workspaceId: "workspace-probed",
      relay,
    });

    expect(routes.modeFor("workspace-probed")).toBe("typescript");
    routes.releaseWorkspace("workspace-probed", "typescript");

    const daemon = new MockDaemon();
    const sessions = new EngineWorkspaceSessions(
      new RelayConfiguredDaemonClientSource(
        { currentClient: () => daemon },
        routes,
      ),
      { transportRebindAttempts: 1 },
    );
    const live = new EngineRelayClient({ sessions, routes });
    live.bind({
      workspaceId: "workspace-probed",
      rootPath,
      relay,
    });
    expect(routes.modeFor("workspace-probed")).toBe("daemon");
    finishProbe(
      globalThis.Response.json({
        ok: true,
        hasContent: true,
        replicationEpoch: "epoch-probed",
        streamIdentity: "stream-probed",
      }),
    );
    await expect(probe).resolves.toEqual({
      hasContent: true,
      identity: {
        replicationEpoch: "epoch-probed",
        streamIdentity: "stream-probed",
      },
    });
    expect(
      routes.modeFor("workspace-probed"),
      "a late probe cleanup must not release a newer daemon route",
    ).toBe("daemon");
    await sessions.closeAll();
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
          sharingDeclined: [],
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
          refusals: [],
          refusalCount: 0,
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

    const view = await client.pullShareView({
      shareId: "share-view",
      grantedSelector: { paths: ["docs"], versionId: null },
    });
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
      if (request.method === "sync.push" || request.method === "sync.pull") {
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
    await expect(client.pull()).rejects.toBeInstanceOf(DaemonRefusalError);
    originMarker = true;
    await expect(client.push()).rejects.toBeInstanceOf(
      RelayOriginDivergedError,
    );
    await expect(client.pull()).rejects.toBeInstanceOf(
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

describe("RelayConfiguredDaemonClientSource capability forwarding", () => {
  it("preserves the inner client's optional capabilities through the wrap", () => {
    const seen: string[] = [];
    const unsubscribe = () => undefined;
    const inner: EngineDaemonClient = {
      sendRequest: () => Promise.reject(new Error("unused")),
      close: () => undefined,
      cancelRequest: async (requestId) => {
        seen.push(`cancel:${requestId}`);
      },
      onBlob: () => {
        seen.push("onBlob");
        return unsubscribe;
      },
      onEvent: () => {
        seen.push("onEvent");
        return unsubscribe;
      },
      waitForExit: async () => {
        seen.push("waitForExit");
      },
    };
    const source = new RelayConfiguredDaemonClientSource(
      { currentClient: () => inner },
      new RelayTransportRouteGuard(),
    );
    const wrapped = source.currentClient();
    expect(wrapped).not.toBe(inner);
    // The engine Y.Doc open path gates on `typeof client.onEvent === "function"`;
    // a wrapper that drops it silently downgrades every rich doc to the plain
    // editor.
    expect(typeof wrapped.onEvent).toBe("function");
    expect(wrapped.onEvent?.(() => undefined)).toBe(unsubscribe);
    expect(wrapped.onBlob?.(() => undefined)).toBe(unsubscribe);
    void wrapped.cancelRequest?.(7);
    void wrapped.waitForExit?.();
    expect(seen).toEqual(["onEvent", "onBlob", "cancel:7", "waitForExit"]);
  });

  it("does not invent capabilities the inner client lacks", () => {
    const inner: EngineDaemonClient = {
      sendRequest: () => Promise.reject(new Error("unused")),
      close: () => undefined,
    };
    const source = new RelayConfiguredDaemonClientSource(
      { currentClient: () => inner },
      new RelayTransportRouteGuard(),
    );
    const wrapped = source.currentClient();
    expect(wrapped.onEvent).toBeUndefined();
    expect(wrapped.onBlob).toBeUndefined();
    expect(wrapped.cancelRequest).toBeUndefined();
    expect(wrapped.waitForExit).toBeUndefined();
  });
});

describe("allowInsecureLoopbackRelayForTests", () => {
  const enabled = { [INSECURE_LOOPBACK_RELAY_TEST_ENV]: "1" };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows plain-http loopback relays when the e2e env flag is set", () => {
    expect(
      allowInsecureLoopbackRelayForTests("http://127.0.0.1:8787", enabled),
    ).toBe(true);
    expect(
      allowInsecureLoopbackRelayForTests("http://localhost:8787/relay", enabled),
    ).toBe(true);
    expect(
      allowInsecureLoopbackRelayForTests("http://[::1]:8787", enabled),
    ).toBe(true);
  });

  it("refuses non-loopback http hosts even with the flag set", () => {
    expect(
      allowInsecureLoopbackRelayForTests("http://relay.example.com", enabled),
    ).toBe(false);
    expect(
      allowInsecureLoopbackRelayForTests(
        "http://localhost.evil.test:8787",
        enabled,
      ),
    ).toBe(false);
    expect(
      allowInsecureLoopbackRelayForTests("http://192.168.1.10:8787", enabled),
    ).toBe(false);
  });

  it("stays off without the exact flag, for https, and for junk URLs", () => {
    expect(allowInsecureLoopbackRelayForTests("http://127.0.0.1:8787", {})).toBe(
      false,
    );
    expect(
      allowInsecureLoopbackRelayForTests("http://127.0.0.1:8787", {
        [INSECURE_LOOPBACK_RELAY_TEST_ENV]: "true",
      }),
    ).toBe(false);
    expect(
      allowInsecureLoopbackRelayForTests("https://relay.test", enabled),
    ).toBe(false);
    expect(allowInsecureLoopbackRelayForTests("not a url", enabled)).toBe(false);
  });

  it("flows from the env flag into the daemon workspace.open relay config", async () => {
    vi.stubEnv(INSECURE_LOOPBACK_RELAY_TEST_ENV, "1");
    const { rootPath, daemon, live, sessions } = await harness();
    const client = live.bind({
      workspaceId: "workspace-loopback",
      rootPath,
      relay: { baseUrl: "http://127.0.0.1:8787", token: "loopback-token" },
    });
    await client.push();
    const open = daemon.requests.find(
      (request) =>
        request.method === "workspace.open" &&
        request.params &&
        typeof request.params === "object" &&
        !Array.isArray(request.params) &&
        request.params.workspaceId === "workspace-loopback",
    );
    expect(open?.params).toMatchObject({
      relay: {
        baseUrl: "http://127.0.0.1:8787",
        bearerToken: "loopback-token",
        allowInsecureLoopbackForTests: true,
      },
    });
    await sessions.closeAll();
  });

  it("keeps the flag out of workspace.open when the env flag is unset", async () => {
    const { daemon, sessions, client } = await harness();
    await client.push();
    const open = daemon.requests.find(
      (request) => request.method === "workspace.open",
    );
    expect(open?.params).toMatchObject({
      relay: { baseUrl: "https://relay.test" },
    });
    const relayParams =
      open &&
      open.params &&
      typeof open.params === "object" &&
      !Array.isArray(open.params)
        ? open.params.relay
        : null;
    expect(relayParams).not.toHaveProperty("allowInsecureLoopbackForTests");
    await sessions.closeAll();
  });
});

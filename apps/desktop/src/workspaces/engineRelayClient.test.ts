import { existsSync, mkdirSync } from "node:fs";
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
  RelayIdentityMissingError,
  RelayClaimRefusedError,
} from "@dohc/workspace-contracts/relay";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineClientError,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import {
  allowInsecureLoopbackRelayForTests,
  EngineRelayClient,
  MixedRelayTransportError,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import { INSECURE_LOOPBACK_RELAY_TEST_ENV } from "./cloudConfiguration";
import { refreshStandaloneShareThroughOwnerForTest } from "../testing/shareViewFilesMountHarness";

// Every test in this file pulls with the selector its share record pins. The
// damaged-record path has its own tests in sharedView.test.ts. This is a real
// selector — no paths and no version selects nothing at all, which the engine
// refuses.
const PINNED_SELECTOR = {
  paths: ["docs"],
  versionId: null,
  access: "view",
} as const;
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import { readLocalStateFrom } from "./workspaceLocalState";

class MockDaemon implements EngineDaemonClient {
  readonly requests: Request[] = [];

  constructor(private readonly override?: (request: Request) => JsonValue | undefined) {}

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    const overridden = this.override?.(request);
    if (overridden !== undefined) {
      return { id: request.id, result: overridden };
    }
    const result = (() => {
      switch (request.method) {
        case "workspace.open": {
          // As the engine's open does, make `.dohc/local` and say so.
          const { rootDir } = request.params as { rootDir: string };
          if (existsSync(rootDir)) {
            mkdirSync(join(rootDir, ".dohc", "local"), { recursive: true, mode: 0o700 });
          }
          return { workspace: "ws-mock", localStateReady: true };
        }
        case "workspace.close":
          return { closed: true };
        case "sync.push":
          return {
            status: "complete",
            refused: 0,
            pushed: 3,
            ownerAdmissionPending: [],
            fetched: 0,
            applied: 0,
            skipped: 0,
            conflictsOpened: 0,
            hasMore: false,
            nextCursor: null,
            pendingCursor: null,
            changedPaths: [],
            sharingDeclined: [],
            refusals: [],
          };
        case "sync.fetchPull":
          return { pageToken: "page-token" };
        case "sync.applyPull":
          return {
            status: "complete",
            refused: 0,
            pushed: 0,
            ownerAdmissionPending: [],
            fetched: 4,
            applied: 2,
            skipped: 2,
            conflictsOpened: 1,
            hasMore: false,
            nextCursor: 9,
            pendingCursor: { kind: "relay", token: "cursor-9" },
            changedPaths: [
              {
                versionId: "main",
                path: "notes/plan.md",
                operation: "write",
                contentKind: "text",
              },
              {
                versionId: "main",
                path: ".env",
                operation: "write",
                contentKind: "secret",
              },
            ],
            sharingDeclined: [],
            refusals: [],
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
        case "sync.resetClaimRefusal":
          return { reset: true };
        case "sync.collectionsWaiting":
          return { waiting: true };
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
        case "share.proposal.submit":
          return {
            submitted: 2,
            proposalId: "proposal-1",
            skippedOutsideShare: 0,
            morePending: false,
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

async function harness(daemon = new MockDaemon(), onRefusalsChanged?: () => void) {
  const rootPath = await createTestScratch("dohc-relay-client-unit-");
  const attachmentId = Symbol("test-workspace-attachment");
  roots.push(rootPath);
  const routes = new RelayTransportRouteGuard();
  const source = new RelayConfiguredDaemonClientSource({ currentClient: () => daemon }, routes);
  const sessions = new EngineWorkspaceSessions(source, {
    transportRebindAttempts: 1,
  });
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
  const live = new EngineRelayClient({
    sessions,
    routes,
    requestDeadlineMs: 1_000,
    onRefusalsChanged,
  });
  const relay = { baseUrl: "https://relay.test/", token: "secret-token" };
  const client = live.bind({
    workspaceId: "workspace-a",
    rootPath,
    attachmentId,
    relay,
  });
  return {
    rootPath,
    attachmentId,
    daemon,
    routes,
    sessions,
    live,
    relay,
    client,
  };
}

describe("EngineRelayClient", () => {
  it("fetches off the capture chain and completes each batch before fetching another", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    let pages = 0;
    const events: string[] = [];
    const daemon = new MockDaemon((request) => {
      if (request.method === "sync.applyPull") {
        expect(held).toBe(true);
        events.push("apply");
        pages += 1;
        return {
          status: "complete",
          refused: 0,
          fetched: 1,
          applied: 1,
          skipped: 0,
          conflictsOpened: 0,
          hasMore: pages === 1,
          nextCursor: pages,
          pendingCursor: { kind: "relay", token: `cursor-${pages}` },
          sharingDeclined: [],
          refusals: [],
          changedPaths: [],
        };
      }
      if (request.method === "sync.commitCursor") {
        expect(held).toBe(true);
        events.push("commit");
      }
      return undefined;
    });
    const send = daemon.sendRequest.bind(daemon);
    vi.spyOn(daemon, "sendRequest").mockImplementation(async (request) => {
      if (request.method === "sync.fetchPull") {
        expect(held).toBe(false);
        events.push("fetch");
        entered.resolve();
        await release.promise;
      }
      return send(request);
    });
    const { client, sessions } = await harness(daemon);
    const pulling = client.pull(async (apply) => {
      held = true;
      try {
        return await apply(async () => {
          expect(held).toBe(true);
          events.push("project");
        });
      } finally {
        held = false;
      }
    });
    await entered.promise;
    expect(held).toBe(false);
    expect(events).toEqual(["fetch"]);
    release.resolve();
    await pulling;
    expect(events).toEqual([
      "fetch",
      "apply",
      "project",
      "commit",
      "fetch",
      "apply",
      "project",
      "commit",
    ]);
    await sessions.closeAll();
  });

  it("claims after reopening a refused workspace under another account", async () => {
    let refusalAccount: string | null = null;
    let pending = true;
    const daemon = new MockDaemon((request) => {
      const params = request.params;
      const accountId =
        params !== null && typeof params === "object" && !Array.isArray(params)
          ? params.accountId
          : undefined;
      if (request.method === "sync.resetClaimRefusal") {
        if (accountId !== refusalAccount) refusalAccount = null;
      }
      if (request.method === "sync.push" && refusalAccount !== null) {
        throw new DaemonRefusalError(
          { code: "WORKSPACE_UNAVAILABLE", message: "relay-claim-refused", retry: "no" },
          new Error("refused"),
        );
      }
      if (request.method === "sync.push" && pending) {
        throw new DaemonRefusalError(
          { code: "IDENTITY_REQUIRED", message: "relay-identity-required", retry: "no" },
          new Error("pending"),
        );
      }
      if (request.method === "sync.claim") {
        if (accountId === "account-b") pending = false;
        else {
          refusalAccount = "account-a";
          throw new DaemonRefusalError(
            { code: "WORKSPACE_UNAVAILABLE", message: "relay-workspace-unavailable", retry: "no" },
            new Error("refused"),
          );
        }
      }
      return undefined;
    });
    const h = await harness(daemon);
    const binding = {
      workspaceId: "workspace-a",
      rootPath: h.rootPath,
      relay: h.relay,
      accountId: "account-a",
    };
    const first = h.live.bind(binding);
    await expect(first.claim()).rejects.toBeInstanceOf(RelayClaimRefusedError);
    await h.live.closeWorkspace("workspace-a");
    const sameAccount = h.live.bind({
      ...binding,
      relay: { ...h.relay, token: "refreshed-token" },
    });
    await expect(sameAccount.push()).rejects.toBeInstanceOf(RelayClaimRefusedError);
    await h.live.closeWorkspace("workspace-a");
    await h.live.closeAll({ accountChanged: true });
    expect(refusalAccount).toBe("account-a");
    const next = h.live.bind({
      ...binding,
      accountId: "account-b",
      relay: { ...h.relay, token: "account-b-token" },
    });
    await expect(next.push()).rejects.toBeInstanceOf(RelayIdentityMissingError);
    await next.claim();
    await expect(next.push()).resolves.toBeDefined();
    expect(daemon.requests.filter((request) => request.method === "sync.claim")).toHaveLength(2);
    await h.live.closeAll();
  });

  it("materializes each workspace pull page before committing its cursor", async () => {
    let committedPages = 0;
    const materializedPaths: string[] = [];
    const daemon = new MockDaemon((request) => {
      if (request.method === "sync.applyPull") {
        const page = committedPages + 1;
        return {
          status: "complete",
          refused: 0,
          pushed: 0,
          ownerAdmissionPending: [],
          fetched: 1,
          applied: 1,
          skipped: 0,
          conflictsOpened: 0,
          hasMore: page === 1,
          nextCursor: page,
          pendingCursor: { kind: "relay", token: `cursor-${page}` },
          changedPaths: [
            {
              versionId: "main",
              path: `notes/page-${page}.md`,
              operation: "write",
              contentKind: "text",
            },
          ],
          sharingDeclined: [],
          refusals: [],
        };
      }
      if (request.method === "sync.commitCursor") {
        const cursor = (
          request.params as unknown as {
            pendingCursor: { token?: string };
          }
        ).pendingCursor;
        expect(cursor.token).toBe(`cursor-${committedPages + 1}`);
        expect(materializedPaths.at(-1)).toBe(`notes/page-${committedPages + 1}.md`);
        committedPages += 1;
        return { committed: true, sharingDeclined: [] };
      }
      return undefined;
    });
    const { sessions, client } = await harness(daemon);
    let failSecondPage = true;
    const materializePage = vi.fn(async (paths: readonly { path: string }[]): Promise<void> => {
      const path = paths[0]?.path;
      if (path === "notes/page-2.md" && failSecondPage) {
        failSecondPage = false;
        throw new Error("disk unavailable");
      }
      if (path) materializedPaths.push(path);
    });

    await expect(client.pull(async (apply) => apply(materializePage))).rejects.toThrow(
      "disk unavailable",
    );
    expect(committedPages).toBe(1);
    expect(materializedPaths).toEqual(["notes/page-1.md"]);

    const pulled = await client.pull(async (apply) => apply(materializePage));
    expect(committedPages).toBe(2);
    expect(pulled.fastForwardedPaths).toEqual([
      expect.objectContaining({ path: "notes/page-2.md" }),
    ]);
    expect(materializePage).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ path: "notes/page-1.md" }),
    ]);
    expect(materializePage).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ path: "notes/page-2.md" }),
    ]);
    expect(materializePage).toHaveBeenNthCalledWith(3, [
      expect.objectContaining({ path: "notes/page-2.md" }),
    ]);
    await sessions.closeAll();
  });

  // The durable record holds every reason — each page reaches the recorder
  // before its cursor commits — so the in-memory aggregate only has to carry
  // enough to log and to show. A relay that refuses on every page must not be
  // able to grow it with its log; the paging loop has no page limit of its own.
  it("bounds the refusals it accumulates in memory while counting them all", async () => {
    const pages = MAX_REPORTED_REFUSALS + 1;
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
      grantedSelector: { paths: ["docs"], versionId: null, access: "view" },
      recordRefusals: async (refusals) => {
        recorded += refusals.length;
      },
    });

    expect(
      pull.refusals.length,
      "an unbounded aggregate lets a relay grow memory in proportion to its log",
    ).toBe(MAX_REPORTED_REFUSALS);
    // The count is still the truth, and every page still reached the record.
    expect(pull.refusalCount).toBe(pages);
    expect(recorded).toBe(pages);
    await sessions.closeAll();
  });

  // The pull commits each intermediate page's cursor as it goes. So an early
  // page's refusals must be recorded before that commit: if a later page
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
        grantedSelector: { paths: ["docs"], versionId: null, access: "view" },
        recordRefusals: async (refusals) => {
          recorded.push(...refusals.map((refusal) => refusal.detail));
        },
      }),
    ).rejects.toThrow();

    expect(
      recorded,
      "recording after the commit loses the reason while the cursor stays past the op",
    ).toEqual(["the share granted version main, the relay offered version version-other"]);
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
            {
              path: "notes/daemon.md",
              operation: "write",
              contentKind: "text",
            },
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
    const { rootPath, attachmentId, sessions, client, relay } = await harness(daemon);
    const store = createCaptureLiveStores(
      { workspaceId: "workspace-a", rootPath, attachmentId },
      sessions,
    ).store;

    await expect(
      refreshStandaloneShareThroughOwnerForTest({
        rootDir: rootPath,
        workspaceId: "workspace-a",
        attachmentId,
        relay,
        shareId: "share-view",
        store,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        pull: async (input) => {
          const pull = await client.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
          });
          expect(pull.nextCursor).toBe(14);
          return pull;
        },
      }),
    ).resolves.toEqual({
      status: "updated",
      changedPaths: 1,
      excludedPaths: [],
      unjournalablePaths: [],
      collisionRecordQuarantined: false,
      refusedOps: 0,
      refusedDetail: null,
    });

    expect(await readFile(join(rootPath, "notes/daemon.md"), "utf8")).toBe(body);
    expect(daemon.requests.map((request) => request.method)).toContain("versionedText.read");
    await sessions.closeAll();
  });

  it("rebinds the attachment-keyed session before and after a transport restart", async () => {
    const rootPath = await createTestScratch("dohc-relay-attachment-rebind-");
    roots.push(rootPath);
    const routes = new RelayTransportRouteGuard();
    const second = new MockDaemon();
    let current: EngineDaemonClient;
    const first = new MockDaemon((request) => {
      if (request.method === "sync.push") {
        current = second;
        throw new EngineClientError("transport-error", "injected daemon restart");
      }
      return undefined;
    });
    current = first;
    const sessions = new EngineWorkspaceSessions(
      new RelayConfiguredDaemonClientSource({ currentClient: () => current }, routes),
      {
        transportRebindAttempts: 2,
        sleep: async () => undefined,
      },
    );
    const live = new EngineRelayClient({ sessions, routes });
    const workspace = {
      workspaceId: "workspace-rebind-attached",
      rootPath,
      attachmentId: Symbol("relay-rebind-attachment"),
    };
    const client = live.bind({
      ...workspace,
      relay: { baseUrl: "https://relay.test", token: "secret-token" },
    });
    await sessions.run(workspace, async () => undefined);

    await expect(client.push()).resolves.toMatchObject({ pushed: 3 });

    expect(first.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "workspace.close",
      "workspace.open",
      "sync.push",
    ]);
    expect(second.requests.map((request) => request.method)).toEqual([
      "workspace.open",
      "sync.push",
    ]);
    await sessions.closeAll();
  });

  it("isolates same-id physical successors through run and close", async () => {
    let opens = 0;
    const daemon = new MockDaemon((request) => {
      if (request.method === "workspace.open") {
        opens += 1;
        return { workspace: `ws-${opens}` };
      }
      return undefined;
    });
    const { rootPath, live, relay, routes, sessions } = await harness(daemon);
    const firstWorkspace = {
      workspaceId: "workspace-successor",
      rootPath,
      attachmentId: Symbol("relay-predecessor"),
    };
    const secondWorkspace = {
      ...firstWorkspace,
      attachmentId: Symbol("relay-successor"),
    };
    const first = live.bind({ ...firstWorkspace, relay });
    await first.push();
    await live.closeWorkspace(firstWorkspace);

    const second = live.bind({ ...secondWorkspace, relay });
    await second.push();
    expect(opens).toBe(2);

    // A delayed predecessor cleanup must not release the successor's route or
    // close its attachment-keyed session.
    await live.closeWorkspace(firstWorkspace);
    expect(routes.isBound(firstWorkspace.workspaceId)).toBe(true);
    await second.push();
    expect(opens).toBe(2);
    expect(
      daemon.requests
        .filter((request) => request.method === "workspace.close")
        .map((request) => request.workspace),
    ).toEqual(["ws-1"]);

    await live.closeWorkspace(secondWorkspace);
    expect(routes.isBound(firstWorkspace.workspaceId)).toBe(false);
    expect(
      daemon.requests
        .filter((request) => request.method === "workspace.close")
        .map((request) => request.workspace),
    ).toEqual(["ws-1", "ws-2"]);
    await sessions.closeAll();
  });

  it("keeps exact share-mount policy through relay token refresh", async () => {
    const { rootPath, daemon, live, relay } = await harness();
    const workspace = {
      workspaceId: "workspace-share-refresh",
      rootPath,
      attachmentId: Symbol("relay-share-refresh"),
    };

    const first = live.bind({ ...workspace, shareMount: true, relay });
    await first.push();
    const refreshed = live.bind({
      ...workspace,
      relay: { ...relay, token: "refreshed-token" },
    });
    await refreshed.push();

    const opens = daemon.requests.filter((request) => request.method === "workspace.open");
    expect(opens).toHaveLength(2);
    expect(opens.map((request) => request.params)).toEqual([
      expect.objectContaining({
        workspaceId: workspace.workspaceId,
        captureMode: "none",
      }),
      expect.objectContaining({
        workspaceId: workspace.workspaceId,
        captureMode: "none",
      }),
    ]);
    await live.closeWorkspace(workspace);
  });

  it("drains every daemon pull page before reporting synchronization complete", async () => {
    let workspacePulls = 0;
    let channelPulls = 0;
    let viewPulls = 0;
    const daemon = new MockDaemon((request) => {
      if (request.method === "sync.applyPull") {
        workspacePulls += 1;
        const first = workspacePulls === 1;
        return {
          status: "complete",
          refused: 0,
          pushed: 0,
          ownerAdmissionPending: [],
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
              versionId: "main",
              path: first ? "first.md" : "second.md",
              operation: "write",
              contentKind: "text",
            },
          ],
          sharingDeclined: [],
          refusals: [],
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

    const workspace = await client.pull(async (apply) => apply(async () => undefined));
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
    expect(workspacePulls, "stopping after the first hasMore page strands remote data").toBe(2);
    expect(
      daemon.requests.filter((request) => request.method === "sync.commitCursor"),
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
      grantedSelector: { paths: ["docs"], versionId: null, access: "view" },
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
    expect(routes.isBound("workspace-switch")).toBe(false);
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
});

describe("RelayConfiguredDaemonClientSource unfinished ordinary pulls", () => {
  async function openParams(
    source: RelayConfiguredDaemonClientSource,
    inner: MockDaemon,
    params: Record<string, JsonValue> = {},
  ): Promise<JsonValue | undefined> {
    await source.currentClient().sendRequest({
      id: 1,
      method: "workspace.open",
      params: { rootDir: "/no-such-root", workspaceId: "ws", ...params },
    });
    return inner.requests.at(-1)?.params;
  }

  it("lets a full owner open of a workspace with no ordinary sync abandon one", async () => {
    const inner = new MockDaemon();
    const source = new RelayConfiguredDaemonClientSource(
      { currentClient: () => inner },
      new RelayTransportRouteGuard(),
      (workspaceId) => workspaceId === "ws",
    );
    expect(await openParams(source, inner)).toMatchObject({ abandonOrdinaryPull: true });
    const temporaryOpens: Record<string, JsonValue>[] = [
      { captureMode: "none" },
      { skipStartupMaintenance: true },
      { storeMode: "passive" },
    ];
    for (const temporary of temporaryOpens) {
      expect(await openParams(source, inner, temporary)).not.toHaveProperty("abandonOrdinaryPull");
    }
  });

  it("keeps one while ordinary sync is configured or the open carries a relay", async () => {
    const inner = new MockDaemon();
    const routes = new RelayTransportRouteGuard();
    const synced = new RelayConfiguredDaemonClientSource(
      { currentClient: () => inner },
      routes,
      () => false,
    );
    expect(await openParams(synced, inner)).not.toHaveProperty("abandonOrdinaryPull");
    routes.bind({
      workspaceId: "ws",
      rootPath: "/no-such-root",
      relay: { baseUrl: "https://relay.test", token: "token" },
    });
    const routed = new RelayConfiguredDaemonClientSource(
      { currentClient: () => inner },
      routes,
      () => true,
    );
    const params = await openParams(routed, inner);
    expect(params).toHaveProperty("relay");
    expect(params).not.toHaveProperty("abandonOrdinaryPull");
  });
});

describe("allowInsecureLoopbackRelayForTests", () => {
  const enabled = { [INSECURE_LOOPBACK_RELAY_TEST_ENV]: "1" };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses non-loopback http hosts even with the flag set", () => {
    expect(allowInsecureLoopbackRelayForTests("http://relay.example.com", enabled)).toBe(false);
    expect(allowInsecureLoopbackRelayForTests("http://localhost.evil.test:8787", enabled)).toBe(
      false,
    );
    expect(allowInsecureLoopbackRelayForTests("http://192.168.1.10:8787", enabled)).toBe(false);
  });

  it("stays off without the exact flag, for https, and for junk URLs", () => {
    expect(allowInsecureLoopbackRelayForTests("http://127.0.0.1:8787", {})).toBe(false);
    expect(
      allowInsecureLoopbackRelayForTests("http://127.0.0.1:8787", {
        [INSECURE_LOOPBACK_RELAY_TEST_ENV]: "true",
      }),
    ).toBe(false);
    expect(allowInsecureLoopbackRelayForTests("https://relay.test", enabled)).toBe(false);
    expect(allowInsecureLoopbackRelayForTests("not a url", enabled)).toBe(false);
  });
});

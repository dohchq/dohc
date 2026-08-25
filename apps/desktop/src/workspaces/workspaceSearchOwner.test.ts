import type { SearchResult } from "@dohc/workspace-engine-client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../ipc/channels";
import type {
  SearchBatch,
  WorkspaceSearchRequest,
} from "./workspaceSearch";
import {
  WorkspaceSearchOwner,
  type WorkspaceSearchEngineInput,
} from "./workspaceSearchOwner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-search-owner-"));
  roots.push(root);
  await mkdir(join(root, ".dohc"));
  return root;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FakeStart {
  ownerId: number;
  searchId: string;
  request: WorkspaceSearchRequest;
  onBatch(batch: SearchBatch): void;
  isCurrent(): boolean;
  allowPath?: (path: string) => boolean;
}

function createFakeRegistry(
  onStart?: (start: FakeStart) => Promise<void>,
) {
  const starts: FakeStart[] = [];
  return {
    starts,
    adapter: {
      async startSearch(
        ownerId: number,
        _rootPath: string,
        searchId: string,
        request: WorkspaceSearchRequest,
        onBatch: (batch: SearchBatch) => void,
        options: {
          isCurrent: () => boolean;
          allowPath?: (path: string) => boolean;
        },
      ) {
        const next = { ownerId, searchId, request, onBatch, ...options };
        starts.push(next);
        await onStart?.(next);
      },
      cancel: vi.fn(),
      disposeOwner: vi.fn(),
      killAll: vi.fn(),
    },
  };
}

function createSender(id: number) {
  const destroyed: Array<() => void> = [];
  let isDestroyed = false;
  return {
    id,
    isDestroyed: () => isDestroyed,
    send: vi.fn(),
    once: vi.fn((event: "destroyed", listener: () => void) => {
      if (event === "destroyed") destroyed.push(listener);
    }),
    destroy() {
      isDestroyed = true;
      for (const listener of destroyed.splice(0)) listener();
    },
  };
}

function searchPayload(searchId: string, query = searchId) {
  return {
    workspaceId: "workspace-1",
    searchId,
    query,
  };
}

function authority<
  Workspace extends {
    workspaceId: string;
    rootPath: string;
    shareMounts?: unknown;
  },
>(workspace: Workspace, isCurrent: () => boolean = () => true) {
  return { workspace, isCurrent };
}

function engineResult(path: string): SearchResult {
  return {
    surface: "file",
    path,
    title: path,
    line: 1,
    preview: "needle",
    matchStart: 0,
    matchEnd: 6,
    threadId: null,
    objectId: path,
  };
}

const readablePolicy = {
  filesPolicy: null,
  visibilityPolicy: null,
  errors: [],
};

function expectStopped(search: Promise<void>): Promise<void> {
  return expect(search).rejects.toThrow(
    "Workspace search stopped because it is no longer current.",
  );
}

describe("WorkspaceSearchOwner", () => {
  it("rejects a replaced engine search without emitting or starting its late mount pass", async () => {
    const rootPath = await makeRoot();
    const oldResult = deferred<SearchResult[]>();
    const oldQueryStarted = deferred<void>();
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => ({ flush: async () => undefined }),
      queryEngine: async (_workspace, input) => {
        if (input.query === "old") {
          oldQueryStarted.resolve();
          return await oldResult.promise;
        }
        return [engineResult("new.md")];
      },
      logError: vi.fn(),
    });
    const workspace = {
      workspaceId: "workspace-1",
      rootPath,
      shareMounts: [
        {
          shareId: "11111111-1111-4111-8111-111111111111",
          label: "alex",
        },
      ],
    };
    const sender = createSender(1);

    const oldSearch = owner.start(
      sender,
      authority(workspace),
      searchPayload("old"),
    );
    await oldQueryStarted.promise;
    await owner.start(sender, authority(workspace), searchPayload("new"));
    const oldStopped = expectStopped(oldSearch);
    oldResult.resolve([engineResult("old.md")]);
    await oldStopped;

    expect(registry.adapter.cancel).toHaveBeenCalledWith(1, "old");
    expect(registry.starts.map((start) => start.searchId)).toEqual(["new"]);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(
      CHANNELS.searchResults,
      expect.objectContaining({
        searchId: "new",
        entries: [expect.objectContaining({ path: "new.md" })],
        done: false,
      }),
    );
  });

  it("rejects when workspace authority changes during the daemon query", async () => {
    const rootPath = await makeRoot();
    const result = deferred<SearchResult[]>();
    const queryStarted = deferred<void>();
    const registry = createFakeRegistry();
    let workspaceIsCurrent = true;
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => ({ flush: async () => undefined }),
      queryEngine: async () => {
        queryStarted.resolve();
        return await result.promise;
      },
      logError: vi.fn(),
    });
    const sender = createSender(10);
    const pending = owner.start(
      sender,
      authority(
        { workspaceId: "workspace-1", rootPath },
        () => workspaceIsCurrent,
      ),
      searchPayload("workspace-changed"),
    );
    await queryStarted.promise;

    workspaceIsCurrent = false;
    result.resolve([engineResult("late.md")]);
    await expectStopped(pending);

    expect(sender.send).not.toHaveBeenCalled();
    expect(registry.starts).toEqual([]);
  });

  it("rejects when workspace authority changes during search preparation", async () => {
    const rootPath = await makeRoot();
    const preparation = deferred<{ allowPath: () => boolean }>();
    const preparationStarted = deferred<void>();
    let workspaceIsCurrent = true;
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => {
        preparationStarted.resolve();
        return await preparation.promise;
      },
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(13);
    const pending = owner.start(
      sender,
      authority(
        { workspaceId: "workspace-1", rootPath },
        () => workspaceIsCurrent,
      ),
      searchPayload("preparation-stale"),
    );
    await preparationStarted.promise;

    workspaceIsCurrent = false;
    preparation.resolve({ allowPath: () => true });
    await expectStopped(pending);

    expect(registry.starts).toEqual([]);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("cancels its ripgrep handle when authority changes during root validation", async () => {
    const rootPath = await makeRoot();
    const validation = deferred<void>();
    const validationStarted = deferred<void>();
    let workspaceIsCurrent = true;
    const registry = createFakeRegistry(async () => {
      validationStarted.resolve();
      await validation.promise;
    });
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(17);
    const pending = owner.start(
      sender,
      authority(
        { workspaceId: "workspace-1", rootPath },
        () => workspaceIsCurrent,
      ),
      searchPayload("validation-stale"),
    );
    await validationStarted.promise;

    workspaceIsCurrent = false;
    validation.resolve();
    await expectStopped(pending);

    expect(registry.adapter.cancel).toHaveBeenCalledWith(
      sender.id,
      "validation-stale",
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rejects when workspace authority changes during capture flush", async () => {
    const rootPath = await makeRoot();
    const flush = deferred<void>();
    const flushStarted = deferred<void>();
    let workspaceIsCurrent = true;
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => ({
        flush: async () => {
          flushStarted.resolve();
          await flush.promise;
        },
      }),
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(14);
    const pending = owner.start(
      sender,
      authority(
        { workspaceId: "workspace-1", rootPath },
        () => workspaceIsCurrent,
      ),
      searchPayload("flush-stale"),
    );
    await flushStarted.promise;

    workspaceIsCurrent = false;
    flush.resolve();
    await expectStopped(pending);

    expect(registry.starts).toEqual([]);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rejects when workspace authority changes during the policy read", async () => {
    const rootPath = await makeRoot();
    const policy = deferred<typeof readablePolicy>();
    const policyReadStarted = deferred<void>();
    let workspaceIsCurrent = true;
    const registry = createFakeRegistry();
    const queryEngine = vi.fn(async () => []);
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => ({ flush: async () => undefined }),
      readEnginePolicy: async () => {
        policyReadStarted.resolve();
        return await policy.promise;
      },
      queryEngine,
      logError: vi.fn(),
    });
    const sender = createSender(15);
    const pending = owner.start(
      sender,
      authority(
        { workspaceId: "workspace-1", rootPath },
        () => workspaceIsCurrent,
      ),
      searchPayload("policy-stale"),
    );
    await policyReadStarted.promise;

    workspaceIsCurrent = false;
    policy.resolve(readablePolicy);
    await expectStopped(pending);

    expect(queryEngine).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rejects a null daemon result as a stale or cancelled invocation", async () => {
    const rootPath = await makeRoot();
    const result = deferred<SearchResult[] | null>();
    const queryStarted = deferred<void>();
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => ({ flush: async () => undefined }),
      readEnginePolicy: async () => readablePolicy,
      queryEngine: async () => {
        queryStarted.resolve();
        return await result.promise;
      },
      logError: vi.fn(),
    });
    const sender = createSender(16);
    const pending = owner.start(
      sender,
      authority({ workspaceId: "workspace-1", rootPath }),
      searchPayload("daemon-null"),
    );
    await queryStarted.promise;

    result.resolve(null);
    await expectStopped(pending);

    expect(registry.starts).toEqual([]);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("settles the exact ripgrep search once when authority changes after start", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    let workspaceIsCurrent = true;
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(11);
    await owner.start(
      sender,
      authority(
        { workspaceId: "workspace-1", rootPath },
        () => workspaceIsCurrent,
      ),
      searchPayload("workspace-changed"),
    );

    workspaceIsCurrent = false;
    const staleBatch: SearchBatch = {
      searchId: "workspace-changed",
      entries: [
        {
          path: "stale.md",
          line: 1,
          column: 1,
          preview: "stale",
          matchStart: 0,
          matchEnd: 5,
        },
      ],
      done: false,
      limitHit: false,
    };
    registry.starts[0]?.onBatch(staleBatch);
    registry.starts[0]?.onBatch(staleBatch);

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(CHANNELS.searchResults, {
      searchId: "workspace-changed",
      entries: [],
      done: true,
      limitHit: false,
    });
    expect(registry.adapter.cancel).toHaveBeenCalledWith(
      sender.id,
      "workspace-changed",
    );
    expect(registry.adapter.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel or settle a superseded ripgrep search", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(18);
    const workspace = { workspaceId: "workspace-1", rootPath };
    await owner.start(sender, authority(workspace), searchPayload("older"));
    await owner.start(sender, authority(workspace), searchPayload("newer"));
    registry.adapter.cancel.mockClear();

    registry.starts[0]?.onBatch({
      searchId: "older",
      entries: [],
      done: false,
      limitHit: false,
    });

    expect(registry.adapter.cancel).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();

    const currentBatch: SearchBatch = {
      searchId: "newer",
      entries: [],
      done: true,
      limitHit: false,
    };
    registry.starts[1]?.onBatch(currentBatch);
    expect(sender.send).toHaveBeenCalledWith(
      CHANNELS.searchResults,
      currentBatch,
    );
  });

  it("cancels only the named sender's current search and drops late batches", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const workspace = { workspaceId: "workspace-1", rootPath };
    const first = createSender(1);
    const second = createSender(2);
    await owner.start(first, authority(workspace), searchPayload("shared-id"));
    await owner.start(second, authority(workspace), searchPayload("shared-id"));

    owner.cancel(first.id, "shared-id");
    const batch: SearchBatch = {
      searchId: "shared-id",
      entries: [],
      done: true,
      limitHit: false,
    };
    registry.starts[0]?.onBatch(batch);
    registry.starts[1]?.onBatch(batch);

    expect(registry.adapter.cancel).toHaveBeenCalledWith(1, "shared-id");
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledWith(CHANNELS.searchResults, batch);
  });

  it("drops a replaced ripgrep batch even when the renderer reuses its search id", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(8);
    const workspace = { workspaceId: "workspace-1", rootPath };
    await owner.start(
      sender,
      authority(workspace),
      searchPayload("reused", "first"),
    );
    await owner.start(
      sender,
      authority(workspace),
      searchPayload("reused", "second"),
    );
    registry.adapter.cancel.mockClear();
    const batch: SearchBatch = {
      searchId: "reused",
      entries: [],
      done: true,
      limitHit: false,
    };

    registry.starts[0]?.onBatch(batch);
    expect(sender.send).not.toHaveBeenCalled();
    expect(registry.adapter.cancel).not.toHaveBeenCalled();
    registry.starts[1]?.onBatch(batch);
    expect(sender.send).toHaveBeenCalledWith(CHANNELS.searchResults, batch);
  });

  it("retires a search that starts between workspace-switch disposals", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const preparation = deferred<{ allowPath: () => boolean }>();
    const preparationStarted = deferred<void>();
    let preparationCount = 0;
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => {
        preparationCount += 1;
        if (preparationCount === 1) return { allowPath: () => true };
        preparationStarted.resolve();
        return await preparation.promise;
      },
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(12);
    const workspace = { workspaceId: "workspace-1", rootPath };
    await owner.start(sender, authority(workspace), searchPayload("before"));

    owner.disposeSender(sender.id);
    const duringTeardown = owner.start(
      sender,
      authority(workspace),
      searchPayload("during-teardown"),
    );
    await preparationStarted.promise;
    owner.disposeSender(sender.id);
    preparation.resolve({ allowPath: () => true });
    await expectStopped(duringTeardown);

    expect(registry.starts.map((start) => start.searchId)).toEqual(["before"]);
    expect(registry.adapter.disposeOwner).toHaveBeenCalledTimes(2);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rejects an engine result that resolves after explicit cancellation", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const result = deferred<SearchResult[]>();
    const queryStarted = deferred<void>();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => ({ flush: async () => undefined }),
      queryEngine: async () => {
        queryStarted.resolve();
        return await result.promise;
      },
      logError: vi.fn(),
    });
    const sender = createSender(9);
    const pending = owner.start(
      sender,
      authority({ workspaceId: "workspace-1", rootPath }),
      searchPayload("cancelled"),
    );
    await queryStarted.promise;

    owner.cancel(sender.id, "cancelled");
    result.resolve([engineResult("late.md")]);
    await expectStopped(pending);

    expect(sender.send).not.toHaveBeenCalled();
    expect(registry.starts).toEqual([]);
  });

  it("invalidates pending and active work when a sender is destroyed or disposed", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const workspace = { workspaceId: "workspace-1", rootPath };
    const destroyed = createSender(3);
    await owner.start(
      destroyed,
      authority(workspace),
      searchPayload("destroyed"),
    );
    destroyed.destroy();
    registry.starts[0]?.onBatch({
      searchId: "destroyed",
      entries: [],
      done: true,
      limitHit: false,
    });

    expect(registry.adapter.disposeOwner).toHaveBeenCalledWith(3);
    expect(destroyed.send).not.toHaveBeenCalled();

    const disposed = createSender(4);
    await owner.start(
      disposed,
      authority(workspace),
      searchPayload("disposed"),
    );
    owner.dispose();
    registry.starts[1]?.onBatch({
      searchId: "disposed",
      entries: [],
      done: true,
      limitHit: false,
    });

    expect(registry.adapter.killAll).toHaveBeenCalledTimes(1);
    expect(disposed.send).not.toHaveBeenCalled();
  });

  it("does not settle a ripgrep search after sender disposal", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender = createSender(19);
    await owner.start(
      sender,
      authority({ workspaceId: "workspace-1", rootPath }),
      searchPayload("disposed-sender"),
    );

    owner.disposeSender(sender.id);
    registry.adapter.cancel.mockClear();
    registry.starts[0]?.onBatch({
      searchId: "disposed-sender",
      entries: [],
      done: false,
      limitHit: false,
    });

    expect(registry.adapter.cancel).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("fails closed when a workspace policy file cannot be parsed", async () => {
    const rootPath = await makeRoot();
    await writeFile(join(rootPath, ".dohc", "files.toml"), "[[files]\n");
    const registry = createFakeRegistry();
    const queryEngine = vi.fn(
      async (_workspace: unknown, _input: WorkspaceSearchEngineInput) => [],
    );
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => ({ flush: async () => undefined }),
      queryEngine,
      logError: vi.fn(),
    });
    const sender = createSender(5);

    await owner.start(
      sender,
      authority({ workspaceId: "workspace-1", rootPath }),
      searchPayload("blocked"),
    );

    expect(queryEngine).not.toHaveBeenCalled();
    expect(registry.starts).toEqual([]);
    expect(sender.send).toHaveBeenCalledWith(
      CHANNELS.searchResults,
      expect.objectContaining({
        searchId: "blocked",
        entries: [],
        done: true,
        notice: expect.stringContaining("Fix the policy file"),
      }),
    );
  });

  it("ignores damaged mount records and validates every ripgrep batch", async () => {
    const rootPath = await makeRoot();
    const registry = createFakeRegistry();
    const logError = vi.fn();
    let engineBacked = true;
    const owner = new WorkspaceSearchOwner({
      searchRegistry: registry.adapter,
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () =>
        engineBacked ? { flush: async () => undefined } : null,
      queryEngine: vi.fn(async () => []),
      logError,
    });
    const sender = createSender(6);
    await owner.start(
      sender,
      authority({
        workspaceId: "workspace-1",
        rootPath,
        shareMounts: [
          {
            shareId: "11111111-1111-4111-8111-111111111111",
            label: "duplicate",
          },
          {
            shareId: "22222222-2222-4222-8222-222222222222",
            label: "duplicate",
          },
        ],
      }),
      searchPayload("damaged"),
    );

    expect(registry.starts).toEqual([]);
    expect(sender.send).toHaveBeenCalledWith(
      CHANNELS.searchResults,
      expect.objectContaining({ searchId: "damaged", done: true }),
    );

    engineBacked = false;
    const ripgrepSender = createSender(7);
    await owner.start(
      ripgrepSender,
      authority({ workspaceId: "workspace-1", rootPath }),
      searchPayload("invalid-batch"),
    );
    registry.starts[0]?.onBatch({
      searchId: "invalid-batch",
      entries: [
        {
          path: "notes.md",
          line: 0,
          column: 1,
          preview: "needle",
          matchStart: 0,
          matchEnd: 6,
        },
      ],
      done: true,
      limitHit: false,
    });

    expect(ripgrepSender.send).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "Workspace search dropped an invalid ripgrep batch.",
      expect.anything(),
    );
  });
});

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

function createFakeRegistry() {
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
        starts.push({ ownerId, searchId, request, onBatch, ...options });
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

describe("WorkspaceSearchOwner", () => {
  it("prevents a replaced engine search from emitting or starting its late mount pass", async () => {
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

    const oldSearch = owner.start(sender, workspace, searchPayload("old"));
    await oldQueryStarted.promise;
    await owner.start(sender, workspace, searchPayload("new"));
    oldResult.resolve([engineResult("old.md")]);
    await oldSearch;

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
    await owner.start(first, workspace, searchPayload("shared-id"));
    await owner.start(second, workspace, searchPayload("shared-id"));

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
    await owner.start(sender, workspace, searchPayload("reused", "first"));
    await owner.start(sender, workspace, searchPayload("reused", "second"));
    const batch: SearchBatch = {
      searchId: "reused",
      entries: [],
      done: true,
      limitHit: false,
    };

    registry.starts[0]?.onBatch(batch);
    expect(sender.send).not.toHaveBeenCalled();
    registry.starts[1]?.onBatch(batch);
    expect(sender.send).toHaveBeenCalledWith(CHANNELS.searchResults, batch);
  });

  it("drops an engine result that resolves after cancellation", async () => {
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
      { workspaceId: "workspace-1", rootPath },
      searchPayload("cancelled"),
    );
    await queryStarted.promise;

    owner.cancel(sender.id, "cancelled");
    result.resolve([engineResult("late.md")]);
    await pending;

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
    await owner.start(destroyed, workspace, searchPayload("destroyed"));
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
    await owner.start(disposed, workspace, searchPayload("disposed"));
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
      { workspaceId: "workspace-1", rootPath },
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
      {
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
      },
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
      { workspaceId: "workspace-1", rootPath },
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

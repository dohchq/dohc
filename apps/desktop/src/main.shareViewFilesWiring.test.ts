import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { CHANNELS } from "./ipc/channels";
import { registerWorkspaceSearchIpcHandlers } from "./ipc/workspaceSearchIpc";
import {
  createSearchRegistry,
  type SearchBatch,
} from "./workspaces/workspaceSearch";
import { WorkspaceSearchOwner } from "./workspaces/workspaceSearchOwner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-search-owner-"));
  roots.push(root);
  await mkdir(join(root, ".dohc"));
  return root;
}

interface TestSender {
  id: number;
  isDestroyed(): boolean;
  send: Mock<(channel: string, payload: unknown) => void>;
  once: Mock<(event: "destroyed", listener: () => void) => void>;
}

interface TestEvent {
  sender: TestSender;
}

function harness(input: { capture: boolean; rootPath: string }) {
  const handlers = new Map<
    string,
    (event: TestEvent, payload: unknown) => Promise<unknown> | unknown
  >();
  const starts: Array<{
    request: { includeGlob?: string };
    allowPath: (path: string) => boolean;
  }> = [];
  const workspace = {
    workspaceId: "workspace-1",
    rootPath: input.rootPath,
    shareMounts: [
      {
        shareId: "11111111-1111-4111-8111-111111111111",
        label: "alex",
      },
    ],
  };
  const owner = new WorkspaceSearchOwner({
    searchRegistry: {
      async startSearch(_ownerId, _rootPath, _searchId, request, _onBatch, options) {
        starts.push({
          request,
          allowPath: options.allowPath ?? (() => true),
        });
      },
      cancel: vi.fn(),
      disposeOwner: vi.fn(),
      killAll: vi.fn(),
    },
    prepareOwnedSearch: async () => ({
      allowPath: (path) => path === "shared-with-me/alex/owned.md",
    }),
    engineCaptureFor: () =>
      input.capture ? { flush: vi.fn(async () => undefined) } : null,
    queryEngine: vi.fn(async () => []),
    logError: vi.fn(),
  });
  registerWorkspaceSearchIpcHandlers<TestEvent, typeof workspace>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: () => undefined,
    authorizeWorkspace: (_event, workspaceId) => {
      if (workspaceId !== workspace.workspaceId) throw new Error("Unknown workspace.");
      return { workspace, isCurrent: () => true };
    },
    authorizeCancel: () => true,
    owner,
  });
  const sender: TestSender = {
    id: input.capture ? 1 : 2,
    isDestroyed: () => false,
    send: vi.fn<(channel: string, payload: unknown) => void>(),
    once: vi.fn<(event: "destroyed", listener: () => void) => void>(),
  };
  return {
    starts,
    invoke: async (payload: unknown) =>
      await handlers.get(CHANNELS.searchWorkspace)!({ sender }, payload),
  };
}

describe("ShareViewFiles workspace search wiring", () => {
  it("repeated switch cleanup cancels an active ripgrep once and drops its late settlement", async () => {
    const rootPath = await workspaceRoot();
    const killed: string[] = [];
    const emit: Array<(batch: SearchBatch) => void> = [];
    const owner = new WorkspaceSearchOwner({
      searchRegistry: createSearchRegistry({
        rgPath: "/unused",
        start: (options) => {
          emit.push(options.onBatch);
          return {
            searchId: options.searchId,
            kill: () => killed.push(options.searchId),
          };
        },
      }),
      prepareOwnedSearch: async () => ({ allowPath: () => true }),
      engineCaptureFor: () => null,
      queryEngine: vi.fn(async () => []),
      logError: vi.fn(),
    });
    const sender: TestSender = {
      id: 81,
      isDestroyed: () => false,
      send: vi.fn<(channel: string, payload: unknown) => void>(),
      once: vi.fn<(event: "destroyed", listener: () => void) => void>(),
    };
    await owner.start(
      sender,
      {
        workspace: { workspaceId: "workspace-a", rootPath },
        isCurrent: () => true,
      },
      {
        workspaceId: "workspace-a",
        searchId: "search-a",
        query: "needle",
      },
    );

    owner.disposeSender(sender.id);
    owner.disposeSender(sender.id);
    await owner.start(
      sender,
      {
        workspace: { workspaceId: "workspace-b", rootPath },
        isCurrent: () => true,
      },
      {
        workspaceId: "workspace-b",
        searchId: "search-b",
        query: "needle",
      },
    );
    emit[0]?.({
      searchId: "search-a",
      entries: [],
      done: true,
      limitHit: false,
    });

    expect(killed).toEqual(["search-a"]);
    expect(sender.send).not.toHaveBeenCalled();

    emit[1]?.({
      searchId: "search-b",
      entries: [],
      done: true,
      limitHit: false,
    });
    expect(sender.send).toHaveBeenCalledWith(
      CHANNELS.searchResults,
      expect.objectContaining({ searchId: "search-b", done: true }),
    );
  });

  it("applies the owned-file predicate to mount-only and full-workspace ripgrep", async () => {
    const rootPath = await workspaceRoot();
    const engine = harness({ capture: true, rootPath });
    await engine.invoke({
      workspaceId: "workspace-1",
      searchId: "engine-search",
      query: "needle",
      includeGlob: "*.md",
    });

    expect(engine.starts).toHaveLength(1);
    expect(engine.starts[0]?.request.includeGlob).toBe(
      "shared-with-me/**/*.md",
    );
    expect(engine.starts[0]?.allowPath("shared-with-me/alex/owned.md")).toBe(
      true,
    );
    expect(engine.starts[0]?.allowPath("shared-with-me/alex/leaked.md")).toBe(
      false,
    );

    const ripgrep = harness({ capture: false, rootPath });
    await ripgrep.invoke({
      workspaceId: "workspace-1",
      searchId: "ripgrep-search",
      query: "needle",
      includeGlob: "*.md",
    });

    expect(ripgrep.starts).toHaveLength(1);
    expect(ripgrep.starts[0]?.request.includeGlob).toBe("*.md");
    expect(ripgrep.starts[0]?.allowPath("shared-with-me/alex/owned.md")).toBe(
      true,
    );
    expect(ripgrep.starts[0]?.allowPath("notes/leaked.md")).toBe(false);
  });
});

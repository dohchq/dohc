import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../ipc/channels";
import { registerWorkspaceSearchIpcHandlers } from "../ipc/workspaceSearchIpc";
import { queryWorkspaceSearchDaemon } from "./workspaceSearchDaemon";
import { WorkspaceSearchOwner } from "./workspaceSearchOwner";

describe("queryWorkspaceSearchDaemon", () => {
  it("reads bounded daemon pages and preserves the renderer result contract", async () => {
    const queryPage = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          {
            surface: "file",
            path: "notes/first.md",
            title: "notes/first.md",
            line: 2,
            preview: "é needle",
            matchStart: 3,
            matchEnd: 9,
            threadId: null,
            objectId: "object-first",
          },
        ],
        nextCursor: "page-2",
        versionId: "main",
        restartRequired: false,
      })
      .mockResolvedValueOnce({
        results: [
          {
            surface: "chat",
            path: "chat/thread-1",
            title: "Thread one",
            line: 1,
            preview: "needle",
            matchStart: 0,
            matchEnd: 6,
            threadId: "thread-1",
            objectId: null,
          },
        ],
        nextCursor: null,
        versionId: "main",
        restartRequired: false,
      });

    const results = await queryWorkspaceSearchDaemon({
      daemon: { queryPage },
      query: "needle",
      limit: 50,
      isCurrent: () => true,
    });

    expect(results).toHaveLength(2);
    expect(results?.[0]).toMatchObject({
      path: "notes/first.md",
      matchStart: 2,
      matchEnd: 8,
    });
    expect(queryPage).toHaveBeenNthCalledWith(
      1,
      { query: "needle", limit: 50 },
    );
    expect(queryPage).toHaveBeenNthCalledWith(
      2,
      { query: "needle", limit: 50, cursor: "page-2" },
    );
  });

  it("fails closed on an unpaged daemon response", async () => {
    const queryPage = vi.fn().mockResolvedValue([]);
    await expect(
      queryWorkspaceSearchDaemon({
        daemon: { queryPage },
        query: "needle",
        limit: 50,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("must be a JSON object");
  });

  it("follows an empty page when its continuation cursor advances", async () => {
    // MUTATION: treat an empty result page as zero progress and the second
    // bounded scan page is never requested.
    const queryPage = vi
      .fn()
      .mockResolvedValueOnce({
        results: [],
        nextCursor: "after-empty-scan",
        versionId: "main",
        restartRequired: false,
      })
      .mockResolvedValueOnce({
        results: [
          {
            surface: "file",
            path: "after-empty.md",
            title: "after-empty.md",
            line: 1,
            preview: "AI target",
            matchStart: 0,
            matchEnd: 2,
            threadId: null,
            objectId: "after-empty",
          },
        ],
        nextCursor: null,
        versionId: "main",
        restartRequired: false,
      });

    const results = await queryWorkspaceSearchDaemon({
      daemon: { queryPage },
      query: "AI",
      limit: 50,
      isCurrent: () => true,
    });

    expect(results?.map((result) => result.path)).toEqual(["after-empty.md"]);
    expect(queryPage).toHaveBeenNthCalledWith(2, {
      query: "AI",
      limit: 50,
      cursor: "after-empty-scan",
    });
  });

  it("restarts from page one when the active version changes", async () => {
    // MUTATION: ignore restartRequired and the final array mixes old-generation
    // first.md with new-generation replacement.md.
    const queryPage = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          {
            surface: "file",
            path: "first.md",
            title: "first.md",
            line: 1,
            preview: "needle",
            matchStart: 0,
            matchEnd: 6,
            threadId: null,
            objectId: "first",
          },
        ],
        nextCursor: "old-generation",
        versionId: "main",
        restartRequired: false,
      })
      .mockResolvedValueOnce({
        results: [],
        nextCursor: null,
        versionId: "feature",
        restartRequired: true,
      })
      .mockResolvedValueOnce({
        results: [
          {
            surface: "file",
            path: "replacement.md",
            title: "replacement.md",
            line: 1,
            preview: "needle",
            matchStart: 0,
            matchEnd: 6,
            threadId: null,
            objectId: "replacement",
          },
        ],
        nextCursor: null,
        versionId: "feature",
        restartRequired: false,
      });

    const results = await queryWorkspaceSearchDaemon({
      daemon: { queryPage },
      query: "needle",
      limit: 50,
      isCurrent: () => true,
    });

    expect(results?.map((result) => result.path)).toEqual(["replacement.md"]);
    expect(queryPage).toHaveBeenNthCalledWith(3, { query: "needle", limit: 50 });
  });

  it("returns null when the workspace becomes stale after a page resolves", async () => {
    // MUTATION: remove the post-page isCurrent guard and this completed page is
    // surfaced after the renderer has switched workspaces.
    const queryPage = vi.fn().mockResolvedValue({
      results: [
        {
          surface: "file",
          path: "stale.md",
          title: "stale.md",
          line: 1,
          preview: "needle",
          matchStart: 0,
          matchEnd: 6,
          threadId: null,
          objectId: "stale",
        },
      ],
      nextCursor: null,
      versionId: "main",
      restartRequired: false,
    });
    const isCurrent = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const results = await queryWorkspaceSearchDaemon({
      daemon: { queryPage },
      query: "needle",
      limit: 50,
      isCurrent,
    });

    expect(results).toBeNull();
    expect(queryPage).toHaveBeenCalledTimes(1);
  });

  it("converts astral preview byte offsets to in-bounds UTF-16 offsets", async () => {
    // MUTATION: pass Rust byte offsets through and matchEnd exceeds the
    // JavaScript preview length, causing the IPC result validator to reject it.
    const prefix = "😀".repeat(80);
    const preview = `${prefix}needle`;
    const matchStart = Buffer.byteLength(prefix);
    const queryPage = vi.fn().mockResolvedValue({
      results: [
        {
          surface: "file",
          path: "astral.md",
          title: "astral.md",
          line: 1,
          preview,
          matchStart,
          matchEnd: matchStart + Buffer.byteLength("needle"),
          threadId: null,
          objectId: "astral",
        },
      ],
      nextCursor: null,
      versionId: "main",
      restartRequired: false,
    });

    const results = await queryWorkspaceSearchDaemon({
      daemon: { queryPage },
      query: "needle",
      limit: 50,
      isCurrent: () => true,
    });

    expect(preview.length).toBeLessThanOrEqual(250);
    expect(results?.[0]).toMatchObject({
      matchStart: prefix.length,
      matchEnd: prefix.length + "needle".length,
    });
    expect(
      preview.slice(results![0].matchStart, results![0].matchEnd),
    ).toBe("needle");
  });
});

describe("desktop workspace-search owner wiring", () => {
  it("flushes capture and streams the paged daemon result through the registrar", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "dohc-search-daemon-"));
    await mkdir(join(rootPath, ".dohc"));
    try {
      const trace: string[] = [];
      const queryPage = vi
        .fn()
        .mockImplementationOnce(async () => {
          trace.push("page:1");
          return {
            results: [],
            nextCursor: "page-2",
            versionId: "main",
            restartRequired: false,
          };
        })
        .mockImplementationOnce(async () => {
          trace.push("page:2");
          return {
            results: [
              {
                surface: "file",
                path: "notes/result.md",
                title: "notes/result.md",
                line: 3,
                preview: "needle",
                matchStart: 0,
                matchEnd: 6,
                threadId: null,
                objectId: "result",
              },
            ],
            nextCursor: null,
            versionId: "main",
            restartRequired: false,
          };
        });
      const owner = new WorkspaceSearchOwner({
        searchRegistry: {
          startSearch: vi.fn(async () => undefined),
          cancel: vi.fn(),
          disposeOwner: vi.fn(),
          killAll: vi.fn(),
        },
        prepareOwnedSearch: async () => ({ allowPath: () => true }),
        engineCaptureFor: () => ({
          flush: async () => {
            trace.push("flush");
          },
        }),
        queryEngine: async (_workspace, input) =>
          await queryWorkspaceSearchDaemon({
            daemon: { queryPage },
            query: input.query,
            limit: input.limit,
            isCurrent: input.isCurrent,
          }),
        logError: vi.fn(),
      });
      const handlers = new Map<
        string,
        (event: TestEvent, payload: unknown) => Promise<unknown> | unknown
      >();
      const sender = {
        id: 71,
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
      };
      type TestEvent = { sender: typeof sender };
      registerWorkspaceSearchIpcHandlers<
        TestEvent,
        { workspaceId: string; rootPath: string }
      >({
        registerHandler: (channel, handler) => handlers.set(channel, handler),
        assertTrustedSender: () => undefined,
        authorizeWorkspace: (_event, workspaceId) => ({
          workspace: { workspaceId, rootPath },
          isCurrent: () => true,
        }),
        authorizeCancel: () => true,
        owner,
      });

      await handlers.get(CHANNELS.searchWorkspace)!({ sender }, {
        workspaceId: "workspace-1",
        searchId: "search-1",
        query: "needle",
      });

      expect(trace).toEqual(["flush", "page:1", "page:2"]);
      expect(queryPage).toHaveBeenNthCalledWith(2, {
        query: "needle",
        limit: 50,
        cursor: "page-2",
      });
      expect(sender.send).toHaveBeenCalledWith(
        CHANNELS.searchResults,
        expect.objectContaining({
          searchId: "search-1",
          done: true,
          entries: [
            expect.objectContaining({
              path: "notes/result.md",
              column: 1,
              objectId: "result",
            }),
          ],
        }),
      );
    } finally {
      await rm(rootPath, { recursive: true });
    }
  });
});

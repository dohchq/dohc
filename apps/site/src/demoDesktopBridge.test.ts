// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  answerDemoJoinedLane,
  configureDemoDesktopBridge,
  demoExplorerMenu,
  demoLinkEdges,
  searchDemoDocuments,
  type DemoBridgeDocument,
} from "./demoDesktopBridge";

const documents: DemoBridgeDocument[] = [
  {
    path: "projects/launch.md",
    title: "Launch work",
    body: "## Checklist\nworkflow work WORK",
  },
  {
    path: "research/notes.md",
    title: "Research",
    body: "## Findings\nwork",
  },
];

describe("demoLinkEdges", () => {
  it("links each page to the pages its [[links]] name, in order, skipping links to no page", () => {
    const pages: DemoBridgeDocument[] = [
      {
        path: "Trip plan.md",
        title: "Trip plan",
        body: "Type **[[** to link.\n## Days\n[[Day 1]], [[Budget|money]], [[Nowhere]]",
      },
      { path: "Days/Day 1.md", title: "Day 1", body: "Back to [[Trip plan#Days]]" },
      { path: "Budget.md", title: "Budget", body: "" },
    ];
    expect(demoLinkEdges(pages)).toEqual([
      { source: "Trip plan.md", target: "Days/Day 1.md", kind: "wikilink", ordinal: 0 },
      { source: "Trip plan.md", target: "Budget.md", kind: "wikilink", ordinal: 1 },
      { source: "Days/Day 1.md", target: "Trip plan.md", kind: "wikilink", ordinal: 0 },
    ]);
  });
});

describe("searchDemoDocuments", () => {
  it("honors regex and case sensitivity", () => {
    expect(
      searchDemoDocuments(documents, {
        query: "^## [A-Z]",
        regex: true,
        caseSensitive: true,
      }).map((entry) => entry.preview),
    ).toEqual(["## Checklist", "## Findings"]);
  });

  it("honors whole-word matching", () => {
    const results = searchDemoDocuments(documents, {
      query: "work",
      wholeWord: true,
      caseSensitive: true,
    });
    expect(results.map((entry) => entry.preview)).toEqual([
      "Launch work",
      "workflow work WORK",
      "work",
    ]);
    expect(results[1]).toMatchObject({ matchStart: 9, matchEnd: 13 });
  });

  it("honors include and exclude globs", () => {
    expect(
      searchDemoDocuments(documents, {
        query: "##",
        includeGlob: "**/*.md",
        excludeGlob: "research/**",
      }).map((entry) => entry.path),
    ).toEqual(["projects/launch.md"]);
  });

  it("returns no results for an invalid regular expression", () => {
    expect(searchDemoDocuments(documents, { query: "[", regex: true })).toEqual([]);
  });
});

describe("answerDemoJoinedLane", () => {
  it("answers exactly the wire ids the caller named", () => {
    expect(answerDemoJoinedLane(["wire-general", "wire-projects"])).toEqual([
      { channelWireId: "wire-general", joined: null },
      { channelWireId: "wire-projects", joined: null },
    ]);
  });

  it("answers no grant, which is what makes an owned local channel writable", () => {
    // null is "asked, and this workspace holds no grant". Absent would be
    // "nobody asked", and that fails closed.
    const [answer] = answerDemoJoinedLane(["wire-general"]);
    expect(answer).toHaveProperty("joined", null);
  });

  it("answers nothing for a caller that named nothing", () => {
    expect(answerDemoJoinedLane([])).toEqual([]);
  });
});

describe("demoExplorerMenu", () => {
  const fixed = ["trip-planner/index.html", "guests/dataset.json"];
  const rows = (input: Parameters<typeof demoExplorerMenu>[0]) =>
    demoExplorerMenu(input, fixed).map((entry) => (entry.kind === "item" ? entry.label : "—"));

  it("offers the desktop's rows the demo can run, and no others", () => {
    expect(rows({ kind: "file", path: "Budget.md", pinned: false })).toEqual([
      "Rename",
      "Delete",
      "Pin",
    ]);
    expect(rows({ kind: "folder", path: "Days", pinned: true })).toEqual([
      "New page",
      "New folder",
      "—",
      "Rename",
      "Delete",
      "Unpin",
    ]);
    expect(rows({ kind: "root", pinned: false })).toEqual(["New page", "New folder"]);
    expect(rows({ kind: "file", path: "Budget.md", pinned: false, count: 2 })).toEqual([
      "Delete 2 items",
      "Pin 2 items",
    ]);
  });

  it("offers no rename or delete for the app and Collection the demo keeps", () => {
    expect(rows({ kind: "folder", path: "trip-planner", pinned: false })).toEqual([
      "New page",
      "New folder",
      "—",
      "Pin",
    ]);
    expect(rows({ kind: "file", path: "guests/dataset.json", pinned: false })).toEqual(["Pin"]);
  });
});

describe("a delete's Undo", () => {
  function bridgeWith(paths: string[]) {
    const restore = vi.fn();
    configureDemoDesktopBridge({
      documents: paths.map((path) => ({ path, title: path, body: "" })),
      folders: [],
      fixedPaths: [],
      createFile: () => undefined,
      createFolder: () => undefined,
      movePath: () => undefined,
      deletePath: () => restore,
    });
    const bridge = window.dohcDesktop!;
    const listed = async () =>
      (await bridge.linksEdges({ workspaceId: "marketing-demo" } as never)).files.map(
        (file) => file.path,
      );
    return { bridge, restore, listed };
  }

  it("puts a deleted folder back once, and names no trash", async () => {
    const { bridge, restore, listed } = bridgeWith(["Budget.md", "Days/Day 1.md"]);
    const deleted = await bridge.deleteWorkspacePath({
      workspaceId: "marketing-demo",
      relativePath: "Days",
    });
    expect(deleted).toEqual({ operationId: expect.any(String), undo: { available: true } });
    expect(deleted).not.toHaveProperty("trashed");
    expect(await listed()).toEqual(["Budget.md"]);

    const undo = () =>
      bridge.undoHistoryOperation({
        workspaceId: "marketing-demo",
        operationId: deleted.operationId!,
      });
    await expect(undo()).resolves.toMatchObject({ ok: true, restored: ["Days"] });
    expect(restore).toHaveBeenCalledOnce();
    expect(await listed()).toEqual(["Budget.md", "Days/Day 1.md"]);
    await expect(undo()).resolves.toMatchObject({ ok: false });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("refuses while something new holds the path, and runs once it is gone", async () => {
    const { bridge, restore } = bridgeWith(["Budget.md"]);
    const workspaceId = "marketing-demo";
    const { operationId } = await bridge.deleteWorkspacePath({
      workspaceId,
      relativePath: "Budget.md",
    });
    await bridge.createWorkspaceFile({ workspaceId, relativePath: "Budget.md", initialText: "" });
    const undo = () => bridge.undoHistoryOperation({ workspaceId, operationId: operationId! });
    await expect(undo()).resolves.toEqual({
      ok: false,
      reason: expect.any(String),
      refusal: { code: "old-path-occupied", path: "Budget.md" },
    });
    expect(restore).not.toHaveBeenCalled();

    await bridge.deleteWorkspacePath({ workspaceId, relativePath: "Budget.md" });
    await expect(undo()).resolves.toMatchObject({ ok: true });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("refuses while a file holds a folder the deleted page was in", async () => {
    const { bridge, restore } = bridgeWith(["Days/Day 1.md"]);
    const workspaceId = "marketing-demo";
    const { operationId } = await bridge.deleteWorkspacePath({
      workspaceId,
      relativePath: "Days/Day 1.md",
    });
    await bridge.createWorkspaceFile({ workspaceId, relativePath: "Days", initialText: "" });
    await expect(
      bridge.undoHistoryOperation({ workspaceId, operationId: operationId! }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.any(String),
      refusal: { code: "old-path-occupied", path: "Days" },
    });
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("Chats Home", () => {
  it("lists each Group's opening post", async () => {
    configureDemoDesktopBridge({
      documents: [],
      folders: [],
      fixedPaths: [],
      createFile: () => undefined,
      createFolder: () => undefined,
      movePath: () => undefined,
      deletePath: () => () => undefined,
    });
    const bridge = window.dohcDesktop!;
    const workspaceId = "marketing-demo";
    const { items } = await bridge.listPersonalChatFeed({ workspaceId });
    expect(items.map((item) => [item.channel?.name ?? null, item.message.body])).toEqual([
      ["lisbon-trip", "Who's sorting the Sintra cottage? It goes fast on weekends."],
      ["bookings", "Flat's booked for the 14th to the 17th. Deposit is in Budget."],
    ]);
    await expect(
      bridge.workspaceMembers({ workspaceId, request: { action: "list" } }),
    ).resolves.toEqual({
      status: "refused",
    });
  });
});

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGraphResult } from "../../ipc/bridgeContract";
import { GraphView } from "./GraphView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function immediateResponse<T>() {
  let onSuccess: ((value: T) => void) | null = null;
  const promise = {
    then(success: (value: T) => void) {
      onSuccess = success;
      return Promise.resolve();
    },
  } as unknown as Promise<T>;
  return {
    promise,
    resolve(value: T) {
      onSuccess?.(value);
    },
  };
}

function graph(path: string): WorkspaceGraphResult {
  return {
    nodes: [{ path, title: path, incoming: 0, outgoing: 0 }],
    edges: [],
    unresolvedLinks: 0,
    scannedFileCount: 1,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  };
}

function connectedGraph(): WorkspaceGraphResult {
  return {
    nodes: [
      { path: "alpha.md", title: "Alpha", incoming: 0, outgoing: 1 },
      { path: "beta.md", title: "Beta", incoming: 1, outgoing: 0 },
    ],
    edges: [{ source: "alpha.md", target: "beta.md", kind: "wikilink" }],
    unresolvedLinks: 0,
    scannedFileCount: 2,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  };
}

function colonPathGraph(): WorkspaceGraphResult {
  return {
    nodes: [
      { path: "a:b", title: "A:B", incoming: 0, outgoing: 1 },
      { path: "c", title: "C", incoming: 1, outgoing: 0 },
      { path: "a", title: "A", incoming: 0, outgoing: 1 },
      { path: "b:c", title: "B:C", incoming: 1, outgoing: 0 },
    ],
    edges: [
      { source: "a:b", target: "c", kind: "wikilink" },
      { source: "a", target: "b:c", kind: "wikilink" },
    ],
    unresolvedLinks: 0,
    scannedFileCount: 4,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  };
}

function stubAnimationFrames() {
  let nextHandle = 1;
  let timestamp = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((handle: number) => callbacks.delete(handle)),
  );

  return {
    get pending() {
      return callbacks.size;
    },
    runNext() {
      const entry = callbacks.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      expect(entry).toBeDefined();
      const [handle, callback] = entry!;
      callbacks.delete(handle);
      timestamp += 16;
      callback(timestamp);
    },
  };
}

function graphNodePosition(element: HTMLElement) {
  const transform = element.parentElement?.getAttribute("transform");
  const match = transform?.match(/^translate\(([-\d.]+) ([-\d.]+)\)$/);
  expect(match).toBeTruthy();
  return { x: Number(match![1]), y: Number(match![2]) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GraphView", () => {
  it("bounds the panel DOM while keeping the active document reachable", async () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) => ({
      path: `note-${index.toString().padStart(4, "0")}.md`,
      title: `Note ${index}`,
      incoming: index % 17,
      outgoing: index % 11,
    }));
    const activePath = nodes.at(-1)!.path;
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => ({
        nodes,
        edges: [],
        unresolvedLinks: 0,
        scannedFileCount: nodes.length,
        omittedFileCount: 7_000,
        truncatedFileCount: 0,
      })),
    });

    render(
      <GraphView
        workspaceId="ws-large-graph"
        activePath={activePath}
        refreshKey="0"
        onOpenPath={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("graph-view").dataset.state).toBe("ready"),
    );
    await waitFor(
      () => expect(screen.queryAllByTestId("graph-node")).toHaveLength(240),
      { timeout: 5_000 },
    );
    expect(screen.getAllByTestId("graph-file-row")).toHaveLength(240);
    expect(
      screen.getAllByTestId("graph-node").some((node) => node.dataset.path === activePath),
    ).toBe(true);
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "240 of 2000 shown",
    );
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "7000 omitted",
    );
  });

  it("uses the larger bounded slice in the full-page graph", async () => {
    const nodes = Array.from({ length: 900 }, (_, index) => ({
      path: `page-${index}.md`,
      title: `Page ${index}`,
      incoming: index % 5,
      outgoing: 0,
    }));
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => ({
        nodes,
        edges: [],
        unresolvedLinks: 0,
        scannedFileCount: nodes.length,
        omittedFileCount: 0,
        truncatedFileCount: 0,
      })),
    });

    render(
      <GraphView
        workspaceId="ws-page-graph"
        activePath={null}
        refreshKey="0"
        variant="page"
        onOpenPath={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("graph-view").dataset.state).toBe("ready"),
    );
    await waitFor(
      () => expect(screen.queryAllByTestId("graph-node")).toHaveLength(500),
      { timeout: 5_000 },
    );
    expect(screen.queryAllByTestId("graph-file-row")).toHaveLength(0);
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "500 of 900 shown",
    );
  });

  it("does not commit React renders during force-simulation frames", async () => {
    const frames = stubAnimationFrames();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => connectedGraph()),
    });
    let renderCount = 0;

    render(
      <Profiler id="graph-view" onRender={() => (renderCount += 1)}>
        <GraphView
          workspaceId="ws-graph"
          activePath={null}
          refreshKey="0"
          onOpenPath={vi.fn()}
        />
      </Profiler>,
    );

    expect(await screen.findAllByTestId("graph-node")).toHaveLength(2);
    renderCount = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      await act(async () => frames.runNext());
    }

    expect(renderCount).toBe(0);
  });

  it("commits the final dragged position only when the drag ends", async () => {
    stubAnimationFrames();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => connectedGraph()),
    });
    let renderCount = 0;
    const onOpenPath = vi.fn();
    const view = () => (
      <Profiler id="graph-view" onRender={() => (renderCount += 1)}>
        <GraphView
          workspaceId="ws-drag"
          activePath={null}
          refreshKey="0"
          onOpenPath={onOpenPath}
        />
      </Profiler>
    );
    const { rerender } = render(view());
    const node = (await screen.findAllByTestId("graph-node")).find(
      (element) => element.dataset.path === "alpha.md",
    )!;
    const map = screen.getByTestId("graph-map");
    const edge = screen.getByTestId("graph-edge");

    renderCount = 0;
    fireEvent.pointerDown(node, {
      button: 0,
      pointerId: 1,
      clientX: 130,
      clientY: 210,
    });
    fireEvent.pointerMove(map, {
      pointerId: 1,
      clientX: 200,
      clientY: 300,
    });
    expect(node.getAttribute("transform")).toBeNull();
    expect(node.parentElement?.classList.contains("dohc-graph-node")).toBe(false);
    expect(node.parentElement?.getAttribute("transform")).toBe(
      "translate(200 300)",
    );
    expect([edge.getAttribute("x1"), edge.getAttribute("y1")]).toEqual([
      "200",
      "300",
    ]);
    expect(renderCount).toBe(0);

    renderCount = 0;
    fireEvent.pointerUp(map, {
      pointerId: 1,
      clientX: 200,
      clientY: 300,
    });
    expect(renderCount).toBe(1);
    expect(onOpenPath).not.toHaveBeenCalled();

    rerender(view());
    const committedNode = screen
      .getAllByTestId("graph-node")
      .find((element) => element.dataset.path === "alpha.md")!;
    expect(
      committedNode.parentElement?.getAttribute("transform"),
    ).toBe("translate(200 300)");
  });

  it("keeps the held node at the pointer through a graph refresh", async () => {
    const frames = stubAnimationFrames();
    const refreshed = deferred<WorkspaceGraphResult>();
    const readWorkspaceGraph = vi
      .fn()
      .mockResolvedValueOnce(connectedGraph())
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });
    const view = (refreshKey: string) => (
      <GraphView
        workspaceId="ws-drag-refresh"
        activePath={null}
        refreshKey={refreshKey}
        onOpenPath={vi.fn()}
      />
    );
    const { rerender } = render(view("0"));
    const node = (await screen.findAllByTestId("graph-node")).find(
      (element) => element.dataset.path === "alpha.md",
    )!;

    fireEvent.pointerDown(node, {
      button: 0,
      pointerId: 1,
      clientX: 130,
      clientY: 210,
    });
    rerender(view("1"));
    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalledTimes(2));
    await act(async () => {
      refreshed.resolve(connectedGraph());
      await refreshed.promise;
    });
    await act(async () => frames.runNext());

    expect(node.parentElement?.getAttribute("transform")).toBe(
      "translate(130 210)",
    );
    fireEvent.pointerUp(screen.getByTestId("graph-map"), {
      pointerId: 1,
      clientX: 130,
      clientY: 210,
    });
  });

  it("keeps one pointer as drag owner and commits when that pointer releases", async () => {
    const frames = stubAnimationFrames();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => connectedGraph()),
    });
    let renderCount = 0;
    render(
      <Profiler id="graph-view" onRender={() => (renderCount += 1)}>
        <GraphView
          workspaceId="ws-two-pointers"
          activePath={null}
          refreshKey="0"
          onOpenPath={vi.fn()}
        />
      </Profiler>,
    );
    const nodes = await screen.findAllByTestId("graph-node");
    const alpha = nodes.find((element) => element.dataset.path === "alpha.md")!;
    const beta = nodes.find((element) => element.dataset.path === "beta.md")!;
    const map = screen.getByTestId("graph-map");

    fireEvent.pointerDown(alpha, {
      button: 0,
      pointerId: 1,
      clientX: 120,
      clientY: 200,
    });
    fireEvent.pointerDown(beta, {
      button: 0,
      pointerId: 2,
      clientX: 220,
      clientY: 100,
    });
    fireEvent.pointerUp(map, {
      pointerId: 2,
      clientX: 220,
      clientY: 100,
    });

    renderCount = 0;
    fireEvent.pointerMove(map, {
      pointerId: 1,
      clientX: 180,
      clientY: 260,
    });
    expect(alpha.parentElement?.getAttribute("transform")).toBe(
      "translate(180 260)",
    );
    fireEvent.pointerUp(map, {
      pointerId: 1,
      clientX: 180,
      clientY: 260,
    });
    expect(renderCount).toBe(1);

    let frameCount = 0;
    await act(async () => {
      while (frames.pending > 0 && frameCount < 180) {
        frames.runNext();
        frameCount += 1;
      }
    });
    expect(frames.pending).toBe(0);
  });

  it("updates both edges when colon-bearing paths would share a delimited key", async () => {
    stubAnimationFrames();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => colonPathGraph()),
    });
    render(
      <GraphView
        workspaceId="ws-colon-paths"
        activePath={null}
        refreshKey="0"
        onOpenPath={vi.fn()}
      />,
    );
    const nodes = await screen.findAllByTestId("graph-node");
    const firstSource = nodes.find((element) => element.dataset.path === "a:b")!;
    const secondSource = nodes.find((element) => element.dataset.path === "a")!;
    const edges = screen.getAllByTestId("graph-edge");
    const map = screen.getByTestId("graph-map");

    fireEvent.pointerDown(firstSource, {
      button: 0,
      pointerId: 1,
      clientX: 130,
      clientY: 210,
    });

    expect([edges[0]!.getAttribute("x1"), edges[0]!.getAttribute("y1")]).toEqual([
      "130",
      "210",
    ]);
    expect([
      edges[1]!.getAttribute("x1"),
      edges[1]!.getAttribute("y1"),
    ]).not.toEqual(["130", "210"]);

    fireEvent.pointerUp(map, { pointerId: 1, clientX: 130, clientY: 210 });
    fireEvent.pointerDown(secondSource, {
      button: 0,
      pointerId: 2,
      clientX: 60,
      clientY: 100,
    });
    expect([edges[1]!.getAttribute("x1"), edges[1]!.getAttribute("y1")]).toEqual([
      "60",
      "100",
    ]);
    expect([
      edges[0]!.getAttribute("x1"),
      edges[0]!.getAttribute("y1"),
    ]).not.toEqual(["60", "100"]);
  });

  it("matches a full React render after the simulation settles", async () => {
    const frames = stubAnimationFrames();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => connectedGraph()),
    });
    const onOpenPath = vi.fn();
    const view = () => (
      <GraphView
        workspaceId="ws-rest"
        activePath={null}
        refreshKey="0"
        onOpenPath={onOpenPath}
      />
    );
    const { rerender } = render(view());
    expect(await screen.findAllByTestId("graph-node")).toHaveLength(2);

    let frameCount = 0;
    while (frames.pending > 0 && frameCount < 1_000) {
      await act(async () => frames.runNext());
      frameCount += 1;
    }
    expect(frames.pending).toBe(0);
    expect(frameCount).toBeLessThanOrEqual(120);
    const settledDom = screen.getByTestId("graph-map").innerHTML;

    rerender(view());
    expect(screen.getByTestId("graph-map").innerHTML).toBe(settledDom);
  });

  it("does not carry residual velocity past a frame-cap commit", async () => {
    const frames = stubAnimationFrames();
    const readWorkspaceGraph = vi.fn(async () => graph("solo.md"));
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });
    const view = (refreshKey: string) => (
      <GraphView
        workspaceId="ws-frame-cap"
        activePath={null}
        refreshKey={refreshKey}
        onOpenPath={vi.fn()}
      />
    );
    const { rerender } = render(view("0"));
    const node = await screen.findByTestId("graph-node");
    const map = screen.getByTestId("graph-map");

    await act(async () => {
      while (frames.pending > 0) frames.runNext();
    });
    fireEvent.pointerDown(node, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });
    fireEvent.pointerUp(map, {
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });

    let frameCount = 0;
    await act(async () => {
      while (frames.pending > 0 && frameCount < 121) {
        frames.runNext();
        frameCount += 1;
      }
    });
    expect(frameCount).toBe(120);
    expect(frames.pending).toBe(0);

    const capped = graphNodePosition(node);
    rerender(view("1"));
    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("graph-view").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
    const refreshed = graphNodePosition(node);
    expect(refreshed.x).toBeCloseTo(capped.x, 10);
    expect(refreshed.y).toBeCloseTo(capped.y, 10);

    await act(async () => frames.runNext());
    const afterOneFrame = graphNodePosition(node);
    expect(afterOneFrame.x).toBeCloseTo(
      refreshed.x + (130 - refreshed.x) * 0.014 * 0.86 * 0.84,
      10,
    );
    expect(afterOneFrame.y).toBeCloseTo(
      refreshed.y + (210 - refreshed.y) * 0.014 * 0.86 * 0.84,
      10,
    );
  });

  it("hides chat mentions when Chats is unavailable", async () => {
    const readWorkspaceGraph = vi.fn(async () => ({
      nodes: [],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 0,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });

    render(
      <GraphView
        workspaceId="ws-unflagged"
        activePath={null}
        refreshKey="0"
        chatMentionsAvailable={false}
        onOpenPath={vi.fn()}
      />,
    );

    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalled());
    expect(screen.queryByTestId("graph-chat-mentions-toggle")).toBeNull();
    expect(readWorkspaceGraph).toHaveBeenCalledWith({
      workspaceId: "ws-unflagged",
      includeChatMentions: false,
    });
  });

  it("loads the workspace graph and opens a clicked document", async () => {
    const onOpenPath = vi.fn();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => ({
        nodes: [
          { path: "alpha.md", title: "Alpha", incoming: 1, outgoing: 1 },
          { path: "beta.md", title: "Beta", incoming: 1, outgoing: 0 },
        ],
        edges: [{ source: "alpha.md", target: "beta.md", kind: "wikilink" }],
        unresolvedLinks: 1,
        scannedFileCount: 2,
        omittedFileCount: 0,
        truncatedFileCount: 0,
      })),
    });

    render(
      <GraphView
        workspaceId="ws-graph"
        activePath="alpha.md"
        refreshKey="0"
        onOpenPath={onOpenPath}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("graph-view").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
    expect(screen.getByTestId("graph-doc-count").textContent).toBe("2 docs");
    expect(screen.getByTestId("graph-link-count").textContent).toBe("1 link");
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "1 unresolved",
    );
    const graphNodes = await screen.findAllByTestId("graph-node");
    expect(
      graphNodes
        .find((node) => node.dataset.path === "beta.md")
        ?.getAttribute("aria-label"),
    ).toBe("Open or focus beta.md");

    await userEvent.click(
      graphNodes.find((node) => node.dataset.path === "beta.md")!,
    );
    expect(onOpenPath).toHaveBeenCalledWith("beta.md");
  });

  it("clears the previous workspace while the next graph loads and rejects a late repaint", async () => {
    const lateWorkspaceA = deferred<WorkspaceGraphResult>();
    const workspaceB = deferred<WorkspaceGraphResult>();
    const readWorkspaceGraph = vi.fn(
      (input: { workspaceId: string }) => {
        if (input.workspaceId === "workspace-a") {
          return readWorkspaceGraph.mock.calls.length === 1
            ? Promise.resolve(graph("a.md"))
            : lateWorkspaceA.promise;
        }
        return workspaceB.promise;
      },
    );
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });

    const { rerender } = render(
      <GraphView
        workspaceId="workspace-a"
        activePath={null}
        refreshKey="0"
        onOpenPath={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Open or focus a.md" }),
    ).toBeTruthy();

    rerender(
      <GraphView
        workspaceId="workspace-a"
        activePath={null}
        refreshKey="1"
        onOpenPath={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open or focus a.md" }),
    ).toBeTruthy();

    rerender(
      <GraphView
        workspaceId="workspace-b"
        activePath={null}
        refreshKey="0"
        onOpenPath={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Open or focus a.md" }),
    ).toBeNull();
    expect(screen.getByText("Building graph…")).toBeTruthy();

    await act(async () => {
      lateWorkspaceA.resolve(graph("late-a.md"));
      await lateWorkspaceA.promise;
    });
    expect(
      screen.queryByRole("button", { name: "Open or focus late-a.md" }),
    ).toBeNull();
    expect(screen.getByText("Building graph…")).toBeTruthy();

    await act(async () => {
      workspaceB.resolve(graph("b.md"));
      await workspaceB.promise;
    });
    expect(
      await screen.findByRole("button", { name: "Open or focus b.md" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open or focus late-a.md" }),
    ).toBeNull();
  });

  it("drops a stale response from an older refresh generation", async () => {
    // Deliver K1 from the parent's layout effect after K2 commits but before
    // GraphView's passive cleanup retires K1.
    const first = immediateResponse<WorkspaceGraphResult>();
    const second = deferred<WorkspaceGraphResult>();
    const readWorkspaceGraph = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });
    function RefreshRace(props: { refreshKey: string }) {
      useLayoutEffect(() => {
        if (props.refreshKey === "1") first.resolve(graph("stale.md"));
      }, [props.refreshKey]);
      return (
        <GraphView
          workspaceId="ws-refresh-generation"
          activePath={null}
          refreshKey={props.refreshKey}
          onOpenPath={vi.fn()}
        />
      );
    }
    const { rerender } = render(<RefreshRace refreshKey="0" />);
    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalledOnce());

    rerender(<RefreshRace refreshKey="1" />);
    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole("button", { name: "Open or focus stale.md" }),
    ).toBeNull();

    await act(async () => {
      second.resolve(graph("current.md"));
      await second.promise;
    });
    expect(
      await screen.findByRole("button", { name: "Open or focus current.md" }),
    ).toBeTruthy();
  });

  it("enables mention overlays and routes heading and chat nodes", async () => {
    const headingNode = {
      path: "heading:object-plan:scope",
      kind: "heading" as const,
      filePath: "docs/plan.md",
      headingAnchor: "scope",
      title: "#Scope",
      incoming: 1,
      outgoing: 1,
    };
    const chatNode = {
      path: "chat-thread:thread-1",
      kind: "chat-thread" as const,
      threadId: "thread-1",
      channelId: "channel-1",
      channelName: "planning",
      channelSlug: "planning",
      channelKind: "channel" as const,
      title: "Planning discussion",
      incoming: 0,
      outgoing: 1,
    };
    const readWorkspaceGraph = vi.fn(
      async (input: { includeChatMentions?: boolean }) => ({
        nodes: input.includeChatMentions
          ? [
              {
                path: "docs/plan.md",
                kind: "file" as const,
                filePath: "docs/plan.md",
                title: "Plan",
                incoming: 1,
                outgoing: 0,
              },
              headingNode,
              chatNode,
            ]
          : [],
        edges: [],
        unresolvedLinks: 0,
        scannedFileCount: 1,
        omittedFileCount: 0,
        truncatedFileCount: 0,
      }),
    );
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });
    const onOpenPath = vi.fn();
    const onOpenChatThread = vi.fn();
    render(
      <GraphView
        workspaceId="ws-graph"
        activePath={null}
        refreshKey="0"
        chatMentionsAvailable
        onOpenPath={onOpenPath}
        onOpenChatThread={onOpenChatThread}
      />,
    );

    await waitFor(() => expect(readWorkspaceGraph).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await waitFor(() =>
      expect(readWorkspaceGraph).toHaveBeenLastCalledWith({
        workspaceId: "ws-graph",
        includeChatMentions: true,
      }),
    );

    const rows = await screen.findAllByTestId("graph-file-row");
    await userEvent.click(
      rows.find((row) => row.getAttribute("data-path") === headingNode.path)!,
    );
    expect(onOpenPath).toHaveBeenCalledWith("docs/plan.md", "scope");

    await userEvent.click(
      rows.find((row) => row.getAttribute("data-path") === chatNode.path)!,
    );
    expect(onOpenChatThread).toHaveBeenCalledWith(expect.objectContaining(chatNode));
  });

  it("clears mention nodes when chat access is revoked even if the replacement fails", async () => {
    const disabledGraph = deferred<WorkspaceGraphResult>();
    const overlayGraph: WorkspaceGraphResult = {
      nodes: [
        {
          path: "chat-thread:thread-sensitive",
          kind: "chat-thread",
          threadId: "thread-sensitive",
          title: "Sensitive discussion",
          incoming: 0,
          outgoing: 0,
        },
      ],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 0,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    };
    const readWorkspaceGraph = vi.fn(
      (input: { includeChatMentions?: boolean }) =>
        input.includeChatMentions
          ? Promise.resolve(overlayGraph)
          : readWorkspaceGraph.mock.calls.length === 1
            ? Promise.resolve(graph("safe.md"))
            : disabledGraph.promise,
    );
    vi.stubGlobal("dohcDesktop", { readWorkspaceGraph });

    const { rerender } = render(
      <GraphView
        workspaceId="ws-graph"
        activePath={null}
        refreshKey="0"
        chatMentionsAvailable
        onOpenPath={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Open or focus safe.md" });
    await userEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    expect(await screen.findAllByText("Sensitive discussion")).not.toHaveLength(0);

    rerender(
      <GraphView
        workspaceId="ws-graph"
        activePath={null}
        refreshKey="0"
        chatMentionsAvailable={false}
        onOpenPath={vi.fn()}
      />,
    );

    expect(screen.queryByText("Sensitive discussion")).toBeNull();
    expect(screen.getByText("Building graph…")).toBeTruthy();

    await act(async () => {
      disabledGraph.reject(new Error("access revoked"));
      try {
        await disabledGraph.promise;
      } catch {
        // The component owns and renders this expected load failure.
      }
    });

    expect(screen.queryByText("Sensitive discussion")).toBeNull();
    expect(screen.getByText("access revoked")).toBeTruthy();
  });
});

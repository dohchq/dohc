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
import type { ChatFileMentionRecord } from "../../ipc/bridgeContract";
import type { LinksEdgesResult } from "@dohc/workspace-contracts/links";
type GraphFixture = {nodes:{path:string;title:string;incoming:number;outgoing:number}[];edges:{source:string;target:string;kind:"wikilink"|"markdown"}[];[key:string]:unknown};
import { GraphView } from "./GraphView";
import { deferred } from "../../testing/deferred";

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

function graph(path: string): GraphFixture {
  return {
    nodes: [{ path, title: path, incoming: 0, outgoing: 0 }],
    edges: [],
    unresolvedLinks: 0,
    scannedFileCount: 1,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  };
}

function connectedGraph(): GraphFixture {
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

function denseGraph(nodeCount: number, edgeCount: number): GraphFixture {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    path: `note-${index.toString().padStart(4, "0")}.md`,
    title: `Note ${index}`,
    incoming: 0,
    outgoing: 0,
  }));
  return {
    nodes,
    edges: Array.from({ length: edgeCount }, (_, index) => ({
      source: nodes[Math.floor(index / nodeCount)]!.path,
      target: nodes[index % nodeCount]!.path,
      kind: "wikilink" as const,
    })),
    unresolvedLinks: 0,
    scannedFileCount: nodeCount,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  };
}

function colonPathGraph(): GraphFixture {
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
    stubFileGraph({
      linksEdges: vi.fn(async () => ({
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
    await waitFor(() => expect(screen.queryAllByTestId("graph-node")).toHaveLength(240));
    expect(screen.getAllByTestId("graph-file-row")).toHaveLength(240);
    expect(
      screen.getAllByTestId("graph-node").some((node) => node.dataset.path === activePath),
    ).toBe(true);
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "240 of 2000 docs shown",
    );

  });

  it("uses the larger bounded slice in the full-page graph", async () => {
    const nodes = Array.from({ length: 900 }, (_, index) => ({
      path: `page-${index}.md`,
      title: `Page ${index}`,
      incoming: index % 5,
      outgoing: 0,
    }));
    stubFileGraph({
      linksEdges: vi.fn(async () => ({
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
    await waitFor(() => expect(screen.queryAllByTestId("graph-node")).toHaveLength(500));
    expect(screen.queryAllByTestId("graph-file-row")).toHaveLength(0);
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "500 of 900 docs shown",
    );
  });

  it.each([
    { variant: "panel" as const, nodeCount: 240, edgeLimit: 2_000 },
    { variant: "page" as const, nodeCount: 500, edgeLimit: 5_000 },
  ])(
    "reports the $variant link limit instead of implying every link is drawn",
    async ({ variant, nodeCount, edgeLimit }) => {
      stubFileGraph({
        linksEdges: vi.fn(async () => denseGraph(nodeCount, edgeLimit + 1)),
      });

      render(
        <GraphView
          workspaceId={`ws-${variant}-edge-limit`}
          activePath={null}
          refreshKey="0"
          variant={variant}
          onOpenPath={vi.fn()}
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId("graph-view").dataset.state).toBe("ready"),
      );
      expect(screen.getByTestId("graph-link-count").textContent).toBe(
        `${edgeLimit + 1} links`,
      );
      expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
        `${edgeLimit} of ${edgeLimit + 1} links shown`,
      );
    },
  );

  it("does not commit React renders during force-simulation frames", async () => {
    const frames = stubAnimationFrames();
    stubFileGraph({
      linksEdges: vi.fn(async () => connectedGraph()),
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
    stubFileGraph({
      linksEdges: vi.fn(async () => connectedGraph()),
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
    const refreshed = deferred<GraphFixture>();
    const linksEdges = vi
      .fn()
      .mockResolvedValueOnce(connectedGraph())
      .mockReturnValueOnce(refreshed.promise);
    stubFileGraph({ linksEdges });
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
    await waitFor(() => expect(linksEdges).toHaveBeenCalledTimes(2));
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
    stubFileGraph({
      linksEdges: vi.fn(async () => connectedGraph()),
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
    stubFileGraph({
      linksEdges: vi.fn(async () => colonPathGraph()),
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
    stubFileGraph({
      linksEdges: vi.fn(async () => connectedGraph()),
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
    const linksEdges = vi.fn(async () => graph("solo.md"));
    stubFileGraph({ linksEdges });
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
    await waitFor(() => expect(linksEdges).toHaveBeenCalledTimes(2));
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


  it("paints the first page before continuing and deduplicates visible degrees", async () => {
    const frames = stubAnimationFrames();
    const second = deferred<LinksEdgesResult>();
    const linksEdges = vi.fn().mockResolvedValueOnce(page("a.md", "next")).mockImplementation(() => second.promise);
    vi.stubGlobal("dohcDesktop", { linksEdges });
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} />);
    expect(await screen.findAllByText("a.md")).toBeTruthy();
    expect(linksEdges).toHaveBeenCalledOnce();
    expect(screen.getByText("Gathering linked mentions").textContent).toBe("Gathering linked mentions");
    act(() => { while (frames.pending) frames.runNext(); });
    await waitFor(() => expect(linksEdges).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve({ ...page("isolated.md"), entries: [
      {source:"a.md",target:"b.md",kind:"wikilink",ordinal:0},
      {source:"a.md",target:"b.md",kind:"wikilink",ordinal:1},
    ] }));
    await waitFor(() => expect(screen.getByTestId("graph-doc-count").textContent).toBe("3 docs"));
    expect(screen.getByTestId("graph-link-count").textContent).toBe("1 link");
    const row=screen.getAllByTestId("graph-file-row").find(row=>row.dataset.path==="a.md")!;
    expect(row.textContent).toContain("0/1");
    expect(screen.queryByText("Gathering linked mentions")).toBeNull();
  });

  it("rejects late workspace pages and routes a failed refresh to Notices with retry", async () => {
    const late = deferred<LinksEdgesResult>();
    const linksEdges = vi.fn().mockImplementation(({workspaceId}) => workspaceId==="a" ? late.promise : Promise.resolve(page("b.md")));
    const onError=vi.fn();
    vi.stubGlobal("dohcDesktop",{linksEdges});
    const props={activePath:null,refreshKey:"0",onOpenPath:vi.fn(),onError};
    const view=render(<GraphView {...props} workspaceId="a"/>);
    view.rerender(<GraphView {...props} workspaceId="b"/>);
    expect(await screen.findAllByText("b.md")).toBeTruthy();
    await act(async()=>late.resolve(page("late.md")));
    expect(screen.queryByText("late.md")).toBeNull();
    linksEdges.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByLabelText("Refresh graph"));
    await waitFor(()=>expect(onError).toHaveBeenCalledOnce());
    expect(screen.getAllByText("b.md")).toBeTruthy();
    linksEdges.mockResolvedValue(page("recovered.md"));
    act(()=>onError.mock.calls[0]![2]());
    expect(await screen.findAllByText("recovered.md")).toBeTruthy();
  });

  it("leaves terminal unchecked coverage visible without polling", async () => {
    const linksEdges=vi.fn(async()=>({...page("a.md"),complete:false,unchecked:["a.md"]}));
    vi.stubGlobal("dohcDesktop",{linksEdges});
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()}/>);
    expect(await screen.findAllByText("a.md")).toBeTruthy();
    expect(screen.queryByText("Gathering linked mentions")).toBeNull();
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain("1 unchecked");
    expect(linksEdges).toHaveBeenCalledOnce();
  });

  it("bounds index-building refreshes and cancels them on unmount", async () => {
    vi.useFakeTimers();
    try {
      const linksEdges=vi.fn(async()=>({...page("a.md"),complete:false,indexBuilding:true}));
      vi.stubGlobal("dohcDesktop",{linksEdges});
      const view=render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()}/>);
      await act(async()=>{ await vi.advanceTimersByTimeAsync(20000); });
      expect(linksEdges).toHaveBeenCalledTimes(6);
      view.unmount();
      await vi.advanceTimersByTimeAsync(20000);
      expect(linksEdges).toHaveBeenCalledTimes(6);
    } finally { vi.useRealTimers(); }
  });

  it("keeps file edges usable after chat failure and ignores a late disabled chat answer", async () => {
    const chat = deferred<{mentions:ChatFileMentionRecord[]}>();
    const linksEdges=vi.fn(async()=>page("a.md"));
    const listChatFileMentions=vi.fn(()=>chat.promise);
    const onError=vi.fn();
    vi.stubGlobal("dohcDesktop",{linksEdges,listChatFileMentions});
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} onError={onError} chatMentionsAvailable/>);
    expect(await screen.findAllByText("a.md")).toBeTruthy();
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await waitFor(()=>expect(listChatFileMentions).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await act(async()=>chat.reject(new Error("chat offline")));
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getAllByText("a.md")).toBeTruthy();
    listChatFileMentions.mockRejectedValue(new Error("chat offline"));
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await waitFor(()=>expect(onError).toHaveBeenCalledOnce());
    expect(screen.getAllByText("a.md")).toBeTruthy();
  });
});

function page(path: string, nextCursor: string | null = null): LinksEdgesResult {
  return {versionId:"main",files:[{path,objectId:path,title:path}],entries:[],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,nextCursor};
}
function stubFileGraph(mock: { linksEdges: (...args: never[]) => Promise<GraphFixture> }) {
  vi.stubGlobal("dohcDesktop", { linksEdges: async () => {
    const graph = await mock.linksEdges();
    return {...page(""),files:graph.nodes.map(node=>({path:node.path,objectId:node.path,title:node.title})),
      entries:graph.edges.map((edge,ordinal)=>({...edge,ordinal}))};
  }});
}

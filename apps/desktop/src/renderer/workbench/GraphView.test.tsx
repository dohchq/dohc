// @vitest-environment jsdom
import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { ipcWireError } from "../../ipc/errorWords";
import * as graphData from "./graphData";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatFileMentionRecord } from "../../ipc/bridgeContract";
import type { LinksEdgesResult } from "@dohc/workspace-contracts/links";
import { GraphView } from "./GraphView";
import { deferred } from "../../testing/deferred";

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

function rowPaths(): string[] {
  return screen.getAllByTestId("graph-file-row").map((row) => row.dataset.path ?? "");
}

function stubPages(paths: readonly string[], links: readonly (readonly [string, string])[]) {
  vi.stubGlobal("dohcDesktop", {
    linksEdges: vi.fn(async () => ({
      ...page(""),
      files: paths.map((path) => ({ path, objectId: path, title: path })),
      entries: links.map(([source, target], ordinal) => ({ source, target, kind: "wikilink" as const, ordinal })),
    })),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GraphView", () => {
  it("shows the open page's local graph in the side panel, in title order", async () => {
    stubPages(
      ["alpha.md", "beta.md", "gamma.md", "delta.md", "sketch.excalidraw"],
      [["alpha.md", "beta.md"], ["beta.md", "gamma.md"], ["delta.md", "gamma.md"]],
    );
    const view = render(<GraphView workspaceId="ws" activePath="beta.md" refreshKey="0" onOpenPath={vi.fn()} />);
    await waitFor(() => expect(rowPaths()).toEqual(["alpha.md", "beta.md", "gamma.md"]));
    // The open page keeps its place in the list instead of moving to the top.
    expect(screen.getAllByTestId("graph-file-row")[1]!.dataset.active).toBe("true");
    expect(screen.getByTestId("graph-canvas").dataset.nodeCount).toBe("3");
    expect(screen.getByTestId("graph-doc-count").textContent).toBe("5 files");

    view.rerender(<GraphView workspaceId="ws" activePath="nowhere.md" refreshKey="0" onOpenPath={vi.fn()} />);
    // With no open page in the graph, the panel shows the whole workspace.
    await waitFor(() => expect(rowPaths()).toHaveLength(5));
  });

  it("widens the local graph with its depth setting", async () => {
    stubPages(["a.md", "b.md", "c.md", "d.md"], [["a.md", "b.md"], ["b.md", "c.md"], ["c.md", "d.md"]]);
    render(<GraphView workspaceId="ws" activePath="a.md" refreshKey="0" onOpenPath={vi.fn()} />);
    await waitFor(() => expect(rowPaths()).toEqual(["a.md", "b.md"]));
    fireEvent.click(screen.getByTestId("graph-settings-toggle"));
    fireEvent.change(screen.getByRole("slider", { name: "Depth" }), { target: { value: "3" } });
    await waitFor(() => expect(rowPaths()).toEqual(["a.md", "b.md", "c.md", "d.md"]));
  });

  it("opens a row's file and lights its node while the row has focus", async () => {
    stubPages(["alpha.md", "beta.md"], [["alpha.md", "beta.md"]]);
    const onOpenPath = vi.fn();
    render(<GraphView workspaceId="ws" activePath="alpha.md" refreshKey="0" onOpenPath={onOpenPath} />);
    await waitFor(() => expect(rowPaths()).toEqual(["alpha.md", "beta.md"]));
    const beta = screen.getAllByTestId("graph-file-row")[1]!;
    fireEvent.focus(beta);
    const description = screen.getByTestId("graph-focused-node");
    expect(screen.getByTestId("graph-canvas").getAttribute("aria-describedby")).toBe(description.id);
    expect(description.textContent).toBe("beta.md, 1 link");
    fireEvent.click(beta);
    expect(onOpenPath).toHaveBeenCalledWith("beta.md");
  });

  it("finds a file by search in the full graph and opens it with Enter", async () => {
    stubPages(["alpha.md", "beta.md", "gamma.md"], [["alpha.md", "beta.md"]]);
    const onOpenPath = vi.fn();
    const user = userEvent.setup();
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" variant="page" onOpenPath={onOpenPath} />);
    await waitFor(() => expect(screen.getByTestId("graph-canvas").dataset.nodeCount).toBe("3"));
    await user.type(screen.getByTestId("graph-search"), "gam");
    await waitFor(() => expect(screen.getAllByTestId("graph-search-option").map((option) => option.dataset.path)).toEqual(["gamma.md"]));
    expect(screen.getByTestId("graph-canvas").dataset.nodeCount).toBe("1");
    expect(screen.getByTestId("graph-doc-count").textContent).toBe("1 of 3 files");
    await user.keyboard("{Enter}");
    expect(onOpenPath).toHaveBeenCalledWith("gamma.md");
    await user.clear(screen.getByTestId("graph-search"));
    await user.type(screen.getByTestId("graph-search"), "zzz");
    expect(await screen.findByText('No files match "zzz". Try a shorter search.')).toBeTruthy();
  });

  it("moves keyboard focus onto the graph's nodes and opens one with Enter", async () => {
    stubPages(["alpha.md", "beta.md", "gamma.md"], [["alpha.md", "beta.md"], ["gamma.md", "beta.md"]]);
    const onOpenPath = vi.fn();
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" variant="page" onOpenPath={onOpenPath} />);
    const canvas = await screen.findByTestId("graph-canvas");
    await waitFor(() => expect(canvas.dataset.nodeCount).toBe("3"));
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    // With nothing open, focus starts on the most-linked node.
    expect(screen.getByTestId("graph-focused-node").textContent).toBe("beta.md, 2 links");
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(onOpenPath).toHaveBeenCalledWith("beta.md");
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(canvas.getAttribute("aria-describedby")).toBeNull();
  });

  it("marks the open page on the full graph", async () => {
    stubPages(["a.md", "b.md"], [["a.md", "b.md"]]);
    render(<GraphView workspaceId="ws" activePath="b.md" refreshKey="0" variant="page" onOpenPath={vi.fn()} />);
    const canvas = await screen.findByTestId("graph-canvas");
    expect(canvas.dataset.activePath).toBe("b.md");
    await waitFor(() => expect(canvas.dataset.linkCount).toBe("1"));
  });

  it("hides a kind and orphans from the settings, and says how many are shown", async () => {
    stubPages(["a.md", "b.md", "plan.excalidraw", "alone.md"], [["a.md", "b.md"], ["a.md", "plan.excalidraw"]]);
    render(<GraphView workspaceId="ws-filters" activePath={null} refreshKey="0" variant="page" onOpenPath={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("graph-canvas").dataset.nodeCount).toBe("4"));
    fireEvent.click(screen.getByTestId("graph-settings-toggle"));
    fireEvent.click(screen.getByRole("switch", { name: "Show drawing nodes" }));
    await waitFor(() => expect(screen.getByTestId("graph-doc-count").textContent).toBe("3 of 4 files"));
    expect(screen.getByTestId("graph-link-count").textContent).toBe("1 of 2 links");
    fireEvent.click(screen.getByRole("switch", { name: "Show files with no links" }));
    await waitFor(() => expect(screen.getByTestId("graph-canvas").dataset.nodeCount).toBe("2"));
  });

  it("groups the digits of large counts", async () => {
    stubPages(Array.from({ length: 1200 }, (_, index) => `note-${index}.md`), []);
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" variant="page" onOpenPath={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("graph-doc-count").textContent).toBe(`${(1200).toLocaleString()} files`));
  });

  it("offers Try again when the first read fails", async () => {
    const linksEdges = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page("a.md"));
    const onError = vi.fn();
    vi.stubGlobal("dohcDesktop", { linksEdges });
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" variant="page" onOpenPath={vi.fn()} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    fireEvent.click(within(await screen.findByTestId("graph-retry")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("graph-canvas").dataset.nodeCount).toBe("1"));
    expect(screen.queryByTestId("graph-retry")).toBeNull();
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
    await waitFor(() => expect(screen.getByTestId("graph-doc-count").textContent).toBe("3 files"));
    expect(screen.getByTestId("graph-link-count").textContent).toBe("1 link");
    // The counts truncate together in a narrow panel, so their tooltip holds both.
    expect(screen.getByTestId("graph-doc-count").parentElement?.title).toBe("3 files · 1 link");
    const row=screen.getAllByTestId("graph-file-row").find(row=>row.dataset.path==="a.md")!;
    // One link, counted once although the page repeats it.
    expect(row.textContent).toBe("a.md1");
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
    expect(screen.getByTestId("graph-unresolved-count").getAttribute("aria-label")).toContain("1 unchecked");
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
    const chat = deferred<{entries:ChatFileMentionRecord[]}>();
    const linksEdges=vi.fn(async()=>page("a.md"));
    const chatFileMentionsPage=vi.fn(()=>chat.promise);
    const onError=vi.fn();
    vi.stubGlobal("dohcDesktop",{linksEdges,chatFileMentionsPage});
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} onError={onError} chatMentionsAvailable/>);
    expect(await screen.findAllByText("a.md")).toBeTruthy();
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await waitFor(()=>expect(chatFileMentionsPage).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await act(async()=>chat.reject(new Error("chat offline")));
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getAllByText("a.md")).toBeTruthy();
    chatFileMentionsPage.mockRejectedValue(new Error("chat offline"));
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await waitFor(()=>expect(onError).toHaveBeenCalledOnce());
    expect(screen.getAllByText("a.md")).toBeTruthy();
  });
  it("keeps the drawn graph through every page of a refresh", async () => {
    const next = deferred<LinksEdgesResult>();
    const linksEdges = vi.fn().mockResolvedValueOnce(page("old.md"))
      .mockResolvedValueOnce(page("replacement.md", "next")).mockReturnValueOnce(next.promise);
    vi.stubGlobal("dohcDesktop", { linksEdges });
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} />);
    await screen.findAllByText("old.md");
    fireEvent.click(screen.getByLabelText("Refresh graph"));
    await waitFor(() => expect(linksEdges).toHaveBeenCalledTimes(3));
    expect(screen.getAllByText("old.md")).toBeTruthy();
    expect(screen.queryByText("replacement.md")).toBeNull();
    await act(async () => next.resolve(page("last.md")));
    await screen.findAllByText("replacement.md");
    expect(screen.queryByText("old.md")).toBeNull();
    expect(screen.getAllByText("last.md")).toBeTruthy();
  });

  it.each([false, true])("restarts a changed-source cursor once; repeated rejection=%s", async repeated => {
    const frames = stubAnimationFrames();
    const changed = new Error("DaemonRefusalError [CONFLICT]: links-edges-source-changed");
    const linksEdges = vi.fn().mockResolvedValueOnce(page("a.md", "cursor"))
      .mockRejectedValueOnce(changed).mockResolvedValueOnce(page("fresh.md", "fresh-cursor"));
    if (repeated) linksEdges.mockRejectedValueOnce(changed);
    else linksEdges.mockResolvedValueOnce(page("last.md"));
    const onError = vi.fn();
    vi.stubGlobal("dohcDesktop", { linksEdges });
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} onError={onError} />);
    await screen.findAllByText("a.md");
    await act(async () => { while (frames.pending) frames.runNext(); });
    await waitFor(() => expect(linksEdges).toHaveBeenCalledTimes(4));
    expect(linksEdges.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, "cursor", undefined, "fresh-cursor"]);
    if (repeated) {
      await waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(screen.getAllByText("a.md")).toBeTruthy();
    } else {
      await screen.findAllByText("last.md");
      expect(screen.queryByText("a.md")).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("requests one chat batch for drawn files and joins non-Markdown targets once", async () => {
    const mention = {
      attachment: { objectId: "svg", pathHint: "picture.svg" },
      thread: { id: "thread", title: "Picture discussion" },
    } as ChatFileMentionRecord;
    const linksEdges = vi.fn(async () => ({ ...page("a.md"), entries: [
      { source: "a.md", target: "picture.svg", kind: "markdown" as const, ordinal: 0 },
    ] }));
    const chatFileMentionsPage = vi.fn(async () => ({ entries: [mention] }));
    vi.stubGlobal("dohcDesktop", { linksEdges, chatFileMentionsPage });
    const { rerender } = render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} chatMentionsAvailable />);
    await screen.findAllByText("a.md");
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await screen.findAllByText("Picture discussion");
    expect(chatFileMentionsPage).toHaveBeenCalledOnce();
    expect(chatFileMentionsPage).toHaveBeenCalledWith({ workspaceId: "ws" });
    expect(screen.getByTestId("graph-link-count").textContent).toBe("2 links");
    // Opening another file that draws the same files asks for nothing new.
    for (const activePath of ["a.md", "picture.svg"]) {
      rerender(<GraphView workspaceId="ws" activePath={activePath} refreshKey="0" onOpenPath={vi.fn()} chatMentionsAvailable />);
      await screen.findAllByText("Picture discussion");
    }
    expect(chatFileMentionsPage).toHaveBeenCalledOnce();
  });

  it("keeps the chat overlay while a refreshed file walk is pending", async () => {
    const held = deferred<LinksEdgesResult>();
    const linksEdges = vi.fn().mockResolvedValue(page("a.md"));
    const chatFileMentionsPage = vi.fn(async () => ({ entries: [{
      attachment: {objectId:"a.md",pathHint:"a.md"}, thread: {id:"thread",title:"Discussion"},
    } as ChatFileMentionRecord] }));
    vi.stubGlobal("dohcDesktop",{linksEdges,chatFileMentionsPage});
    render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} chatMentionsAvailable />);
    await screen.findAllByText("a.md");
    fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
    await screen.findAllByText("Discussion");
    linksEdges.mockReturnValueOnce(held.promise);
    fireEvent.click(screen.getByLabelText("Refresh graph"));
    await screen.findByText("Gathering linked mentions");
    expect(screen.getAllByText("Discussion")).toBeTruthy();
    expect(chatFileMentionsPage).toHaveBeenCalledOnce();
    await act(async()=>held.resolve(page("a.md")));
    await waitFor(()=>expect(chatFileMentionsPage).toHaveBeenCalledTimes(2));
  });

});

function page(path: string, nextCursor: string | null = null): LinksEdgesResult {
  return {versionId:"main",files:[{path,objectId:path,title:path}],entries:[],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,nextCursor};
}

it("paints the first chat page, continues once, and deduplicates attachments across pages", async()=>{
  const overlay = vi.spyOn(graphData, "withChatMentions");
  try {
  const later=deferred<unknown>();
  const row=(id:string,title:string)=>({attachment:{attachmentId:id,objectId:"a.md",pathHint:"a.md"},thread:{id,title}} as ChatFileMentionRecord);
  const first=row("one","First discussion"), second=row("two","Second discussion");
  const chatFileMentionsPage=vi.fn().mockResolvedValueOnce({entries:[first],nextCursor:"next"}).mockReturnValueOnce(later.promise);
  vi.stubGlobal("dohcDesktop",{linksEdges:vi.fn(async()=>page("a.md")),chatFileMentionsPage});
  render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} chatMentionsAvailable/>);
  await screen.findAllByText("a.md");
  fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
  await screen.findAllByText("First discussion");
  await waitFor(()=>expect(chatFileMentionsPage).toHaveBeenCalledTimes(2));
  expect(chatFileMentionsPage.mock.calls.map(([input])=>input)).toEqual([{workspaceId:"ws"},{workspaceId:"ws",cursor:"next"}]);
  expect(screen.getByText("Gathering linked mentions")).toBeTruthy();
  await act(async()=>later.resolve({entries:[first,second],nextCursor:null}));
  await screen.findAllByText("Second discussion");
  expect(screen.getByTestId("graph-link-count").textContent).toBe("2 links");
  expect(overlay.mock.lastCall?.[1]).toHaveLength(2);
  expect(screen.queryByText("Gathering linked mentions")).toBeNull();
  } finally {
    overlay.mockRestore();
  }
});
it("discards a continuation after the chat toggle is disabled",async()=>{
  const later=deferred<unknown>();
  const chatFileMentionsPage=vi.fn().mockResolvedValueOnce({entries:[],nextCursor:"next"}).mockReturnValueOnce(later.promise);
  vi.stubGlobal("dohcDesktop",{linksEdges:vi.fn(async()=>page("a.md")),chatFileMentionsPage});
  render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} chatMentionsAvailable/>);
  await screen.findAllByText("a.md");
  fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
  await waitFor(()=>expect(chatFileMentionsPage).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
  await act(async()=>later.resolve({entries:[{attachment:{attachmentId:"late",objectId:"a.md",pathHint:"a.md"},thread:{id:"late",title:"Late discussion"}}],nextCursor:"third"}));
  expect(screen.queryByText("Late discussion")).toBeNull();
  expect(chatFileMentionsPage).toHaveBeenCalledTimes(2);
});

it.each(["chat-mention-access-changed", "chat-mention-version-changed"])("clears chat rows for %s, restarts once, then reports a repeated change", async reason => {
  const changed = deferred<unknown>(), restarted = deferred<unknown>();
  const row = { attachment: { attachmentId: "old", objectId: "a.md", pathHint: "a.md" }, thread: { id: "old", title: "Old access" } };
  const chatFileMentionsPage = vi.fn().mockResolvedValueOnce({entries:[row],nextCursor:"old-cursor"})
    .mockReturnValueOnce(changed.promise).mockReturnValueOnce(restarted.promise);
  const onError = vi.fn();
  vi.stubGlobal("dohcDesktop",{linksEdges:vi.fn(async()=>page("a.md")),chatFileMentionsPage});
  render(<GraphView workspaceId="ws" activePath={null} refreshKey="0" onOpenPath={vi.fn()} onError={onError} chatMentionsAvailable/>);
  await screen.findAllByText("a.md");
  fireEvent.click(screen.getByTestId("graph-chat-mentions-toggle"));
  await screen.findAllByText("Old access");
  await waitFor(()=>expect(chatFileMentionsPage).toHaveBeenCalledTimes(2));
  await act(async()=>changed.reject(new Error(`Error invoking remote method 'desktop:chat-file-mentions-page': ${String(ipcWireError(new DaemonRefusalError({code:"CONFLICT",message:reason,retry:"no"},null)))}`)));
  await waitFor(()=>expect(chatFileMentionsPage).toHaveBeenCalledTimes(3));
  expect(chatFileMentionsPage.mock.calls[2]![0]).toEqual({workspaceId:"ws"});
  expect(screen.queryByText("Old access")).toBeNull();
  expect(onError).not.toHaveBeenCalled();
  await act(async()=>restarted.reject(new Error(`Error invoking remote method 'desktop:chat-file-mentions-page': ${String(ipcWireError(new DaemonRefusalError({code:"CONFLICT",message:reason,retry:"no"},null)))}`)));
  expect(onError).toHaveBeenCalledOnce();
  expect(chatFileMentionsPage).toHaveBeenCalledTimes(3);
  expect(screen.getAllByText("a.md").length).toBeGreaterThan(0);
});

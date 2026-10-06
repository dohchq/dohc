// @vitest-environment jsdom
// Each historical case runs against the idiom that shipped the defect and against the hooks.
import { StrictMode, Suspense, startTransition, use, useLayoutEffect, useRef, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAsyncResponseEffect } from "./useAsyncResponseEffect";
import {
  desktopMetadata,
  useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad, type DesktopTask,
} from "./desktopAction";
import { installGlobalErrorReporters } from "./ErrorBoundary";
import { desktopMembers, type ReadDesktop } from "./desktopOperations";
import type { JSX } from "react";
import { whenSettled } from "./desktopActionTesting";

const reported: unknown[] = [];
beforeEach(() => vi.stubGlobal("dohcDesktop", {}));
window.addEventListener("error", (event) => reported.push(event.error));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); reported.length = 0; });
function setTestTransport(transport: Record<string, (input: unknown) => PromiseLike<unknown>>) { vi.stubGlobal("dohcDesktop", transport); }
function setTestEvents(events: Record<string, (listener: (value: unknown) => void) => () => void>) { vi.stubGlobal("dohcDesktop", events); }
function setTestMetadata(metadata: { platform: string; devTools: boolean; windowRole: string }) { vi.stubGlobal("dohcDesktop", metadata); }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function immediateResponse<T>() {
  let onSuccess: ((value: T) => void) | null = null;
  const promise = { then(success: (value: T) => void) { onSuccess = success; return Promise.resolve(); } } as unknown as PromiseLike<T>;
  return { promise, resolve: (value: T) => onSuccess?.(value) };
}
const desktop = (operations: Record<string, (input: never) => PromiseLike<unknown>>) =>
  setTestTransport(operations as Record<string, (input: unknown) => PromiseLike<unknown>>);
const ok = () => {};

describe("#933 refresh generation: reply lands after commit, before passive cleanup", () => {
  it("today's useAsyncResponseEffect paints the stale refresh", () => {
    const first = immediateResponse<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(new Promise(() => {}));
    function Graph(props: { refreshKey: string }) {
      const [text, setText] = useState("loading");
      useAsyncResponseEffect(() => read() as Promise<string>, { onSuccess: setText, onError: () => setText("error") }, [props.refreshKey]);
      return <p>{text}</p>;
    }
    function Race(props: { refreshKey: string }) {
      useLayoutEffect(() => { if (props.refreshKey === "1") first.resolve("stale"); }, [props.refreshKey]);
      return <Graph refreshKey={props.refreshKey} />;
    }
    const view = render(<Race refreshKey="0" />);
    view.rerender(<Race refreshKey="1" />);
    expect(screen.getByText("stale")).toBeTruthy();
  });

  it("the load drops it, shows the current refresh, and sends the committed payload", async () => {
    const first = immediateResponse<string>();
    const second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    desktop({ readWorkspaceGraph: read });
    function Graph(props: { refreshKey: string }) {
      const [text, setText] = useState("loading");
      useDesktopLoad([props.refreshKey], "readWorkspaceGraph", { workspaceId: "w1", includeChatMentions: props.refreshKey === "1" },
        { success: setText as never, failure: () => setText("error") });
      return <p>{text}</p>;
    }
    function Race(props: { refreshKey: string }) {
      useLayoutEffect(() => { if (props.refreshKey === "1") first.resolve("stale"); }, [props.refreshKey]);
      return <Graph refreshKey={props.refreshKey} />;
    }
    const view = render(<Race refreshKey="0" />);
    view.rerender(<Race refreshKey="1" />);
    expect(screen.queryByText("stale")).toBeNull();
    await act(async () => { second.resolve("current"); await second.promise; });
    expect(screen.getByText("current")).toBeTruthy();
    expect(read.mock.calls).toEqual([[{ workspaceId: "w1", includeChatMentions: false }], [{ workspaceId: "w1", includeChatMentions: true }]]);
  });

  it("changing only an input field re-issues the load", () => {
    const read = vi.fn(() => new Promise(() => {}));
    desktop({ readWorkspaceGraph: read });
    function Graph(props: { mentions: boolean }) {
      useDesktopLoad([], "readWorkspaceGraph", { workspaceId: "w1", includeChatMentions: props.mentions }, { success: ok, failure: ok });
      return null;
    }
    const view = render(<Graph mentions={false} />);
    view.rerender(<Graph mentions />);
    expect(read.mock.calls).toEqual([[{ workspaceId: "w1", includeChatMentions: false }], [{ workspaceId: "w1", includeChatMentions: true }]]);
  });

  it("an explicitly undefined field is a different input from an absent one", () => {
    const read = vi.fn(() => new Promise(() => {}));
    desktop({ getCollectionRecordHistory: read });
    function History(props: { explicit: boolean }) {
      const input = props.explicit
        ? { workspaceId: "w", collectionPath: "c", recordId: "r", beforeHistoryId: undefined }
        : { workspaceId: "w", collectionPath: "c", recordId: "r" };
      useDesktopLoad([], "getCollectionRecordHistory", input, { success: ok, failure: ok });
      return null;
    }
    const view = render(<History explicit={false} />);
    view.rerender(<History explicit />);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a null input skips the load", () => {
    const read = vi.fn(() => new Promise(() => {}));
    desktop({ readWorkspaceGraph: read });
    function Graph(props: { active: boolean }) {
      useDesktopLoad([], "readWorkspaceGraph", props.active ? { workspaceId: "w", includeChatMentions: false } : null, { success: ok, failure: ok });
      return null;
    }
    const view = render(<Graph active={false} />);
    expect(read).not.toHaveBeenCalled();
    view.rerender(<Graph active />);
    expect(read).toHaveBeenCalledExactlyOnceWith({ workspaceId: "w", includeChatMentions: false });
    view.rerender(<Graph active={false} />);
    expect(read).toHaveBeenCalledOnce();
    expect(reported).toEqual([]);
  });
});

describe("#602 reused cursor: Show more from a replaced window", () => {
  type Props = { refreshNonce: number; expose: (more: () => void) => void };
  async function run(Versions: (props: Props) => JSX.Element | null, readPage: (cursor: string) => PromiseLike<string[]>, page: { resolve: (rows: string[]) => void; promise: Promise<string[]> }) {
    desktop({ compareWorkspaceVersions: (input: { afterPath: string }) => Promise.resolve(readPage(input.afterPath)).then(rows => ({ files: rows.map(path => ({ path })), nextAfterPath: null })) });
    let more = () => {};
    const view = render(<Versions refreshNonce={0} expose={(f) => { more = f; }} />);
    act(() => more());
    view.rerender(<Versions refreshNonce={1} expose={(f) => { more = f; }} />);
    await act(async () => { page.resolve(["old-page-row"]); await page.promise; });
  }

  it("the pre-#602 cursor comparison appends the old page", async () => {
    const page = deferred<string[]>();
    const readPage = vi.fn().mockReturnValueOnce(page.promise);
    function Versions(props: Props) {
      const [rows, setRows] = useState<string[]>([]);
      const cursorRef = useRef("c1");
      useLayoutEffect(() => { setRows([`window-${props.refreshNonce}`]); cursorRef.current = "c1"; }, [props.refreshNonce]);
      props.expose(() => {
        const cursor = cursorRef.current;
        void (readPage(cursor) as Promise<string[]>).then((rowsPage) => { if (cursorRef.current === cursor) setRows((r) => [...r, ...rowsPage]); });
      });
      return <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>;
    }
    await run(Versions, readPage, page);
    expect(screen.getByText("old-page-row")).toBeTruthy();
  });

  it("the action bound to the window identity drops it", async () => {
    const page = deferred<string[]>();
    const readPage = vi.fn().mockReturnValueOnce(page.promise);
    function Versions(props: Props) {
      const [rows, setRows] = useState<string[]>([]);
      useLayoutEffect(() => { setRows([`window-${props.refreshNonce}`]); }, [props.refreshNonce]);
      const [showMore] = useDesktopAction([props.refreshNonce], "compareWorkspaceVersions", { success: rowsPage => setRows(r => [...r, ...rowsPage.files.map(file => file.path)]), failure: ok });
      props.expose(() => { showMore({ workspaceId: "w", versionId: "v", afterPath: "c1" }); });
      return <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>;
    }
    expect(desktopMembers.compareWorkspaceVersions.kind).toBe("read");
    await run(Versions, readPage, page);
    expect(readPage).toHaveBeenCalledExactlyOnceWith("c1");
    expect(screen.queryByText("old-page-row")).toBeNull();
    expect(screen.getByText("window-1")).toBeTruthy();
  });
});

describe("#1484 retained retry for a record that is no longer shown", () => {
  it("the pre-fix retry closure reads the obsolete record", async () => {
    const notices: Array<() => void> = [];
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("history");
    function Dialog(props: { recordId: string }) {
      const [, setHistory] = useState("");
      const load = (recordId: string): Promise<void> => (read(recordId) as Promise<string>).then(setHistory, () => { notices.push(() => { void load(recordId); }); });
      const loaded = useRef<string | null>(null);
      if (loaded.current !== props.recordId) { loaded.current = props.recordId; if (props.recordId === "r1") void load("r1"); }
      return null;
    }
    const view = render(<Dialog recordId="r1" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    view.rerender(<Dialog recordId="r2" />);
    const before = read.mock.calls.length;
    expect(before).toBe(1);
    expect(notices).toHaveLength(1);
    await act(async () => { notices[0]!(); await Promise.resolve(); });
    expect(read.mock.calls.length).toBe(before + 1);
    expect(read).toHaveBeenLastCalledWith("r1");
  });

  it("a view retry holding the retired action sends nothing", async () => {
    const notices: Array<() => void> = [];
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("history");
    desktop({ getCollectionRecordHistory: read });
    function Dialog(props: { recordId: string }) {
      const [, setHistory] = useState("");
      const [load] = useDesktopAction([props.recordId], "getCollectionRecordHistory",
        { success: setHistory as never, failure: () => notices.push(() => { load({ workspaceId: "w", collectionPath: "c", recordId: props.recordId }); }) });
      useLayoutEffect(() => { if (props.recordId === "r1") load({ workspaceId: "w", collectionPath: "c", recordId: "r1" }); }, [load, props.recordId]);
      return null;
    }
    const view = render(<Dialog recordId="r1" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    view.rerender(<Dialog recordId="r2" />);
    const before = read.mock.calls.length;
    expect(before).toBe(1);
    expect(notices).toHaveLength(1);
    await act(async () => { notices[0]!(); await Promise.resolve(); });
    expect(read.mock.calls.length).toBe(before);
  });
});

describe("#1147 overlapping lane reads in one lifetime seed the cache", () => {
  it("a lifetime-only token lets the old read paint and seed the cache", async () => {
    const x = deferred<string>();
    const y = deferred<string>();
    const readLane = vi.fn().mockReturnValueOnce(x.promise).mockReturnValueOnce(y.promise);
    const cache = new Map<string, string>();
    function Lane(props: { lane: string }) {
      const [agents, setAgents] = useState("");
      const live = useRef(true);
      useLayoutEffect(() => () => { live.current = false; }, []);
      useLayoutEffect(() => {
        const lane = props.lane;
        void (readLane(lane) as Promise<string>).then((value) => { if (live.current) { cache.set(lane, value); setAgents(value); } });
      }, [props.lane]);
      return <p>{agents}</p>;
    }
    const view = render(<Lane lane="X" />);
    view.rerender(<Lane lane="Y" />);
    await act(async () => { y.resolve("agents-of-Y"); await y.promise; });
    await act(async () => { x.resolve("agents-of-X"); await x.promise; });
    expect(screen.getByText("agents-of-X")).toBeTruthy();
  });

  it("the load keyed by lane drops the old read; cache updates arrive as data through delivery", async () => {
    const x = deferred<{ agents: string; updates: Record<string, string> }>();
    const y = deferred<{ agents: string; updates: Record<string, string> }>();
    const readLane = vi.fn().mockReturnValueOnce(x.promise).mockReturnValueOnce(y.promise);
    const executor = (_desktop: unknown, input: { lane: string }) => readLane(input.lane);
    const cache: Record<string, string> = {};
    function Lane(props: { lane: string }) {
      const [agents, setAgents] = useState("");
      useDesktopLoad([props.lane], executor as never, { lane: props.lane } as never,
        { success: (result: { agents: string; updates: Record<string, string> }) => { Object.assign(cache, result.updates); setAgents(result.agents); }, failure: ok });
      return <p>{agents}</p>;
    }
    const view = render(<Lane lane="X" />);
    view.rerender(<Lane lane="Y" />);
    await act(async () => { y.resolve({ agents: "agents-of-Y", updates: { Y: "y" } }); await y.promise; });
    await act(async () => { x.resolve({ agents: "agents-of-X", updates: { X: "x" } }); await x.promise; });
    expect(screen.getByText("agents-of-Y")).toBeTruthy();
    expect(cache).toEqual({ Y: "y" });
  });
});

describe("#1147 with a reduced lane executor: inputs are detached and the cache-hit path works", () => {
  // Reduced lane executor for the input-clone and cache-delivery contract.
  async function readLaneAgents(desktop: ReadDesktop, input: { workspaceId: string; channelIds: readonly string[] }, cached: Record<string, { updatedAtMs: number; spoke: readonly { id: string; atMs: number }[] }>) {
    const updates: Record<string, { updatedAtMs: number; spoke: readonly { id: string; atMs: number }[] }> = {};
    const agents = await Promise.all(input.channelIds.map(async (channelId) => {
      const listed = await desktop.listChannelThreads({ workspaceId: input.workspaceId, channelId, lane: "chat" });
      const lane = [...listed.threads].sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
      if (!lane) return [];
      const hit = cached[channelId];
      if (hit && hit.updatedAtMs === lane.updatedAtMs) return hit.spoke;
      const page = await desktop.listChatMessages({ workspaceId: input.workspaceId, threadId: lane.id });
      const spoke = page.messages.filter((m) => m.authorKind === "agent").map((m) => ({ id: m.authorDisplayName, atMs: m.createdAtMs }));
      updates[channelId] = { updatedAtMs: lane.updatedAtMs, spoke };
      return spoke;
    }));
    return { agents: agents.flat(), updates };
  }

  it("an executor that writes its input cannot touch the caller's live cache (review r3 F1)", async () => {
    const reply = deferred<{ messages: { authorDisplayName: string }[] }>();
    const listChatMessages = vi.fn(() => reply.promise);
    desktop({ listChatMessages });
    async function readCached(d: ReadDesktop, input: { threadId: string; cache: Record<string, string> }) {
      const page = await d.listChatMessages({ workspaceId: "w", threadId: input.threadId });
      input.cache[input.threadId] = page.messages.map((m: { authorDisplayName: string }) => m.authorDisplayName).join(",");
      return input.cache[input.threadId];
    }
    const live: Record<string, string> = {};
    function Lane(props: { threadId: string }) {
      const cache = useRef(live);
      useDesktopLoad([props.threadId], readCached as never, { threadId: props.threadId, cache: cache.current } as never, { success: ok, failure: ok });
      return null;
    }
    const view = render(<Lane threadId="t1" />);
    view.rerender(<Lane threadId="t2" />);
    await act(async () => { reply.resolve({ messages: [{ authorDisplayName: "agent" }] }); await reply.promise; });
    expect(listChatMessages.mock.calls).toEqual([[{ workspaceId: "w", threadId: "t1" }], [{ workspaceId: "w", threadId: "t2" }]]);
    expect(live).toEqual({});
  });

  it("an obsolete real lane read seeds nothing; the next identity hits the cache delivery wrote", async () => {
    const threads = { threads: [{ id: "th1", createdAtMs: 1, updatedAtMs: 10 }] };
    const slow = deferred<{ messages: unknown[] }>();
    const listChatMessages = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue({ messages: [{ authorKind: "agent", authorDisplayName: "bot", createdAtMs: 5 }] });
    desktop({ listChannelThreads: vi.fn().mockResolvedValue(threads), listChatMessages });
    const cache: Record<string, { updatedAtMs: number; spoke: readonly { id: string; atMs: number }[] }> = {};
    const shown: string[] = [];
    function Lane(props: { pass: number }) {
      useDesktopLoad([props.pass], readLaneAgents, { workspaceId: "w", channelIds: ["c1"] },
        { success: (r: { agents: { id: string }[]; updates: typeof cache }) => { Object.assign(cache, r.updates); shown.push(r.agents.map((a) => a.id).join(",")); }, failure: ok }, cache);
      return null;
    }
    const view = render(<Lane pass={1} />);
    view.rerender(<Lane pass={2} />);
    await vi.waitFor(() => expect(shown).toEqual(["bot"]));
    await act(async () => { slow.resolve({ messages: [{ authorKind: "agent", authorDisplayName: "stale-bot", createdAtMs: 1 }] }); await slow.promise; });
    expect(shown).toEqual(["bot"]);
    expect(cache.c1?.spoke.map((s) => s.id)).toEqual(["bot"]);
    view.rerender(<Lane pass={3} />);
    await vi.waitFor(() => expect(shown).toEqual(["bot", "bot"]));
    expect(listChatMessages).toHaveBeenCalledTimes(2);
  });
});

describe("#1166 shape: a failure reaches a parent callback after its workspace shell is gone", () => {
  type ShellProps = { workspaceId: string; report: (workspaceId: string, message: string) => void; expose: (check: () => void) => void };
  async function run(Shell: (props: ShellProps) => JSX.Element | null, reply: { reject: (e: unknown) => void; promise: Promise<string> }) {
    const reports: string[] = [];
    let check = () => {};
    function Root(props: { workspaceId: string }) {
      return <Shell key={props.workspaceId} workspaceId={props.workspaceId} report={(ws, m) => reports.push(`${ws}:${m}`)} expose={(f) => { check = f; }} />;
    }
    const view = render(<Root workspaceId="A" />);
    act(() => check());
    view.rerender(<Root workspaceId="B" />);
    await act(async () => { reply.reject(new Error("offline")); await reply.promise.catch(ok); });
    return reports;
  }
  it("an unguarded continuation reports A's failure while B is shown", async () => {
    const reply = deferred<string>();
    function Shell(props: ShellProps) {
      props.expose(() => { void reply.promise.catch((e: Error) => props.report(props.workspaceId, e.message)); });
      return null;
    }
    expect(await run(Shell, reply)).toEqual(["A:offline"]);
  });
  it("the action retires with the shell and reports nothing", async () => {
    const reply = deferred<string>();
    const read = vi.fn(() => reply.promise);
    desktop({ readWorkspaceGraph: read });
    function Shell(props: ShellProps) {
      const [readWorkspaceGraph] = useDesktopAction([props.workspaceId], "readWorkspaceGraph" as never, { success: ok, failure: (e) => props.report(props.workspaceId, (e as Error).message) });
      props.expose(() => { readWorkspaceGraph(undefined as never); });
      return null;
    }
    expect(await run(Shell, reply)).toEqual([]);
    expect(read).toHaveBeenCalledOnce();
  });
});

describe("commit-time publication, reentrancy, pending, and handler errors", () => {
  it("a suspended transition render cannot redirect the committed binding's delivery", async () => {
    const reply = deferred<string>();
    desktop({ read: () => reply.promise });
    const delivered: string[] = [];
    const never = new Promise<never>(() => {});
    let issueRead = () => {};
    function Viewer(props: { label: string; suspend: boolean }) {
      const [read] = useDesktopAction([], "read" as never, { success: (v: string) => delivered.push(`${props.label}:${v}`), failure: ok });
      issueRead = () => { read(undefined as never); };
      if (props.suspend) use(never);
      return <p>{props.label}</p>;
    }
    const view = render(<Suspense fallback={<p>fallback</p>}><Viewer label="A" suspend={false} /></Suspense>);
    act(() => issueRead());
    await act(async () => { startTransition(() => { view.rerender(<Suspense fallback={<p>fallback</p>}><Viewer label="B" suspend /></Suspense>); }); });
    expect(screen.getByText("A")).toBeTruthy();
    await act(async () => { reply.resolve("value"); await reply.promise; });
    expect(delivered).toEqual(["A:value"]);
  });

  it("a success that issues newer work keeps the newer call pending", async () => {
    const first = deferred<string>();
    desktop({ refresh: vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(new Promise(() => {})) });
    let refresh = () => {};
    function Viewer() {
      const [read, pending]: readonly [(input: never) => DesktopTask, boolean] = useDesktopAction([], "refresh" as never, { success: () => { read(undefined as never); }, failure: ok });
      refresh = () => { read(undefined as never); };
      return <p>{pending ? "loading" : "idle"}</p>;
    }
    render(<Viewer />);
    act(() => refresh());
    await act(async () => { first.resolve("ok"); await first.promise; });
    expect(screen.getByText("loading")).toBeTruthy();
  });

  it("the older of two calls in one binding cannot deliver after the newer one", async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    desktop({ search: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise) });
    let search = (_: string) => {};
    function Search() {
      const [text, setText] = useState("none");
      const [run] = useDesktopAction([], "search" as never, { success: setText as never, failure: ok });
      search = (query) => { run(query as never); };
      return <p>{text}</p>;
    }
    render(<Search />);
    act(() => search("a"));
    act(() => search("ab"));
    await act(async () => { newer.resolve("results-ab"); await newer.promise; });
    await act(async () => { older.resolve("results-a"); await older.promise; });
    expect(screen.getByText("results-ab")).toBeTruthy();
  });

  it("a new identity is not pending while the old call is still in flight (stuck spinner)", async () => {
    const old = deferred<string>();
    desktop({ refresh: vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(new Promise(() => {})) });
    let refresh = () => {};
    function Viewer(props: { recordId: string }) {
      const [read, pending] = useDesktopAction([props.recordId], "refresh" as never, { success: ok, failure: ok });
      refresh = () => { read(undefined as never); };
      return <p>{pending ? "loading" : "idle"}</p>;
    }
    const view = render(<Viewer recordId="r1" />);
    act(() => refresh());
    expect(screen.getByText("loading")).toBeTruthy();
    view.rerender(<Viewer recordId="r2" />);
    expect(screen.getByText("idle")).toBeTruthy();
    await act(async () => { old.resolve("ok"); await old.promise; });
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("handler errors from fire-and-forget loads, actions, and commands reach the error owner once each", async () => {
    desktop({ readWorkspaceGraph: () => Promise.resolve("g"), refresh: () => Promise.reject(new Error("net")), revokeRelayShare: () => Promise.resolve({}) });
    const scope = { live: () => true };
    let run = () => {};
    function Viewer() {
      useDesktopLoad([], "readWorkspaceGraph", { workspaceId: "w", includeChatMentions: false }, { success: () => { throw new Error("load handler"); }, failure: ok });
      const [read] = useDesktopAction([], "refresh" as never, { success: ok, failure: () => { throw new Error("action handler"); } });
      const [revoke] = useDesktopCommand([], "revokeRelayShare", { scope, success: () => { throw new Error("command handler"); }, failure: ok });
      run = () => { read(undefined as never); revoke({ shareId: "A" }); };
      return null;
    }
    render(<Viewer />);
    act(() => run());
    await vi.waitFor(() => expect(reported).toHaveLength(3));
    expect(reported.map((e) => (e as Error).message).sort()).toEqual(["action handler", "command handler", "load handler"]);
  });

  it("A -> B -> A does not revive the first A request (workspace-id ref guard does)", async () => {
    const firstA = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(firstA.promise).mockReturnValue(new Promise<string>(() => {}));
    function RefGuard(props: { workspaceId: string }) {
      const [text, setText] = useState("idle");
      const ref = useRef(props.workspaceId);
      ref.current = props.workspaceId;
      useLayoutEffect(() => {
        const askedFor = props.workspaceId;
        void (read() as Promise<string>).then((value) => { if (ref.current === askedFor) setText(value); });
      }, [props.workspaceId]);
      return <p data-testid="ref">{text}</p>;
    }
    const refView = render(<RefGuard workspaceId="A" />);
    refView.rerender(<RefGuard workspaceId="B" />);
    refView.rerender(<RefGuard workspaceId="A" />);
    await act(async () => { firstA.resolve("first-A"); await firstA.promise; });
    expect(screen.getByTestId("ref").textContent).toBe("first-A");
    refView.unmount();

    const firstA2 = deferred<string>();
    const actionRead = vi.fn().mockReturnValueOnce(firstA2.promise).mockReturnValue(new Promise<string>(() => {}));
    desktop({ readWorkspaceGraph: actionRead });
    function Action(props: { workspaceId: string }) {
      const [text, setText] = useState("idle");
      useDesktopLoad([props.workspaceId], "readWorkspaceGraph", { workspaceId: props.workspaceId, includeChatMentions: false }, { success: setText as never, failure: ok });
      return <p data-testid="action">{text}</p>;
    }
    const actionView = render(<Action workspaceId="A" />);
    actionView.rerender(<Action workspaceId="B" />);
    actionView.rerender(<Action workspaceId="A" />);
    await act(async () => { firstA2.resolve("first-A"); await firstA2.promise; });
    expect(actionRead.mock.calls).toEqual([[{ workspaceId: "A", includeChatMentions: false }], [{ workspaceId: "B", includeChatMentions: false }], [{ workspaceId: "A", includeChatMentions: false }]]);
    expect(screen.getByTestId("action").textContent).toBe("idle");
  });

  it("StrictMode replay delivers once, and whenSettled is a test seam with no result", async () => {
    const replies = [deferred<string>(), deferred<string>()];
    let call = 0;
    const read = vi.fn(() => replies[call++]!.promise);
    desktop({ read });
    const delivered: string[] = [];
    let task: DesktopTask | null = null;
    function Viewer() {
      const [load] = useDesktopAction([], "read" as never, { success: (v: string) => delivered.push(v), failure: ok });
      useLayoutEffect(() => { task = load(undefined as never); }, [load]);
      return null;
    }
    render(<StrictMode><Viewer /></StrictMode>);
    await act(async () => { replies[0]!.resolve("first-setup"); replies[1]?.resolve("second-setup"); await whenSettled(task!); });
    expect(delivered).toEqual([read.mock.calls.length === 2 ? "second-setup" : "first-setup"]);
    expect(whenSettled(task!)).toBeInstanceOf(Promise);
    await whenSettled(task!);
    expect(read).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["second-setup"]);
  });
});

describe("mutations, events, and metadata", () => {
  it("overlapping revokes keep their own target; a failure after close still reaches Notices with its own retry", async () => {
    const replies = { A: deferred<{ undo?: { undoId: string; expiresAtMs: number } }>(), B: deferred<{ undo?: { undoId: string; expiresAtMs: number } }>(), C: deferred<{ undo?: { undoId: string; expiresAtMs: number } }>() };
    const revokeRelayShare = vi.fn((input: { shareId: "A" | "B" | "C" }) => replies[input.shareId].promise);
    desktop({ revokeRelayShare: revokeRelayShare as never });
    const notices: string[] = [];
    const retries: Array<() => void> = [];
    const scope = { live: () => true };
    let revoke = (_: "A" | "B" | "C") => {};
    function SharedByMe() {
      const [busy, setBusy] = useState<string | null>(null);
      const [run, revoking] = useDesktopCommand<"revokeRelayShare", { recipient: string }>([], "revokeRelayShare",
        { scope, success: (result, input, labels) => notices.push(`undo ${input.shareId} with ${labels.recipient} ${result.undo?.undoId ?? "none"}`),
          failure: (error, input, retry, labels) => { notices.push(`failed ${input.shareId} with ${labels.recipient}: ${(error as Error).message}`); retries.push(retry); } },
        { success: () => setBusy(null) });
      revoke = (shareId) => { setBusy(shareId); run({ shareId }, { recipient: `${shareId.toLowerCase()}@example.com` }); };
      return <p>{revoking ? `busy ${busy}` : "idle"}</p>;
    }
    const view = render(<SharedByMe />);
    act(() => revoke("A"));
    act(() => revoke("B"));
    act(() => revoke("C"));
    await act(async () => { replies.B.resolve({ undo: { undoId: "tB", expiresAtMs: 1 } }); await replies.B.promise; });
    await act(async () => { replies.A.resolve({ undo: { undoId: "tA", expiresAtMs: 1 } }); await replies.A.promise; });
    view.unmount();
    await act(async () => { replies.C.reject(new Error("offline")); await replies.C.promise.catch(ok); });
    expect(notices).toEqual(["undo B with b@example.com tB", "undo A with a@example.com tA", "failed C with c@example.com: offline"]);
    expect(retries).toHaveLength(1);
    // The retry belongs to the outcome scope: it re-issues C after the view closed.
    replies.C = deferred<{ undo?: { undoId: string; expiresAtMs: number } }>();
    await act(async () => { retries[0]!(); replies.C.resolve({ undo: { undoId: "tC", expiresAtMs: 1 } }); await replies.C.promise; });
    expect(revokeRelayShare).toHaveBeenLastCalledWith({ shareId: "C" });
    expect(notices.at(-1)).toBe("undo C with c@example.com tC");
  });

  it("a retained retry does nothing once its outcome scope closed", async () => {
    const reply = deferred<{ undo?: { undoId: string; expiresAtMs: number } }>();
    const revokeRelayShare = vi.fn().mockReturnValueOnce(reply.promise).mockReturnValue(new Promise(() => {}));
    desktop({ revokeRelayShare });
    const workspace = { open: true, live: () => workspace.open };
    const retries: Array<() => void> = [];
    let revoke = () => {};
    function SharedByMe() {
      const [run] = useDesktopCommand([], "revokeRelayShare", { scope: workspace, success: ok, failure: (_e, _input, retry) => retries.push(retry) });
      revoke = () => { run({ shareId: "A" }); };
      return null;
    }
    const view = render(<SharedByMe />);
    act(() => revoke());
    await act(async () => { reply.reject(new Error("offline")); await reply.promise.catch(ok); });
    view.unmount();
    workspace.open = false;
    act(() => retries[0]!());
    expect(revokeRelayShare).toHaveBeenCalledTimes(1);
  });

  it("a command outcome is dropped once its outcome scope (the workspace) closed", async () => {
    const reply = deferred<{ undo?: { undoId: string; expiresAtMs: number } }>();
    const revokeRelayShare = vi.fn(() => reply.promise);
    desktop({ revokeRelayShare });
    const notices: string[] = [];
    const workspace = { open: true, live: () => workspace.open };
    let revoke = () => {};
    function SharedByMe() {
      const [run] = useDesktopCommand([], "revokeRelayShare", { scope: workspace, success: (_r, input) => notices.push(`undo ${input.shareId}`), failure: ok });
      revoke = () => { run({ shareId: "A" }); };
      return null;
    }
    render(<SharedByMe />);
    act(() => revoke());
    expect(revokeRelayShare).toHaveBeenCalledExactlyOnceWith({ shareId: "A" });
    workspace.open = false;
    await act(async () => { reply.resolve({}); await reply.promise; });
    expect(notices).toEqual([]);
  });

  it("an event after the identity changed reaches only the current binding", () => {
    const listeners = new Set<(value: unknown) => void>();
    setTestEvents({ onWorkspaceActivity: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } });
    const seen: string[] = [];
    function Activity(props: { workspaceId: string }) {
      useDesktopEvent([props.workspaceId], "onWorkspaceActivity", (value) => seen.push(`${props.workspaceId}:${String(value)}`));
      return null;
    }
    const view = render(<Activity workspaceId="A" />);
    act(() => { for (const l of listeners) l("one"); });
    view.rerender(<Activity workspaceId="B" />);
    act(() => { for (const l of listeners) l("two"); });
    expect(seen).toEqual(["A:one", "B:two"]);
    expect(listeners.size).toBe(1);
  });

  it("metadata is read synchronously without the bridge", () => {
    setTestMetadata({ platform: "win32", devTools: true, windowRole: "manager" });
    expect(desktopMetadata()).toEqual({ platform: "win32", devTools: true, windowRole: "manager" });
  });
});

describe("tagged load input", () => {
  const inputs = [{}, { field: undefined }, { field: NaN }, { field: null }, { field: "\u0000undefined" }, { field: "\u0000NaN" }];
  for (let a = 0; a < inputs.length; a++) for (let b = a + 1; b < inputs.length; b++) {
    it(`distinguishes input ${a} from ${b}`, () => {
      const read = vi.fn((_input: { field?: string | number | null }) => new Promise<null>(() => {}));
      const executor = (_desktop: ReadDesktop, input: { field?: string | number | null }) => read(input);
      function Viewer(props: { input: { field?: string | number | null } }) {
        useDesktopLoad([], executor, props.input, { success: ok, failure: ok });
        return null;
      }
      desktop({});
      const view = render(<Viewer input={inputs[a]!} />);
      view.rerender(<Viewer input={inputs[b]!} />);
      expect(read.mock.calls).toEqual([[inputs[a]], [inputs[b]]]);
    });
  }
});

it("reports a handler exception through the renderer's installed error owner", async () => {
  installGlobalErrorReporters();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("delivery failed");
  desktop({ readWorkspaceGraph: () => Promise.resolve("graph") });
  let task: DesktopTask;
  function Viewer() {
    const [read] = useDesktopAction([], "readWorkspaceGraph", { success: () => { throw error; }, failure: ok });
    useLayoutEffect(() => { task = read({ workspaceId: "w", includeChatMentions: false }); }, [read]);
    return null;
  }
  try {
    render(<Viewer />);
    expect(whenSettled(task!)).toBeInstanceOf(Promise);
    await act(async () => { await whenSettled(task!); });
    expect(log.mock.calls).toEqual([["[desktop] uncaught renderer error:", error]]);
  } finally { log.mockRestore(); }
});

it("uncloneable command input fails through its outcome scope and settles", async () => {
  const send = vi.fn().mockResolvedValue({});
  desktop({ revokeRelayShare: send });
  const failure = vi.fn();
  const success = vi.fn();
  let task: DesktopTask;
  let run = (_input: { shareId: string }) => {};
  function Viewer() {
    const [revoke] = useDesktopCommand([], "revokeRelayShare", { scope: { live: () => true }, success, failure });
    run = input => { task = revoke(input); };
    return null;
  }
  render(<Viewer />);
  const input = { shareId: "A", uncloneable: () => {} };
  act(() => run(input));
  expect(whenSettled(task!)).toBeInstanceOf(Promise);
  await act(async () => { await whenSettled(task!); });
  expect(failure).toHaveBeenCalledOnce();
  expect(failure.mock.calls[0]?.[0]).toMatchObject({ name: "DataCloneError" });
  expect(failure.mock.calls[0]?.slice(1)).toEqual([input, expect.any(Function), undefined]);
  expect(send).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
});

it("dropped-file paths have a supported synchronous read hook", async () => {
  const file = new File(["text"], "notes.md");
  const read = vi.fn(() => ["C:/notes.md"]);
  vi.stubGlobal("dohcDesktop", { getDroppedFilePaths: read });
  const delivered: string[][] = [];
  let task: DesktopTask;
  function Viewer() {
    const [paths] = useDesktopAction([], "getDroppedFilePaths", { success: value => delivered.push(value), failure: ok });
    useLayoutEffect(() => { task = paths([file]); }, [paths]);
    return null;
  }
  render(<Viewer />);
  await act(async () => { await whenSettled(task!); });
  expect(read).toHaveBeenCalledExactlyOnceWith([file]);
  expect(delivered).toEqual([["C:/notes.md"]]);
});

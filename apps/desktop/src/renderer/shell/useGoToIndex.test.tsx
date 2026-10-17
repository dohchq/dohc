// @vitest-environment jsdom
import { useEffect, useMemo } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceListing } from "./useWorkspaceListing";
import { useGoToIndex } from "./useGoToIndex";
import { GoToIndex, type GoToListing } from "../workbench/quick-open-rank";
import type { ListWorkspaceFilesResult } from "../../ipc/bridgeContract";

const listWorkspaceFiles = vi.fn();
vi.mock("../bridge", () => ({ bridge: () => ({ listWorkspaceFiles }) }));
afterEach(() => { cleanup(); listWorkspaceFiles.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const context = { pinned: [], recent: [] };
function deferred() {
  let resolve!: (value: ListWorkspaceFilesResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ListWorkspaceFilesResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const answer = (path: string): ListWorkspaceFilesResult => ({ visibility: { status: "ready", rules: [] }, files: [{ path, kind: "file" }], folders: [] });
function Shell(props: { workspaceId: string; refresh: number }) {
  const { files, folders, visibility, refreshFiles } = useWorkspaceListing(props.workspaceId);
  useEffect(() => { void refreshFiles().catch(() => undefined); }, [refreshFiles, props.refresh]);
  const listing = useMemo(() => ({ files, folders, visibility, receivedRoots: [] }), [files, folders, visibility]);
  const index = useGoToIndex(props.workspaceId, { listing }, context);
  return <><output data-testid="explorer">{files.map(file => file.path).join(",")}</output><output data-testid="names">{index.query("").map(row => row.path).join(",")}</output><output data-testid="preparing">{index.preparing ? "preparing" : "ready"}</output></>;
}
function Root(props: { workspaceId: string; refresh?: number }) {
  return <Shell key={props.workspaceId} workspaceId={props.workspaceId} refresh={props.refresh ?? 0} />;
}
function expectListing(path: string) {
  expect(screen.getByTestId("explorer").textContent).toBe(path);
  expect(screen.getByTestId("names").textContent).toBe(path);
}
it("cannot accept A's delayed listing after the shell remounts for B", async () => {
  const a = deferred(), b = deferred();
  listWorkspaceFiles.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const view = render(<Root workspaceId="A" />);
  view.rerender(<Root workspaceId="B" />);
  expectListing("");
  await act(async () => { b.resolve(answer("B.md")); });
  await waitFor(() => expectListing("B.md"));
  await act(async () => { a.resolve(answer("A.md")); });
  expectListing("B.md");
});
it("follows Explorer's newest committed answer through a same-workspace version or attachment switch", async () => {
  const old = deferred(), next = deferred();
  listWorkspaceFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const view = render(<Root workspaceId="A" />);
  view.rerender(<Root workspaceId="A" refresh={1} />);
  await act(async () => { next.resolve(answer("new-version.md")); });
  await waitFor(() => expectListing("new-version.md"));
  await act(async () => { old.resolve(answer("old-version.md")); });
  expectListing("new-version.md");
});
it("keeps the successful committed listing through failure and recovers on the next successful read", async () => {
  listWorkspaceFiles.mockResolvedValueOnce(answer("first.md")).mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce(answer("recovered.md"));
  const view = render(<Root workspaceId="A" />);
  await waitFor(() => expectListing("first.md"));
  view.rerender(<Root workspaceId="A" refresh={1} />);
  await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId("names").textContent).toBe(""));
  expect(screen.getByTestId("explorer").textContent).toBe("first.md");
  view.rerender(<Root workspaceId="A" refresh={2} />);
  await waitFor(() => expectListing("recovered.md"));
});

function taskQueue() {
  const tasks = new Map<number, () => void>();
  let id = 0;
  vi.stubGlobal("setTimeout", (callback: () => void) => { tasks.set(++id, callback); return id; });
  vi.stubGlobal("clearTimeout", (task: number) => tasks.delete(task));
  const timers = vi.fn((callback: () => void) => { tasks.set(++id, callback); return id; });
  vi.stubGlobal("setTimeout", timers);
  const postTask = vi.fn((callback: () => void, options: { priority: string; signal: AbortSignal }) => {
    const task = ++id;
    const abort = () => tasks.delete(task);
    tasks.set(task, () => { options.signal.removeEventListener("abort", abort); callback(); });
    options.signal.addEventListener("abort", abort, { once: true });
    return Promise.resolve();
  });
  vi.stubGlobal("scheduler", { postTask });
  const frame = vi.fn(() => { throw new Error("preparation entered a frame callback"); });
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => { time += .25; return time; });
  const one = () => {
    const [task, callback] = tasks.entries().next().value!;
    tasks.delete(task);
    act(callback);
  };
  const drain = () => { while (tasks.size) one(); };
  return { tasks, one, drain, frame, timers, postTask, enqueue: (callback: () => void) => tasks.set(++id, callback) };
}
const snapshot = (prefix: string, count = 20): GoToListing => ({
  files: Array.from({ length: count }, (_, i) => ({ path: prefix + i + ".md", kind: "file" })),
  folders: [], visibility: { status: "ready", rules: [] }, receivedRoots: [],
});
function Snapshot(props: { workspaceId?: string; listing: GoToListing; committed?: boolean }) {
  const index = useGoToIndex(props.workspaceId ?? "workspace", { listing: props.listing }, context, props.committed ?? true);
  return <output>{index.preparing ? "preparing" : index.query("").map(row => row.target.workspaceId + ":" + row.path).join(",")}</output>;
}
it("prepares only in yielding tasks outside frames and starts no source reads", () => {
  const queue = taskQueue();
  const source = snapshot("file", 2_000);
  const view = render(<Snapshot listing={source} />);
  expect(view.container.textContent).toBe("preparing");
  expect(queue.tasks.size).toBe(1);
  queue.one();
  expect(queue.tasks.size).toBe(1);
  expect(view.container.textContent).toBe("preparing");
  queue.drain();
  expect(view.container.textContent).toContain("workspace:file0.md");
  view.rerender(<Snapshot listing={source} />);
  expect(queue.tasks.size).toBe(0);
  expect(queue.frame).not.toHaveBeenCalled();
  expect(queue.timers).not.toHaveBeenCalled();
  expect(queue.postTask).toHaveBeenCalledWith(expect.any(Function), { priority: "background", signal: expect.any(AbortSignal) });
  expect(listWorkspaceFiles).not.toHaveBeenCalled();
});
it("reads the committed listing once while Go to prepares in the background", async () => {
  listWorkspaceFiles.mockResolvedValue(answer("painted.md"));
  render(<Root workspaceId="A" />);
  await waitFor(() => expect(screen.getByTestId("explorer").textContent).toBe("painted.md"));
  await waitFor(() => expect(screen.getByTestId("names").textContent).toBe("painted.md"));
  expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);
});
it("supersedes in-flight slices with the newer source", () => {
  const queue = taskQueue();
  const view = render(<Snapshot listing={snapshot("old", 2_000)} />);
  queue.one();
  const late = [...queue.tasks.values()];
  view.rerender(<Snapshot listing={snapshot("new", 1)} />);
  late.forEach(callback => act(callback));
  queue.drain();
  expect(view.container.textContent).toBe("workspace:new0.md");
});
it("cannot show A's names after switching the same shell to B during preparation", () => {
  const queue = taskQueue();
  const sourceA = snapshot("A", 2_000);
  const sourceB = snapshot("B", 1);
  const view = render(<Snapshot workspaceId="A" listing={sourceA} />);
  queue.one();
  const late = [...queue.tasks.values()];
  view.rerender(<Snapshot workspaceId="B" listing={sourceA} committed={false} />);
  expect(view.container.textContent).toBe("");
  late.forEach(callback => act(callback));
  expect(view.container.textContent).toBe("");
  view.rerender(<Snapshot workspaceId="B" listing={sourceB} />);
  queue.drain();
  expect(view.container.textContent).toBe("B:B0.md");
  late.forEach(callback => act(callback));
  expect(view.container.textContent).toBe("B:B0.md");
});
it("does not reapply existing file verdicts for unchanged metadata", () => {
  const queue = taskQueue();
  const update = vi.spyOn(GoToIndex.prototype, "update");
  const first = snapshot("a", 1);
  first.visibility.rules = [{ path: "private", visibility: "hidden" }];
  const view = render(<Snapshot listing={first} />);
  queue.drain();
  expect(view.container.textContent).toBe("workspace:a0.md");
  const index = update.mock.instances[0] as GoToIndex;
  expect(index.lastVisibilityCheckCount).toBe(1);
  const rules = [{ path: "private", visibility: "hidden" as const }];
  view.rerender(<Snapshot listing={{ ...first, files: [...first.files, { path: "renamed.md", kind: "file" }], visibility: { ...first.visibility, rules }, receivedRoots: [] }} />);
  queue.drain();
  expect(view.container.textContent).toContain("renamed.md");
  expect(index.lastVisibilityCheckCount).toBe(1);
});

it("withholds a hidden host path from Go to while Explorer retains it", async () => {
  const update = vi.spyOn(GoToIndex.prototype, "update");
  listWorkspaceFiles.mockResolvedValueOnce({ ...answer("private.md"), files: [{ path: "private.md", kind: "file" }, { path: "public.md", kind: "file" }], visibility: { status: "ready", rules: [{ path: "private.md", visibility: "hidden" }] } });
  render(<Root workspaceId="A" />);
  await waitFor(() => expect(screen.getByTestId("explorer").textContent).toBe("private.md,public.md"));
  await waitFor(() => expect(update).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId("names").textContent).toBe("public.md"));
  expect(screen.getByTestId("names").textContent).not.toContain("private.md");
});
it.each(["degraded", "unavailable"] as const)("withholds host names when visibility is %s", async status => {
  const update = vi.spyOn(GoToIndex.prototype, "update");
  const listing: ListWorkspaceFilesResult = { ...answer("private.md"), files: [{ path: "private.md", kind: "file" }, { path: "public.md", kind: "file" }], visibility: { status, rules: [] } };
  listWorkspaceFiles.mockResolvedValueOnce(listing);
  render(<Root workspaceId="A" />);
  await waitFor(() => expect(screen.getByTestId("explorer").textContent).toBe("private.md,public.md"));
  await waitFor(() => expect(update).toHaveBeenLastCalledWith({ listing: expect.objectContaining({ files: listing.files, visibility: listing.visibility }) }, context));
  await waitFor(() => expect(screen.getByTestId("preparing").textContent).toBe("ready"));
  expect(screen.getByTestId("names").textContent).not.toContain("private.md");
  expect(screen.getByTestId("names").textContent).not.toContain("public.md");
});
it("cancels the task on unmount even if its callback arrives late", () => {
  const queue = taskQueue();
  const update = vi.spyOn(GoToIndex.prototype, "update");
  const view = render(<Snapshot listing={snapshot("old")} />);
  const late = [...queue.tasks.values()];
  const run = update.mock.results[0].value;
  const step = vi.spyOn(run, "step");
  view.unmount();
  expect(queue.tasks.size).toBe(0);
  late.forEach(callback => act(callback));
  expect(step).not.toHaveBeenCalled();
});

it("withholds a newly hidden path in the render before effects", () => {
  const queue = taskQueue();
  const answers: string[][] = [];
  function QuerySnapshot(props: { listing: GoToListing }) {
    const index = useGoToIndex("workspace", { listing: props.listing }, context);
    const paths = index.query("budget").map(row => row.path);
    answers.push(paths);
    return <output>{paths.join(",")}</output>;
  }
  const first = snapshot("file", 2_000);
  first.files = [{ path: "private/budget.md", kind: "file" }, ...first.files];
  const view = render(<QuerySnapshot listing={first} />);
  queue.drain();
  expect(view.container.textContent).toBe("private/budget.md");
  answers.length = 0;
  view.rerender(<QuerySnapshot listing={{ ...first, visibility: { status: "ready", rules: [{ path: "private/budget.md", visibility: "hidden" }] } }} />);
  expect(answers.length).toBeGreaterThan(0);
  expect(answers.every(paths => paths.length === 0)).toBe(true);
  queue.drain();
  expect(view.container.textContent).toBe("");
});
it("keeps results visible for a rename and equal new context arrays", () => {
  const queue = taskQueue();
  const answers: string[][] = [];
  function QuerySnapshot(props: { listing: GoToListing; ranking: typeof context }) {
    const index = useGoToIndex("workspace", { listing: props.listing }, props.ranking);
    const paths = index.query("file").map(row => row.path);
    answers.push(paths);
    return <output>{paths.join(",")}</output>;
  }
  const first = snapshot("file", 2_000);
  const view = render(<QuerySnapshot listing={first} ranking={context} />);
  queue.drain();
  answers.length = 0;
  view.rerender(<QuerySnapshot listing={first} ranking={{ pinned: [], recent: [] }} />);
  expect(queue.tasks.size).toBe(0);
  expect(answers.every(paths => paths.length > 0)).toBe(true);
  answers.length = 0;
  const changed = { ...first, files: first.files.map((file, n) => n === 123 ? { ...file, path: "renamed.md" } : file) };
  view.rerender(<QuerySnapshot listing={changed} ranking={context} />);
  expect(answers.every(paths => paths.length > 0)).toBe(true);
  queue.one();
  expect(view.container.textContent).not.toBe("");
  queue.drain();
});

it("filters removed non-file keys in the render before effects", () => {
  const queue = taskQueue();
  const answers: string[][] = [];
  function QuerySnapshot(props: { groups: { id: string; name: string; kind: "channel" }[] }) {
    const index = useGoToIndex("workspace", { groups: props.groups }, context);
    const names = index.query("Channel").map(row => row.id);
    answers.push(names);
    return <output>{names.join(",")}</output>;
  }
  const view = render(<QuerySnapshot groups={Array.from({ length: 70 }, (_, n) => ({ id: String(n), name: "Channel " + n, kind: "channel" }))} />);
  queue.drain();
  answers.length = 0;
  view.rerender(<QuerySnapshot groups={[{ id: "69", name: "Channel 69", kind: "channel" }]} />);
  expect(answers.length).toBeGreaterThan(0);
  expect(answers.every(names => names.length === 1 && names[0] === "group:69")).toBe(true);
  queue.drain();
});

it("yields through MessageChannel when background postTask is unavailable", () => {
  const queue = taskQueue();
  vi.stubGlobal("scheduler", undefined);
  const channels: FakeChannel[] = [];
  class FakeChannel {
    port1 = { onmessage: null as (() => void) | null, close: vi.fn() };
    port2 = { postMessage: vi.fn(() => queue.enqueue(() => this.port1.onmessage?.())), close: vi.fn() };
    constructor() { channels.push(this); }
  }
  vi.stubGlobal("MessageChannel", FakeChannel);
  const view = render(<Snapshot listing={snapshot("file", 2_000)} />);
  queue.one();
  expect(queue.tasks.size).toBe(1);
  queue.drain();
  expect(view.container.textContent).toContain("workspace:file0.md");
  expect(queue.timers).not.toHaveBeenCalled();
  expect(queue.frame).not.toHaveBeenCalled();
  expect(channels[0].port1.close).toHaveBeenCalled();
  expect(channels[0].port2.close).toHaveBeenCalled();
});

it("keeps a pending channel removal hidden through an undefined reload source", () => {
  const queue = taskQueue();
  const answers: string[][] = [];
  function Groups(props: { groups?: { id: string; name: string; kind: "channel" }[] }) {
    const index = useGoToIndex("workspace", { groups: props.groups }, context);
    answers.push(index.query("Channel").map(row => row.id));
    return null;
  }
  const view = render(<Groups groups={Array.from({ length: 2_000 }, (_, n) => ({ id: String(n), name: "Channel " + n, kind: "channel" }))} />);
  queue.drain();
  view.rerender(<Groups groups={[]} />);
  expect(queue.tasks.size).toBe(1);
  answers.length = 0;
  view.rerender(<Groups groups={undefined} />);
  expect(answers.every(answer => answer.length === 0)).toBe(true);
  queue.drain();
});


it("reuses filtered rows across unchanged renders during a pending removal", () => {
  const queue = taskQueue();
  const rows: (readonly unknown[])[] = [];
  function Groups(props: { groups: { id: string; name: string; kind: "channel" }[] }) {
    const index = useGoToIndex("workspace", { groups: props.groups }, context);
    rows.push(index.rows);
    return null;
  }
  const groups = Array.from({ length: 2_000 }, (_, n) => ({ id: String(n), name: "Channel " + n, kind: "channel" as const }));
  const view = render(<Groups groups={groups} />);
  queue.drain();
  const remaining = groups.slice(1);
  view.rerender(<Groups groups={remaining} />);
  const filtered = rows.at(-1);
  expect(filtered).toHaveLength(1_999);
  rows.length = 0;
  view.rerender(<Groups groups={remaining} />);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row === filtered)).toBe(true);
  queue.drain();
});

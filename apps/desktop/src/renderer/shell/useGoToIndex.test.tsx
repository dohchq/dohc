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
const answer = (path: string): ListWorkspaceFilesResult => ({ files: [{ path, kind: "file" }], folders: [] });
function Shell(props: { workspaceId: string; refresh: number }) {
  const { files, folders, refreshFiles } = useWorkspaceListing(props.workspaceId);
  useEffect(() => { void refreshFiles().catch(() => undefined); }, [refreshFiles, props.refresh]);
  const listing = useMemo(() => ({ files, folders, visibility: { status: "ready" as const, hiddenHostPaths: new Set<string>() }, receivedRoots: [] }), [files, folders]);
  const index = useGoToIndex(props.workspaceId, { listing }, context);
  return <><output data-testid="explorer">{files.map(file => file.path).join(",")}</output><output data-testid="names">{index.query("").map(row => row.path).join(",")}</output></>;
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
  expectListing("first.md");
  view.rerender(<Root workspaceId="A" refresh={2} />);
  await waitFor(() => expectListing("recovered.md"));
});

function taskQueue() {
  const tasks = new Map<number, () => void>();
  let id = 0;
  vi.stubGlobal("setTimeout", (callback: () => void) => { tasks.set(++id, callback); return id; });
  vi.stubGlobal("clearTimeout", (task: number) => tasks.delete(task));
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
  return { tasks, one, drain, frame };
}
const snapshot = (prefix: string, count = 20): GoToListing => ({
  files: Array.from({ length: count }, (_, i) => ({ path: prefix + i + ".md", kind: "file" })),
  folders: [], visibility: { status: "ready", hiddenHostPaths: new Set() }, receivedRoots: [],
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
  expect(listWorkspaceFiles).not.toHaveBeenCalled();
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
  const first = snapshot("a", 1);
  first.visibility.hiddenHostPaths = new Set(["private"]);
  const view = render(<Snapshot listing={first} />);
  queue.drain();
  expect(view.container.textContent).toBe("workspace:a0.md");
  const hidden = new Set(["private"]);
  const has = vi.spyOn(hidden, "has");
  view.rerender(<Snapshot listing={{ ...first, files: [...first.files, { path: "renamed.md", kind: "file" }], visibility: { ...first.visibility, hiddenHostPaths: hidden }, receivedRoots: [] }} />);
  queue.drain();
  expect(view.container.textContent).toContain("renamed.md");
  expect(has).toHaveBeenCalledTimes(1);
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
  view.rerender(<QuerySnapshot listing={{ ...first, visibility: { status: "ready", hiddenHostPaths: new Set(["private/budget.md"]) } }} />);
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

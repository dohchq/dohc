import type { VisibilityPolicyRule } from "@dohc/security-contract/visibility-policy";
// @vitest-environment jsdom
import { useEffect, useMemo } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceListing } from "./useWorkspaceListing";
import { useGoToIndex } from "./useGoToIndex";
import { GoToIndex } from "../workbench/quick-open-rank";
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
  await waitFor(() => expect(screen.getByTestId("names").textContent).toBe(""));
  expect(screen.getByTestId("explorer").textContent).toBe("first.md");
  view.rerender(<Root workspaceId="A" refresh={2} />);
  await waitFor(() => expectListing("recovered.md"));
});

it("waits for a complete paint before the first preparation and starts no extra source reads", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const update = vi.spyOn(GoToIndex.prototype, "prepareSlice");
  listWorkspaceFiles.mockResolvedValue(answer("painted.md"));
  const view = render(<Root workspaceId="A" />);
  await waitFor(() => expect(screen.getByTestId("explorer").textContent).toBe("painted.md"));
  expect(screen.getByTestId("names").textContent).toBe("");
  expect(update).not.toHaveBeenCalled();
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(performance.now())); };
  act(frame);
  expect(update).not.toHaveBeenCalled();
  act(frame);
  expect(update).not.toHaveBeenCalled();
  await waitFor(() => expectListing("painted.md"));
  expect(update).toHaveBeenCalledTimes(1);
  view.rerender(<Root workspaceId="A" />);
  expect(update).toHaveBeenCalledTimes(1);
  expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);
});

it("does not reapply existing file verdicts when hook inputs recreate unchanged metadata", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const files = [{ path: "a.md", kind: "file" as const }];
  const receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
  function Snapshot(props: { renamed: boolean; rules: VisibilityPolicyRule[] }) {
    const listing = useMemo(() => ({
      files: props.renamed ? [{ path: "renamed.md", kind: "file" as const }] : files,
      folders: [], visibility: { status: "ready" as const, rules: props.rules },
      receivedRoots: receivedRoots.map(root => ({ ...root })),
    }), [props.renamed, props.rules]);
    const index = useGoToIndex("workspace", { listing }, context);
    return <output>{index.query("").map(row => row.path).join(",")}</output>;
  }
  const view = render(<Snapshot renamed={false} rules={[{ path: "private", visibility: "hidden" }]} />);
  act(() => frames.shift()!(0));
  act(() => frames.shift()!(0));
  await waitFor(() => expect(view.container.textContent).toBe("a.md"));
  const freshRules: VisibilityPolicyRule[] = [{ path: "private", visibility: "hidden" }];
  view.rerender(<Snapshot renamed rules={freshRules} />);
  await waitFor(() => expect(view.container.textContent).toBe("renamed.md"));
});

 it("withholds a hidden host path from Go to while Explorer retains it", async () => {
  const update = vi.spyOn(GoToIndex.prototype, "prepareSlice");
  listWorkspaceFiles.mockResolvedValueOnce({ ...answer("private.md"), visibility: { status: "ready", rules: [{ path: "private.md", visibility: "hidden" }] } });
  render(<Root workspaceId="A" />);
  await waitFor(() => expect(screen.getByTestId("explorer").textContent).toBe("private.md"));
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(screen.getByTestId("names").textContent).toBe("");
});
 it.each(["degraded", "unavailable"])("withholds host names when visibility is %s", async status => {
  listWorkspaceFiles.mockResolvedValueOnce({ ...answer("private.md"), visibility: { status, rules: [] } });
  render(<Root workspaceId="A" />);
  await waitFor(() => expect(screen.getByTestId("explorer").textContent).toBe("private.md"));
  await waitFor(() => expect(screen.getByTestId("names").textContent).toBe(""));
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderAppAnswer } from "../../ipc/bridgeContract";
import { siteTabPath } from "../workbench/workbenchState";
import { useShellError } from "../shell/useShellError";
import { useFolderAppOffers } from "./useFolderAppOffers";

type Read = { workspaceId: string; folder: string };
let reads: Array<Read & { resolve(answer: FolderAppAnswer): void; reject(error: unknown): void }>;
let listeners: Set<(answer: FolderAppAnswer) => void>;

beforeEach(() => {
  reads = [];
  listeners = new Set();
  vi.stubGlobal("dohcDesktop", {
    getFolderApp: vi.fn((payload: Read) => new Promise<FolderAppAnswer>((resolve, reject) => {
      reads.push({ ...payload, resolve, reject });
    })),
    onFolderAppChanged: vi.fn((listener: (answer: FolderAppAnswer) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function app(workspaceId: string, folder: string): FolderAppAnswer {
  return { workspaceId, folder, isApp: true, run: { path: folder, entryPath: `${folder}/index.html`, previewMode: "static" } };
}

type Props = { workspaceId: string; enabled: boolean; expandedFolders: string[]; activePath: string | null };
function setup(initial: Partial<Props> = {}) {
  const onError = vi.fn();
  const hook = renderHook((props: Props) => useFolderAppOffers({ ...props, onError }), {
    initialProps: { workspaceId: "one", enabled: true, expandedFolders: [], activePath: null, ...initial },
  });
  return { ...hook, onError };
}

async function answer(index: number, value: FolderAppAnswer) {
  await act(async () => reads[index]!.resolve(value));
}

describe("folder app offers", () => {
  it("asks nothing for tree rows; only an expansion asks, once", async () => {
    const { result, rerender } = setup();
    expect(reads).toEqual([]);
    rerender({ workspaceId: "one", enabled: true, expandedFolders: ["site"], activePath: null });
    expect(reads.map((read) => read.folder)).toEqual(["site"]);
    await answer(0, app("one", "site"));
    expect(result.current.get("site")?.run?.entryPath).toBe("site/index.html");
    // Rendering again with the same expansion asks nothing more.
    rerender({ workspaceId: "one", enabled: true, expandedFolders: ["site"], activePath: null });
    expect(reads).toHaveLength(1);
  });

  it("asks again when a folder is expanded again", () => {
    const { rerender } = setup({ expandedFolders: ["site"] });
    rerender({ workspaceId: "one", enabled: true, expandedFolders: [], activePath: null });
    rerender({ workspaceId: "one", enabled: true, expandedFolders: ["site"], activePath: null });
    expect(reads.map((read) => read.folder)).toEqual(["site", "site"]);
  });

  it("asks for the active file's folder on each navigation, never the root or a virtual tab", () => {
    const { rerender } = setup({ activePath: "site/index.html" });
    rerender({ workspaceId: "one", enabled: true, expandedFolders: [], activePath: "site/about.html" });
    rerender({ workspaceId: "one", enabled: true, expandedFolders: [], activePath: "readme.md" });
    rerender({ workspaceId: "one", enabled: true, expandedFolders: [], activePath: siteTabPath("site") });
    expect(reads.map((read) => read.folder)).toEqual(["site", "site"]);
  });

  it("asks nothing while disabled", () => {
    setup({ enabled: false, expandedFolders: ["site"], activePath: "site/index.html" });
    expect(reads).toEqual([]);
  });

  it("asks every expanded folder again when the window regains focus, past main's 128", () => {
    const folders = Array.from({ length: 129 }, (_, index) => `folder-${index}`);
    setup({ expandedFolders: folders, activePath: "site/index.html" });
    expect(reads).toHaveLength(130);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(reads).toHaveLength(260);
    // The oldest, which main stopped refreshing, is among them.
    expect(reads.slice(130).map((read) => read.folder)).toContain("folder-0");
    expect(reads.slice(130).map((read) => read.folder)).toContain("site");
  });

  it("drops an answer for A that lands after A -> B -> A", async () => {
    const { result, rerender } = setup({ expandedFolders: ["site"] });
    rerender({ workspaceId: "two", enabled: true, expandedFolders: ["site"], activePath: null });
    rerender({ workspaceId: "one", enabled: true, expandedFolders: ["site"], activePath: null });
    expect(reads.map((read) => read.workspaceId)).toEqual(["one", "two", "one"]);
    await answer(0, app("one", "site"));
    await answer(1, app("two", "site"));
    expect(result.current.size).toBe(0);
    await answer(2, app("one", "site"));
    expect([...result.current.keys()]).toEqual(["site"]);
  });

  it("follows main's changes for asked folders only", async () => {
    const { result } = setup({ expandedFolders: ["site"] });
    await answer(0, { workspaceId: "one", folder: "site", isApp: false, run: null });
    expect(result.current.size).toBe(0);
    act(() => { for (const listener of listeners) listener(app("one", "other")); });
    expect(result.current.size).toBe(0);
    act(() => { for (const listener of listeners) listener(app("one", "site")); });
    expect([...result.current.keys()]).toEqual(["site"]);
    act(() => { for (const listener of listeners) listener({ workspaceId: "one", folder: "site", isApp: false, run: null }); });
    expect(result.current.size).toBe(0);
  });

  // Every failure reports, so a dismissed Notices row comes back. Only the
  // first, a Try again, or the first after a read raises a toast.
  it("reports every failure of a folder, quietly after the first, until it reads or Try again", async () => {
    const { onError } = setup({ expandedFolders: ["site"] });
    const quiet = () => onError.mock.calls.map((call) => call[3]);
    await act(async () => reads[0]!.reject(new Error("listing failed")));
    expect(quiet()).toEqual([false]);

    // Refocus asks again, and the same failure reports quietly.
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => reads[1]!.reject(new Error("listing failed")));
    expect(quiet()).toEqual([false, true]);

    // Try again is the person's own request, so its failure toasts.
    act(() => onError.mock.calls[0]![2]());
    await act(async () => reads[2]!.reject(new Error("listing failed")));
    expect(quiet()).toEqual([false, true, false]);

    // After a read succeeds, a new failure is news.
    act(() => { window.dispatchEvent(new Event("focus")); });
    await answer(3, { workspaceId: "one", folder: "site", isApp: false, run: null });
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => reads[4]!.reject(new Error("listing failed")));
    expect(quiet()).toEqual([false, true, false, false]);
  });

  // As the shell wires it: a toast is a row not yet seen.
  it("brings back a dismissed Notices row on the next failure, without a second toast", async () => {
    const { result } = renderHook(() => {
      const shell = useShellError("one");
      useFolderAppOffers({
        workspaceId: "one", enabled: true, expandedFolders: ["site"], activePath: null,
        onError: (folder, error, retry, quiet) => shell.reportShellFailure({
          message: `dohc could not read the folder ${folder}.`, cause: error, retry, identity: `folder-app:${folder}`, quiet,
        }),
      });
      return shell;
    });
    await act(async () => reads[0]!.reject(new Error("listing failed")));
    expect(result.current.shellErrors.map((row) => row.seen)).toEqual([false]);

    act(() => result.current.dismissShellError(result.current.shellErrors[0]!.id));
    expect(result.current.shellErrors).toEqual([]);

    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => reads[1]!.reject(new Error("listing failed")));
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]).toMatchObject({ identity: "folder-app:site", seen: true });
    expect(result.current.shellErrors[0]!.retry).toBeTypeOf("function");
  });

  it("reports a failed read with a retry that asks again", async () => {
    const { onError } = setup({ expandedFolders: ["site"] });
    const failure = new Error("listing failed");
    await act(async () => reads[0]!.reject(failure));
    expect(onError).toHaveBeenCalledWith("site", failure, expect.any(Function), false);
    act(() => onError.mock.calls[0]![2]());
    expect(reads.map((read) => read.folder)).toEqual(["site", "site"]);
  });
});

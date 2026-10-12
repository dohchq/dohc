// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderAppAnswer } from "../../ipc/bridgeContract";
import { siteTabPath } from "../workbench/workbenchState";
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

  it("reports a folder that keeps failing once, until it reads or Try again fails again", async () => {
    const { onError } = setup({ expandedFolders: ["site"] });
    await act(async () => reads[0]!.reject(new Error("listing failed")));
    expect(onError).toHaveBeenCalledOnce();

    // Refocus asks again, and the same failure stays quiet.
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => reads[1]!.reject(new Error("listing failed")));
    expect(onError).toHaveBeenCalledOnce();

    // Try again is the person's own request, so its failure says so.
    act(() => onError.mock.calls[0]![2]());
    await act(async () => reads[2]!.reject(new Error("listing failed")));
    expect(onError).toHaveBeenCalledTimes(2);

    // After a read succeeds, a new failure is news.
    act(() => { window.dispatchEvent(new Event("focus")); });
    await answer(3, { workspaceId: "one", folder: "site", isApp: false, run: null });
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => reads[4]!.reject(new Error("listing failed")));
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("reports a failed read with a retry that asks again", async () => {
    const { onError } = setup({ expandedFolders: ["site"] });
    const failure = new Error("listing failed");
    await act(async () => reads[0]!.reject(failure));
    expect(onError).toHaveBeenCalledWith("site", failure, expect.any(Function));
    act(() => onError.mock.calls[0]![2]());
    expect(reads.map((read) => read.folder)).toEqual(["site", "site"]);
  });
});

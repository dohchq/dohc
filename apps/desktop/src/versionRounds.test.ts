import { afterEach, describe, expect, it, vi } from "vitest";
import type { VersionRoundMessage } from "./ipc/bridgeContract";
import { createVersionRounds } from "./versionRounds";

type Window = { id: number; gone?: boolean; heard: VersionRoundMessage[] };

function rounds(windows: Window[], timeoutMs?: number) {
  return createVersionRounds<Window>({
    windowsShowing: () => windows,
    windowId: window => window.id,
    isGone: window => window.gone === true,
    send: (window, message) => window.heard.push(message),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const window = (id: number): Window => ({ id, heard: [] });

// Lets the round's promise chain reach the change.
const settled = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => { vi.useRealTimers(); });

describe("version rounds", () => {
  it("runs the change only after every window showing the workspace is ready, then tells them where it left them", async () => {
    const [a, b] = [window(1), window(2)];
    const { run, answer } = rounds([a, b]);
    const change = vi.fn(async () => ({ activeVersionId: "draft" }));
    const result = run("workspace", change, { done: switched => ({ activeVersionId: switched.activeVersionId }) });
    expect(a.heard).toEqual([{ kind: "begin", roundId: 1, workspaceId: "workspace" }]);
    answer(1, 1, { ready: true });
    await settled();
    expect(change).not.toHaveBeenCalled();
    answer(2, 1, { ready: true });
    await expect(result).resolves.toEqual({ activeVersionId: "draft" });
    expect(change).toHaveBeenCalledOnce();
    for (const each of [a, b]) expect(each.heard.at(-1)).toEqual({ kind: "end", roundId: 1, changed: true, activeVersionId: "draft" });
  });

  it("changes nothing when a window refuses, and every window hears the round end unchanged", async () => {
    const [a, b] = [window(1), window(2)];
    const { run, answer } = rounds([a, b]);
    const change = vi.fn(async () => undefined);
    const result = run("workspace", change, { done: () => ({}) });
    answer(1, 1, { ready: true });
    answer(2, 1, { ready: false, reason: "A Collection write failed." });
    await expect(result).rejects.toThrow("A Collection write failed.");
    expect(change).not.toHaveBeenCalled();
    for (const each of [a, b]) expect(each.heard.at(-1)).toEqual({ kind: "end", roundId: 1, changed: false });
  });

  it("refuses when a window stays silent, and ignores its late answer", async () => {
    vi.useFakeTimers();
    const a = window(1);
    const { run, answer } = rounds([a], 50);
    const change = vi.fn(async () => undefined);
    const result = run("workspace", change, { done: () => ({}) });
    const refused = expect(result).rejects.toThrow("didn't save its open edits in time");
    await vi.advanceTimersByTimeAsync(50);
    await refused;
    answer(1, 1, { ready: true });
    expect(change).not.toHaveBeenCalled();
    expect(a.heard.at(-1)).toEqual({ kind: "end", roundId: 1, changed: false });
  });

  it("counts a closed window as ready, and an answer from outside the round for nothing", async () => {
    const [a, gone] = [window(1), { ...window(2), gone: true }];
    const { run, answer } = rounds([a, gone]);
    const change = vi.fn(async () => undefined);
    const result = run("workspace", change, { done: () => ({}) });
    answer(3, 1, { ready: false, reason: "Not in this round." });
    answer(1, 1, { ready: true });
    await expect(result).resolves.toBeUndefined();
    expect(change).toHaveBeenCalledOnce();
    expect(gone.heard).toEqual([{ kind: "begin", roundId: 1, workspaceId: "workspace" }]);
  });

  it("runs at once when no window shows the workspace", async () => {
    const { run } = rounds([]);
    await expect(run("workspace", async () => 7, { done: () => ({}) })).resolves.toBe(7);
  });

  it("tells the windows what a failed change may have left, and rethrows its error", async () => {
    const [a, b] = [window(1), window(2)];
    const { run, answer } = rounds([a, b]);
    const failing = (failed?: { activeVersionId?: string }) => run("workspace", async () => { throw new Error("Engine refused."); },
      { done: () => ({}), ...(failed ? { failed } : {}) });
    const switching = failing({});
    answer(1, 1, { ready: true }); answer(2, 1, { ready: true });
    await expect(switching).rejects.toThrow("Engine refused.");
    expect(a.heard.at(-1)).toEqual({ kind: "end", roundId: 1, changed: true });
    const merging = failing();
    answer(1, 2, { ready: true }); answer(2, 2, { ready: true });
    await expect(merging).rejects.toThrow("Engine refused.");
    expect(b.heard.at(-1)).toEqual({ kind: "end", roundId: 2, changed: false });
  });
});

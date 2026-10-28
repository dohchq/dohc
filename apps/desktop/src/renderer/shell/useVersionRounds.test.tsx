// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VersionRoundAnswerPayload, VersionRoundMessage } from "../../ipc/bridgeContract";
import { useVersionRounds } from "./useVersionRounds";

const listeners = new Set<(message: VersionRoundMessage) => void>();
const bridge = {
  onVersionRound: vi.fn((listener: (message: VersionRoundMessage) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }),
  answerVersionRound: vi.fn(async (_payload: VersionRoundAnswerPayload) => undefined),
};
const hear = (message: VersionRoundMessage) => act(() => { for (const listener of listeners) listener(message); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  listeners.clear();
  bridge.answerVersionRound.mockClear();
  window.dohcDesktop = bridge as unknown as typeof window.dohcDesktop;
});
afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

it("saves the open edits before answering ready, and moves to the version the change left active", async () => {
  const release = vi.fn();
  const saving = deferred<() => void>();
  const begin = vi.fn(() => saving.promise);
  const changed = vi.fn();
  renderHook(() => useVersionRounds("workspace", begin, changed));
  hear({ kind: "begin", roundId: 1, workspaceId: "workspace" });
  expect(begin).toHaveBeenCalledOnce();
  expect(bridge.answerVersionRound).not.toHaveBeenCalled();
  await act(async () => { saving.resolve(release); });
  expect(bridge.answerVersionRound).toHaveBeenCalledWith({ roundId: 1, ready: true });
  expect(release).not.toHaveBeenCalled();
  hear({ kind: "end", roundId: 1, changed: true, activeVersionId: "draft" });
  expect(changed).toHaveBeenCalledWith("draft");
  expect(release).toHaveBeenCalledOnce();
});

it("refuses with the reason its edits could not be saved", async () => {
  const begin = vi.fn(async (): Promise<() => void> => { throw new Error("A Collection write failed. Try again."); });
  renderHook(() => useVersionRounds("workspace", begin, vi.fn()));
  hear({ kind: "begin", roundId: 2, workspaceId: "workspace" });
  await waitFor(() => expect(bridge.answerVersionRound).toHaveBeenCalledWith({ roundId: 2, ready: false, reason: "A Collection write failed. Try again." }));
});

it("answers ready for another workspace without saving, and lets go when main gives up first", async () => {
  const release = vi.fn();
  const saving = deferred<() => void>();
  const begin = vi.fn(() => saving.promise);
  const changed = vi.fn();
  renderHook(() => useVersionRounds("workspace", begin, changed));
  hear({ kind: "begin", roundId: 3, workspaceId: "other" });
  expect(begin).not.toHaveBeenCalled();
  expect(bridge.answerVersionRound).toHaveBeenCalledWith({ roundId: 3, ready: true });
  hear({ kind: "begin", roundId: 4, workspaceId: "workspace" });
  hear({ kind: "end", roundId: 4, changed: false });
  await act(async () => { saving.resolve(release); });
  expect(release).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(bridge.answerVersionRound).not.toHaveBeenCalledWith({ roundId: 4, ready: true });
});

it("lets go of a held round when the window leaves the workspace", async () => {
  const release = vi.fn();
  const view = renderHook(({ id }) => useVersionRounds(id, async () => release, vi.fn()), { initialProps: { id: "workspace" } });
  hear({ kind: "begin", roundId: 5, workspaceId: "workspace" });
  await waitFor(() => expect(bridge.answerVersionRound).toHaveBeenCalledWith({ roundId: 5, ready: true }));
  view.rerender({ id: "other" });
  expect(release).toHaveBeenCalledOnce();
});

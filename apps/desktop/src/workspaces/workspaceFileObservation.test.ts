import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWorkspaceFiles, startWorkspaceFileObservation, type WorkspaceObservationCallbacks } from "./workspaceFileObservation";
import { EngineWorkspaceSessions, type EngineDaemonLifecycle, type FileObservationChanges } from "@dohc/workspace-engine-client/daemon";
import type { Event, JsonValue, Request } from "@dohc/workspace-engine-client";
import { deferred } from "../testing/deferred";
import { closeActivityFirst } from "./workspaceActivity";
import { createSuiteTestScratchSync } from "./testTemp";

const answer = (revision: number, extra: Partial<FileObservationChanges> = {}): FileObservationChanges => ({
  cursor: { generation: "first", revision }, ready: true, resync: false, facts: [], ...extra,
});
function fixture(read: Parameters<typeof observeWorkspaceFiles>[0]["read"]) {
  let wake = () => {};
  let capture = () => {};
  const callbacks: WorkspaceObservationCallbacks = { facts: vi.fn(), resync: vi.fn(async () => {}), captured: vi.fn(), pulled: vi.fn(), degraded: vi.fn() };
  const onError = vi.fn();
  const handle = observeWorkspaceFiles({ read, callbacks, onError,
    subscribe(w, c) { wake = w; capture = c; return vi.fn(); } });
  return { handle, callbacks, onError, wake: () => wake(), capture: () => capture() };
}
afterEach(() => vi.useRealTimers());

describe("workspace file observation", () => {
  it("retries failed reads with backoff and stops retrying after success", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(answer(1)).mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"))
      .mockResolvedValue(answer(9, { resync: true, facts: [{ path: "fresh.md", kind: "appeared" }] }));
    const f = fixture(read);
    await f.handle.ready;
    f.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.callbacks.degraded).not.toHaveBeenCalledWith("read-failed");
    expect(read).toHaveBeenCalledTimes(2);
    f.wake();
    await vi.advanceTimersByTimeAsync(249);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.callbacks.resync).toHaveBeenCalledOnce();
    expect(f.callbacks.facts).toHaveBeenCalledWith([{ path: "fresh.md", kind: "appeared" }]);
    expect(read.mock.calls[1]?.[0]).toEqual({ generation: "first", revision: 1 });
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(4);
    await f.handle.stop();
  });

  it("resolves startup when a read fails and cancels its retry on stop", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("file-observation-unavailable")).mockResolvedValue(answer(1));
    const f = fixture(read);
    await vi.advanceTimersByTimeAsync(0);
    await f.handle.ready;
    expect(f.callbacks.degraded).not.toHaveBeenCalledWith("read-failed");
    await f.handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("resolves readiness for a known degraded feed", async () => {
    const f = fixture(vi.fn().mockResolvedValue({ ...answer(0), ready: false, degraded: true }));
    await f.handle.ready;
    expect(f.callbacks.degraded).toHaveBeenCalledWith("unavailable");
    await f.handle.stop();
  });

  it("resolves readiness on stop before a pending initial read finishes", async () => {
    const pending = deferred<FileObservationChanges>();
    const f = fixture(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(answer(1)));
    const stopped = f.handle.stop();
    await f.handle.ready;
    pending.resolve(answer(0, { ready: false }));
    await stopped;
  });

  it("fans a large revision out once", async () => {
    const facts = Array.from({ length: 2000 }, (_, n) => ({ path: `${n}.md`, kind: "changed" as const }));
    const f = fixture(vi.fn().mockResolvedValueOnce(answer(1, { facts })).mockResolvedValue(answer(1)));
    await f.handle.ready;
    expect(f.callbacks.facts).toHaveBeenCalledExactlyOnceWith(facts);
    await f.handle.stop();
  });

  it("retains a wake received during a read and keeps capture independent", async () => {
    const pending = deferred<FileObservationChanges>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(answer(2));
    const f = fixture(read);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    f.capture(); f.wake();
    expect(f.callbacks.captured).toHaveBeenCalledOnce();
    pending.resolve(answer(1));
    await f.handle.ready;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await f.handle.stop();
  });

  it("routes pulled paths without draining and deduplicates already observed paths", async () => {
    const read = vi.fn().mockResolvedValueOnce(answer(1)).mockResolvedValueOnce(answer(2, {
      facts: [{ path: "a.md", kind: "changed" }],
    })).mockResolvedValue(answer(3));
    const f = fixture(read);
    await f.handle.ready;
    f.handle.pullStarting();
    f.wake();
    await vi.waitFor(() => expect(f.callbacks.facts).toHaveBeenCalledWith([{ path: "a.md", kind: "changed" }]));
    await f.handle.pulledPaths(["a.md", "b.md"]);
    expect(f.callbacks.pulled).toHaveBeenCalledExactlyOnceWith(["b.md"]);
    expect(read).toHaveBeenCalledTimes(2);
    f.handle.pullFinished();
    f.handle.pullStarting();
    read.mockResolvedValueOnce(answer(4, { facts: [{ path: "c.md", kind: "appeared" }] }));
    await f.handle.pulledPaths(["c.md"]);
    expect(f.callbacks.pulled).toHaveBeenLastCalledWith(["c.md"]);
    f.wake();
    await vi.waitFor(() => expect(f.callbacks.facts).toHaveBeenCalledWith([{ path: "c.md", kind: "appeared" }]));
    f.handle.pullFinished();
    await f.handle.stop();
  });

  it("routes every pulled path while observation is degraded", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn().mockRejectedValue(new Error("decode failed")));
    await vi.advanceTimersByTimeAsync(0);
    await f.handle.pulledPaths(["a.md", "b.md"]);
    expect(f.callbacks.pulled).toHaveBeenCalledExactlyOnceWith(["a.md", "b.md"]);
    await expect(f.handle.stop()).rejects.toThrow("decode failed");
  });

  it("does not make a pulled page wait for an in-flight observation read", async () => {
    const pending = deferred<FileObservationChanges>();
    const f = fixture(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(answer(1)));
    await f.handle.pulledPaths(["pulled.md"]);
    expect(f.callbacks.pulled).toHaveBeenCalledExactlyOnceWith(["pulled.md"]);
    pending.resolve(answer(1));
    await f.handle.stop();
  });

  it("reports a failed drain and never advances its cursor on that failure", async () => {
    const read = vi.fn().mockResolvedValueOnce(answer(1)).mockRejectedValue(new Error("drain unavailable"));
    const f = fixture(read);
    await f.handle.ready;
    await expect(f.handle.stop()).rejects.toThrow("drain unavailable");
    expect(read.mock.calls[1]).toEqual([{ generation: "first", revision: 1 }, true]);
    expect(f.onError).toHaveBeenCalledOnce();
  });

  it("reports only persistent read failures and lets Try again bypass the backoff", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("read failed"));
    const f = fixture(read);
    await vi.advanceTimersByTimeAsync(0);
    await f.handle.ready;
    await vi.advanceTimersByTimeAsync(7_749);
    expect(f.callbacks.degraded).not.toHaveBeenCalledWith("read-failed");
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(6);
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith("read-failed");
    const retry = f.handle.retry();
    await expect(retry).rejects.toThrow("read failed");
    expect(read).toHaveBeenCalledTimes(7);
    read.mockResolvedValue(answer(1));
    await f.handle.retry();
    expect(read).toHaveBeenCalledTimes(8);
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(8);
    await f.handle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a flapping read quiet when each retry recovers", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(answer(1));
    const f = fixture(read);
    await f.handle.ready;
    for (let n = 0; n < 4; n++) {
      read.mockRejectedValueOnce(new Error("transient failure"));
      f.wake();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(f.callbacks.degraded).not.toHaveBeenCalledWith("read-failed");
    await f.handle.stop();
  });

  it("clears a failed read after restart while scanning, including Try again", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(answer(1)).mockRejectedValue(new Error("daemon stopped"));
    const f = fixture(read);
    await f.handle.ready;
    f.wake();
    await vi.advanceTimersByTimeAsync(7_750);
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith("read-failed");
    read.mockResolvedValue({ ...answer(0, { cursor: { generation: "restarted", revision: 0 }, ready: false, resync: true }), degraded: false });
    await f.handle.retry();
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith(null);
    expect(f.callbacks.resync).toHaveBeenCalledOnce();
    await f.handle.retry();
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith(null);
    expect(read).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(9);
    await f.handle.stop();
  });

  it("reports watcher degradation even when a successful read is ready", async () => {
    const f = fixture(vi.fn().mockResolvedValue({ ...answer(1), degraded: true }));
    await f.handle.ready;
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith("unavailable");
    await f.handle.stop();
  });

  it("logs a drain timeout once even when the drain later rejects", async () => {
    vi.useFakeTimers();
    const pending = deferred<FileObservationChanges>();
    const f = fixture(vi.fn().mockResolvedValueOnce(answer(1)).mockReturnValueOnce(pending.promise));
    await f.handle.ready;
    const result = expect(f.handle.stop()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    pending.reject(new Error("late drain failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onError).toHaveBeenCalledOnce();
  });

  it.each(["read", "drain"])("bounds stop while a %s never answers and ignores its late facts", async blocked => {
    vi.useFakeTimers();
    const pending = deferred<FileObservationChanges>();
    const read = vi.fn().mockResolvedValue(answer(3));
    if (blocked === "read") read.mockReturnValueOnce(pending.promise);
    else read.mockResolvedValueOnce(answer(1)).mockReturnValueOnce(pending.promise);
    const f = fixture(read);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = f.handle.stop();
    expect(f.handle.stop()).toBe(stopped);
    const result = vi.fn();
    void stopped.then(() => result("resolved"), error => result(error.message));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toHaveBeenCalledExactlyOnceWith("File observation drain timed out after 5000ms");
    pending.resolve(answer(2, { facts: [{ path: "late.md", kind: "changed" }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.callbacks.facts).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(blocked === "read" ? 1 : 2);
    expect(f.onError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("subscribes to workspace events, forwards truncated capture broadly, and unsubscribes", async () => {
    const eventHandlers = new Set<(event: Event) => void>();
    const clientHandlers = new Set<() => void>();
    const daemon: Pick<EngineDaemonLifecycle, "onEvent" | "onClientChanged"> = {
      onEvent(handler) { eventHandlers.add(handler); return () => { eventHandlers.delete(handler); }; },
      onClientChanged(handler) { clientHandlers.add(handler); return () => { clientHandlers.delete(handler); }; },
    };
    const emit = (name: string, payload: Event["payload"]) => {
      for (const handler of eventHandlers) handler({ seq: 1, sessionGeneration: 1, name, payload });
    };
    const sendRequest = vi.fn(async (request: { id: number }) => ({ id: request.id, result: answer(1) }));
    const sessions = {
      run: async (_workspace: unknown, run: (binding: unknown) => Promise<unknown>) => run({ client: { sendRequest }, workspace: "binding" }),
      assertCurrentBinding: vi.fn(),
    } as unknown as EngineWorkspaceSessions;
    const callbacks: WorkspaceObservationCallbacks = {
      facts: vi.fn(), resync: vi.fn(async () => {}), captured: vi.fn(), pulled: vi.fn(), degraded: vi.fn(),
    };
    const handle = startWorkspaceFileObservation({ workspaceId: "a", rootPath: "/a", attachmentId: Symbol(),
      kind: "personal", mode: "local-first" }, sessions, daemon, callbacks);
    await handle.ready;
    emit("capture.momentRecorded", { workspaceId: "a", paths: ["note.md"], appliedCount: 1, notOwnedCount: 0 });
    expect(callbacks.captured).toHaveBeenCalledExactlyOnceWith(["note.md"]);
    emit("capture.momentRecorded", { workspaceId: "b", paths: ["other.md"], appliedCount: 1, notOwnedCount: 0 });
    expect(callbacks.captured).toHaveBeenCalledOnce();
    emit("capture.momentRecorded", { workspaceId: "a", paths: ["note.md"], appliedCount: 2, notOwnedCount: 0 });
    expect(callbacks.captured).toHaveBeenLastCalledWith(undefined);
    emit("workspace.filesChanged", { workspaceId: "b", cursor: answer(1).cursor });
    expect(sendRequest).toHaveBeenCalledOnce();
    emit("workspace.filesChanged", { workspaceId: "a", cursor: answer(1).cursor });
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2));
    for (const handler of clientHandlers) handler();
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(3));
    await handle.stop();
    expect(eventHandlers.size).toBe(0);
    expect(clientHandlers.size).toBe(0);
  });

  it("drains the file feed through the engine session before the stores close it", async () => {
    const workspace = { workspaceId: "forget", rootPath: createSuiteTestScratchSync("dohc-file-feed-"),
      attachmentId: Symbol(), kind: "personal" as const, mode: "local-first" as const };
    const methods: string[] = [];
    const client = {
      close: () => undefined,
      async sendRequest(request: Request) {
        methods.push(request.method);
        const result: JsonValue = request.method === "workspace.open" ? { workspace: `handle-${methods.length}` }
          : request.method === "workspace.close" ? { closed: true }
            : { cursor: { generation: "first", revision: 1 }, ready: true, resync: false, facts: [] };
        return { id: request.id, result };
      },
    };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    const daemon = { onEvent: () => () => {}, onClientChanged: () => () => {} };
    const handle = startWorkspaceFileObservation(workspace, sessions, daemon, {
      facts: vi.fn(), resync: vi.fn(async () => {}), captured: vi.fn(), pulled: vi.fn(), degraded: vi.fn(),
    });
    await handle.ready;
    // The linked chat store and the agent dispatch store each close the session.
    await closeActivityFirst(() => handle.stop(),
      () => [sessions.closeWorkspace(workspace), sessions.closeWorkspace(workspace)]);
    expect(methods).toEqual(["workspace.open", "files.changesSince", "files.drain", "workspace.close"]);
    await sessions.closeAll();
  });
});

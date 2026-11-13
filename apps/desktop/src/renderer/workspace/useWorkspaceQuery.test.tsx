// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { Activity, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { useWorkspaceQuery, type WorkspaceQuery } from "./useWorkspaceQuery";
import { useWorkspaceSession, WorkspaceSessionProvider, type WorkspaceSession } from "./workspaceSession";

const wrapper = ({ children }: { children?: ReactNode }) => <WorkspaceSessionProvider workspaceId="w">{children}</WorkspaceSessionProvider>;

describe("useWorkspaceQuery", () => {
  it("reads when it starts, and a new key drops the old key's late answer and failure", async () => {
    const answers = { a: deferred<string>(), b: deferred<string>() };
    const signals: AbortSignal[] = [];
    const report = vi.fn();
    const hook = renderHook(({ key }) => useWorkspaceQuery(useWorkspaceSession(), {
      key,
      report,
      load: (signal) => { signals.push(signal); return answers[key].promise; },
    }), { wrapper, initialProps: { key: "a" as "a" | "b" } });
    expect(hook.result.current.pending).toBe(true);
    hook.rerender({ key: "b" });
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => { answers.b.resolve("b"); });
    await act(async () => { answers.a.reject(Error("late")); });
    expect(hook.result.current).toMatchObject({ value: "b", pending: false, error: null });
    expect(report).not.toHaveBeenCalled();
  });

  it("drops an answer from an earlier visit to the same workspace", async () => {
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce("B").mockResolvedValue("second visit");
    const sessions = new Set<WorkspaceSession>();
    let mounts = 0, files!: WorkspaceQuery<string, never>;
    function Files() {
      useState(() => { mounts += 1; });
      const session = useWorkspaceSession();
      sessions.add(session);
      files = useWorkspaceQuery(session, { key: "files", load: read });
      return null;
    }
    const visit = (workspaceId: string) => <WorkspaceSessionProvider workspaceId={workspaceId}><Files /></WorkspaceSessionProvider>;
    // A to B to A, without unmounting the reader.
    const view = render(visit("A"));
    view.rerender(visit("B"));
    view.rerender(visit("A"));
    await act(async () => { first.resolve("first visit"); });
    expect(files).toMatchObject({ value: "second visit", pending: false });
    expect(read).toHaveBeenCalledTimes(3);
    expect(mounts).toBe(1);
    expect(sessions.size).toBe(3);
  });

  // React retires and starts the owner again when it hides and shows its
  // subtree: here with Activity, and also when a Suspense boundary suspends again.
  async function hideAndShowWhileReading(manual: boolean) {
    const first = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("after show");
    let files!: WorkspaceQuery<string, never>;
    function Files() {
      files = useWorkspaceQuery(useWorkspaceSession(), { key: "files", manual, load });
      return null;
    }
    const shown = (mode: "visible" | "hidden") => <WorkspaceSessionProvider workspaceId="w"><Activity mode={mode}><Files /></Activity></WorkspaceSessionProvider>;
    const view = render(shown("visible"));
    if (manual) act(() => { void files.retry(); });
    expect(files.pending).toBe(true);
    view.rerender(shown("hidden"));
    view.rerender(shown("visible"));
    await act(async () => { first.resolve("before hide"); });
    return { files, load };
  }
  it("a manual query stops pending when shown again during a read", async () => {
    const { files, load } = await hideAndShowWhileReading(true);
    expect(files).toMatchObject({ value: undefined, pending: false, error: null });
    expect(load).toHaveBeenCalledOnce();
  });
  it("a query that reads on start reads again when shown again during a read", async () => {
    const { files, load } = await hideAndShowWhileReading(false);
    expect(files).toMatchObject({ value: "after show", pending: false, error: null });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps only the newest read, and retry waits for its own read", async () => {
    const older = deferred<string>(), newer = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const hook = renderHook(() => useWorkspaceQuery(useWorkspaceSession(), { key: "k", manual: true, load }), { wrapper });
    expect(load).not.toHaveBeenCalled();
    let first!: Promise<void>;
    act(() => { first = hook.result.current.retry(); });
    act(() => { void hook.result.current.retry(); });
    await act(async () => { older.resolve("older"); await first; });
    expect(hook.result.current).toMatchObject({ value: undefined, pending: true });
    await act(async () => { newer.resolve("newer"); });
    expect(hook.result.current).toMatchObject({ value: "newer", pending: false });
  });

  it("needs the shell's session", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useWorkspaceSession())).toThrow(/WorkspaceSessionProvider/);
    vi.mocked(console.error).mockRestore();
  });
});

// Each case below rebuilds one read race from the history. The "before" hook
// is a reduced copy of the code the fix replaced, and runs the same scenario
// as the query. The "before" case asserts the wrong value the old logic shows.

describe("#894 (c15dce8c7): the first backlinks read landed over the focus read", () => {
  // Before: the first read and each focus read had separate effects, each
  // with its own live flag, so both answers were live for the same note.
  function useBacklinksBefore(path: string, read: (path: string) => Promise<string>) {
    const [loaded, setLoaded] = useState<string>();
    const [focusNonce, setFocusNonce] = useState(0);
    useEffect(() => {
      let active = true;
      read(path).then((answer) => { if (active) setLoaded(answer); }, () => undefined);
      return () => { active = false; };
    }, [path, read]);
    useEffect(() => {
      const onFocus = () => setFocusNonce((nonce) => nonce + 1);
      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    }, []);
    useEffect(() => {
      if (focusNonce === 0) return;
      let active = true;
      read(path).then((answer) => { if (active) setLoaded(answer); }, () => undefined);
      return () => { active = false; };
    }, [focusNonce, path, read]);
    return loaded;
  }
  function useBacklinksOnQuery(path: string, read: (path: string) => Promise<string>) {
    const query = useWorkspaceQuery(useWorkspaceSession(), { key: path, load: () => read(path) });
    const { retry } = query;
    useEffect(() => {
      const onFocus = () => void retry();
      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    }, [retry]);
    return query.value;
  }
  async function firstReadLandsLast(useBacklinks: typeof useBacklinksBefore) {
    const first = deferred<string>(), focus = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(focus.promise);
    const hook = renderHook(() => useBacklinks("note.md", read), { wrapper });
    try {
      act(() => { window.dispatchEvent(new Event("focus")); });
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => { focus.resolve("after the edit"); });
      await act(async () => { first.resolve("before the edit"); });
      return hook.result.current;
    } finally {
      // Its focus listener must not reach the next case.
      hook.unmount();
    }
  }
  it("before: the older first read repaints over the focus read", async () => {
    expect(await firstReadLandsLast(useBacklinksBefore)).toBe("before the edit");
  });
  it("query: one owner orders both reads", async () => {
    expect(await firstReadLandsLast(useBacklinksOnQuery)).toBe("after the edit");
  });
});

describe("#698 (ca868c25a): an unclaimed status write turned a run off", () => {
  type AgentLane = { active: boolean; refresh: (branch: "engine" | "opted-out") => Promise<void> };
  // Before: the engine branch claimed the lane with an issue token, and the
  // opted-out branch wrote the same lane without one.
  function useAgentLaneBefore(read: () => Promise<boolean>): AgentLane {
    const [active, setActive] = useState(false);
    const issued = useRef(0);
    const committed = useRef(0);
    const refresh = useCallback(async (branch: "engine" | "opted-out") => {
      if (branch === "opted-out") {
        setActive(await read());
        return;
      }
      const token = ++issued.current;
      const answer = await read();
      if (token <= committed.current) return;
      committed.current = token;
      setActive(answer);
    }, [read]);
    return { active, refresh };
  }
  function useAgentLaneOnQuery(read: () => Promise<boolean>): AgentLane {
    const query = useWorkspaceQuery(useWorkspaceSession(), { key: "agent-run", manual: true, load: () => read() });
    return { active: query.value ?? false, refresh: () => query.retry() };
  }
  async function olderRefreshLandsAfterRunStarted(useAgentLane: (read: () => Promise<boolean>) => AgentLane) {
    const before = deferred<boolean>(), after = deferred<boolean>();
    const read = vi.fn().mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    const hook = renderHook(() => useAgentLane(read), { wrapper });
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = hook.result.current.refresh("opted-out"); second = hook.result.current.refresh("engine"); });
    await act(async () => { after.resolve(true); await second; });
    await act(async () => { before.resolve(false); await first; });
    return hook.result.current.active;
  }
  it("before: the opted-out answer lands last and wins", async () => {
    expect(await olderRefreshLandsAfterRunStarted(useAgentLaneBefore)).toBe(false);
  });
  it("query: there is no unclaimed writer", async () => {
    expect(await olderRefreshLandsAfterRunStarted(useAgentLaneOnQuery)).toBe(true);
  });
});

describe("known gap", () => {
  // The query owns only its own state. A loader that captures a setter can
  // still write after its workspace was left, and no check sees it.
  it("a loader that captures its own setter still commits late", async () => {
    const answers = { A: deferred<string>(), B: deferred<string>() };
    const hook = renderHook(({ workspaceId }) => {
      const [leaked, setLeaked] = useState<string>();
      const query = useWorkspaceQuery(useWorkspaceSession(), {
        key: workspaceId,
        load: async () => {
          const answer = await answers[workspaceId].promise;
          setLeaked(answer);
          return answer;
        },
      });
      return { value: query.value, leaked };
    }, { wrapper, initialProps: { workspaceId: "A" as "A" | "B" } });
    hook.rerender({ workspaceId: "B" });
    await act(async () => { answers.B.resolve("B's files"); });
    await act(async () => { answers.A.resolve("A's files"); });
    expect(hook.result.current.value).toBe("B's files");
    expect(hook.result.current.leaked).toBe("A's files");
  });
});

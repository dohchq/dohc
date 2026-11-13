// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { useWorkspaceQuery } from "./useWorkspaceQuery";
import { useWorkspaceSession, WorkspaceSessionProvider } from "./workspaceSession";

const wrapper = WorkspaceSessionProvider;

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
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("second visit");
    const sessions: unknown[] = [];
    function Visit(props: { children?: ReactNode }) {
      return createElement(WorkspaceSessionProvider, null, props.children);
    }
    // The shell is keyed by workspace id, so A to B to A mounts a new session.
    const hook = renderHook(() => {
      const session = useWorkspaceSession();
      sessions.push(session);
      return useWorkspaceQuery(session, { key: "files", load: read });
    }, { wrapper: Visit });
    hook.unmount();
    const again = renderHook(() => {
      const session = useWorkspaceSession();
      sessions.push(session);
      return useWorkspaceQuery(session, { key: "files", load: read });
    }, { wrapper: Visit });
    await act(async () => { first.resolve("first visit"); });
    expect(again.result.current.value).toBe("second visit");
    expect(sessions.at(0)).not.toBe(sessions.at(-1));
  });

  it("latest-issued keeps only the newest read, and retry waits for its own read", async () => {
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

  it("latest-success shows the error of the newest read and keeps the older success", async () => {
    const older = deferred<string>(), newer = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const report = vi.fn();
    const hook = renderHook(() => useWorkspaceQuery(useWorkspaceSession(), {
      key: "k", manual: true, ordering: "latest-success", report, load,
    }), { wrapper });
    act(() => { void hook.result.current.retry(); void hook.result.current.retry(); });
    const failure = Error("newest failed");
    await act(async () => { newer.reject(failure); });
    expect(hook.result.current).toMatchObject({ value: undefined, pending: true, error: failure });
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    await act(async () => { older.resolve("older"); });
    expect(hook.result.current).toMatchObject({ value: "older", pending: false, error: failure });
  });

  it("needs the shell's session", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useWorkspaceSession())).toThrow(/WorkspaceSessionProvider/);
    vi.mocked(console.error).mockRestore();
  });
});

// Each case below rebuilds one read race from the history. The "before" hook
// is a reduced copy of the code the fix replaced, and runs the same scenario
// as the query. it.fails passes only while the old logic still loses.

describe("#502 (7e6cd873a): a failed refresh threw away the older answer", () => {
  type History = { page: string | undefined; refresh: () => Promise<void> };
  // Before: every refresh advanced one token, and only the newest issued
  // refresh could write the page.
  function useHistoryBefore(read: () => Promise<string>): History {
    const [page, setPage] = useState<string>();
    const token = useRef(0);
    const refresh = useCallback(async () => {
      const request = ++token.current;
      try {
        const answer = await read();
        if (request !== token.current) return;
        setPage(answer);
      } catch {
        // The shell reported the failure; the page stays as it was.
      }
    }, [read]);
    return { page, refresh };
  }
  function useHistoryOnQuery(read: () => Promise<string>): History {
    const query = useWorkspaceQuery(useWorkspaceSession(), {
      key: "history", manual: true, ordering: "latest-success", load: () => read(),
    });
    return { page: query.value, refresh: query.retry };
  }
  async function refreshFailsAfterOlderRefresh(useHistory: (read: () => Promise<string>) => History) {
    const older = deferred<string>(), newer = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const hook = renderHook(() => useHistory(read), { wrapper });
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = hook.result.current.refresh(); second = hook.result.current.refresh(); });
    await act(async () => { newer.reject(Error("refresh failed")); await second; });
    await act(async () => { older.resolve("the only page read"); await first; });
    expect(hook.result.current.page).toBe("the only page read");
  }
  it.fails("before: the newer failure discards the older page", () => refreshFailsAfterOlderRefresh(useHistoryBefore));
  it("query: the older page still lands", () => refreshFailsAfterOlderRefresh(useHistoryOnQuery));
});

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
    const query = useWorkspaceQuery(useWorkspaceSession(), {
      key: path, ordering: "latest-success", load: () => read(path),
    });
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
      expect(hook.result.current).toBe("after the edit");
    } finally {
      // Its focus listener must not reach the next case.
      hook.unmount();
    }
  }
  it.fails("before: the older first read repaints over the focus read", () => firstReadLandsLast(useBacklinksBefore));
  it("query: one owner orders both reads", () => firstReadLandsLast(useBacklinksOnQuery));
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
    const query = useWorkspaceQuery(useWorkspaceSession(), {
      key: "agent-run", manual: true, ordering: "latest-success", load: () => read(),
    });
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
    expect(hook.result.current.active).toBe(true);
  }
  it.fails("before: the opted-out answer lands last and wins", () => olderRefreshLandsAfterRunStarted(useAgentLaneBefore));
  it("query: there is no unclaimed writer", () => olderRefreshLandsAfterRunStarted(useAgentLaneOnQuery));
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

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalAgentsEvent } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { knownPersonalAgents, usePersonalAgents, type PersonalAgentsState } from "./usePersonalAgents";

const AGENT_ID = `p-${"a".repeat(26)}`;

function event(name: string): PersonalAgentsEvent {
  return {
    accounts: [{
      accountKey: "https://server.test#https://relay.test#ana",
      host: "relay.test",
      agentLinkOrigin: "https://relay.test",
      roster: {
        revision: 1,
        agents: [{
          agentId: AGENT_ID, name, hue: "teal", reportedProduct: null, reportedVersion: null, status: "active",
          createdAtMs: 1, signedInAtMs: 1, lastActionAtMs: null, reach: [{ workspaceId: "ws-a", level: "view" }],
        }],
        workspaces: [{ workspaceId: "ws-a", name: "Trip" }],
      },
      failure: null,
    }],
  };
}

function names(state: PersonalAgentsState): string[] | null {
  return knownPersonalAgents(state)?.map(agent => agent.name) ?? null;
}

let listener: ((event: PersonalAgentsEvent) => void) | null = null;
const readPersonalAgents = vi.fn(async (_payload: { refresh: boolean }): Promise<PersonalAgentsEvent> => ({ accounts: [] }));
const onPersonalAgents = vi.fn((next: (event: PersonalAgentsEvent) => void) => {
  listener = next;
  return () => { listener = null; };
});

beforeEach(() => vi.stubGlobal("dohcDesktop", { readPersonalAgents, onPersonalAgents }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  listener = null;
});

describe("the personal agents a workspace reads", () => {
  it("drops a read that answers after the workspace changed", async () => {
    const slow = deferred<PersonalAgentsEvent>();
    const fresh = deferred<PersonalAgentsEvent>();
    readPersonalAgents.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fresh.promise);
    const { result, rerender } = renderHook(
      ({ workspaceId }) => usePersonalAgents(workspaceId, false),
      { initialProps: { workspaceId: "ws-a" } },
    );
    rerender({ workspaceId: "ws-b" });
    expect(readPersonalAgents).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ status: "loading" });

    await act(async () => slow.resolve(event("Grok Bot")));
    expect(result.current.state).toEqual({ status: "loading" });

    await act(async () => fresh.resolve(event("Iris")));
    expect(names(result.current.state)).toEqual(["Iris"]);
  });

  it("keeps main's push over a read still in flight", async () => {
    const slow = deferred<PersonalAgentsEvent>();
    readPersonalAgents.mockReturnValueOnce(slow.promise);
    const { result } = renderHook(() => usePersonalAgents("ws-a", false));

    act(() => listener!(event("Iris")));
    expect(names(result.current.state)).toEqual(["Iris"]);
    await act(async () => slow.resolve(event("Grok Bot")));
    expect(names(result.current.state)).toEqual(["Iris"]);
  });

  it("asks main to read the server first only when told to", () => {
    renderHook(() => usePersonalAgents("ws-a", true));
    renderHook(() => usePersonalAgents("ws-a", false));
    expect(readPersonalAgents.mock.calls).toEqual([[{ refresh: true }], [{ refresh: false }]]);
  });

  it("says a read failed, and reload reads the server again", async () => {
    readPersonalAgents.mockRejectedValueOnce(new Error("main went away"));
    const { result } = renderHook(() => usePersonalAgents("ws-a", false));
    await act(async () => {});
    expect(result.current.state).toEqual({ status: "failed" });

    readPersonalAgents.mockResolvedValueOnce(event("Iris"));
    await act(async () => result.current.reload());
    expect(readPersonalAgents).toHaveBeenLastCalledWith({ refresh: true });
    expect(names(result.current.state)).toEqual(["Iris"]);
  });

  it("answers a reload with what it then holds, which a push from main during the read can be", async () => {
    const { result } = renderHook(() => usePersonalAgents("ws-a", false));
    await act(async () => {});
    readPersonalAgents.mockImplementationOnce(async () => {
      listener!(event("Iris"));
      throw new Error("main went away");
    });
    let answer: PersonalAgentsState | undefined;
    await act(async () => { answer = await result.current.reload(); });
    expect(names(answer!)).toEqual(["Iris"]);
    expect(names(result.current.state)).toEqual(["Iris"]);
  });
});

describe("which personal agents are known", () => {
  it("knows none until every account's roster has arrived", () => {
    const ready = event("Iris");
    const unread = { ...ready.accounts[0]!, accountKey: "other", roster: null };
    expect(knownPersonalAgents({ status: "loading" })).toBeNull();
    expect(knownPersonalAgents({ status: "failed" })).toBeNull();
    expect(knownPersonalAgents({ status: "ready", accounts: [] })).toBeNull();
    expect(knownPersonalAgents({ status: "ready", accounts: [...ready.accounts, unread] })).toBeNull();
    expect(knownPersonalAgents({ status: "ready", accounts: ready.accounts })?.map(agent => agent.agentId)).toEqual([AGENT_ID]);
  });
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunStatusResult } from "../../ipc/bridgeContract";
import type { SettingsSectionId } from "../settings/settingsRegistry";
import { useAgentSetup } from "./useAgentSetup";

const inactive: AgentRunStatusResult = { activeRun: null, lastRun: null };
const active: AgentRunStatusResult = {
  activeRun: { id: "run-1", startedAt: 1, agentId: "agent", onBehalfOf: "owner", status: "running" },
  lastRun: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shares the bootstrap status read with history", async () => {
  let resolve!: (status: AgentRunStatusResult) => void;
  const pending = new Promise<AgentRunStatusResult>((done) => { resolve = done; });
  const getAgentRunStatus = vi.fn().mockReturnValue(pending);
  vi.stubGlobal("dohcDesktop", { getAgentRunStatus });
  const { result } = renderHook(() => useAgentSetup("ws-1", null, null, true));

  const historyRead = result.current.readAgentStatusForHistory();
  expect(historyRead).toBe(pending);
  await act(async () => { resolve(active); await historyRead; });
  expect(getAgentRunStatus).toHaveBeenCalledTimes(1);
});

it.each([false, true])("discards unconsumed bootstrap status when Settings closes (already resolved: %s)", async (resolved) => {
  let resolve!: (status: AgentRunStatusResult) => void;
  const pending = new Promise<AgentRunStatusResult>((done) => { resolve = done; });
  const getAgentRunStatus = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(inactive);
  vi.stubGlobal("dohcDesktop", { getAgentRunStatus });
  const { result, rerender } = renderHook(
    ({ section }: { section: SettingsSectionId | null }) => useAgentSetup("ws-1", null, section, true),
    { initialProps: { section: null } as { section: SettingsSectionId | null } },
  );
  if (resolved) await act(async () => { resolve(active); await pending; });
  rerender({ section: "agents" });
  await act(async () => { rerender({ section: null }); });

  // History first becomes available after Settings has observed the ended run.
  const historyRead = result.current.readAgentStatusForHistory();
  await expect(historyRead).resolves.toEqual(inactive);
  expect(getAgentRunStatus).toHaveBeenCalledTimes(3);
  if (!resolved) await act(async () => { resolve(active); await pending; });
  await expect(historyRead).resolves.toEqual(inactive);
});

it("does not read agent status before workspace admission", async () => {
  const getAgentRunStatus = vi.fn().mockResolvedValue(inactive);
  vi.stubGlobal("dohcDesktop", { getAgentRunStatus });
  const { rerender } = renderHook(
    ({ ready }) => useAgentSetup("workspace", null, null, ready),
    { initialProps: { ready: false } },
  );
  expect(getAgentRunStatus).not.toHaveBeenCalled();
  await act(async () => { rerender({ ready: true }); });
  expect(getAgentRunStatus).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace" });
});

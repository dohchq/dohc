// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunStatusResult, DesktopUserSettingsResult } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
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

it("reads run status when the workspace opens and again when Settings closes", async () => {
  const getAgentRunStatus = vi.fn().mockResolvedValue(inactive);
  vi.stubGlobal("dohcDesktop", { getAgentRunStatus });
  const { rerender } = renderHook(
    ({ section }: { section: SettingsSectionId | null }) => useAgentSetup("ws-1", null, section, true),
    { initialProps: { section: null } as { section: SettingsSectionId | null } },
  );
  expect(getAgentRunStatus).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1" });
  rerender({ section: "agents" });
  await act(async () => { rerender({ section: null }); });
  expect(getAgentRunStatus).toHaveBeenCalledTimes(2);
  expect(getAgentRunStatus).toHaveBeenLastCalledWith({ workspaceId: "ws-1" });
});

it("drops a slow run read from A after a switch to B and back to A", async () => {
  const reads: Array<(status: AgentRunStatusResult) => void> = [];
  const getAgentRunStatus = vi.fn(() => new Promise<AgentRunStatusResult>((done) => { reads.push(done); }));
  vi.stubGlobal("dohcDesktop", { getAgentRunStatus });
  const settings: DesktopUserSettingsResult = { settings: DEFAULT_USER_SETTINGS, source: "stored" };
  const { result, rerender } = renderHook(
    ({ workspaceId }: { workspaceId: string }) => useAgentSetup(workspaceId, settings, null, true),
    { initialProps: { workspaceId: "ws-a" } },
  );
  rerender({ workspaceId: "ws-b" });
  rerender({ workspaceId: "ws-a" });
  expect(reads).toHaveLength(3);

  await act(async () => { reads[2]!(inactive); });
  expect(result.current.agentSetup).toMatchObject({ workspaceId: "ws-a", agentRunActive: false });
  // The first A read and B's read both answer after the current one.
  await act(async () => { reads[0]!(active); reads[1]!(active); });
  expect(result.current.agentSetup).toMatchObject({ workspaceId: "ws-a", agentRunActive: false });
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

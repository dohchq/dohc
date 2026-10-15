// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunStatusResult } from "../../ipc/bridgeContract";
import type { SettingsSectionId } from "../settings/settingsRegistry";
import { useAgentSetup } from "./useAgentSetup";

const inactive: AgentRunStatusResult = { activeRun: null, lastRun: null };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads run status when the workspace opens and again when Settings closes", async () => {
  const getAgentRunStatus = vi.fn().mockResolvedValue(inactive);
  vi.stubGlobal("dohcDesktop", { getAgentRunStatus });
  const { rerender } = renderHook(
    ({ section }: { section: SettingsSectionId | null }) => useAgentSetup("ws-1", null, section),
    { initialProps: { section: null } as { section: SettingsSectionId | null } },
  );
  expect(getAgentRunStatus).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1" });
  rerender({ section: "agents" });
  await act(async () => { rerender({ section: null }); });
  expect(getAgentRunStatus).toHaveBeenCalledTimes(2);
  expect(getAgentRunStatus).toHaveBeenLastCalledWith({ workspaceId: "ws-1" });
});

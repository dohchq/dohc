import { describe, expect, it, vi } from "vitest";
import { createDesktopAgentDrivers } from "./AgentProcessDrivers";
import {
  BUILT_IN_AGENT_DRIVER_IDS,
  createAgentDriverRegistry,
  selectPermissionOption,
  type AgentDriver,
  type AgentProbe,
} from "./AgentDriver";

const authenticatedProbe: AgentProbe = {
  installed: true,
  version: "1.2.3",
  auth: { status: "authenticated", label: "Pro", email: "agent@example.test" },
  models: [{ id: "plan-model", name: "Plan model", planIncluded: true }],
};

function driver(id: string, probe: AgentDriver["probe"] = async () => authenticatedProbe): AgentDriver {
  return {
    id,
    displayName: id,
    probe,
    startSession: vi.fn(async () => ({
      sessionId: `${id}-session`,
      resumeCursor: `${id}-cursor`,
      prompt: vi.fn(async () => ({ turnId: "turn-1" })),
      cancel: vi.fn(async () => undefined),
      answerPermission: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    })),
  };
}

describe("the drivers dohc ships", () => {
  it("are exactly the ids a plugin may not take", () => {
    // The plugin driver registry refuses these ids by name, so a driver added
    // to the app without joining this list would be one a plugin could
    // shadow.
    expect(createDesktopAgentDrivers({}).map((driver) => driver.id).sort())
      .toEqual([...BUILT_IN_AGENT_DRIVER_IDS].sort());
  });
});

describe("AgentDriverRegistry", () => {
  it("keeps drivers lookup-only and rejects duplicate ids", () => {
    const one = driver("generic-acp");
    const two = driver("claude-acp");
    const registry = createAgentDriverRegistry([one, two]);

    expect(registry.list()).toEqual([one, two]);
    expect(registry.get("generic-acp")).toBe(one);
    expect(registry.get("missing")).toBeNull();
    expect(() => createAgentDriverRegistry([one, driver("generic-acp")])).toThrow(
      /Duplicate agent driver id/,
    );
  });

  it("probes every driver and normalizes probe failures for the picker", async () => {
    const env = { PATH: "/bin" };
    const okProbe = vi.fn(async () => authenticatedProbe);
    const brokenProbe = vi.fn(async () => {
      throw new Error("claude not found");
    });
    const ok = driver("generic-acp", okProbe);
    const broken = driver("claude-acp", brokenProbe);
    const registry = createAgentDriverRegistry([ok, broken]);

    await expect(registry.probeAll(env)).resolves.toEqual([
      { driver: ok, probe: authenticatedProbe },
      {
        driver: broken,
        probe: {
          installed: false,
          auth: { status: "unknown" },
          models: [],
          errorMessage: "claude not found",
        },
      },
    ]);
    expect(okProbe).toHaveBeenCalledWith(env);
    expect(brokenProbe).toHaveBeenCalledWith(env);
  });
});

describe("selectPermissionOption", () => {
  const options = [
    { optionId: "agent-random-1", name: "Reject once", kind: "reject_once" as const },
    { optionId: "agent-random-2", name: "Allow always", kind: "allow_always" as const },
    { optionId: "agent-random-3", name: "Allow once", kind: "allow_once" as const },
  ];

  it("selects by ACP option kind rather than hardcoded option ids", () => {
    expect(selectPermissionOption(options, "allow_once")?.optionId).toBe("agent-random-3");
    expect(selectPermissionOption(options, "allow_always")?.optionId).toBe("agent-random-2");
    expect(selectPermissionOption(options, "reject_once")?.optionId).toBe("agent-random-1");
    expect(selectPermissionOption(options, "reject_always")).toBeNull();
    expect(selectPermissionOption(options, "cancel")).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createAgentDriverRegistry,
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

describe("AgentDriverRegistry", () => {
  it("keeps drivers lookup-only and rejects duplicate ids", () => {
    const one = driver("plugin-a");
    const two = driver("plugin-b");
    const registry = createAgentDriverRegistry([one, two]);

    expect(registry.list()).toEqual([one, two]);
    expect(registry.get("plugin-a")).toBe(one);
    expect(registry.get("missing")).toBeNull();
    expect(() => createAgentDriverRegistry([one, driver("plugin-a")])).toThrow(
      /Duplicate agent driver id/,
    );
  });

  it("probes every driver and normalizes probe failures for the picker", async () => {
    const env = { PATH: "/bin" };
    const okProbe = vi.fn(async () => authenticatedProbe);
    const brokenProbe = vi.fn(async () => {
      throw new Error("claude not found");
    });
    const ok = driver("plugin-a", okProbe);
    const broken = driver("plugin-b", brokenProbe);
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


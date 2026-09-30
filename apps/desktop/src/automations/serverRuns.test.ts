import { describe, expect, it } from "vitest";
import { createServerRuns } from "./serverRuns";

describe("server automation recovery", () => {
  it("preserves the typed controls target when Try again reaches an off automation", async () => {
    const target = { recovery: "automation-controls" as const, automation: "collection:Tasks#slow", path: "Tasks/automations.yaml" };
    const server = createServerRuns(async () => ({ status: 200, body: { ok: true, status: "switched-off", target }, asker: { account: "owner", current: () => true } }));
    await expect(server.retry("ws", { automationId: target.automation, claimId: "third-timeout", startOver: false }))
      .resolves.toEqual({ status: "switched-off", target });
  });
});

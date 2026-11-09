// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CollectionMoveNote, type CollectionServer } from "./CollectionMoveNote";
afterEach(cleanup);
const said = (server: Partial<CollectionServer>) => render(<CollectionMoveNote action="Publishing"
  server={{ host: "sync.example.test", runs: "all", automations: 1, scheduledAutomations: 1, ...server }} />).container.textContent?.replace(/^.*move it back\./, "").trim();
it("says what the move does to a Collection's automations only when it changes them", () => {
  expect(said({ automations: 0, runs: "off" })).toBe("");
  expect(said({ runs: "all" })).toBe("");
  expect(said({ runs: "off" })).toBe("Its automations stop, because sync.example.test doesn't run automations.");
  expect(said({ runs: null })).toBe("Its automations run only if sync.example.test runs automations.");
  expect(said({ runs: "no-schedules" })).toBe("Its schedules and Group messages stop until you choose sync.example.test under Schedules run on in Settings.");
  expect(said({ runs: "no-schedules", scheduledAutomations: 0 })).toBe("");
});

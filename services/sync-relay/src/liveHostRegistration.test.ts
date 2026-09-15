import {expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {LiveHostRegistrations} from "./liveHostRegistration";

const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "docs/note.md", selectorPaths: ["docs/note.md"], restoreFenceGeneration: 0};
function fixture() {
  let id = 0;
  const sendRequest = vi.fn(async () => ({result: {registrationId: ++id}}));
  const registrations = new LiveHostRegistrations({client: {sendRequest} as unknown as EngineClient,
    workspace: "native-workspace", nextRequestId: () => id + 1, deadlineMs: 1000});
  return {sendRequest, registrations};
}

it("keeps one native registration across readers and admitted grant selectors", async () => {
  const {registrations, sendRequest} = fixture();
  const first = await registrations.ensure(binding);
  const second = await registrations.ensure({...binding, selectorPaths: ["docs"]});
  expect(second.id).toBe(first.id);
  expect(second.binding).toEqual(binding);
  expect(first.invalidated.aborted).toBe(false);
  expect(sendRequest).toHaveBeenCalledTimes(1);
  (second.binding.selectorPaths as string[]).push("other");
  expect(registrations.capture(binding).binding).toEqual(binding);
});

it.each(["restoreFenceGeneration", "lineageClaimId", "currentPath"] as const)("invalidates borrowed readers when %s changes", async field => {
  const {registrations} = fixture();
  const first = await registrations.ensure(binding);
  const changed = {...binding, [field]: field === "restoreFenceGeneration" ? 1 : field === "lineageClaimId" ? "b".repeat(64) : "docs/moved.md"};
  const second = await registrations.ensure(changed);
  expect(first.invalidated.aborted).toBe(true);
  expect(second.invalidated.aborted).toBe(false);
  expect(second.id).not.toBe(first.id);
  expect(() => registrations.capture(binding)).toThrow("unavailable");
});

it("does not retain an ambiguous or cancelled registration", async () => {
  const {registrations, sendRequest} = fixture();
  const first = await registrations.ensure(binding);
  const abort = new AbortController();
  sendRequest.mockImplementationOnce(async () => {abort.abort(); return {result: {registrationId: 2}};});
  const changed = {...binding, restoreFenceGeneration: 1};
  await expect(registrations.ensure(changed, abort.signal)).rejects.toThrow();
  expect(first.invalidated.aborted).toBe(true);
  expect(() => registrations.capture(changed)).toThrow("unavailable");
});

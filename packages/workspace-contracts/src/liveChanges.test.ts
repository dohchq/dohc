import { describe, expect, it } from "vitest";
import { LiveDocumentChanges, type LiveDocumentStatus, liveChangeAlreadyShown, liveChangeOutcome } from "./liveChanges";

describe("liveChangeOutcome", () => {
  it("leaves a Stop this computer still owes to reconciliation", () => {
    expect(liveChangeOutcome({ action: "stopped" }, { stopOwed: true })).toBeNull();
  });

  it("leaves every other interrupted change unrecorded, so no status credits it", () => {
    expect(liveChangeOutcome({ action: "stopped" }, { stopOwed: false })).toBe("unrecorded");
    for (const stopOwed of [false, true]) expect(liveChangeOutcome({ action: "resumed" }, { stopOwed })).toBe("unrecorded");
  });

  it("names the states each action already shows", () => {
    const statuses: LiveDocumentStatus[] = ["ready", "preparing", "paused", "retired", "unavailable", "absent"];
    expect(statuses.filter(status => liveChangeAlreadyShown("stopped", status))).toEqual(["retired"]);
    expect(statuses.filter(status => liveChangeAlreadyShown("resumed", status))).toEqual(["ready", "preparing"]);
  });
});

it("reads the engine's records and nothing else", () => {
  const author = { kind: "agent", agentId: "agent-1", onBehalfOf: "person-1", depth: 1 } as const;
  const listed = {
    objectId: "doc",
    pending: { changeId: "c1", action: "resumed", path: "a.md", atMs: 2, author },
    last: { action: "stopped", path: "a.md", atMs: 1, author: { kind: "person", personId: "person-1" } },
  };
  expect(LiveDocumentChanges.parse(listed)).toEqual(listed);
  expect(LiveDocumentChanges.safeParse({ ...listed, pending: { ...listed.pending, before: "ready" } }).success).toBe(false);
  expect(LiveDocumentChanges.safeParse({ ...listed, pending: { ...listed.pending, action: "paused" } }).success).toBe(false);
});

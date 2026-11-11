import { describe, expect, it } from "vitest";
import { LiveDocumentChanges, type LiveDocumentStatus, liveChangeAlreadyShown, liveChangeOutcome } from "./liveChanges";

const settled = { stopOwed: false, complete: true };

describe("liveChangeOutcome", () => {
  it.each<[LiveDocumentStatus | undefined, boolean, ReturnType<typeof liveChangeOutcome>]>([
    ["retired", false, "applied"],
    ["retired", true, "applied"],
    // The relay is still finishing a Stop, or it is a Pause: no proof either way.
    ["paused", false, null],
    ["paused", true, null],
    // This computer sends its Stop again; wait for it.
    ["ready", true, null],
    ["preparing", true, null],
    ["unavailable", true, null],
    ["ready", false, "refused"],
    ["preparing", false, "refused"],
    ["unavailable", false, "refused"],
    ["absent", false, "refused"],
    [undefined, false, "refused"],
  ])("settles an interrupted Stop that found %s, stopOwed %s, as %s", (status, stopOwed, outcome) => {
    expect(liveChangeOutcome({ action: "stopped", before: "ready" }, status, { stopOwed, complete: true })).toBe(outcome);
  });

  it.each<[LiveDocumentStatus | undefined, ReturnType<typeof liveChangeOutcome>]>([
    ["ready", "applied"],
    ["preparing", "applied"],
    ["paused", null],
    ["retired", "refused"],
    ["unavailable", "refused"],
    ["absent", "refused"],
    [undefined, "refused"],
  ])("settles an interrupted Resume that found %s as %s", (status, outcome) => {
    expect(liveChangeOutcome({ action: "resumed", before: "retired" }, status, settled)).toBe(outcome);
    expect(liveChangeOutcome({ action: "resumed", before: "retired" }, status, { ...settled, stopOwed: true })).toBe(outcome);
  });

  it("waits while the relay's list is incomplete", () => {
    for (const action of ["stopped", "resumed"] as const) {
      expect(liveChangeOutcome({ action, before: "paused" }, undefined, { stopOwed: false, complete: false })).toBeNull();
    }
  });

  it("drops a change whose result was already there when it began", () => {
    // A person stopped the document; an agent's Stop was interrupted; the relay shows it stopped.
    expect(liveChangeOutcome({ action: "stopped", before: "retired" }, "retired", settled)).toBe("refused");
    expect(liveChangeOutcome({ action: "resumed", before: "ready" }, "ready", settled)).toBe("refused");
    expect(liveChangeOutcome({ action: "resumed", before: "preparing" }, "ready", settled)).toBe("refused");
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
    pending: { changeId: "c1", action: "resumed", path: "a.md", atMs: 2, author, before: "retired" },
    last: { action: "stopped", path: "a.md", atMs: 1, author: { kind: "person", personId: "person-1" } },
  };
  expect(LiveDocumentChanges.parse(listed)).toEqual(listed);
  expect(LiveDocumentChanges.safeParse({ ...listed, last: { ...listed.last, before: "ready" } }).success).toBe(false);
  expect(LiveDocumentChanges.safeParse({ ...listed, pending: { ...listed.pending, action: "paused" } }).success).toBe(false);
});

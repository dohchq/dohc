import { describe, expect, it } from "vitest";
import { LiveDocumentChanges, type LiveDocumentStatus, liveChangeAlreadyShown, liveChangeOutcome } from "./liveChanges";

const settled = { stopOwed: false, complete: true };

describe("liveChangeOutcome", () => {
  const statuses: LiveDocumentStatus[] = ["ready", "preparing", "paused", "retired", "unavailable", "absent"];

  it.each<[LiveDocumentStatus | undefined, ReturnType<typeof liveChangeOutcome>]>([
    ["retired", "applied"],
    // This computer sends its Stop again; its answer settles the change.
    ["paused", null],
    ["ready", null],
    ["preparing", null],
    ["unavailable", null],
    ["absent", "refused"],
    [undefined, "refused"],
  ])("settles an interrupted Stop this computer still owes that found %s as %s", (status, outcome) => {
    expect(liveChangeOutcome({ action: "stopped", before: "ready" }, status, { stopOwed: true, complete: true })).toBe(outcome);
  });

  it("refuses a Stop this computer no longer owes, whatever retired the document", () => {
    // Access ending or another device's Stop also retires it.
    for (const status of [...statuses, undefined]) {
      expect(liveChangeOutcome({ action: "stopped", before: "ready" }, status, settled)).toBe("refused");
    }
  });

  it("refuses an interrupted Resume, since a share's enrollment also makes a document ready", () => {
    for (const status of [...statuses, undefined]) {
      for (const stopOwed of [false, true]) {
        expect(liveChangeOutcome({ action: "resumed", before: "retired" }, status, { stopOwed, complete: true })).toBe("refused");
      }
    }
  });

  it("waits while the relay's list is incomplete", () => {
    for (const action of ["stopped", "resumed"] as const) {
      expect(liveChangeOutcome({ action, before: "paused" }, undefined, { stopOwed: true, complete: false })).toBeNull();
    }
  });

  it("drops a change whose result was already there when it began", () => {
    // A person stopped the document; an agent's Stop was interrupted; the relay shows it stopped.
    expect(liveChangeOutcome({ action: "stopped", before: "retired" }, "retired", { stopOwed: true, complete: true })).toBe("refused");
    expect(liveChangeOutcome({ action: "resumed", before: "ready" }, "ready", settled)).toBe("refused");
    expect(liveChangeOutcome({ action: "resumed", before: "preparing" }, "ready", settled)).toBe("refused");
  });

  it("names the states each action already shows", () => {
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

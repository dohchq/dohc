import { describe, expect, it, vi } from "vitest";
import { errorDetails } from "../shell/copyDetails";
import { SHELL_ERROR_MAX_CHARS } from "../shell/useShellError";
import { refusedChangesWords, withoutRefusal, type RefusedChange, type RefusedChanges } from "./refusedChanges";

const livePage = (path: string) =>
  Object.assign(new Error(`dohc can't delete "${path}" while it has live editing on\nIn Live documents, stop live editing for this page, then delete it again.`), { name: "LivePageOwnedError" });

function refused(path: string, order: number): RefusedChange {
  return { change: { id: `c-${order}`, kind: "delete-file", path }, order, identity: `delete:${path}`, path, live: true,
    reveal: path, retryable: true, cause: livePage(path) };
}

function group(refusals: RefusedChange[], went = 1): RefusedChanges {
  return { identity: "refused:1", action: "delete", total: refusals.length + went, went, refusals, retry: vi.fn() };
}

describe("refusedChangesWords", () => {
  it("names the refusals in the order the changes ran", () => {
    const words = refusedChangesWords(group([refused("Lisbon/c.md", 2), refused("Lisbon/a.md", 0)]));
    expect(words.message).toBe("Live editing is on: Lisbon/a.md, Lisbon/c.md");
    expect(words.reveal).toBe("Lisbon/a.md");
  });

  it("keeps every refused path and its full words in Details when the message runs past the notice's bound", () => {
    const paths = Array.from({ length: 12 }, (_, index) => `Projects/Lisbon trip/Day ${index + 1} itinerary and bookings.md`);
    paths.push(`${"Projects/Lisbon trip/".repeat(25)}Day 13.md`);
    const words = refusedChangesWords(group(paths.map((path, index) => refused(path, index))));
    expect(words.message.length).toBeGreaterThan(SHELL_ERROR_MAX_CHARS);
    const copied = errorDetails(words.details).split("\n");
    expect(copied).toHaveLength(paths.length);
    for (const [index, path] of paths.entries()) {
      expect(copied[index]).toBe(`${path}: dohc can't delete "${path}" while it has live editing on. In Live documents, stop live editing for this page, then delete it again.`);
    }
  });
});

describe("withoutRefusal", () => {
  it("drops a change that went and counts it, and answers null after the last", () => {
    const before = group([refused("a.md", 0), refused("b.md", 1)]);
    const after = withoutRefusal(before, "delete:a.md");
    expect(after?.refusals.map((refusal) => refusal.path)).toEqual(["b.md"]);
    expect(after && refusedChangesWords(after).title).toBe("dohc deleted 2 of 3 items");
    expect(withoutRefusal(before, "delete:other.md")).toBe(before);
    expect(withoutRefusal(after!, "delete:b.md")).toBeNull();
  });
});

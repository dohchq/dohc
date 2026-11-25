import { describe, expect, it, vi } from "vitest";
import type { DatasetHistoryPage } from "@dohc/cli/dataset";
import { collectionHistoryAuthors, type CollectionHistoryNames } from "./collectionHistoryAuthors";

type Entry = DatasetHistoryPage["entries"][number];
const sha = (c: string) => c.repeat(64);
const entry = (revision: number, actor?: Entry["actor"]): Entry => ({
  revision,
  operation: "update",
  callerReference: sha("a"),
  recordedAtMs: 1,
  approvedRevisionHash: sha("b"),
  changesetBytes: 10,
  attachmentCount: 0,
  ...(actor ? { actor } : {}),
});

function names(): CollectionHistoryNames {
  return {
    ownerId: "owner-1",
    prepare: vi.fn(),
    person: vi.fn((userId: string) =>
      userId === "member-1" ? "dana@example.com" : "Someone you shared with",
    ),
    agent: vi.fn((agentId: string) => (agentId === "claude-code" ? "Claude" : "Agent")),
    app: vi.fn(async (publicationId: string) => {
      if (publicationId === "held") return "roadmap-pm";
      if (publicationId === "broken") throw new Error("offline");
      return null;
    }),
  };
}

describe("collectionHistoryAuthors", () => {
  it("names people, agents, link holders, and apps, and leaves no ids", async () => {
    const lookup = names();
    const result = await collectionHistoryAuthors(
      [
        entry(7, { kind: "owner", userId: "owner-1", appId: "held" }),
        entry(6, { kind: "named", userId: "member-1", appId: "held" }),
        entry(5, { kind: "agent", agentId: "claude-code", userId: "owner-1" }),
        entry(4, { kind: "agent" }),
        entry(3, { kind: "link", appId: "withdrawn" }),
        entry(2, { kind: "named", userId: "member-2", appId: "broken" }),
        entry(1, { kind: "owner", userId: "local:device" }),
      ],
      lookup,
    );
    expect(result.map((row) => row.by)).toEqual([
      { kind: "person", name: "You", app: "roadmap-pm" },
      { kind: "person", name: "dana@example.com", app: "roadmap-pm" },
      { kind: "agent", name: "Claude", person: "You" },
      { kind: "agent", name: "Agent" },
      { kind: "link", name: "Link holder", app: "an app" },
      { kind: "person", name: "Someone you shared with", app: "an app" },
      { kind: "person", name: "You" },
    ]);
    expect(result.every((row) => !("actor" in row) && row.callerReference === null)).toBe(true);
    const shown = JSON.stringify(result);
    for (const id of ["owner-1", "member-1", "member-2", "withdrawn", "broken", "local:device"])
      expect(shown).not.toContain(id);
    expect(lookup.prepare).toHaveBeenCalledWith(["member-1", "member-2"]);
    expect(lookup.app).toHaveBeenCalledTimes(3);
  });

  it("shows no author for a change made before dohc recorded one", async () => {
    const [row] = await collectionHistoryAuthors([entry(1)], names());
    expect(row).not.toHaveProperty("by");
  });
});

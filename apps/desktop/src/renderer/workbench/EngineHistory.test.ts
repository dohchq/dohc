import { describe, expect, it } from "vitest";
import type { EngineMomentRecord } from "../../ipc/bridgeContract";
import {
  engineMomentSourceLabel,
  engineMomentSummary,
  engineOriginLabel,
  momentDescription,
  fileMomentSteps,
  groupAgentAuthorName,
  groupTimeline,
  collectionListPhrase,
  missingSourcesWords,
} from "./EngineHistory";
import { chatAuthorLabel } from "./chatMessages";

function moment(overrides: Partial<EngineMomentRecord> & { id: string }): EngineMomentRecord {
  return {
    versionId: "main",
    path: "notes/plan.md",
    recordedAtMs: 100,
    operation: "write",
    origin: "local-file",
    momentOrder: 0,
    ...overrides,
  };
}

describe("engineMomentSummary", () => {
  it("prefers the moment's real engine summary", () => {
    expect(
      engineMomentSummary(
        moment({ id: "m1", summary: "Merged version Draft into Main" }),
      ),
    ).toBe("Merged version Draft into Main");
    expect(
      engineMomentSummary(moment({ id: "m2", summary: "Changed while dohc was closed" })),
    ).toBe("Changed while dohc was closed");
  });

  it("names only the admitted after path for a rename", () => {
    expect(engineMomentSummary(moment({ id: "rename", operation: "rename", path: "notes/b.md" })))
      .toBe("Renamed to b.md");
  });

  it("falls back to calm product copy from the operation", () => {
    expect(engineMomentSummary(moment({ id: "m1" }))).toBe("Edited plan.md");
    expect(
      engineMomentSummary(moment({ id: "m2", operation: "delete" })),
    ).toBe("Deleted plan.md");
  });
});

describe("engineOriginLabel", () => {
  it("maps every origin to a product label", () => {
    expect(engineOriginLabel("local-file")).toBe("Local file edit");
    expect(engineOriginLabel("restore")).toBe("Restore");
    expect(engineOriginLabel("sync")).toBe("Sync");
    expect(engineOriginLabel("api")).toBe("dohc");
    expect(engineOriginLabel("ydoc")).toBe("Live edit");
    expect(engineOriginLabel("unknown")).toBe("Unknown source");
  });

  it("names kept typing whether or not its notice is still open", () => {
    expect(engineOriginLabel("capture-recovery")).toBe("Text kept");
    expect(engineOriginLabel("capture-recovery-cleared")).toBe("Text kept");
  });
});

// Agent-authored moments display as "the agent name" — the
// same formatting rule the chat rail uses — while everything else keeps its
// actor-neutral origin label.
describe("momentDescription", () => {
  // A change several wrote lists each author; an agent or an automation
  // among them says what it is, so it never reads as another person.
  it("names each of several authors by their own kind", () => {
    const description = momentDescription(moment({ id: "mixed",
      authors: [
        { kind: "named", userId: "sam", grantId: "grant-sam", grantGeneration: 1 },
        { kind: "agent", agentId: "nova" },
        { kind: "automation", automationId: "collection:Tasks#stamp", depth: 1 },
      ],
      authorLabels: ["Sam Rivera", "Nova", "Stamp in Tasks"] }));
    expect(description).toMatch(/^Edited plan\.md, Sam Rivera, Agent Nova, Automation Stamp in Tasks, /);
  });

  it("names a single agent or automation by its kind, and a person or origin by name", () => {
    expect(momentDescription(moment({ id: "agent", agentAuthorName: "Nova", authors: [{ kind: "agent", agentId: "nova" }] })))
      .toMatch(/^Edited plan\.md, Agent Nova, /);
    expect(momentDescription(moment({ id: "unnamed", agentAuthorName: "Agent", authors: [{ kind: "agent", agentId: "a" }] })))
      .toMatch(/^Edited plan\.md, Agent, /);
    expect(momentDescription(moment({ id: "person", namedAuthor: { userId: "sam", label: "Sam Rivera" } })))
      .toMatch(/^Edited plan\.md, Sam Rivera, /);
    expect(momentDescription(moment({ id: "local" }))).toMatch(/^Edited plan\.md, Local file edit, /);
  });
});

describe("engineMomentSourceLabel", () => {
  it("names a person the owner shared with, not the sync that carried their change", () => {
    expect(engineMomentSourceLabel(moment({ id: "named", origin: "sync", namedAuthor: { userId: "user_ana", label: "ana@example.com (Edit)" } })))
      .toBe("ana@example.com (Edit)");
    expect(engineMomentSourceLabel(moment({ id: "served", origin: "sync" }))).toBe("Sync");
  });
  it("labels an Edit link's file write apart from an app submission, and names no person", () => {
    const principalId = "3f9a2c1d-7b4e-4c55-9d0a-1e2f3a4b5c6d";
    const link = engineMomentSourceLabel(moment({
      id: "link", origin: "sync", linkAuthor: {kind: "link", grantId: "grant-1", grantGeneration: 2, principalId},
    }));
    expect(link).toBe("Edit link · holder 3f9a2c1d");
    const submission = engineMomentSourceLabel(moment({
      id: "public", origin: "sync", publicAuthor: {kind: "public", principalId, grantId: "grant-1"},
    }));
    expect(submission).toBe("Link holder 3f9a2c1d");
  });
  it("names every author of a moment several wrote, and none in place of the rest", () => {
    expect(engineMomentSourceLabel(moment({ id: "mixed", origin: "local-file",
      authorLabels: ["trip-agent", "ana@example.com (Edit)"] }))).toBe("trip-agent, ana@example.com (Edit)");
    expect(engineMomentSourceLabel(moment({ id: "many", origin: "local-file",
      authorLabels: ["You", "trip-agent", "ana@example.com (Edit)", "ben@example.com (Edit)", "Edit link · holder 3f9a2c1d"] })))
      .toBe("You, trip-agent, ana@example.com (Edit) and 2 more");
  });
  it("names the account or link holder a live edit's author snapshot admitted", () => {
    expect(engineMomentSourceLabel(moment({ id: "account", origin: "local-file", liveAuthorName: "Owner" }))).toBe("Owner");
    expect(engineMomentSourceLabel(moment({ id: "link", origin: "local-file", liveAuthorName: "Link holder Anonymous" })))
      .toBe("Link holder Anonymous");
  });
  it("labels a public principal without inventing an agent identity", () => {
    expect(engineMomentSourceLabel(moment({id: "public", publicAuthor: {kind: "public", principalId: "public_3f9a2c1d-7b4e-4c55-9d0a-1e2f3a4b5c6d", grantId: "grant-1"}})))
      .toBe("Link holder 3f9a2c1d");
  });
  it("shows an agent-authored moment as \"the agent name\"", () => {
    expect(
      engineMomentSourceLabel(moment({ id: "m1", agentAuthorName: "You" })),
    ).toBe("You");
    expect(
      engineMomentSourceLabel(
        moment({ id: "m2", agentAuthorName: "ice@example.com" }),
      ),
    ).toBe("ice@example.com");
  });

  it("matches the agent label in the chat rail exactly", () => {
    expect(
      engineMomentSourceLabel(moment({ id: "m1", agentAuthorName: "Sam Rivera" })),
    ).toBe(
      chatAuthorLabel({ authorKind: "agent", authorDisplayName: "Sam Rivera" }),
    );
  });

  it("names an automation-authored moment by the automation's name and Collection", () => {
    expect(
      engineMomentSourceLabel(moment({ id: "m1", origin: "api", automationAuthor: { name: "Stamp the finish date", collection: "Tasks" } })),
    ).toBe("Stamp the finish date in Tasks");
  });

  it("keeps unattributed moments on their actor-neutral origin label", () => {
    expect(engineMomentSourceLabel(moment({ id: "m1" }))).toBe("Local file edit");
    // A record a person made or deleted by hand reads as their file edit.
    expect(engineMomentSourceLabel(moment({ id: "hand", operation: "delete",
      authors: [{ kind: "human", humanId: "local:installation" }] }))).toBe("Local file edit");
    expect(
      engineMomentSourceLabel(moment({ id: "m2", origin: "restore" })),
    ).toBe("Restore");
  });

  it("names this computer's person on their restore, and keeps their edits as local file edits", () => {
    const authors = [{ kind: "human" as const, humanId: "user-ice" }];
    expect(engineMomentSourceLabel(moment({ id: "restored", origin: "restore", authors, personAuthorName: "Ice" }))).toBe("Ice");
    expect(engineMomentSourceLabel(moment({ id: "edited", origin: "local-file", authors, personAuthorName: "Ice" }))).toBe("Local file edit");
  });
});

describe("groupAgentAuthorName", () => {
  it("returns the shared name when every moment in the group carries it", () => {
    expect(
      groupAgentAuthorName([
        moment({ id: "m2", agentAuthorName: "You" }),
        moment({ id: "m1", agentAuthorName: "You" }),
      ]),
    ).toBe("You");
  });

  it("returns undefined for mixed, partially attributed, or neutral groups", () => {
    expect(
      groupAgentAuthorName([
        moment({ id: "m2", agentAuthorName: "You" }),
        moment({ id: "m1", agentAuthorName: "ice@example.com" }),
      ]),
    ).toBeUndefined();
    expect(
      groupAgentAuthorName([
        moment({ id: "m2", agentAuthorName: "You" }),
        moment({ id: "m1" }),
      ]),
    ).toBeUndefined();
    expect(
      groupAgentAuthorName([
        moment({ id: "m2" }),
        moment({ id: "m1", agentAuthorName: "You" }),
      ]),
    ).toBeUndefined();
    expect(groupAgentAuthorName([moment({ id: "m1" })])).toBeUndefined();
    expect(groupAgentAuthorName([])).toBeUndefined();
  });
});

// The file groups `groupTimeline` builds, for entries that are all files.
function groupEngineMoments(moments: EngineMomentRecord[]) {
  return groupTimeline(moments.map((entry) => ({ kind: "file" as const, moment: entry })))
    .flatMap((item) => (item.kind === "files" ? [item.group] : []));
}

describe("groupTimeline", () => {
  it("keeps every entry kind in the order main merged them", () => {
    const items = groupTimeline([
      { kind: "file", moment: moment({ id: "m2", momentOrder: 2, correlationId: "pass" }) },
      { kind: "version", version: { id: "draft", workspaceId: "workspace", kind: "named", name: "Draft", createdAtMs: 90 } },
      { kind: "file", moment: moment({ id: "m1", momentOrder: 1, correlationId: "pass" }) },
      { kind: "collection", datasetId: "00000000-0000-4000-8000-000000000001", name: "Budget", sortAtMs: null, change: {
        revision: 4, operation: "addRow", callerReference: null, recordedAtMs: null, approvedRevisionHash: "a".repeat(64), changesetBytes: 10, attachmentCount: 0,
      } },
    ]);
    expect(items.map((item) => [item.kind, item.key])).toEqual([
      ["files", "m2"],
      ["version", "version:draft"],
      // A row between two moments of one pass ends their group.
      ["files", "m1"],
      ["collection", "collection:00000000-0000-4000-8000-000000000001:4"],
    ]);
  });

  it("groups consecutive moments sharing a correlationId into one entry", () => {
    const groups = groupEngineMoments([
      moment({
        id: "m3",
        path: "b.md",
        momentOrder: 3,
        summary: "Changed while dohc was closed",
        correlationId: "reconcile-1",
      }),
      moment({
        id: "m2",
        path: "a.md",
        momentOrder: 2,
        summary: "Changed while dohc was closed",
        correlationId: "reconcile-1",
      }),
      moment({ id: "m1", momentOrder: 1 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].summary).toBe("Changed while dohc was closed");
    expect(groups[0].moments.map((entry) => entry.path)).toEqual(["b.md", "a.md"]);
    expect(groups[1].moments.map((entry) => entry.id)).toEqual(["m1"]);
  });

  it("keeps NON-consecutive repeats of a correlationId apart and singletons single", () => {
    const groups = groupEngineMoments([
      moment({ id: "m4", momentOrder: 4, correlationId: "merge-1", summary: "Merged version X into Main" }),
      moment({ id: "m3", momentOrder: 3 }),
      moment({ id: "m2", momentOrder: 2, correlationId: "merge-1", summary: "Merged version X into Main" }),
      moment({ id: "m1", momentOrder: 1 }),
    ]);
    expect(groups.map((group) => group.moments.length)).toEqual([1, 1, 1, 1]);
  });

  it("never merges uncorrelated neighbours", () => {
    const groups = groupEngineMoments([
      moment({ id: "m2", momentOrder: 2 }),
      moment({ id: "m1", momentOrder: 1 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  // An edit by the agent `agentId`, which shows as `name`.
  const byAgent = (id: string, overrides: Partial<EngineMomentRecord> = {}, agentId = "nova", name = "Nova") =>
    moment({ id, agentAuthorName: name, authors: [{ kind: "agent", agentId }], ...overrides });

  it("folds an agent's consecutive edits to one file into a run, keyed by its oldest edit", () => {
    const items = groupTimeline([
      byAgent("m6"),
      byAgent("m5"),
      byAgent("m4"),
      // Each of these ends the run before it.
      byAgent("m3", { path: "notes/other.md" }),
      byAgent("m2", { path: "notes/other.md" }, "pat", "Pat"),
      moment({ id: "m1", path: "notes/other.md" }),
    ].map((entry) => ({ kind: "file" as const, moment: entry })));
    expect(items.map((item) => item.kind === "files" ? [item.key, item.group.run, item.group.moments.map((entry) => entry.id)] : null))
      .toEqual([["m4", true, ["m6", "m5", "m4"]], ["m3", false, ["m3"]], ["m2", false, ["m2"]], ["m1", false, ["m1"]]]);
    // A new edit on top keeps the run's row.
    expect(groupTimeline([byAgent("m7"), byAgent("m6")].map((entry) => ({ kind: "file" as const, moment: entry })))[0]!.key).toBe("m6");
  });

  // A name is what an agent calls itself; its id is who it is.
  it("never folds two agents that share a name", () => {
    expect(groupEngineMoments([byAgent("m2"), byAgent("m1", {}, "another-nova")]).map((group) => group.moments.length)).toEqual([1, 1]);
    // A name with no agent identity behind it never folds either.
    expect(groupEngineMoments([moment({ id: "m2", agentAuthorName: "Nova" }), moment({ id: "m1", agentAuthorName: "Nova" })])
      .map((group) => group.moments.length)).toEqual([1, 1]);
  });

  // An agent's file write is its own one-moment operation.
  it("folds an agent's writes that each carry their own operation", () => {
    const groups = groupEngineMoments(["op-3", "op-2", "op-1"].map((correlationId, index) =>
      byAgent(`m${3 - index}`, { correlationId, summary: "Updated plan.md" })));
    expect(groups.map((group) => [group.run, group.moments.map((entry) => entry.id)])).toEqual([[true, ["m3", "m2", "m1"]]]);
  });

  // An edit by the person `humanId`.
  const byPerson = (id: string, overrides: Partial<EngineMomentRecord> = {}, humanId = "maya") =>
    moment({ id, authors: [{ kind: "human", humanId }], ...overrides });

  it("folds a person's consecutive edits to one file as it folds an agent's", () => {
    expect(groupEngineMoments([byPerson("m3"), byPerson("m2"), byPerson("m1")])
      .map((group) => [group.run, group.moments.map((entry) => entry.id)])).toEqual([[true, ["m3", "m2", "m1"]]]);
    // Another person, or an agent, starts a new row.
    expect(groupEngineMoments([byPerson("m3"), byPerson("m2", {}, "jun"), byAgent("m1")])
      .map((group) => group.moments.length)).toEqual([1, 1, 1]);
    // A person the owner shared with, writing directly, folds by their user id.
    const byNamed = (id: string, userId = "ana") =>
      moment({ id, authors: [{ kind: "named", userId, grantId: "g-1", grantGeneration: 1 }] });
    expect(groupEngineMoments([byNamed("m4"), byNamed("m3"), byNamed("m2", "lee"), byPerson("m1")])
      .map((group) => group.moments.map((entry) => entry.id))).toEqual([["m4", "m3"], ["m2"], ["m1"]]);
  });

  it("never folds a delete, a restore, kept typing, a multi-file pass, another day, or edits with no single author", () => {
    const day = new Date(2026, 9, 16, 12).getTime();
    const cases: Array<[EngineMomentRecord[], number[]]> = [
      [[byAgent("a"), byAgent("b", { operation: "delete" })], [1, 1]],
      [[byPerson("a"), byPerson("b", { origin: "restore" }), byPerson("c", { origin: "capture-recovery" })], [1, 1, 1]],
      // The pass's first file stays with the pass, and the pass stays whole.
      [[byAgent("a"), byAgent("b", { correlationId: "pass" }), byAgent("c", { correlationId: "pass", path: "notes/other.md" })], [1, 2]],
      [[byAgent("a", { correlationId: "pass" }), byAgent("b", { correlationId: "pass", path: "notes/other.md" }),
        byAgent("c", { path: "notes/other.md" })], [2, 1]],
      [[byAgent("a", { recordedAtMs: day }), byAgent("b", { recordedAtMs: day - 86_400_000 })], [1, 1]],
      [[moment({ id: "a" }), moment({ id: "b" })], [1, 1]],
      [[byPerson("a", { authors: [{ kind: "human", humanId: "maya" }, { kind: "human", humanId: "jun" }] }),
        byPerson("b", { authors: [{ kind: "human", humanId: "maya" }, { kind: "human", humanId: "jun" }] })], [1, 1]],
    ];
    for (const [moments, sizes] of cases) expect(groupEngineMoments(moments).map((group) => group.moments.length)).toEqual(sizes);
  });

  // The history view never re-sorts: the order the merge in
  // workspaceEngineCapture hands over is the order the user reads. Moments
  // that share a millisecond would be free to move if it did.
  it("shows same-millisecond moments in the order it is given", () => {
    const tied = [
      moment({ id: "later", momentOrder: 2, recordedAtMs: 500 }),
      moment({ id: "earlier", momentOrder: 1, recordedAtMs: 500 }),
    ];
    expect(
      groupEngineMoments(tied).map((group) => group.moments[0].id),
    ).toEqual(["later", "earlier"]);
    expect(
      groupEngineMoments([...tied].reverse()).map((group) => group.moments[0].id),
    ).toEqual(["earlier", "later"]);
  });
});

describe("fileMomentSteps", () => {
  it("steps to the nearest older and newer change of the same file, across other rows", () => {
    const steps = fileMomentSteps([
      { kind: "file", moment: moment({ id: "m4" }) },
      { kind: "file", moment: moment({ id: "m3", path: "b.md" }) },
      { kind: "version", version: { id: "draft", workspaceId: "workspace", kind: "named", name: "Draft", createdAtMs: 90 } },
      { kind: "file", moment: moment({ id: "m2" }) },
      { kind: "file", moment: moment({ id: "m1" }) },
    ]);
    const plan = (momentId: string) => ({ momentId, path: "notes/plan.md" });
    expect(steps.get("m4")).toEqual({ newer: null, older: plan("m2") });
    expect(steps.get("m2")).toEqual({ newer: plan("m4"), older: plan("m1") });
    expect(steps.get("m1")).toEqual({ newer: plan("m2"), older: null });
    expect(steps.get("m3")).toEqual({ newer: null, older: null });
  });
});

describe("missing sources", () => {
  it("names up to three Collections and counts the rest", () => {
    expect(collectionListPhrase(["Budget"], 1)).toBe("Budget");
    expect(collectionListPhrase(["Budget", "Guests"], 2)).toBe("Budget and Guests");
    expect(collectionListPhrase(["Budget", "Guests", "Tasks"], 3)).toBe("Budget, Guests and Tasks");
    expect(collectionListPhrase(["Budget", "Guests", "Tasks", "Venues"], 5)).toBe("Budget, Guests, Tasks and 2 more");
    expect(collectionListPhrase(["Budget"], 2)).toBe("Budget and 1 more");
    expect(collectionListPhrase([], 2)).toBe("2 Collections");
  });

  it("says which Collections did not load and how many the limit left out", () => {
    const names = new Map([["a", "Budget"]]);
    expect(missingSourcesWords([{ datasetId: "a" }, { datasetId: "b" }], 3, (id) => names.get(id))).toEqual({
      unavailable: "dohc could not load changes from Budget and 1 more.",
      omitted: "History includes up to 128 Collections. 3 more are left out. To see a Collection's changes, open it and choose History.",
    });
    expect(missingSourcesWords([], 1, () => undefined)).toEqual({
      unavailable: null,
      omitted: "History includes up to 128 Collections. 1 more is left out. To see a Collection's changes, open it and choose History.",
    });
    expect(missingSourcesWords([], 0, () => undefined)).toEqual({ unavailable: null, omitted: null });
  });
});

describe("chatAuthorLabel", () => {
  it("shows human authors by their display name", () => {
    expect(
      chatAuthorLabel({ authorKind: "human", authorDisplayName: "You" }),
    ).toBe("You");
    expect(
      chatAuthorLabel({
        authorKind: "human",
        authorDisplayName: "user@example.com",
      }),
    ).toBe("user@example.com");
  });

  it("shows agent-authored messages as \"the agent name\"", () => {
    expect(
      chatAuthorLabel({ authorKind: "agent", authorDisplayName: "Sam Rivera" }),
    ).toBe("Sam Rivera");
  });
});

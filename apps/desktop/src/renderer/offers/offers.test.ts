import { describe, expect, it } from "vitest";
import { detectCsvBound, MAX_CSV_PREVIEW_ROWS } from "./csvBound";
import { agentRosterPickIsPresent, detectAgentAddressed, mapAgentRosterPick, type AddressedAgentFacts } from "./agentAddressed";
import { observeFolderAppOffers, readFolderAppOffer } from "./folderApp";
const candidate = { id: "agent:default", kind: "agent" as const, handle: "agent", label: "Agent" };
const pick = { candidate, from: 0, to: 6 };
const facts: AddressedAgentFacts = { workspaceId: "one", agentId: candidate.id, presentation: { group: "", hue: null, self: true },
  runActive: false, paused: false, liveRun: false, reach: "C:\\work" };

describe("CSV preview offer", () => {
  it.each([0, MAX_CSV_PREVIEW_ROWS - 1, MAX_CSV_PREVIEW_ROWS])("does not offer at %i rows", totalRows => {
    expect(detectCsvBound({ workspaceId: "one", path: "data.csv", totalRows, source: "workspace-file", complete: true })).toBeNull();
  });
  it("reports the cap and total data rows above the cap", () => {
    expect(detectCsvBound({ workspaceId: "one", path: "data.csv", totalRows: 501, source: "workspace-file", complete: true }))
      .toEqual({ kind: "csv-bound", workspaceId: "one", path: "data.csv", cap: 500, totalRows: 501, plainWorkspaceCsv: true });
  });
  it("excludes incomplete reads, received shares, datasets, non-CSV and invalid counts", () => {
    const base = { path: "data.csv", totalRows: 1000, source: "workspace-file" as const, complete: true };
    for (const override of [{ complete: false }, { source: "received-share" as const }, { source: "dataset" as const }, { path: "data.tsv" }, { path: "shared-with-me/team/data.csv" }, { path: "../data.csv" }, { totalRows: NaN }]) {
      expect(detectCsvBound({ workspaceId: "one", ...base, ...override })).toBeNull();
    }
  });
});
describe("agent pick offer", () => {
  it("requires a roster pick of the agent the facts describe", () => {
    expect(detectAgentAddressed("one", null, facts)).toBeNull(); // Typed @agent has no pick.
    expect(detectAgentAddressed("one", { ...candidate, kind: "user" }, facts)).toBeNull();
    expect(detectAgentAddressed("one", candidate, { ...facts, agentId: "other" })).toBeNull();
    expect(detectAgentAddressed("one", candidate, null)).toBeNull();
    expect(detectAgentAddressed("one", candidate, facts)).toMatchObject({ agent: candidate, state: "runs", working: false, reach: "C:\\work" });
  });
  it.each([
    ["runs", {}],
    ["working", { runActive: true }],
    ["working", { liveRun: true }],
    ["paused", { paused: true, liveRun: true }],
    // Settings not read yet.
    ["unknown", { runActive: null }],
    ["unknown", { paused: null }],
    ["unknown", { liveRun: null }],
  ] as const)("is %s by dispatch's rule for %j", (state, override) => {
    expect(detectAgentAddressed("one", candidate, { ...facts, ...override })?.state).toBe(state);
  });
  it("keeps a known run beside an unknown pause, and invents no run", () => {
    expect(detectAgentAddressed("one", candidate, { ...facts, paused: null, runActive: true })).toMatchObject({ state: "unknown", working: true });
    expect(detectAgentAddressed("one", candidate, { ...facts, liveRun: null, runActive: null })).toMatchObject({ state: "unknown", working: false });
  });
  it("maps edits before a picked reference and removes it when replaced", () => {
    const moved = mapAgentRosterPick(pick, { from: 0, to: 0, insertedLength: 5 });
    expect(moved).toMatchObject({ from: 5, to: 11 });
    expect(mapAgentRosterPick(moved, { from: 5, to: 11, insertedLength: 6 })).toBeNull();
    expect(mapAgentRosterPick(pick, { from: 6, to: 6, insertedLength: 20 })).toBe(pick);
  });
  it("checks only the picked span and drops glued handles", () => {
    expect(agentRosterPickIsPresent(pick, "@agent hello")).toBe(true);
    expect(agentRosterPickIsPresent(pick, "@agentfoo")).toBe(false);
    expect(agentRosterPickIsPresent({ ...pick, from: 1, to: 7 }, "x@agent ")).toBe(false);
  });
});
describe("workspace response guard", () => {
  it("drops a delayed answer after A -> B -> A and a newer request", async () => {
    let token = { workspaceId: "one", generation: 1 };
    let release!: (value: { workspaceId: string; folder: string; isApp: boolean; run: null }) => void;
    const read = () => new Promise<{ workspaceId: string; folder: string; isApp: boolean; run: null }>(resolve => { release = resolve; });
    const response = readFolderAppOffer({ token, currentToken: () => token, folder: "app", read });
    token = { workspaceId: "two", generation: 2 };
    token = { workspaceId: "one", generation: 3 };
    release({ workspaceId: "one", folder: "app", isApp: false, run: null });
    expect(await response).toBeNull();
  });
  it("returns a current answer and drops stale errors", async () => {
    const token = { workspaceId: "one", generation: 1 };
    const answer = { workspaceId: "one", folder: "app", isApp: false, run: null };
    expect(await readFolderAppOffer({ token, currentToken: () => token, folder: "app", read: async () => answer })).toEqual(answer);
    expect(await readFolderAppOffer({ token, currentToken: () => ({ ...token, generation: 2 }), folder: "app", read: async () => { throw Error("old"); } })).toBeNull();
    await expect(readFolderAppOffer({ token, currentToken: () => token, folder: "app", read: async () => { throw Error("current"); } })).rejects.toThrow("current");
  });
});

it("rejects agent facts from A after switching the roster to B with the same agent id", () => {
  expect(detectAgentAddressed("two", candidate, facts)).toBeNull();
  expect(detectAgentAddressed("two", candidate, { ...facts, workspaceId: "two" })?.state).toBe("runs");
});
it("guards offer-specific signals with the workspace generation", () => {
  let token = { workspaceId: "one", generation: 1 };
  let listener!: (answer: { workspaceId: string; folder: string; isApp: boolean; run: null }) => void;
  const changed = (answer: unknown) => received.push(answer);
  const received: unknown[] = [];
  const dispose = observeFolderAppOffers({ token, currentToken: () => token, wants: folder => folder === "app",
    subscribe: callback => { listener = callback; return () => { received.push("disposed"); }; }, onChanged: changed });
  const answer = { workspaceId: "one", folder: "app", isApp: false, run: null };
  listener({ ...answer, workspaceId: "two" });
  listener(answer);
  expect(received).toEqual([answer]);
  token = { workspaceId: "one", generation: 3 };
  listener(answer);
  expect(received).toEqual([answer]);
  dispose();
  expect(received.at(-1)).toBe("disposed");
});

it("ignores answers for folders nobody asked about in the same workspace", () => {
  const token = { workspaceId: "one", generation: 1 };
  let listener!: (answer: { workspaceId: string; folder: string; isApp: boolean; run: null }) => void;
  const received: unknown[] = [];
  const dispose = observeFolderAppOffers({ token, currentToken: () => token, wants: folder => folder === "app",
    subscribe: callback => { listener = callback; return () => {}; }, onChanged: answer => received.push(answer) });
  const answer = { workspaceId: "one", folder: "other", isApp: false, run: null };
  listener(answer);
  listener({ ...answer, folder: "app/nested" });
  expect(received).toEqual([]);
  listener({ ...answer, folder: "app" });
  expect(received).toEqual([{ ...answer, folder: "app" }]);
  dispose();
});

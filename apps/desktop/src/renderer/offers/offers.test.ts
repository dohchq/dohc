import { describe, expect, it } from "vitest";
import { detectCsvBound, MAX_CSV_PREVIEW_ROWS } from "./csvBound";
import { agentRosterPickIsPresent, detectAgentAddressed, mapAgentRosterPick, type AddressedAgentFacts } from "./agentAddressed";
import { readFolderAppOffer } from "./folderApp";
const candidate = { id: "agent:default", kind: "agent" as const, handle: "agent", label: "Agent" };
const pick = { candidate, from: 0, to: 6 };
const facts: AddressedAgentFacts = { agentId: candidate.id, reach: null, runnerAvailable: false,
  runState: { mcpEnabled: false, activeRun: null, lastRun: null }, versionRunState: null };

describe("CSV preview offer", () => {
  it.each([0, MAX_CSV_PREVIEW_ROWS - 1, MAX_CSV_PREVIEW_ROWS])("does not offer at %i rows", totalRows => {
    expect(detectCsvBound({ path: "data.csv", totalRows, source: "workspace-file", complete: true })).toBeNull();
  });
  it("reports the cap and total data rows above the cap", () => {
    expect(detectCsvBound({ path: "data.csv", totalRows: 501, source: "workspace-file", complete: true }))
      .toEqual({ kind: "csv-bound", path: "data.csv", cap: 500, totalRows: 501, plainWorkspaceCsv: true });
  });
  it("excludes incomplete reads, received shares, datasets, non-CSV and invalid counts", () => {
    const base = { path: "data.csv", totalRows: 1000, source: "workspace-file" as const, complete: true };
    for (const override of [{ complete: false }, { source: "received-share" as const }, { source: "dataset" as const }, { path: "data.tsv" }, { path: "shared-with-me/team/data.csv" }, { path: "../data.csv" }, { totalRows: NaN }]) {
      expect(detectCsvBound({ ...base, ...override })).toBeNull();
    }
  });
});
describe("agent pick offer", () => {
  it("requires a roster pick and matching live agent facts", () => {
    expect(detectAgentAddressed(null, facts)).toBeNull(); // Typed @agent has no pick.
    expect(detectAgentAddressed({ ...pick, candidate: { ...candidate, kind: "user" } }, facts)).toBeNull();
    expect(detectAgentAddressed(pick, { ...facts, agentId: "other" })).toBeNull();
    expect(detectAgentAddressed(pick, facts)).toMatchObject({ agent: candidate, reach: null, runnerAvailable: false,
      tryInVersion: { available: false, reason: "no-recoverable-discard" } });
  });
  it("preserves actual reach and run state without inventing availability", () => {
    const run = { id: "run", agentId: "default", onBehalfOf: "person", startedAt: 1, status: "running" as const };
    expect(detectAgentAddressed(pick, { ...facts, reach: ["docs"], runnerAvailable: true, runState: { ...facts.runState, activeRun: run } }))
      .toMatchObject({ reach: ["docs"], runnerAvailable: true, runState: { activeRun: run } });
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
  it("keeps the added typing work within 16 ms per edit", () => {
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      mapAgentRosterPick(pick, { from: 6, to: 6, insertedLength: 1 });
      agentRosterPickIsPresent(pick, "@agent ");
      detectAgentAddressed(pick, facts);
      samples.push(performance.now() - start);
    }
    samples.sort((a,b) => a-b);
    console.log("Offer typing overhead ms", { p50: samples[500], p95: samples[950], max: samples[999] });
    expect(samples[950]).toBeLessThan(16);
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

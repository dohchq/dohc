import { expect, it } from "vitest";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { datasetChangeDigest, describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { describeCollectionChangeRow } from "../../workspaces/collectionChange";
import { applyCollectionChange, collectionChangeDigest, loadCollectionChange, readCollectionChangeProposal } from "./collectionChangeFlow";
import { ask, asked, base, claude, fixtureSources, ice, id, proposalPath, world, type World } from "./collectionChangeFlow.testHarness";

const { schemaSql, operationSource, migrationSql } = fixtureSources;
const load = async (place: World) => {
  const proposal = await readCollectionChangeProposal(place.api, "w", proposalPath);
  return proposal && loadCollectionChange(place.api, { workspaceId: "w", proposal, postedAtMs: 3_000 });
};

it("computes the digest the server checks", async () => {
  const next = describeDatasetRevision({ definition: asked, revision: 4, schemaSql, operationSource });
  await expect(collectionChangeDigest({ definition: asked, revision: 4, schemaSql, operationSource, migrationSql }))
    .resolves.toBe(datasetChangeDigest({ revisionSha256: next.revisionSha256, migrationSql }));
});

it("shows a collaborator's unapplied edit as its own row with its author", async () => {
  const place = world(); ask(place);
  const change = (await load(place))!;
  expect(change.state).toEqual({ kind: "waiting" });
  expect(change.rows.map(row => [describeCollectionChangeRow(row, "present").text, row.source?.author?.name, row.source?.atMs])).toEqual([
    ["Adds the field Due date", "Claude Code", 2_000],
    ["Removes the field Notes", "Claude Code", 2_000],
    ["Makes Email unique", "Ice", 1_000],
    ["Runs a migration on the 12 existing records", "Claude Code", 2_100],
  ]);
});

it("names each row's author as History does, and nobody where History names only where a change came from", async () => {
  const place = world(); ask(place);
  // History names an Edit link's write by its holder, calls an agent that gave no name "Agent",
  // and credits a change written straight to disk to nobody.
  const link = { kind: "link" as const, grantId: "grant-1", grantGeneration: 1, principalId: "3f9a2c1b7d" };
  place.moments[1] = place.moment(2, "volunteers/dataset.json", 1_000, { linkAuthor: link }, place.moments[1]!.afterText);
  place.moments[2] = place.moment(3, "volunteers/dataset.json", 2_000, { agentAuthorName: "Agent" }, JSON.stringify(asked));
  place.moments[3] = place.moment(4, place.moments[3]!.path, 2_100, {}, migrationSql);
  const change = (await load(place))!;
  expect(change.rows.map(row => [describeCollectionChangeRow(row, "present").text, row.source?.author ?? null])).toEqual([
    ["Adds the field Due date", { name: "Agent", agent: true }],
    ["Removes the field Notes", { name: "Agent", agent: true }],
    ["Makes Email unique", { name: "Edit link · holder 3f9a2c1b", agent: false }],
    ["Runs a migration on the 12 existing records", null],
  ]);
});

it("applies the rows the card showed, whatever the attached file says after it loaded", async () => {
  const place = world(); const proposal = ask(place);
  const change = (await load(place))!;
  // Someone with write access hides the deletion in the attached file.
  place.files[proposalPath] = JSON.stringify({ ...proposal, rows: proposal.rows.filter(row => row.kind !== "field-removed") });
  const reads = place.reads.length;
  await expect(applyCollectionChange(place.api, "w", change)).resolves.toMatchObject({ kind: "applied" });
  expect(place.reads.length).toBe(reads);
  expect(place.calls.find(call => call.action === "approveMigration")).toMatchObject({ changeSha256: proposal.changeSha256 });
  expect(place.head().revisionSha256).toBe(proposal.revisionSha256);
  expect((await load(place))!.state).toEqual({ kind: "applied", current: true });
});

it("applies nothing when the attached file hid part of the change before the card loaded", async () => {
  const place = world(); const proposal = ask(place);
  place.files[proposalPath] = JSON.stringify({ ...proposal, rows: proposal.rows.filter(row => row.kind !== "field-removed") });
  const change = (await load(place))!;
  expect(change.rows.some(row => row.kind === "field-removed")).toBe(false);
  await expect(applyCollectionChange(place.api, "w", change)).resolves.toEqual({ kind: "edited" });
  expect(place.actions().slice(-2)).toEqual(["prepareMigration", "discardMigration"]);
  expect(place.head().revisionSha256).toBe(base.revisionSha256);
});

it("applies nothing when the files changed after the card loaded, and then says who changed them", async () => {
  const place = world(); ask(place);
  const change = (await load(place))!;
  const later: DatasetDefinition = structuredClone(asked);
  later.tables[0]!.fields.push({ fieldId: id(10), name: "Phone", sqlColumn: "phone", type: "text", required: false, unique: false });
  place.files["volunteers/dataset.json"] = JSON.stringify(later);
  place.moments.push(place.moment(5, "volunteers/dataset.json", 4_000, { personAuthorName: "Ice" }, JSON.stringify(later)));
  await expect(applyCollectionChange(place.api, "w", change)).resolves.toEqual({ kind: "edited" });
  expect(place.actions()).not.toContain("approveMigration");
  expect(place.head().revisionSha256).toBe(base.revisionSha256);
  const reloaded = (await load(place))!;
  expect(reloaded.state).toEqual({ kind: "edited", by: ice, atMs: 4_000 });
  // The rows are still the ones the message asked about, made before it was sent.
  expect(reloaded.rows.map(row => row.source?.author)).toEqual([claude, claude, ice, claude]);
});

it("applies the change shown when records came after it loaded, and returns it as counted then", async () => {
  const place = world(); ask(place);
  const change = (await load(place))!;
  // A volunteer signed up without a note.
  place.recount(13, 12);
  const result = await applyCollectionChange(place.api, "w", change);
  expect(result.kind).toBe("applied");
  const applied = result.kind === "applied" ? result.proposal : null;
  expect(applied?.rows.map(row => describeCollectionChangeRow(row, "past").text)).toContain("Ran a migration on the 13 existing records");
  expect((await load(place))!.state).toEqual({ kind: "applied", current: true });
});

it("applies nothing when records changed after it loaded so that it deletes more than shown", async () => {
  const place = world(); ask(place);
  const change = (await load(place))!;
  place.recount(13);
  await expect(applyCollectionChange(place.api, "w", change)).resolves.toEqual({ kind: "deletes-more" });
  expect(place.actions().slice(-2)).toEqual(["prepareMigration", "discardMigration"]);
  expect(place.head().revisionSha256).toBe(base.revisionSha256);
});

it("is no change card for a file that isn't one", async () => {
  const place = world();
  place.files[proposalPath] = JSON.stringify({ kind: "something-else" });
  await expect(load(place)).resolves.toBeNull();
  expect(place.calls).toEqual([]);
});

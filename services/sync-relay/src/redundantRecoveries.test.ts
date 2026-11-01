import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASED_COPY_MOMENT_PREFIX } from "./storage/log";
import { claimWorkspace, closeTestStorages, inspect, jsonBody, request, storagePath, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const MARKDOWN = "# Plan\n\nKept from the stopped session.\n";
const MOMENT = `${RELEASED_COPY_MOMENT_PREFIX}${"c".repeat(64)}`;
const OBJECT = `released-copy-object-${"c".repeat(64)}`;

/** A copy of retained work's creation as an owner device publishes it, at `path` and `recordedAtMs`. */
function creation(path: string, recordedAtMs: number, overrides: Record<string, unknown> = {}) {
  return {originSeq: 0, opKind: "moment.append", recordedAtMs, payload: {
    momentId: MOMENT, versionId: "main", objectId: OBJECT, objectCreatedAtMs: recordedAtMs, path, recordedAtMs,
    operation: "write", payloadBeforeBlobSha256: null, payloadBeforePath: null, payloadAfterBlobSha256: sha256(MARKDOWN),
    payloadAfterPath: path, payloadBeforeContentKind: null, payloadBeforeByteLength: null, payloadAfterContentKind: "text",
    payloadAfterByteLength: Buffer.byteLength(MARKDOWN),
    metadata: {origin: "sync", summary: "Kept unsaved edits from notes/plan.md before a later change could remove them.",
      correlationId: "b".repeat(64)},
    authors: null, beforePresent: "null", ...overrides}};
}

async function relay() {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  for (const text of [MARKDOWN, "# Plan\n\nOther.\n"]) {
    storage.putBlob({workspaceId: "workspace", sha256: sha256(text), content: Buffer.from(text), createdAtMs: 1});
  }
  const push = async (originId: string, op: ReturnType<typeof creation>) => {
    const response = await handler(request("owner", "/sync/workspace/log", jsonBody({originId, ops: [op]})));
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as Record<string, unknown>;
  };
  const projected = () => inspect(storagePath(storage), db => ({
    paths: db.prepare("SELECT path FROM sync_relay_object_paths WHERE workspace_id='workspace' AND object_id=?").all(OBJECT),
    moments: db.prepare("SELECT relay_seq FROM sync_relay_object_moments WHERE workspace_id='workspace' AND object_id=?").all(OBJECT),
    log: db.prepare("SELECT origin_id, relay_seq FROM sync_relay_log WHERE workspace_id='workspace' ORDER BY relay_seq").all(),
  }));
  return {push, projected};
}

describe("a copy of retained work published by two owner devices", () => {
  it("keeps the second publication's coordinate, names the accepted creation, and projects only the first", async () => {
    const f = await relay();
    const first = await f.push("device-a", creation("notes/plan (recovered).md", 10));
    expect(first).toMatchObject({inserted: 1});
    expect(first).not.toHaveProperty("redundantRecoveries");
    const acceptedRelaySeq = Number((f.projected().log[0] as {relay_seq: number}).relay_seq);

    // The other device chose another path and recorded at another time: still the same copy.
    const second = await f.push("device-b", creation("notes/plan (recovered 2).md", 20));
    const redundant = [{originSeq: 0, recoveryMomentId: MOMENT, acceptedOriginId: "device-a", acceptedOriginSeq: 0, acceptedRelaySeq}];
    expect(second).toMatchObject({inserted: 1, redundantRecoveries: redundant});
    expect(second).not.toHaveProperty("refusals");
    // A retry after a lost answer derives the same result.
    expect(await f.push("device-b", creation("notes/plan (recovered 2).md", 20))).toMatchObject({inserted: 0, skipped: 1, redundantRecoveries: redundant});

    const projected = f.projected();
    expect(projected.log.map(row => (row as {origin_id: string}).origin_id)).toEqual(["device-a", "device-b"]);
    expect(projected.paths).toEqual([{path: "notes/plan (recovered).md"}]);
    expect(projected.moments).toEqual([{relay_seq: acceptedRelaySeq}]);
    // The first device's own retry names nothing redundant.
    expect(await f.push("device-a", creation("notes/plan (recovered).md", 10))).not.toHaveProperty("redundantRecoveries");
  });

  it.each([
    ["other bytes", {payloadAfterBlobSha256: sha256("# Plan\n\nOther.\n"), payloadAfterByteLength: Buffer.byteLength("# Plan\n\nOther.\n")}],
    ["another correlation", {metadata: {origin: "sync", summary: null, correlationId: "e".repeat(64)}}],
    ["authors the first left out", {authors: [{kind: "agent", agentId: "agent", agentName: "Agent"}]}],
    ["attribution withheld", {attributionUnavailable: {settlementId: "unavailable", reason: "unproven-hosted-authors"}}],
    ["another moment kind", {momentId: "ordinary-moment"}],
  ])("never treats a creation with %s as redundant", async (_case, overrides) => {
    const f = await relay();
    await f.push("device-a", creation("notes/plan (recovered).md", 10));
    const other = await f.push("device-b", creation("notes/plan (recovered 2).md", 20, overrides));
    expect(other).not.toHaveProperty("redundantRecoveries");
  });

  // Sol's Ruling A: a copy credits the authors of the retained work it keeps,
  // and only the same authorship names the same copy.
  const authors = [{kind: "agent", agentId: "earlier-agent", onBehalfOf: "owner", depth: 1},
    {kind: "agent", agentId: "trip-agent", onBehalfOf: "owner", depth: 1}];
  it("treats a creation crediting the same authors as redundant, in any key order", async () => {
    const f = await relay();
    await f.push("device-a", creation("notes/plan (recovered).md", 10, {authors}));
    const reordered = authors.map(author => Object.fromEntries(Object.entries(author).reverse()));
    const second = await f.push("device-b", creation("notes/plan (recovered 2).md", 20, {authors: reordered}));
    expect(second).toHaveProperty("redundantRecoveries");
  });

  it.each([
    ["one author fewer", authors.slice(1)],
    ["another author", [authors[0], {...authors[1], agentId: "stranger"}]],
    ["no authors", null],
  ])("never treats a creation crediting %s as redundant", async (_case, other) => {
    const f = await relay();
    await f.push("device-a", creation("notes/plan (recovered).md", 10, {authors}));
    const second = await f.push("device-b", creation("notes/plan (recovered 2).md", 20, {authors: other}));
    expect(second).not.toHaveProperty("redundantRecoveries");
  });
});

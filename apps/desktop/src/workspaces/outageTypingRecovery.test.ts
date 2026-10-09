import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createTestScratch } from "./testTemp";
import { hasRetainedLiveDraft } from "./liveDraftRecovery";
import { typingRecoveryStateVectorSha256, writeTypingCheckpoint, readTypingCheckpoints, retireTypingCheckpoint, importTypingCheckpoints, flushTypingCheckpoints, registerTypingCheckpoint, type OutageTypingCheckpoint } from "./outageTypingRecovery";
const checkpoint: OutageTypingCheckpoint = {version: 2, workspaceId: "workspace", versionId: "main", objectId: "object", path: "note.md", expectedClaimId: "claim", expectedStateVectorSha256: "a".repeat(64), expectedDiskSha256: "b".repeat(64), text: "typing", updateBase64: "AAA=", admittedBaseBase64: "AAA=", updates: [{requestId: "original", updateBase64: "AAA=", actorOriginId: "person", attribution: {actorKind: "human", onBehalfOf: "person", depth: 0}}]};
it("persists originals and admitted base before exit and replaces the same record during outage edits", async () => {
 const directory = await createTestScratch("typing-checkpoint-");
 await writeTypingCheckpoint(directory, checkpoint);
 await writeTypingCheckpoint(directory, {...checkpoint, text: "more typing"});
 const rows = await readTypingCheckpoints(directory, "workspace");
 expect(rows).toHaveLength(1); expect(rows[0]!.checkpoint.text).toBe("more typing");
 expect(rows[0]!.checkpoint.updates).toEqual(checkpoint.updates);
 expect(await hasRetainedLiveDraft(directory, "workspace", "renamed.md", "object")).toBe(true);
});
it.each(["replayed", "covered", "imported"] as const)("retires only the exact committed checkpoint (%s), refreshing recovery status", async outcome => {
 const directory = await createTestScratch("typing-retire-"); await writeTypingCheckpoint(directory, checkpoint);
 const refresh = vi.fn(); const failure = vi.fn();
 await importTypingCheckpoints(directory, "workspace", async input => {expect(input.updates).toEqual(checkpoint.updates); return {committed: true, outcome, momentId: outcome === "imported" ? "moment" : null};}, failure, refresh);
 expect(await readTypingCheckpoints(directory, "workspace")).toEqual([]); expect(refresh).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
 expect(await hasRetainedLiveDraft(directory, "workspace", "note.md", "object")).toBe(false);
});
it("keeps a newer checkpoint written while the engine answers an older import", async () => {
 const directory = await createTestScratch("typing-race-"); await writeTypingCheckpoint(directory, checkpoint);
 const row = (await readTypingCheckpoints(directory, "workspace"))[0]!;
 await writeTypingCheckpoint(directory, {...checkpoint, text: "newer typing"}); await retireTypingCheckpoint(row);
 expect((await readTypingCheckpoints(directory, "workspace"))[0]!.checkpoint.text).toBe("newer typing");
});
it("keeps a refused import for retry and reports one failure without failing workspace launch", async () => {
 const directory = await createTestScratch("typing-refused-"); await writeTypingCheckpoint(directory, checkpoint);
 const failure = vi.fn(); const refresh = vi.fn();
 await importTypingCheckpoints(directory, "workspace", async () => {throw Error("capture-recovery-refused:remote-human-author");}, failure, refresh);
 expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind: "import", path: "note.md"})); expect(refresh).not.toHaveBeenCalled();
 expect(await readTypingCheckpoints(directory, "workspace")).toHaveLength(1);
});
it("keeps memory available when the checkpoint write fails and retries the actual condition", async () => {
 const directory = await createTestScratch("typing-failure-"); const blocked = join(directory, "blocked"); await writeFile(blocked, "file");
 const flush = vi.fn(() => writeTypingCheckpoint(blocked, checkpoint)); const unregister = registerTypingCheckpoint("workspace", flush);
 try {await expect(flushTypingCheckpoints("workspace")).rejects.toThrow(); await rm(blocked); await mkdir(blocked); await flushTypingCheckpoints("workspace"); expect(await readTypingCheckpoints(blocked, "workspace")).toHaveLength(1);} finally {unregister();}
});
it("rejects tampered authors and does not send a malformed record to the engine", async () => {
 const directory = await createTestScratch("typing-invalid-"); await writeTypingCheckpoint(directory, checkpoint);
 const row = (await readTypingCheckpoints(directory, "workspace"))[0]!; const raw = JSON.parse(await readFile(row.file, "utf8")); raw.updates[0].attribution.actorKind = "remote-person"; await writeFile(row.file, JSON.stringify(raw));
 await expect(readTypingCheckpoints(directory, "workspace")).rejects.toThrow();
});

it("serializes exact retirement with a concurrent checkpoint rewrite", async () => {
 const directory = await createTestScratch("typing-concurrent-"); await writeTypingCheckpoint(directory, checkpoint);
 const row = (await readTypingCheckpoints(directory, "workspace"))[0]!;
 await Promise.all([retireTypingCheckpoint(row), writeTypingCheckpoint(directory, {...checkpoint, text: "new typing"})]);
 expect((await readTypingCheckpoints(directory, "workspace"))[0]!.checkpoint.text).toBe("new typing");
});

it("refreshes only the committed record when another import is refused", async () => {
 const directory = await createTestScratch("typing-partial-");
 await writeTypingCheckpoint(directory, checkpoint);
 await writeTypingCheckpoint(directory, {...checkpoint, objectId: "other", path: "other.md"});
 const failures = new Map<string, string>();
 await importTypingCheckpoints(directory, "workspace", async input => {
  if (input.path === "note.md") throw Error("typed refusal");
  return {committed: true, outcome: "covered", momentId: null};
 }, failure => failures.set(failure.path, failure.detail), path => failures.delete(path));
 expect([...failures.keys()]).toEqual(["note.md"]);
 expect((await readTypingCheckpoints(directory, "workspace")).map(row => row.checkpoint.path)).toEqual(["note.md"]);
});

it("hashes state vectors in the engine's canonical client order", () => {
  const ascending = new Uint8Array([2, 1, 3, 2, 4]);
  const descending = new Uint8Array([2, 2, 4, 1, 3]);
  const engineDigest = createHash("sha256").update(ascending).digest("hex");
  expect(typingRecoveryStateVectorSha256(descending)).toBe(engineDigest);
  expect(typingRecoveryStateVectorSha256(ascending)).toBe(engineDigest);
});

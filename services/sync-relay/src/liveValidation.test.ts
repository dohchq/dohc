import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createLiveValidationExecutor } from "./liveValidation.js";

const {encodeStateAsUpdate} = createRequire(new URL("../../../packages/ydoc-projection/package.json", import.meta.url))("yjs") as {
  encodeStateAsUpdate(doc: ReturnType<typeof markdownToYDoc>): Uint8Array;
};
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {await Promise.all(pools.splice(0).map(pool => pool.close()));});
function fixture() {
  const pool = createLiveValidationExecutor(); pools.push(pool);
  const doc = markdownToYDoc("A **shared** document");
  const checkpoint = encodeStateAsUpdate(doc); doc.destroy();
  const input = {document: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"},
    currentPath: "note.md", checkpoint, suffix: [], candidate: Uint8Array.of(0, 0)};
  return {pool, input, validate: pool.validator(policy)};
}
it("runs the same validator without blocking the event loop or detaching input", async () => {
  const {input, validate} = fixture(), expected = createLiveMarkdownJournalValidator(policy)(input);
  expect(expected.kind).toBe("accepted");
  const original = input.checkpoint.slice(); let completed = false;
  const pending = Promise.resolve(validate(input)).then(result => {completed = true; return result;});
  await setImmediate(); expect(completed).toBe(false);
  expect(await pending).toEqual(expected); expect(input.checkpoint).toEqual(original);
  expect(await validate({...input, candidate: Uint8Array.of(255)})).toEqual(createLiveMarkdownJournalValidator(policy)({...input, candidate: Uint8Array.of(255)}));
});
it("bounds concurrent work, cancels active jobs, and closes without dangling requests", async () => {
  const {pool, input, validate} = fixture(), abort = new AbortController();
  const first = Promise.resolve(validate(input, abort.signal));
  const rejected = expect(first).rejects.toThrow("cancelled");
  const second = Promise.resolve(validate(input));
  const busy = await validate(input);
  expect(busy).toMatchObject({kind: "retry", reason: "admission-unavailable"});
  if (busy.kind !== "retry") throw Error("Expected busy pool");
  let ready = false;
  const available = busy.waitForCapacity().then(() => {ready = true;});
  const cancelled = new AbortController();
  const cancelWait = expect(busy.waitForCapacity(cancelled.signal)).rejects.toThrow("stop waiting");
  cancelled.abort(new Error("stop waiting")); await cancelWait;
  expect(ready).toBe(false);
  abort.abort(new Error("cancelled")); await rejected;
  await available;
  expect((await second).kind).toBe("accepted");
  const active = Promise.resolve(validate(input)); const closing = expect(active).rejects.toThrow("exited");
  await pool.close(); await closing;
  await expect(validate(input)).rejects.toThrow("closed");
});

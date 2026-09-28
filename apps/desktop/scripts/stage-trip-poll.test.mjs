import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stageTripPoll } from "./stage-trip-poll.mjs";
import { compileClosedApp } from "../src/workspaces/closedAppCompiler.ts";

test("stages a captured React app that the production compiler can build", async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-trip-poll-example-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const {appRoot, declaration} = await stageTripPoll(root);
  assert.equal(declaration.version, 1);
  await assert.rejects(stageTripPoll(root), /already exists/);
  const inputs = await Promise.all(declaration.inputs.map(async path => {
    const bytes = await readFile(join(appRoot, path)); return {path, bytes, sha256: createHash("sha256").update(bytes).digest("hex")};
  }));
  const result = await compileClosedApp({entryPath: declaration.entryPath, inputs, packageMap: declaration.packageMap,
    bounds: {maxInputFiles: 512, maxInputBytes: 128 * 1024 * 1024, maxOutputBytes: 32 * 1024 * 1024}});
  assert.deepEqual(result.files.map(file => file.path), ["bundle.css", "bundle.js"]);
  assert.match(Buffer.from(result.files[1].bytes).toString(), /collection\.create/);
  assert.equal(declaration.collection.collectionPath, "responses");
  assert.match(await readFile(join(root, "trip-poll/responses/collection.yaml"), "utf8"), /options: \[Tokyo, Manila\]/);
});

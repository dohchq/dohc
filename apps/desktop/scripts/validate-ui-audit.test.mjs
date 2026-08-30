import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expectedUiAuditShots,
  readPngDimensions,
  validateUiAuditDirectory,
} from "./validate-ui-audit.mjs";

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("reads dimensions from the PNG IHDR header", () => {
  assert.deepEqual(readPngDimensions(pngHeader(1920, 1200)), {
    width: 1920,
    height: 1200,
  });
});

test("rejects a missing or malformed PNG header", () => {
  assert.throws(() => readPngDimensions(Buffer.alloc(24)), /not a PNG file/);
  assert.throws(() => readPngDimensions(Buffer.alloc(8)), /not a PNG file/);
});

test("attributes each validated screenshot to its filesystem capture time", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capturedAt = new Date("2026-08-30T04:00:00.000Z");
  const image = Buffer.alloc(10_001);
  pngHeader(1920, 1200).copy(image);

  await Promise.all(
    expectedUiAuditShots.map(async (name) => {
      const path = join(directory, name);
      await writeFile(path, image);
      await utimes(path, capturedAt, capturedAt);
    }),
  );

  const result = validateUiAuditDirectory(directory);
  assert.equal(result.shots.length, expectedUiAuditShots.length);
  assert.equal(result.shots[0].modifiedAt, capturedAt.toISOString());
});

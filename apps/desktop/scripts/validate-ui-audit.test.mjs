import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expectedUiAuditShots,
  readPngDimensions,
  uiAuditCaptureManifestName,
  validateUiAuditDirectory,
} from "./validate-ui-audit.mjs";

const COMMIT = "a".repeat(40);
const BUNDLES = {
  mainSha256: "1".repeat(64),
  rendererTreeSha256: "2".repeat(64),
  engineSha256: "3".repeat(64),
};

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function writeAuditShots(directory, image) {
  await Promise.all(
    expectedUiAuditShots.map((name) => writeFile(join(directory, name), image)),
  );
}

async function writeCaptureManifest(
  directory,
  image,
  {
    commit = COMMIT,
    startedAt = new Date(Date.now() - 1_000),
    completedAt = new Date(Date.now() + 1_000),
    state = "complete",
    bundles = BUNDLES,
  } = {},
) {
  const sha256 = createHash("sha256").update(image).digest("hex");
  await writeFile(
    join(directory, uiAuditCaptureManifestName),
    `${JSON.stringify({
      schemaVersion: 1,
      state,
      commit,
      startedAt: startedAt.toISOString(),
      completedAt: state === "complete" ? completedAt.toISOString() : null,
      bundles,
      shots: expectedUiAuditShots.map((name) => ({ name, sha256 })),
    })}\n`,
  );
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
  const noIhdr = pngHeader(1920, 1200);
  noIhdr.write("IDAT", 12, "ascii");
  assert.throws(() => readPngDimensions(noIhdr), /PNG has no IHDR header/);
});

test("rejects a capture below the byte floor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(64);
  pngHeader(1920, 1200).copy(image);
  await writeAuditShots(directory, image);
  await writeCaptureManifest(directory, image);

  assert.throws(
    () => validateUiAuditDirectory(directory, COMMIT, BUNDLES),
    /capture may be blank/,
  );
});

test("rejects a capture below the dimension floor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(10_001);
  pngHeader(999, 700).copy(image);
  await writeAuditShots(directory, image);
  await writeCaptureManifest(directory, image);

  assert.throws(
    () => validateUiAuditDirectory(directory, COMMIT, BUNDLES),
    /expected at least 1000x700/,
  );
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
  await writeCaptureManifest(directory, image, {
    startedAt: new Date(capturedAt.getTime() - 1_000),
    completedAt: new Date(capturedAt.getTime() + 1_000),
  });

  const result = validateUiAuditDirectory(directory, COMMIT, BUNDLES);
  assert.equal(result.shots.length, expectedUiAuditShots.length);
  assert.equal(result.shots[0].modifiedAt, capturedAt.toISOString());
  assert.equal(
    result.shots[0].sha256,
    createHash("sha256").update(image).digest("hex"),
  );
});

test("rejects screenshots captured from a different commit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(10_001);
  pngHeader(1920, 1200).copy(image);
  await writeAuditShots(directory, image);
  await writeCaptureManifest(directory, image, { commit: "b".repeat(40) });

  assert.throws(
    () => validateUiAuditDirectory(directory, COMMIT, BUNDLES),
    /screenshots were captured from b{40}; expected a{40}/,
  );
});

test("rejects a screenshot changed after capture", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(10_001);
  pngHeader(1920, 1200).copy(image);
  await writeAuditShots(directory, image);
  await writeCaptureManifest(directory, image);
  const changed = Buffer.from(image);
  changed[100] = 1;
  await writeFile(join(directory, expectedUiAuditShots[0]), changed);

  assert.throws(
    () => validateUiAuditDirectory(directory, COMMIT, BUNDLES),
    /does not match its capture manifest/,
  );
});

test("rejects an incomplete capture", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(10_001);
  pngHeader(1920, 1200).copy(image);
  await writeAuditShots(directory, image);
  await writeCaptureManifest(directory, image, { state: "in-progress" });

  assert.throws(
    () => validateUiAuditDirectory(directory, COMMIT, BUNDLES),
    /has an invalid shape/,
  );
});

test("rejects screenshots from a different desktop build", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(10_001);
  pngHeader(1920, 1200).copy(image);
  await writeAuditShots(directory, image);
  await writeCaptureManifest(directory, image);

  assert.throws(
    () =>
      validateUiAuditDirectory(directory, COMMIT, {
        ...BUNDLES,
        rendererTreeSha256: "4".repeat(64),
      }),
    /rendererTreeSha256 does not match the current desktop build/,
  );
});

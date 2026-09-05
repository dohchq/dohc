import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expectedUiAuditShots,
  readPngDimensions,
  uiAuditCaptureManifestName,
  validateUiAuditDirectory,
} from "./validate-ui-audit.mjs";
import {
  currentUiAuditBundles,
  readUiAuditBuildProvenance,
  sha256Tree,
  writeUiAuditBuildProvenance,
} from "./ui-audit-build-provenance.mjs";
import { pnpmInvocation } from "./pnpm-invocation.mjs";

const COMMIT = "a".repeat(40);
const BUNDLES = {
  mainTreeSha256: "1".repeat(64),
  preloadTreeSha256: "2".repeat(64),
  rendererTreeSha256: "3".repeat(64),
  engineSha256: "4".repeat(64),
};
const BUILD = {
  schemaVersion: 1,
  commit: COMMIT,
  builtAt: "2026-08-30T03:59:00.000Z",
  bundles: BUNDLES,
};

test("runs the inherited pnpm JavaScript CLI without a shell", () => {
  assert.deepEqual(
    pnpmInvocation(["--filter", "@dohc/desktop", "build"], {
      nodeExecutable: "/Program Files/node",
      pnpmCli: "/Package Tools/pnpm.mjs",
    }),
    {
      command: "/Program Files/node",
      args: [
        "/Package Tools/pnpm.mjs",
        "--filter",
        "@dohc/desktop",
        "build",
      ],
    },
  );
});

test("refuses to fall back to a shell or another package manager", () => {
  assert.throws(
    () => pnpmInvocation(["--version"], { pnpmCli: "" }),
    /through its pnpm package script/,
  );
  assert.throws(
    () => pnpmInvocation(["--version"], { pnpmCli: "/tools/npm-cli.js" }),
    /through its pnpm package script/,
  );
});

test(
  "the inherited pnpm CLI is directly executable by Node",
  { skip: !process.env.npm_execpath },
  () => {
    const invocation = pnpmInvocation(["--version"]);
    const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^11\.20\.0$/);
  },
);

test("hashes build trees in locale-independent code-unit order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-tree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, "Z.js"), "upper"),
    writeFile(join(directory, "a.js"), "lower"),
  ]);
  const fileHash = (content) => createHash("sha256").update(content).digest("hex");
  const expected = createHash("sha256")
    .update([`Z.js\0${fileHash("upper")}`, `a.js\0${fileHash("lower")}`].join("\n"))
    .digest("hex");

  assert.equal(sha256Tree(directory), expected);
});

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
    build = BUILD,
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
      build,
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
        preloadTreeSha256: "5".repeat(64),
      }),
    /preloadTreeSha256 does not match the current desktop build/,
  );
});

test("rejects screenshots whose build stamp names a different commit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-ui-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = Buffer.alloc(10_001);
  pngHeader(1920, 1200).copy(image);
  await writeAuditShots(directory, image);
  await writeCaptureManifest(directory, image, {
    build: { ...BUILD, commit: "b".repeat(40) },
  });

  assert.throws(
    () => validateUiAuditDirectory(directory, COMMIT, BUNDLES, BUILD),
    /does not match the verified desktop build/,
  );
});

test("binds every main and preload artifact to the build stamp", async (t) => {
  const desktopRoot = await mkdtemp(join(tmpdir(), "dohc-ui-audit-build-"));
  t.after(() => rm(desktopRoot, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(desktopRoot, "dist/main"), { recursive: true }),
    mkdir(join(desktopRoot, "dist/preload"), { recursive: true }),
    mkdir(join(desktopRoot, "dist/renderer"), { recursive: true }),
    mkdir(join(desktopRoot, "target/debug"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(desktopRoot, "dist/main/main.js"), "main"),
    writeFile(join(desktopRoot, "dist/preload/preload.cjs"), "preload"),
    writeFile(join(desktopRoot, "dist/renderer/index.js"), "renderer"),
    writeFile(join(desktopRoot, "target/debug/dohc-workspace-engine"), "engine"),
  ]);
  const bundles = currentUiAuditBundles(desktopRoot, "linux");
  const distBefore = sha256Tree(join(desktopRoot, "dist"));
  writeUiAuditBuildProvenance(
    desktopRoot,
    COMMIT,
    bundles,
    "2026-08-30T03:59:00.000Z",
  );
  assert.equal(sha256Tree(join(desktopRoot, "dist")), distBefore);
  assert.deepEqual(
    readUiAuditBuildProvenance(desktopRoot, COMMIT, bundles).bundles,
    bundles,
  );

  await writeFile(join(desktopRoot, "dist/main/lazy-chunk.js"), "new main chunk");
  assert.throws(
    () =>
      readUiAuditBuildProvenance(
        desktopRoot,
        COMMIT,
        currentUiAuditBundles(desktopRoot, "linux"),
      ),
    /mainTreeSha256 does not match the current desktop build/,
  );
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  PINNED_ESBUILD_VERSION,
  PINNED_PNPM_VERSION,
  esbuildPlatformPackageName,
  stagePluginTools,
} from "./stage-plugin-tools.mjs";

const roots = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dohc-stage-plugin-tools-"));
  roots.push(root);
  return root;
}

async function write(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

async function createSources(
  root,
  {
    pnpmVersion = PINNED_PNPM_VERSION,
    esbuildVersion = PINNED_ESBUILD_VERSION,
    platformVersion = PINNED_ESBUILD_VERSION,
    includePlatform = true,
  } = {},
) {
  const nodeModulesRoot = join(root, "node_modules");
  const platformKey = esbuildPlatformPackageName().slice("@esbuild/".length);
  await Promise.all([
    write(join(nodeModulesRoot, "pnpm", "package.json"), JSON.stringify({ version: pnpmVersion })),
    write(join(nodeModulesRoot, "pnpm", "LICENSE"), "pnpm license\n"),
    write(join(nodeModulesRoot, "pnpm", "README.md"), "must not be staged\n"),
    write(join(nodeModulesRoot, "pnpm", "bin", "pnpm.mjs"), "pnpm entry\n"),
    write(join(nodeModulesRoot, "pnpm", "dist", "pnpm.cjs"), "pnpm dist\n"),
    write(
      join(nodeModulesRoot, "esbuild", "package.json"),
      JSON.stringify({ version: esbuildVersion }),
    ),
    write(join(nodeModulesRoot, "esbuild", "LICENSE.md"), "esbuild license\n"),
    write(join(nodeModulesRoot, "esbuild", "bin", "esbuild"), "launcher\n"),
    write(join(nodeModulesRoot, "esbuild", "lib", "main.js"), "esbuild main\n"),
  ]);
  if (includePlatform) {
    await Promise.all([
      write(
        join(nodeModulesRoot, "@esbuild", platformKey, "package.json"),
        JSON.stringify({ version: platformVersion }),
      ),
      write(join(nodeModulesRoot, "@esbuild", platformKey, "bin", "esbuild"), "binary\n"),
    ]);
  }
  return { nodeModulesRoot, platformKey };
}

async function treeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await treeFiles(root, path));
    else files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

test("missing source packages fail loudly", async () => {
  const root = await scratch();
  await assert.rejects(
    stagePluginTools({
      desktopRoot: root,
      nodeModulesRoot: join(root, "node_modules"),
      destinationRoot: join(root, "staged"),
    }),
    /pnpm@11\.20\.0 source package was not found.*package\.json/i,
  );

  const source = await createSources(root, { includePlatform: false });
  await assert.rejects(
    stagePluginTools({
      desktopRoot: root,
      nodeModulesRoot: source.nodeModulesRoot,
      destinationRoot: join(root, "staged"),
    }),
    /@esbuild\/.*@0\.28\.1 source package could not be resolved from esbuild/i,
  );
});

test("wrong source package versions name the found and expected versions", async () => {
  const root = await scratch();
  let source = await createSources(root, { pnpmVersion: "11.19.0" });
  const options = {
    desktopRoot: root,
    nodeModulesRoot: source.nodeModulesRoot,
    destinationRoot: join(root, "staged"),
  };
  await assert.rejects(
    stagePluginTools(options),
    /pnpm version mismatch: expected 11\.20\.0, found 11\.19\.0/,
  );

  await rm(source.nodeModulesRoot, { recursive: true, force: true });
  source = await createSources(root, { esbuildVersion: "0.28.0" });
  await assert.rejects(
    stagePluginTools({ ...options, nodeModulesRoot: source.nodeModulesRoot }),
    /esbuild version mismatch: expected 0\.28\.1, found 0\.28\.0/,
  );

  await rm(source.nodeModulesRoot, { recursive: true, force: true });
  source = await createSources(root, { platformVersion: "0.27.0" });
  await assert.rejects(
    stagePluginTools({ ...options, nodeModulesRoot: source.nodeModulesRoot }),
    /@esbuild\/.*version mismatch: expected 0\.28\.1, found 0\.27\.0/,
  );
});

test("a successful run stages exactly the required pnpm and esbuild trees", async () => {
  const root = await scratch();
  const source = await createSources(root);
  const destinationRoot = join(root, "staged");

  const result = await stagePluginTools({
    desktopRoot: root,
    nodeModulesRoot: source.nodeModulesRoot,
    destinationRoot,
  });

  assert.deepEqual(await treeFiles(destinationRoot), [
    `esbuild/${source.platformKey}/node_modules/@esbuild/${source.platformKey}/bin/esbuild`,
    `esbuild/${source.platformKey}/node_modules/@esbuild/${source.platformKey}/package.json`,
    `esbuild/${source.platformKey}/node_modules/esbuild/LICENSE.md`,
    `esbuild/${source.platformKey}/node_modules/esbuild/bin/esbuild`,
    `esbuild/${source.platformKey}/node_modules/esbuild/lib/main.js`,
    `esbuild/${source.platformKey}/node_modules/esbuild/package.json`,
    "pnpm/LICENSE",
    "pnpm/bin/pnpm.mjs",
    "pnpm/dist/pnpm.cjs",
    "pnpm/package.json",
  ]);
  assert.match(result.pnpm.sha512, /^[0-9a-f]{128}$/);
  assert.match(result.esbuild.sha512, /^[0-9a-f]{128}$/);
});

test("re-running overwrites cleanly without retaining stale output", async () => {
  const root = await scratch();
  const source = await createSources(root);
  const destinationRoot = join(root, "staged");
  const options = {
    desktopRoot: root,
    nodeModulesRoot: source.nodeModulesRoot,
    destinationRoot,
  };
  const first = await stagePluginTools(options);
  await write(join(destinationRoot, "pnpm", "stale.txt"), "stale\n");
  await write(join(source.nodeModulesRoot, "pnpm", "dist", "pnpm.cjs"), "updated dist\n");

  const second = await stagePluginTools(options);

  assert.equal(await readFile(join(destinationRoot, "pnpm", "dist", "pnpm.cjs"), "utf8"), "updated dist\n");
  assert.equal((await treeFiles(destinationRoot)).includes("pnpm/stale.txt"), false);
  assert.notEqual(second.pnpm.sha512, first.pnpm.sha512);
});

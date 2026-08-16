import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  PINNED_ESBUILD_VERSION,
  PINNED_PNPM_VERSION,
  aggregateTreeSha512,
  esbuildPlatformPackageName,
  parseStagingTarget,
  stagePluginTools,
  stagePluginToolsFromArgv,
} from "./stage-plugin-tools.mjs";

const roots = [];

test.afterEach(async () => {
  // A test that holds a file open on Windows leaves a directory that cannot be
  // deleted. The temporary directory is not the subject of any test.
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => {})),
  );
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
    platformKeys = [],
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
  const stagedKeys = includePlatform
    ? [platformKey, ...platformKeys]
    : platformKeys;
  for (const key of stagedKeys) {
    await Promise.all([
      write(
        join(nodeModulesRoot, "@esbuild", key, "package.json"),
        JSON.stringify({ version: platformVersion }),
      ),
      write(join(nodeModulesRoot, "@esbuild", key, "bin", "esbuild"), `${key} binary\n`),
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

async function siblingScratchDirectories(root) {
  const entries = await readdir(root);
  return entries.filter((name) => name.startsWith("staged.")).sort();
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

test("--platform and --arch stage the target architecture's esbuild binary", async () => {
  const root = await scratch();
  const source = await createSources(root, {
    platformKeys: ["darwin-arm64", "darwin-x64"],
  });
  const destinationRoot = join(root, "staged");

  // Cross-arch packaging: an x64 mac runner building the arm64 artifact.
  const result = await stagePluginToolsFromArgv(
    ["--platform=darwin", "--arch=arm64"],
    {
      desktopRoot: root,
      nodeModulesRoot: source.nodeModulesRoot,
      destinationRoot,
    },
  );

  assert.equal(result.platformPackage, "@esbuild/darwin-arm64");
  const staged = await treeFiles(destinationRoot);
  assert.equal(
    staged.includes(
      "esbuild/darwin-arm64/node_modules/@esbuild/darwin-arm64/bin/esbuild",
    ),
    true,
  );
  assert.equal(
    staged.some((path) => path.includes("darwin-x64") || path.includes(source.platformKey)),
    false,
  );
  assert.equal(
    await readFile(
      join(
        destinationRoot,
        "esbuild",
        "darwin-arm64",
        "node_modules",
        "@esbuild",
        "darwin-arm64",
        "bin",
        "esbuild",
      ),
      "utf8",
    ),
    "darwin-arm64 binary\n",
  );
});

test("a target architecture with no installed esbuild package fails loudly", async () => {
  const root = await scratch();
  const source = await createSources(root);

  await assert.rejects(
    stagePluginToolsFromArgv(["--platform=darwin", "--arch=arm64"], {
      desktopRoot: root,
      nodeModulesRoot: source.nodeModulesRoot,
      destinationRoot: join(root, "staged"),
    }),
    /@esbuild\/darwin-arm64@0\.28\.1 source package could not be resolved from esbuild/,
  );

  await assert.rejects(
    stagePluginToolsFromArgv(["--platform=darwin", "--arch=sparc"], {
      desktopRoot: root,
      nodeModulesRoot: source.nodeModulesRoot,
      destinationRoot: join(root, "staged"),
    }),
    /has no staged binary package for platform darwin\/sparc/,
  );
});

test("staging target arguments parse into a platform and arch", () => {
  assert.deepEqual(parseStagingTarget([]), {});
  assert.deepEqual(parseStagingTarget(["--platform=darwin", "--arch=arm64"]), {
    platform: "darwin",
    arch: "arm64",
  });
  assert.throws(
    () => parseStagingTarget(["--arch"]),
    /Unsupported stage-plugin-tools argument "--arch"/,
  );
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

  assert.equal(second.swapped, true);
  assert.equal(await readFile(join(destinationRoot, "pnpm", "dist", "pnpm.cjs"), "utf8"), "updated dist\n");
  assert.equal((await treeFiles(destinationRoot)).includes("pnpm/stale.txt"), false);
  assert.notEqual(second.pnpm.sha512, first.pnpm.sha512);
  assert.deepEqual(await siblingScratchDirectories(root), []);
});

test("a staged tree that already matches the source is left in place", async () => {
  const root = await scratch();
  const source = await createSources(root);
  const destinationRoot = join(root, "staged");
  const options = {
    desktopRoot: root,
    nodeModulesRoot: source.nodeModulesRoot,
    destinationRoot,
  };
  const first = await stagePluginTools(options);

  // A delete and re-copy cannot preserve either mark: fs.cp writes a new file
  // with the current time. Digests ignore both, so the trees still match.
  const stagedEntry = join(destinationRoot, "pnpm", "dist", "pnpm.cjs");
  const marked = new Date("2001-02-03T04:05:06.000Z");
  await utimes(stagedEntry, marked, marked);
  const before = await stat(stagedEntry);

  const second = await stagePluginTools(options);

  const after = await stat(stagedEntry);
  assert.equal(second.swapped, false);
  assert.equal(after.mtimeMs, marked.getTime());
  assert.equal(after.ino, before.ino);
  assert.equal(second.pnpm.sha512, first.pnpm.sha512);
  assert.equal(second.esbuild.sha512, first.esbuild.sha512);
  assert.deepEqual(await siblingScratchDirectories(root), []);
});

test("a tree an earlier run could not delete is deleted by the next run", async () => {
  const root = await scratch();
  const source = await createSources(root);
  const destinationRoot = join(root, "staged");
  const options = {
    desktopRoot: root,
    nodeModulesRoot: source.nodeModulesRoot,
    destinationRoot,
  };
  await stagePluginTools(options);
  const leftover = join(root, "staged.replaced-1234-5678");
  await write(join(leftover, "esbuild", "held.exe"), "held\n");

  const result = await stagePluginTools(options);

  assert.deepEqual(result.retained, []);
  assert.deepEqual(await siblingScratchDirectories(root), []);
});

test("a run that fails leaves the staged tree unchanged", async () => {
  const root = await scratch();
  const source = await createSources(root);
  const destinationRoot = join(root, "staged");
  const options = {
    desktopRoot: root,
    nodeModulesRoot: source.nodeModulesRoot,
    destinationRoot,
  };
  await stagePluginTools(options);
  const before = await aggregateTreeSha512(destinationRoot);

  await rm(join(source.nodeModulesRoot, "pnpm", "dist"), { recursive: true, force: true });
  await write(join(source.nodeModulesRoot, "pnpm", "dist"), "not a directory\n");

  await assert.rejects(stagePluginTools(options), /pnpm dist source at .* must be a directory/);

  assert.equal(await aggregateTreeSha512(destinationRoot), before);
  assert.deepEqual(await siblingScratchDirectories(root), []);
});

test(
  "a file a running app holds open never leaves a half-deleted tree",
  {
    skip:
      process.platform === "win32"
        ? false
        : "Only Windows refuses to delete a file that a running process executes.",
  },
  async () => {
    const root = await scratch();
    const source = await createSources(root);
    const destinationRoot = join(root, "staged");
    const options = {
      desktopRoot: root,
      nodeModulesRoot: source.nodeModulesRoot,
      destinationRoot,
    };
    await stagePluginTools(options);

    // The dev app's esbuild service executes a binary inside the staged tree
    // and holds it open for as long as the app runs.
    const heldExe = join(
      destinationRoot,
      "esbuild",
      source.platformKey,
      "node_modules",
      "@esbuild",
      source.platformKey,
      "held.exe",
    );
    await copyFile(process.execPath, heldExe);
    const held = spawn(heldExe, ["-e", "console.log('held'); setTimeout(() => {}, 30_000);"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await once(held.stdout, "data");
      await write(join(source.nodeModulesRoot, "pnpm", "dist", "pnpm.cjs"), "updated dist\n");

      const result = await stagePluginTools(options);

      assert.equal(result.swapped, true);
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
      assert.equal(await readFile(join(destinationRoot, "pnpm", "bin", "pnpm.mjs"), "utf8"), "pnpm entry\n");
      assert.equal(
        await readFile(join(destinationRoot, "pnpm", "dist", "pnpm.cjs"), "utf8"),
        "updated dist\n",
      );

      // The held file is reported, and it is in the replaced tree, not the
      // live one.
      assert.equal(result.retained.length, 1);
      assert.match(result.retained[0].root, /staged\.replaced-/);
      assert.match(result.retained[0].message, /held\.exe/);
      assert.equal(result.retained[0].message.includes(result.retained[0].root), true);

      // The app still runs, so the next run still cannot delete that tree and
      // still reports it.
      const next = await stagePluginTools(options);
      assert.equal(next.swapped, false);
      assert.deepEqual(
        next.retained.map(({ root }) => root),
        [result.retained[0].root],
      );
      assert.match(next.retained[0].message, /held\.exe/);
    } finally {
      held.kill();
      await once(held, "exit").catch(() => {});
    }
  },
);

test(
  "a swap the running app blocks keeps the staged tree and says what to stop",
  {
    skip:
      process.platform === "win32"
        ? false
        : "Only Windows refuses to rename a directory a running process uses.",
  },
  async () => {
    const root = await scratch();
    const source = await createSources(root);
    const destinationRoot = join(root, "staged");
    const options = {
      desktopRoot: root,
      nodeModulesRoot: source.nodeModulesRoot,
      destinationRoot,
    };
    await stagePluginTools(options);
    const before = await aggregateTreeSha512(destinationRoot);

    // A process that works inside the staged tree holds the directory itself.
    const busy = spawn(process.execPath, ["-e", "console.log('busy'); setTimeout(() => {}, 30_000);"], {
      cwd: destinationRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await once(busy.stdout, "data");
      await write(join(source.nodeModulesRoot, "pnpm", "dist", "pnpm.cjs"), "updated dist\n");

      await assert.rejects(
        stagePluginTools(options),
        (error) => {
          assert.match(error.message, /could not move .*staged aside/);
          assert.match(error.message, /Stop the app that runs from this worktree/);
          assert.match(error.message, /The existing tree is unchanged\./);
          return true;
        },
      );

      assert.equal(await aggregateTreeSha512(destinationRoot), before);
      assert.deepEqual(
        (await siblingScratchDirectories(root)).filter((name) => name.includes(".replaced-")),
        [],
      );
    } finally {
      busy.kill();
      await once(busy, "exit").catch(() => {});
    }
  },
);

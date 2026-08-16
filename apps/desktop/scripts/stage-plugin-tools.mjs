import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PINNED_PNPM_VERSION = "11.20.0";
export const PINNED_ESBUILD_VERSION = "0.28.1";
export const PNPM_TARBALL_PROVENANCE = {
  url: "https://registry.npmjs.org/pnpm/-/pnpm-11.20.0.tgz",
  sha512:
    "9A6F330A95B66446EA088FAF1521405A8A01F07FDE7124CC9958DFED52D4BB436737E65B08F85F37B46FCBA375092558AC51262B816844B22F63406ED166BFEE",
};
export const ESBUILD_TARBALL_PROVENANCE = {
  url: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz",
  sha512:
    "1EB26BBD9BF96B2C41CCF7F0A613A837393338822589FCE4D0A26B18AD9CF11E3E2CAA4CB6960B41E51D8E7C235AFFCB665907DA569993EE30EFCA62F7D0F857",
};

const ESBUILD_PLATFORM_PACKAGES = new Map([
  ["aix ppc64", "@esbuild/aix-ppc64"],
  ["android arm", "@esbuild/android-arm"],
  ["android arm64", "@esbuild/android-arm64"],
  ["android x64", "@esbuild/android-x64"],
  ["darwin arm64", "@esbuild/darwin-arm64"],
  ["darwin x64", "@esbuild/darwin-x64"],
  ["freebsd arm64", "@esbuild/freebsd-arm64"],
  ["freebsd x64", "@esbuild/freebsd-x64"],
  ["linux arm", "@esbuild/linux-arm"],
  ["linux arm64", "@esbuild/linux-arm64"],
  ["linux ia32", "@esbuild/linux-ia32"],
  ["linux loong64", "@esbuild/linux-loong64"],
  ["linux mips64el", "@esbuild/linux-mips64el"],
  ["linux ppc64", "@esbuild/linux-ppc64"],
  ["linux riscv64", "@esbuild/linux-riscv64"],
  ["linux s390x", "@esbuild/linux-s390x"],
  ["linux x64", "@esbuild/linux-x64"],
  ["netbsd arm64", "@esbuild/netbsd-arm64"],
  ["netbsd x64", "@esbuild/netbsd-x64"],
  ["openbsd arm64", "@esbuild/openbsd-arm64"],
  ["openbsd x64", "@esbuild/openbsd-x64"],
  ["openharmony arm64", "@esbuild/openharmony-arm64"],
  ["sunos x64", "@esbuild/sunos-x64"],
  ["win32 arm64", "@esbuild/win32-arm64"],
  ["win32 ia32", "@esbuild/win32-ia32"],
  ["win32 x64", "@esbuild/win32-x64"],
]);

export function esbuildPlatformPackageName(platform = process.platform, arch = process.arch) {
  const packageName = ESBUILD_PLATFORM_PACKAGES.get(`${platform} ${arch}`);
  if (!packageName) {
    throw new Error(
      `esbuild@${PINNED_ESBUILD_VERSION} has no staged binary package for platform ${platform}/${arch}.`,
    );
  }
  return packageName;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readPackageVersion(packageName, packageRoot, expectedVersion) {
  const packageJsonPath = join(packageRoot, "package.json");
  let body;
  try {
    body = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    throw new Error(
      `${packageName}@${expectedVersion} source package was not found at ${packageJsonPath}: ${errorMessage(error)}`,
    );
  }

  let metadata;
  try {
    metadata = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `${packageName}@${expectedVersion} source package metadata at ${packageJsonPath} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const foundVersion =
    metadata && typeof metadata === "object" && typeof metadata.version === "string"
      ? metadata.version
      : "missing";
  if (foundVersion !== expectedVersion) {
    throw new Error(
      `${packageName} version mismatch: expected ${expectedVersion}, found ${foundVersion} at ${packageJsonPath}.`,
    );
  }
}

async function resolveEsbuildPlatformRoot(esbuildRoot, platformPackage) {
  const resolvedEsbuildRoot = await realpath(esbuildRoot).catch(() => esbuildRoot);
  const requireFromEsbuild = createRequire(join(resolvedEsbuildRoot, "package.json"));
  try {
    return dirname(requireFromEsbuild.resolve(`${platformPackage}/package.json`));
  } catch (error) {
    throw new Error(
      `${platformPackage}@${PINNED_ESBUILD_VERSION} source package could not be resolved from esbuild at ${esbuildRoot}: ${errorMessage(error)}`,
    );
  }
}

async function assertSourceEntry(label, path, expectedKind) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new Error(`${label} source was not found at ${path}: ${errorMessage(error)}`);
  }
  const matches = expectedKind === "directory" ? info.isDirectory() : info.isFile();
  if (!matches) {
    throw new Error(`${label} source at ${path} must be a ${expectedKind}.`);
  }
}

async function listTreeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTreeFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    } else {
      throw new Error(`Staged plugin tool tree contains an unsupported entry at ${path}.`);
    }
  }
  return files.sort();
}

export async function aggregateTreeSha512(root) {
  const hash = createHash("sha512");
  for (const path of await listTreeFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, ...path.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function removeTree(root) {
  return await rm(root, { recursive: true, force: true }).then(
    () => null,
    (error) => error,
  );
}

// Windows refuses to delete a file that a running process executes, so a
// replaced tree can outlive the run that replaced it.
async function removeReplacedTrees(destinationRoot) {
  const parent = dirname(destinationRoot);
  const prefix = `${basename(destinationRoot)}.replaced-`;
  const retained = [];
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const root = join(parent, entry.name);
    const failure = await removeTree(root);
    if (failure) retained.push({ root, message: errorMessage(failure) });
  }
  return retained;
}

async function swapStagedTree({ destinationRoot, stagingRoot, replacedRoot }) {
  const hasLiveTree = await stat(destinationRoot).then(
    () => true,
    () => false,
  );

  if (hasLiveTree) {
    try {
      await rename(destinationRoot, replacedRoot);
    } catch (error) {
      throw new Error(
        `Staged plugin tools could not move ${destinationRoot} aside: ${errorMessage(error)}. ` +
          "A process is using this directory. Stop the app that runs from this worktree, then build " +
          "again. The existing tree is unchanged.",
      );
    }
  }

  try {
    await rename(stagingRoot, destinationRoot);
  } catch (error) {
    const restored = hasLiveTree
      ? await rename(replacedRoot, destinationRoot).then(
          () => true,
          () => false,
        )
      : false;
    throw new Error(
      `Staged plugin tools could not move the new tree into ${destinationRoot}: ${errorMessage(error)}. ` +
        (hasLiveTree
          ? restored
            ? "The existing tree is restored."
            : `The existing tree is at ${replacedRoot}. Rename it to ${destinationRoot}.`
          : "No tree is staged."),
    );
  }

  if (!hasLiveTree) return null;
  const failure = await removeTree(replacedRoot);
  return failure ? { root: replacedRoot, message: errorMessage(failure) } : null;
}

export async function stagePluginTools(options = {}) {
  const desktopRoot = resolve(options.desktopRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const nodeModulesRoot = resolve(options.nodeModulesRoot ?? join(desktopRoot, "node_modules"));
  const destinationRoot = resolve(
    options.destinationRoot ?? join(desktopRoot, "resources", "plugin-tools"),
  );
  const platformPackage = esbuildPlatformPackageName(options.platform, options.arch);
  const platformKey = platformPackage.slice("@esbuild/".length);

  const pnpmRoot = join(nodeModulesRoot, "pnpm");
  const esbuildRoot = join(nodeModulesRoot, "esbuild");

  await readPackageVersion("pnpm", pnpmRoot, PINNED_PNPM_VERSION);
  await readPackageVersion("esbuild", esbuildRoot, PINNED_ESBUILD_VERSION);
  const esbuildPlatformRoot = await resolveEsbuildPlatformRoot(esbuildRoot, platformPackage);
  await readPackageVersion(platformPackage, esbuildPlatformRoot, PINNED_ESBUILD_VERSION);
  await assertSourceEntry("pnpm bin/pnpm.mjs", join(pnpmRoot, "bin", "pnpm.mjs"), "file");
  await assertSourceEntry("pnpm dist", join(pnpmRoot, "dist"), "directory");
  await assertSourceEntry("pnpm LICENSE", join(pnpmRoot, "LICENSE"), "file");
  await assertSourceEntry("esbuild lib/main.js", join(esbuildRoot, "lib", "main.js"), "file");

  const retained = await removeReplacedTrees(destinationRoot);
  const stagingRoot = `${destinationRoot}.staging`;
  const replacedRoot = `${destinationRoot}.replaced-${process.pid}-${Date.now()}`;
  const stagingFailure = await removeTree(stagingRoot);
  if (stagingFailure) {
    throw new Error(
      `Staged plugin tools could not clear the staging directory ${stagingRoot}: ${errorMessage(stagingFailure)}. ` +
        `Delete ${stagingRoot}, then build again. The existing tree is unchanged.`,
    );
  }

  const stagingNodeModules = join(stagingRoot, "esbuild", platformKey, "node_modules");
  await mkdir(join(stagingRoot, "pnpm"), { recursive: true });
  await mkdir(join(stagingNodeModules, "@esbuild"), { recursive: true });

  await Promise.all([
    cp(join(pnpmRoot, "bin", "pnpm.mjs"), join(stagingRoot, "pnpm", "bin", "pnpm.mjs"), {
      recursive: false,
    }),
    cp(join(pnpmRoot, "dist"), join(stagingRoot, "pnpm", "dist"), {
      recursive: true,
      dereference: true,
    }),
    cp(join(pnpmRoot, "package.json"), join(stagingRoot, "pnpm", "package.json")),
    cp(join(pnpmRoot, "LICENSE"), join(stagingRoot, "pnpm", "LICENSE")),
    cp(esbuildRoot, join(stagingNodeModules, "esbuild"), {
      recursive: true,
      dereference: true,
    }),
    cp(esbuildPlatformRoot, join(stagingNodeModules, "@esbuild", platformKey), {
      recursive: true,
      dereference: true,
    }),
  ]);

  // A tree that already matches is left untouched. A dev app that runs from
  // this worktree holds files in the live tree open, so the rebuild that
  // changes nothing must not touch it.
  const [candidateSha512, liveSha512] = await Promise.all([
    aggregateTreeSha512(stagingRoot),
    aggregateTreeSha512(destinationRoot).catch(() => null),
  ]);
  const swapped = candidateSha512 !== liveSha512;
  if (swapped) {
    const replaced = await swapStagedTree({ destinationRoot, stagingRoot, replacedRoot });
    if (replaced) retained.push(replaced);
  } else {
    await removeTree(stagingRoot);
  }

  const stagedPnpmRoot = join(destinationRoot, "pnpm");
  const stagedEsbuildRoot = join(destinationRoot, "esbuild", platformKey);
  const [pnpmSha512, esbuildSha512] = await Promise.all([
    aggregateTreeSha512(stagedPnpmRoot),
    aggregateTreeSha512(stagedEsbuildRoot),
  ]);
  return {
    destinationRoot,
    platformPackage,
    swapped,
    retained,
    provenance: {
      pnpm: PNPM_TARBALL_PROVENANCE,
      esbuild: ESBUILD_TARBALL_PROVENANCE,
    },
    pnpm: { root: stagedPnpmRoot, sha512: pnpmSha512 },
    esbuild: { root: stagedEsbuildRoot, sha512: esbuildSha512 },
  };
}

/**
 * Reads the staging target from `--platform=<platform>` and `--arch=<arch>`.
 * Packaging for another architecture on the same runner (electron-builder's
 * `--arm64` on an x64 mac, for example) has to stage that architecture's
 * esbuild binary; process.arch would stage a binary the packaged app cannot
 * run, and every plugin build on that artifact would fail.
 */
export function parseStagingTarget(argv = []) {
  const target = {};
  for (const argument of argv) {
    const match = /^--(platform|arch)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2]) {
      throw new Error(
        `Unsupported stage-plugin-tools argument "${argument}". Use --platform=<platform> and --arch=<arch>.`,
      );
    }
    target[match[1]] = match[2];
  }
  return target;
}

export function stagePluginToolsFromArgv(argv = [], options = {}) {
  return stagePluginTools({ ...options, ...parseStagingTarget(argv) });
}

async function main() {
  const result = await stagePluginToolsFromArgv(process.argv.slice(2));
  console.log(`Staged pnpm@${PINNED_PNPM_VERSION} at ${result.pnpm.root}`);
  console.log(
    `pnpm npm tarball: ${result.provenance.pnpm.url} (SHA-512 ${result.provenance.pnpm.sha512})`,
  );
  console.log(`pnpm staged tree SHA-512: ${result.pnpm.sha512}`);
  console.log(
    `Staged esbuild@${PINNED_ESBUILD_VERSION} with ${result.platformPackage} at ${result.esbuild.root}`,
  );
  console.log(
    `esbuild npm tarball: ${result.provenance.esbuild.url} (SHA-512 ${result.provenance.esbuild.sha512})`,
  );
  console.log(`esbuild staged tree SHA-512: ${result.esbuild.sha512}`);
  console.log(
    "Tree digests hash each POSIX-relative file path, a NUL byte, the file bytes, and a trailing NUL byte in lexical path order.",
  );
  if (!result.swapped) {
    console.log(`${result.destinationRoot} already matched the source. The staged tree is unchanged.`);
  }
  for (const { root, message } of result.retained) {
    console.log(
      `Could not delete the replaced tree at ${root}: ${message}. A running app holds a file in it. ` +
        "The next build deletes it after that app stops.",
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await main();
}

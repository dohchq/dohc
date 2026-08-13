import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
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

  await rm(destinationRoot, { recursive: true, force: true });
  const stagedPnpmRoot = join(destinationRoot, "pnpm");
  const stagedEsbuildRoot = join(destinationRoot, "esbuild", platformKey);
  const stagedNodeModules = join(stagedEsbuildRoot, "node_modules");
  await mkdir(stagedPnpmRoot, { recursive: true });
  await mkdir(join(stagedNodeModules, "@esbuild"), { recursive: true });

  await Promise.all([
    cp(join(pnpmRoot, "bin", "pnpm.mjs"), join(stagedPnpmRoot, "bin", "pnpm.mjs"), {
      recursive: false,
    }),
    cp(join(pnpmRoot, "dist"), join(stagedPnpmRoot, "dist"), {
      recursive: true,
      dereference: true,
    }),
    cp(join(pnpmRoot, "package.json"), join(stagedPnpmRoot, "package.json")),
    cp(join(pnpmRoot, "LICENSE"), join(stagedPnpmRoot, "LICENSE")),
    cp(esbuildRoot, join(stagedNodeModules, "esbuild"), {
      recursive: true,
      dereference: true,
    }),
    cp(esbuildPlatformRoot, join(stagedNodeModules, "@esbuild", platformKey), {
      recursive: true,
      dereference: true,
    }),
  ]);

  const [pnpmSha512, esbuildSha512] = await Promise.all([
    aggregateTreeSha512(stagedPnpmRoot),
    aggregateTreeSha512(stagedEsbuildRoot),
  ]);
  return {
    destinationRoot,
    platformPackage,
    provenance: {
      pnpm: PNPM_TARBALL_PROVENANCE,
      esbuild: ESBUILD_TARBALL_PROVENANCE,
    },
    pnpm: { root: stagedPnpmRoot, sha512: pnpmSha512 },
    esbuild: { root: stagedEsbuildRoot, sha512: esbuildSha512 },
  };
}

async function main() {
  const result = await stagePluginTools();
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
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await main();
}

import {
  appReadiness,
  discoverApps,
  parseAppManifest,
  requiresTrust,
  type AppManifest,
  type AppReadiness,
} from "@dohc/workspace-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles } from "./workspaceFiles";

export interface AppPackageInfo {
  name: string;
  root: string;
  manifest: AppManifest;
  sourceFiles: string[];
  requiresTrust: boolean;
  trusted: boolean;
  readiness: AppReadiness;
  lastTestChecks: Array<{ name: string; status: string; message?: string }>;
}

// Persisted per-app trust + last-test state, kept inside .dohc so it travels
// with the workspace (and is inspectable). Small JSON, not a database.
interface AppState {
  trusted: boolean;
  tested: boolean;
  passed: boolean;
  checks: Array<{ name: string; status: string; message?: string }>;
}

function statePath(rootPath: string): string {
  return join(rootPath, ".dohc", "apps-state.json");
}

async function readState(rootPath: string): Promise<Record<string, AppState>> {
  try {
    return JSON.parse(await readFile(statePath(rootPath), "utf8")) as Record<string, AppState>;
  } catch {
    return {};
  }
}

async function writeState(
  rootPath: string,
  state: Record<string, AppState>,
): Promise<void> {
  await mkdir(join(rootPath, ".dohc"), { recursive: true });
  await writeFile(statePath(rootPath), `${JSON.stringify(state, null, 2)}\n`);
}

// Finds the app package that contains `anyPath` (a path inside an .apps/<name>
// folder) and assembles its full info from the workspace-core model + manifest
// + persisted trust/test state.
export async function getAppPackage(
  rootPath: string,
  anyPath: string,
): Promise<AppPackageInfo | null> {
  const files = (await listFiles(rootPath)).map((f) => f.path);
  const pkg = discoverApps(files).find(
    (p) => anyPath === p.root || anyPath.startsWith(`${p.root}/`),
  );
  if (!pkg) return null;

  let manifest: AppManifest;
  try {
    manifest = parseAppManifest(await readFile(join(rootPath, pkg.manifestPath), "utf8"));
  } catch {
    manifest = { entry: "src/App.tsx", read: ["."], write: [], network: false };
  }

  const state = (await readState(rootPath))[pkg.root] ?? {
    trusted: false,
    tested: false,
    passed: false,
    checks: [],
  };

  return {
    name: pkg.name,
    root: pkg.root,
    manifest,
    sourceFiles: pkg.sourceFiles,
    requiresTrust: requiresTrust(manifest),
    trusted: state.trusted,
    readiness: appReadiness({ tested: state.tested, passed: state.passed }),
    lastTestChecks: state.checks,
  };
}

// Runs the real AppTester (static mode) over the app's source and records the
// result so readiness persists. Static mode = compile + SDK-import + manifest
// checks (no Playwright); enough to catch legacy imports and broken builds.
export async function runAppTesterStatic(
  rootPath: string,
  appRoot: string,
): Promise<{ ok: boolean; checks: Array<{ name: string; status: string; message?: string }> }> {
  const allFiles = (await listFiles(rootPath)).map((f) => f.path);
  const pkg = discoverApps(allFiles).find((p) => p.root === appRoot);
  if (!pkg) throw new Error(`Not an app package: ${appRoot}`);

  const files = await Promise.all(
    pkg.sourceFiles.map(async (path) => ({
      relativePath: path.slice(appRoot.length + 1),
      body: await readFile(join(rootPath, path), "utf8"),
    })),
  );

  // Dynamic import keeps the TypeScript compiler off the launch path — it
  // loads only when the user actually runs a test. The /static entry is
  // Playwright-free, so the desktop never bundles a headless browser.
  const { runStaticAppCheck } = await import("@dohc/app-tester/static");
  const result = runStaticAppCheck(files);
  const checks = result.checks.map((c) => ({
    name: c.name,
    status: c.status,
    ...(c.message ? { message: c.message } : {}),
  }));

  const state = await readState(rootPath);
  state[appRoot] = {
    ...(state[appRoot] ?? { trusted: false }),
    tested: true,
    passed: result.ok,
    checks,
  };
  await writeState(rootPath, state);
  return { ok: result.ok, checks };
}

export async function grantAppTrust(rootPath: string, appRoot: string): Promise<void> {
  const state = await readState(rootPath);
  state[appRoot] = {
    ...(state[appRoot] ?? { tested: false, passed: false, checks: [] }),
    trusted: true,
  };
  await writeState(rootPath, state);
}

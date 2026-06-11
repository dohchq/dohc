import {
  appReadiness,
  discoverApps,
  parseAppManifest,
  requiresTrust,
  type AppManifest,
  type AppReadiness,
} from "@dohc/workspace-core";
import { createHash } from "node:crypto";
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
// `fingerprint` binds a pass/trust decision to the exact bytes that were
// tested — see currentState.
interface AppState {
  trusted: boolean;
  tested: boolean;
  passed: boolean;
  checks: Array<{ name: string; status: string; message?: string }>;
  fingerprint?: string;
}

type AppPkg = { root: string; name: string; manifestPath: string; sourceFiles: string[] };

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

// State writes are read-modify-write on one JSON file; serialize them so two
// concurrent IPC calls can't drop each other's updates.
let stateQueue: Promise<unknown> = Promise.resolve();

function updateState(
  rootPath: string,
  mutate: (state: Record<string, AppState>) => void,
): Promise<void> {
  const run = async () => {
    const state = await readState(rootPath);
    mutate(state);
    await mkdir(join(rootPath, ".dohc"), { recursive: true });
    await writeFile(statePath(rootPath), `${JSON.stringify(state, null, 2)}\n`);
  };
  const next = stateQueue.then(run, run);
  stateQueue = next.catch(() => undefined);
  return next;
}

// A content hash over the manifest + every source file. Length-prefix framing
// makes the encoding injective — no delimiter collisions between path and
// body or across entries, and a missing file can't alias real content.
function fingerprintOf(entries: Array<{ rel: string; body: string | null }>): string {
  const hash = createHash("sha256");
  for (const { rel, body } of [...entries].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    const content = body === null ? "<missing>" : body;
    hash.update(`${body === null ? "m" : "f"}${rel.length}:${rel}:${Buffer.byteLength(content)}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function readPackageEntries(
  rootPath: string,
  pkg: AppPkg,
): Promise<Array<{ rel: string; body: string | null }>> {
  return Promise.all(
    [pkg.manifestPath, ...pkg.sourceFiles.filter((f) => f !== pkg.manifestPath)].map(
      async (rel) => {
        try {
          return { rel, body: await readFile(join(rootPath, rel), "utf8") };
        } catch {
          return { rel, body: null };
        }
      },
    ),
  );
}

async function computeFingerprint(rootPath: string, pkg: AppPkg): Promise<string> {
  return fingerprintOf(await readPackageEntries(rootPath, pkg));
}

const FRESH: AppState = { trusted: false, tested: false, passed: false, checks: [] };

// The authoritative per-app state, bound to current package contents. If the
// manifest or any source file changed since the last test, the prior pass/trust
// no longer applies — reset to untested rather than letting edited code (e.g. a
// widened write glob, or a swapped-in malicious source) inherit an old approval.
// The reset is persisted so the on-disk state never reports stale trust to any
// reader (this is the single source of truth for trust — never read raw state).
async function currentState(rootPath: string, pkg: AppPkg): Promise<AppState> {
  const stored = (await readState(rootPath))[pkg.root];
  const fingerprint = await computeFingerprint(rootPath, pkg);
  if (stored && stored.fingerprint === fingerprint) return stored;
  const reset: AppState = { ...FRESH, fingerprint };
  if (stored) {
    await updateState(rootPath, (state) => {
      state[pkg.root] = reset;
    });
  }
  return reset;
}

// Finds the app package that contains `anyPath` (a path inside an .apps/<name>
// folder) and assembles its full info from the workspace-core model + manifest
// + persisted (content-bound) trust/test state.
export async function getAppPackage(
  rootPath: string,
  anyPath: string,
): Promise<AppPackageInfo | null> {
  const files = (await listFiles(rootPath)).files.map((f) => f.path);
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

  const state = await currentState(rootPath, pkg);

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
// result so readiness persists, bound to the current content fingerprint.
// Static mode = compile + @dohc/app SDK-import check (no Playwright): it catches
// legacy SDK imports and syntactically broken source. Full module-resolution /
// build / render validation is the Phase 7b runtime's job, not this gate.
export async function runAppTesterStatic(
  rootPath: string,
  appRoot: string,
): Promise<{ ok: boolean; checks: Array<{ name: string; status: string; message?: string }> }> {
  const allFiles = (await listFiles(rootPath)).files.map((f) => f.path);
  const pkg = discoverApps(allFiles).find((p) => p.root === appRoot);
  if (!pkg) throw new Error(`Not an app package: ${appRoot}`);

  // ONE read feeds both the check and the fingerprint: the recorded pass binds
  // to the exact bytes that were tested, so a file swapped mid-run can never
  // inherit the verdict (it would carry a different fingerprint).
  const entries = await readPackageEntries(rootPath, pkg);
  const fingerprint = fingerprintOf(entries);
  const files = entries
    .filter((e) => pkg.sourceFiles.includes(e.rel))
    .map((e) => ({
      relativePath: e.rel.slice(appRoot.length + 1),
      body: e.body ?? "",
    }));

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

  // Trust carries over only if the prior state matches these exact bytes; a
  // failing re-test always revokes trust (a failed app is never trusted).
  await updateState(rootPath, (state) => {
    const stored = state[appRoot];
    const sameContent = stored?.fingerprint === fingerprint;
    state[appRoot] = {
      trusted: result.ok && sameContent ? (stored?.trusted ?? false) : false,
      tested: true,
      passed: result.ok,
      checks,
      fingerprint,
    };
  });
  return { ok: result.ok, checks };
}

// Trust is gated on AppTester readiness AT THE BACKEND boundary — the renderer's
// "ready"-only button is UX, not the security gate. A direct/forged IPC call
// for an untested, failed, or non-existent app must be refused here.
export async function grantAppTrust(rootPath: string, appRoot: string): Promise<void> {
  const allFiles = (await listFiles(rootPath)).files.map((f) => f.path);
  const pkg = discoverApps(allFiles).find((p) => p.root === appRoot);
  if (!pkg) throw new Error(`Not an app package: ${appRoot}`);

  const state = await currentState(rootPath, pkg);
  if (appReadiness({ tested: state.tested, passed: state.passed }) !== "ready") {
    throw new Error(`App must pass AppTester before it can be trusted: ${appRoot}`);
  }

  // Bind the grant to the fingerprint the readiness check was made against —
  // if the content changed in between, the stored state no longer matches and
  // the trusted flag applies to nothing.
  await updateState(rootPath, (all) => {
    all[appRoot] = { ...state, trusted: true };
  });
}

import type { Page } from "@playwright/test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MarksSnapshot, SwitchTimelineEntry } from "../../src/performance/desktopMarks";
import { profileCountersDelta, type ProfileCountersSnapshot } from "../../src/performance/profileCounters";
import { nativeWorkStatsDelta, type NativeWorkStatsResult } from "../../src/performance/nativeWorkStats";
import { launchDesktopApp, type LaunchedDesktopApp } from "../helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  type TempWorkspace,
  type WorkspaceSummary,
} from "../helpers/workspace";

export type FixtureName = "large-flat" | "large-deep" | "big-docs" | "drawings" | "rich-edit-ordinary" | "rich-edit-stress";

export interface SeedManifest {
  schemaVersion: number;
  seed: number;
  scale: "full" | "tiny";
  fixtures: Record<string, unknown> & {
    "large-flat": { files: number; markdownFiles: number; flatFolderFiles: number };
    "large-deep": { files: number; markdownFiles: number; levels: number };
    "big-docs": { files: Array<{ path: string; bytes: number }> };
    drawings: { files: Array<{ path: string; elementCount: number }> };
    "rich-edit-ordinary": RichEditFixture;
    "rich-edit-stress": RichEditFixture;
  };
}

export interface RichEditFixture {
  files: number;
  path: string;
  bytes: number;
  paragraphs: number;
  tableRows: number;
  contentDigest: string;
  externalWritePaths: string[];
}

export interface ProfileCounterPair {
  main: { marks: MarksSnapshot; counters: ProfileCountersSnapshot | null };
  renderer: { marks: MarksSnapshot; counters: ProfileCountersSnapshot | null };
  native: NativeWorkStatsResult;
  observedAtMs: { started: number; finished: number };
  readBracketsMs: Record<"main" | "native" | "renderer", { started: number; finished: number }>;
}

export type ProfileCounterRead = Omit<Partial<ProfileCounterPair>, "readBracketsMs"> & {
  readBracketsMs: Partial<ProfileCounterPair["readBracketsMs"]>;
  errors: Array<{ lane: "main" | "native" | "renderer"; error: ReturnType<typeof profileError> }>;
};

export function profileError(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null }
    : { name: "Error", message: String(error), stack: null };
}

// Keep the first failure while collecting evidence and saving the partial phase.
export async function recordProfilePhase(phases: Array<Record<string, unknown>>, phase: Record<string, unknown>, steps: {
  run(): Promise<void>; collect(): Promise<void>; verify(): Promise<void>; persist(): Promise<void>;
}): Promise<void> {
  phase.complete = false;
  phases.push(phase);
  let failed = false, failure: unknown;
  const fail = (field: string, error: unknown) => {
    if (!failed) { failed = true; failure = error; }
    phase[field] = profileError(error);
  };
  try { await steps.persist(); await steps.run(); }
  catch (error) { fail("error", error); }
  try { await steps.collect(); }
  catch (error) { fail("collectionError", error); }
  if (!failed) {
    try { await steps.verify(); }
    catch (error) { fail("error", error); }
  }
  phase.complete = !failed;
  try { await steps.persist(); }
  catch (error) { fail("artifactError", error); phase.complete = false; }
  if (failed) throw failure;
}

// Sequential reads are a bracket, not an atomic cross-process snapshot.
export async function readProfileCounters(page: Page, workspaceId: string, observe?: (read: ProfileCounterRead) => void): Promise<ProfileCounterPair> {
  const started = performance.now();
  const partial: ProfileCounterRead = { observedAtMs: { started, finished: started }, readBracketsMs: {}, errors: [] };
  const report = () => observe?.({ ...partial, readBracketsMs: { ...partial.readBracketsMs }, errors: [...partial.errors] });
  let lane: "main" | "native" | "renderer" = "main", laneStarted = started;
  report();
  try {
    const main = await page.evaluate(async () => {
      const api = window.dohcDesktopTest as { getDesktopMarks(): Promise<MarksSnapshot & { counters: ProfileCountersSnapshot | null }> };
      const { counters, ...marks } = await api.getDesktopMarks();
      return { marks, counters };
    });
    const mainFinished = performance.now();
    partial.main = main; partial.readBracketsMs.main = { started, finished: mainFinished };
    partial.observedAtMs = { started, finished: mainFinished }; report();
    lane = "native"; laneStarted = mainFinished;
    const native = await page.evaluate(async workspaceId => {
      const api = window.dohcDesktopTest as { getNativeWorkStats(workspaceId: string): Promise<NativeWorkStatsResult> };
      return api.getNativeWorkStats(workspaceId);
    }, workspaceId);
    const nativeFinished = performance.now();
    partial.native = native; partial.readBracketsMs.native = { started: mainFinished, finished: nativeFinished };
    partial.observedAtMs = { started, finished: nativeFinished }; report();
    lane = "renderer"; laneStarted = nativeFinished;
    const renderer = await page.evaluate(() => {
      const recorder = window.dohcDesktopMarks;
      if (!recorder) throw new Error("Renderer profile counters are unavailable.");
      return { marks: recorder.snapshot(), counters: recorder.counters() };
    });
    const finished = performance.now();
    partial.renderer = renderer; partial.readBracketsMs.renderer = { started: nativeFinished, finished };
    partial.observedAtMs = { started, finished }; report();
    if (!main.counters || !renderer.counters) throw new Error("Test profile counters are disabled.");
    return { main, native, renderer, observedAtMs: { started, finished }, readBracketsMs: {
      main: { started, finished: mainFinished }, native: { started: mainFinished, finished: nativeFinished },
      renderer: { started: nativeFinished, finished },
    } };
  } catch (error) {
    const finished = performance.now();
    partial.observedAtMs = { started, finished };
    partial.readBracketsMs[lane] = { started: laneStarted, finished };
    partial.errors.push({ lane, error: profileError(error) }); report();
    throw error;
  }
}

export function counterPairDelta(before: ProfileCounterPair, after: ProfileCounterPair) {
  return {
    main: profileCountersDelta(before.main.counters, after.main.counters),
    renderer: profileCountersDelta(before.renderer.counters, after.renderer.counters),
    native: nativeWorkStatsDelta(before.native, after.native),
  };
}

export interface ProfileContext {
  desktop: LaunchedDesktopApp;
  page: Page;
  sandbox: TempWorkspace;
  fixtureRoot: string;
  fixture: FixtureName;
  manifest: SeedManifest;
  workspace: WorkspaceSummary;
  close(): Promise<void>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set by tools/perf-profiling/run-profiles.mjs.`);
  return resolve(value);
}

export function profileOutputDir(): string {
  return requiredEnv("DOHC_PROFILE_OUTPUT");
}

export function fixtureDirectory(name: FixtureName): string {
  return join(requiredEnv("DOHC_PROFILE_FIXTURES"), name);
}

export async function readSeedManifest(): Promise<SeedManifest> {
  const text = await readFile(join(requiredEnv("DOHC_PROFILE_FIXTURES"), "seed-manifest.json"), "utf8");
  return JSON.parse(text) as SeedManifest;
}

export function smokeMode(): boolean {
  return process.env.DOHC_PROFILE_SMOKE === "1";
}

export function interactionDuration(fullMs: number, smokeMs: number): number {
  return smokeMode() ? smokeMs : fullMs;
}

export async function prepareFixture(
  name: FixtureName,
  workspaceId: string,
): Promise<{ rootPath: string; manifest: SeedManifest }> {
  const sourcePath = fixtureDirectory(name);
  const rootPath = join(profileOutputDir(), "workspaces", name, workspaceId);
  await rm(rootPath, { recursive: true, force: true });
  await cp(sourcePath, rootPath, { recursive: true });
  await seedWorkspaceManifest({ rootPath }, workspaceId);
  return { rootPath, manifest: await readSeedManifest() };
}

export async function launchFixture(
  name: FixtureName,
  workspaceId: string,
): Promise<ProfileContext> {
  const fixture = await prepareFixture(name, workspaceId);
  const sandbox = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  try {
    desktop = await launchDesktopApp({
      workspace: {
        baseDir: sandbox.baseDir,
        homeDir: sandbox.homeDir,
        rootPath: fixture.rootPath,
      },
    });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, {
      rootPath: fixture.rootPath,
    });
    const launched = desktop;
    return {
      desktop: launched,
      page: launched.page,
      sandbox,
      fixtureRoot: fixture.rootPath,
      fixture: name,
      manifest: fixture.manifest,
      workspace,
      close: () =>
        cleanupDesktopWorkspace(launched, sandbox),
    };
  } catch (error) {
    await cleanupDesktopWorkspace(desktop, sandbox);
    throw error;
  }
}

export async function writeProfileArtifact(
  scenario: string,
  value: Record<string, unknown>,
): Promise<void> {
  const output = profileOutputDir();
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, `${scenario}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scenario,
        scale: process.env.DOHC_PROFILE_SCALE ?? "full",
        capturedAt: new Date().toISOString(),
        ...value,
      },
      null,
      2,
    )}\n`,
  );
}

export async function readRendererMarks(page: Page): Promise<MarksSnapshot> {
  return page.evaluate(() => {
    const marks = window.dohcDesktopMarks;
    if (!marks) throw new Error("The DOHC_DESKTOP_TEST renderer marks seam is unavailable.");
    return marks.snapshot();
  });
}

export async function readSwitchTimeline(page: Page): Promise<SwitchTimelineEntry[]> {
  return page.evaluate(() => {
    const marks = window.dohcDesktopMarks;
    if (!marks) throw new Error("The DOHC_DESKTOP_TEST switch timeline seam is unavailable.");
    return marks.readSwitchTimeline();
  });
}

export function largestDrawing(manifest: SeedManifest): { path: string; elementCount: number } {
  const drawing = [...manifest.fixtures.drawings.files].sort(
    (left, right) => right.elementCount - left.elementCount,
  )[0];
  if (!drawing) throw new Error("The drawings fixture has no scenes.");
  return drawing;
}

export function editableBigDoc(manifest: SeedManifest): { path: string; bytes: number } {
  const doc = manifest.fixtures["big-docs"].files.find(({ path }) =>
    path.endsWith("doc-250kb.md"),
  );
  if (!doc) throw new Error("The big-docs fixture has no doc-250kb.md.");
  return doc;
}

export function oversizedReadDoc(manifest: SeedManifest): { path: string; bytes: number } {
  const doc = manifest.fixtures["big-docs"].files.find(({ path }) =>
    path.endsWith("doc-3mb.md"),
  );
  if (!doc) throw new Error("The big-docs fixture has no doc-3mb.md.");
  return doc;
}

import type { Page } from "@playwright/test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MarksSnapshot, SwitchTimelineEntry } from "../../src/performance/desktopMarks";
import { launchDesktopApp, type LaunchedDesktopApp } from "../helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
  type TempWorkspace,
  type WorkspaceSummary,
} from "../helpers/workspace";

export type FixtureName = "large-flat" | "large-deep" | "big-docs" | "drawings";

export interface SeedManifest {
  schemaVersion: number;
  seed: number;
  scale: "full" | "tiny";
  fixtures: Record<string, unknown> & {
    "large-flat": { files: number; markdownFiles: number; flatFolderFiles: number };
    "large-deep": { files: number; markdownFiles: number; levels: number };
    "big-docs": { files: Array<{ path: string; bytes: number }> };
    drawings: { files: Array<{ path: string; elementCount: number }> };
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
  const rootPath = join(profileOutputDir(), "workspaces", name);
  await rm(rootPath, { recursive: true, force: true });
  await cp(sourcePath, rootPath, { recursive: true });
  await seedWorkspaceManifest({ rootPath }, workspaceId);
  await seedWorkspaceSettings(
    { rootPath },
    { experimental: { workspaceEngineAlpha: true } },
  );
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

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareFixture } from "../../e2e/profiling/harness";
import { createTestScratch, removeTestScratch } from "../workspaces/testTemp";

describe("profiling fixture preparation", () => {
  let scratch: string | null = null;

  afterEach(async () => {
    if (scratch) await removeTestScratch(scratch);
    scratch = null;
    delete process.env.DOHC_PROFILE_FIXTURES;
    delete process.env.DOHC_PROFILE_OUTPUT;
  });

  it("restores a pristine copy before every scenario", async () => {
    scratch = await createTestScratch("dohc-profile-fixture-");
    const fixturesRoot = join(scratch, "fixtures");
    const fixtureRoot = join(fixturesRoot, "large-flat");
    const recordedInput = "# Recorded fixture\n\nKeep these exact bytes.\n";
    await mkdir(join(fixtureRoot, "notes"), { recursive: true });
    await writeFile(join(fixtureRoot, "notes", "fixture.md"), recordedInput);
    await writeFile(
      join(fixturesRoot, "seed-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, seed: 7, scale: "tiny", fixtures: {} })}\n`,
    );
    process.env.DOHC_PROFILE_FIXTURES = fixturesRoot;
    process.env.DOHC_PROFILE_OUTPUT = join(scratch, "output");

    const scenarioA = await prepareFixture("large-flat", "scenario-a");
    const engineDir = join(scenarioA.rootPath, ".dohc", "engine");
    await mkdir(engineDir, { recursive: true });
    await writeFile(join(engineDir, "engine.db"), "scenario-a engine state");
    await writeFile(join(engineDir, "engine.db-wal"), "scenario-a wal state");
    await writeFile(
      join(scenarioA.rootPath, "notes", "fixture.md"),
      `${recordedInput}profilex-0123456789-abcdefghij`,
    );

    const scenarioB = await prepareFixture("large-flat", "scenario-b");

    expect(scenarioA.rootPath).not.toBe(fixtureRoot);
    expect(scenarioB.rootPath).toBe(scenarioA.rootPath);
    expect(existsSync(join(scenarioB.rootPath, ".dohc", "engine"))).toBe(false);
    expect(await readFile(join(scenarioB.rootPath, "notes", "fixture.md"), "utf8")).toBe(
      recordedInput,
    );
    expect(await readFile(join(fixtureRoot, "notes", "fixture.md"), "utf8")).toBe(
      recordedInput,
    );
    expect(
      JSON.parse(
        await readFile(join(scenarioB.rootPath, ".dohc", "manifest.json"), "utf8"),
      ),
    ).toMatchObject({ workspaceId: "scenario-b" });
  });
});

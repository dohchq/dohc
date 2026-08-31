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
  });

  it("starts scenarios that share a fixture without inherited engine state", async () => {
    scratch = await createTestScratch("dohc-profile-fixture-");
    const fixtureRoot = join(scratch, "large-flat");
    const recordedInput = "# Recorded fixture\n\nKeep these exact bytes.\n";
    await mkdir(join(fixtureRoot, "notes"), { recursive: true });
    await writeFile(join(fixtureRoot, "notes", "fixture.md"), recordedInput);
    await writeFile(
      join(scratch, "seed-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, seed: 7, scale: "tiny", fixtures: {} })}\n`,
    );
    process.env.DOHC_PROFILE_FIXTURES = scratch;

    await prepareFixture("large-flat", "scenario-a");
    const engineDir = join(fixtureRoot, ".dohc", "engine");
    const recordedMetadata = join(fixtureRoot, ".dohc", "recorded-input.json");
    await writeFile(recordedMetadata, '{"fixture":true}\n');
    await mkdir(engineDir, { recursive: true });
    await writeFile(join(engineDir, "engine.db"), "scenario-a engine state");
    await writeFile(join(engineDir, "engine.db-wal"), "scenario-a wal state");

    await prepareFixture("large-flat", "scenario-b");

    expect(existsSync(engineDir)).toBe(false);
    expect(await readFile(join(fixtureRoot, "notes", "fixture.md"), "utf8")).toBe(
      recordedInput,
    );
    expect(await readFile(recordedMetadata, "utf8")).toBe('{"fixture":true}\n');
    expect(
      JSON.parse(await readFile(join(fixtureRoot, ".dohc", "manifest.json"), "utf8")),
    ).toMatchObject({ workspaceId: "scenario-b" });
  });
});

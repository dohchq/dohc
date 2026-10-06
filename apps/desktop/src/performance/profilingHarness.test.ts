import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import * as Y from "yjs";
import { seedRichEdit } from "../../../../tools/perf-profiling/seed-workspaces.mjs";
import { counterPairDelta, prepareFixture, readProfileCounters, recordProfilePhase, type ProfileCounterRead } from "../../e2e/profiling/harness";
import { createProfileCounters } from "./profileCounters";
import { createTestScratch, removeTestScratch } from "../workspaces/testTemp";

describe("profiling fixture preparation", () => {
  let scratch: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (scratch) await removeTestScratch(scratch);
    scratch = null;
    delete process.env.DOHC_PROFILE_FIXTURES;
    delete process.env.DOHC_PROFILE_OUTPUT;
  });

  it("brackets sequential main/native/renderer reads and keeps unavailable native evidence", async () => {
    const counters = createProfileCounters(); counters.enable();
    const lane = { marks: { marks: {}, measures: {} }, counters: counters.snapshot() };
    const native = { workspaceId: "requested-workspace", status: "unavailable", reason: "No current open engine binding." };
    const evaluate = vi.fn().mockResolvedValueOnce(lane).mockResolvedValueOnce(native).mockResolvedValueOnce(lane);
    vi.spyOn(performance, "now").mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3).mockReturnValueOnce(4);
    const pair = await readProfileCounters({ evaluate } as unknown as Page, "requested-workspace");
    expect(evaluate.mock.calls[1]![1]).toBe("requested-workspace");
    expect(pair.native).toEqual(native);
    expect(pair.observedAtMs).toEqual({ started: 1, finished: 4 });
    expect(pair.readBracketsMs).toEqual({ main: { started: 1, finished: 2 }, native: { started: 2, finished: 3 }, renderer: { started: 3, finished: 4 } });
    expect(counterPairDelta(pair, pair).native.status).toBe("unavailable");
  });

  it("retains completed reads and the failed native bracket when IPC rejects", async () => {
    const counters = createProfileCounters(); counters.enable();
    const main = { marks: { marks: {}, measures: {} }, counters: counters.snapshot() };
    const failure = new Error("Native work snapshot stopped because this window changed workspaces.");
    const evaluate = vi.fn().mockResolvedValueOnce(main).mockRejectedValueOnce(failure);
    const reads: ProfileCounterRead[] = [];
    vi.spyOn(performance, "now").mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3);
    await expect(readProfileCounters({ evaluate } as unknown as Page, "workspace-a", read => reads.push(read))).rejects.toBe(failure);
    expect(reads.at(-1)).toMatchObject({ main, observedAtMs: { started: 1, finished: 3 },
      readBracketsMs: { main: { started: 1, finished: 2 }, native: { started: 2, finished: 3 } },
      errors: [{ lane: "native", error: { message: failure.message } }],
    });
    expect(reads.at(-1)?.renderer).toBeUndefined();
  });

  it.each(["typing", "persistence", "activity", "table", "counter-delta", "native-validation"])("saves partial evidence and rethrows a %s failure", async stage => {
    const phase: Record<string, unknown> = { name: "typing", measurementStage: stage };
    const phases: Array<Record<string, unknown>> = [];
    const saved: unknown[] = [];
    const failure = new Error(`${stage} failed`);
    const raw = { inputs: [{ trusted: true, atMs: 12 }], saves: [], activities: [] };
    await expect(recordProfilePhase(phases, phase, {
      persist: async () => { saved.push(structuredClone(phases)); },
      run: async () => {
        phase.beforeRead = { main: { counters: { ipcInvocations: 0 } }, observedAtMs: { started: 1, finished: 2 } };
        if (stage !== "native-validation") throw failure;
      },
      collect: async () => {
        phase.raw = raw;
        phase.native = { status: "unavailable", reason: "generation changed" };
        if (stage === "counter-delta") throw new Error("delta unavailable");
      },
      verify: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(saved).toHaveLength(2);
    expect((saved[0] as Array<Record<string, unknown>>)[0]).toMatchObject({ complete: false });
    expect((saved[1] as Array<Record<string, unknown>>)[0]).toMatchObject({ complete: false, raw,
      error: { message: failure.message }, native: { status: "unavailable", reason: "generation changed" }, beforeRead: { observedAtMs: { started: 1, finished: 2 } } });
    if (stage === "counter-delta") expect(phase.collectionError).toMatchObject({ message: "delta unavailable" });
  });

  it("cannot pass when evidence collection fails after otherwise successful work", async () => {
    const phases: Array<Record<string, unknown>> = [], phase: Record<string, unknown> = {};
    const failure = new Error("renderer counters unavailable");
    const verify = vi.fn();
    await expect(recordProfilePhase(phases, phase, {
      run: async () => {}, collect: async () => { throw failure; }, verify, persist: async () => {},
    })).rejects.toBe(failure);
    expect(phase).toMatchObject({ complete: false, collectionError: { message: failure.message } });
    expect(verify).not.toHaveBeenCalled();
  });

  it("keeps ordinary and stress seeds within the engine's Markdown and Y.Doc transport caps", async () => {
    scratch = await createTestScratch("dohc-profile-rich-seed-");
    const domainLimits = await readFile(new URL("../../../../crates/dohc-engine-domain/src/store.rs", import.meta.url), "utf8");
    const collabLimits = await readFile(new URL("../../../../crates/dohc-engine-collab/src/limits.rs", import.meta.url), "utf8");
    const wireLimits = await readFile(new URL("../../../../crates/dohc-engine-protocol/src/limits.rs", import.meta.url), "utf8");
    // Pin the bounds used below to the engine's current constants.
    expect(domainLimits).toMatch(/pub const INBAND_CONTENT_CAP_BYTES: usize = 48 \* 1024;/);
    expect(collabLimits).toMatch(/pub const MAX_YDOC_UPDATE_BYTES: usize = 20 \* 1024 \* 1024;/);
    expect(wireLimits).toMatch(/pub const MIN_NEGOTIABLE_FRAME_BYTES: u32 = 1024 \* 1024;/);
    for (const options of [{ stress: false, tiny: false }, { stress: true, tiny: true }, { stress: true, tiny: false }]) {
      const scale = !options.stress ? "ordinary" : options.tiny ? "tiny" : "full";
      const root = join(scratch, scale);
      const fixture = await seedRichEdit(root, options);
      const markdown = await readFile(join(root, fixture.path), "utf8");
      const doc = markdownToYDoc(markdown, { clientID: 0xffff_ffff });
      try {
        const projection = yDocToMarkdown(doc);
        const sourceMetadataRequired = projection !== markdown;
        if (sourceMetadataRequired) {
          const meta = doc.getMap("meta");
          meta.set("dohcMarkdownSource", markdown);
          meta.set("dohcMarkdownSourceSha256", createHash("sha256").update(markdown).digest("hex"));
          meta.set("dohcMarkdownSourceProjectionSha256", createHash("sha256").update(projection).digest("hex"));
        }
        const encoded = Y.encodeStateAsUpdate(doc);
        const updateBase64 = Buffer.from(encoded).toString("base64");
        expect(fixture.bytes + 60).toBeLessThan(48 * 1024);
        expect(encoded.byteLength).toBeLessThan(20 * 1024 * 1024);
        // Leave room for RPC fields around the base64 seed.
        expect(Buffer.byteLength(updateBase64) + 64 * 1024).toBeLessThan(1024 * 1024);
        if (options.stress) {
          expect(fixture.paragraphs).toBeLessThan(100);
          expect(fixture.bytes / fixture.paragraphs).toBeGreaterThan(500);
        } else expect(fixture.paragraphs).toBe(100);
        console.info("rich-edit seed measurement", {
          scale, markdownBytes: fixture.bytes,
          paragraphs: fixture.paragraphs, encodedYDocBytes: encoded.byteLength,
          base64Bytes: Buffer.byteLength(updateBase64), sourceMetadataRequired,
        });
      } finally {
        doc.destroy();
      }
    }
  });

  it("isolates a pristine copy for every scenario", async () => {
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
    expect(scenarioB.rootPath).not.toBe(scenarioA.rootPath);
    expect(await readFile(join(engineDir, "engine.db"), "utf8")).toBe(
      "scenario-a engine state",
    );
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

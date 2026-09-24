import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { AutomationChangeKind } from "@dohc/workspace-engine-client";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import type { PlannedStep } from "./automationPlan";
import type { StoredReachVerdict } from "./reachVerdicts";

// This computer's record of each Collection automation run, under
// <workspace>/.dohc/automations. Claims are local to the computer that ran
// them, so their runs are too. A run's plan is saved before its first write,
// and each step's writes are saved when the step lands and before the next
// step starts. A run that stops part way, from a crash or a failed write,
// resumes from here instead of evaluating again, so no step takes effect
// twice. Undo and run history read the writes.
//
// Every file is written to a temporary name, flushed to disk, and renamed
// over the old one, so a crash leaves the old record or the new one.

// A run of 25 steps over 50 found records, with values near the claim's
// value bound, stays under this.
const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;
// Kept per automation: every run that failed or has not finished, and the
// newest finished ones for run history.
const KEEP_FINISHED_RUNS = 20;
const KEEP_UNFINISHED_RUNS = 100;
// Pruning reads every run of the automation, so it waits for this many.
const PRUNE_AFTER_FILES = KEEP_FINISHED_RUNS * 2;

// Values are this computer's own writes, read back as JSON.parse left them;
// the write seam checks each one again before it writes.
const JsonValueSchema = z.custom<JsonValue>((value) => value !== undefined);
const TargetSchema = z.union([
  z.object({ recordId: z.string(), path: z.string() }),
  z.object({ addedBy: z.number().int().nonnegative() }),
]);
const EffectSchema = z.union([
  z.object({
    kind: z.literal("set"),
    target: TargetSchema,
    fields: z.array(z.object({ field: z.string(), before: JsonValueSchema, after: JsonValueSchema })),
  }),
  z.object({
    kind: z.literal("add"),
    collectionPath: z.string(),
    recordId: z.string(),
    name: z.string(),
    fields: z.array(z.object({ field: z.string(), value: JsonValueSchema })),
  }),
]);
const WriteSchema = z.union([
  z.object({
    kind: z.literal("field"),
    recordId: z.string(),
    path: z.string(),
    field: z.string(),
    before: JsonValueSchema,
    after: JsonValueSchema,
  }),
  z.object({ kind: z.literal("created"), recordId: z.string(), path: z.string() }),
]);
const StoredRunSchema = z.object({
  version: z.literal(1),
  claimId: z.string().min(1),
  automationId: z.string().min(1),
  definitionHash: z.string().min(1),
  startedAtMs: z.number(),
  updatedAtMs: z.number(),
  plan: z.array(z.object({ ordinal: z.number().int().nonnegative(), effects: z.array(EffectSchema) })).nullable(),
  done: z.array(z.object({ ordinal: z.number().int().nonnegative(), writes: z.array(WriteSchema) })),
  superseded: z.boolean(),
  outcome: z.union([
    z.object({ state: z.literal("done") }),
    z.object({ state: z.literal("skipped") }),
    z.object({ state: z.literal("failed"), error: z.string() }),
  ]).nullable(),
});

/** One change a run made: a field it set, or a record it added. */
export type RunWrite = z.infer<typeof WriteSchema>;

/** One run of one claim under one definition of its automation. */
export interface StoredRun {
  version: 1;
  claimId: string;
  /** The engine automation id, "collection:<collection path>#<id>". */
  automationId: string;
  definitionHash: string;
  startedAtMs: number;
  updatedAtMs: number;
  /**
   * The steps' planned effects, saved once every formula has an answer and
   * dropped when the run is done. Its writes stay.
   */
  plan: PlannedStep[] | null;
  /** What each finished step wrote, in plan order. */
  done: Array<{ ordinal: number; writes: RunWrite[] }>;
  /** A person chose to run the claim again from the start under a newer definition. */
  superseded: boolean;
  outcome: { state: "done" } | { state: "skipped" } | { state: "failed"; error: string } | null;
}

const SubscriptionsSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(z.object({
    automationId: z.string().min(1),
    path: z.string().min(1),
    kinds: z.array(z.enum(["added", "changed", "removed"])),
    fields: z.array(z.string()).optional(),
  })),
});

const ReachVerdictsSchema = z.object({
  version: z.literal(1),
  verdicts: z.array(z.object({
    automationId: z.string().min(1),
    definitionHash: z.string().min(1),
    step: z.number().int().nonnegative(),
    verdict: z.enum(["allowed", "stopped", "held"]),
    stoppedFor: z.string().nullable(),
    seq: z.number().int().nonnegative(),
  })),
});

export interface StoredSubscription {
  automationId: string;
  path: string;
  kinds: AutomationChangeKind[];
  fields?: string[];
}

function hashName(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// A folder under the metadata folder: made when missing, never a symlink,
// so a planted link cannot send run records outside the workspace.
async function realFolder(path: string): Promise<string> {
  let stats = await lstat(path).catch(() => null);
  if (stats === null) {
    await mkdir(path);
    stats = await lstat(path);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${path} must be a folder inside this workspace.`);
  }
  return path;
}

async function writeDurably(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(temp, "w");
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function readJson(path: string): Promise<unknown> {
  const stats = await lstat(path).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_RUN_FILE_BYTES) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export interface AutomationRunStore {
  /** Every run of one claim, one per definition it ran under. */
  runsOf(automationId: string, claimId: string): Promise<StoredRun[]>;
  /** Saves a run before the executor goes on. */
  save(run: StoredRun): Promise<void>;
  /** The automation's runs, newest first. */
  list(automationId: string, limit: number): Promise<StoredRun[]>;
  /** Drops the oldest finished runs past the bound. */
  prune(automationId: string): Promise<void>;
  readSubscriptions(): Promise<StoredSubscription[]>;
  saveSubscriptions(subscriptions: readonly StoredSubscription[]): Promise<void>;
  readReachVerdicts(): Promise<StoredReachVerdict[]>;
  saveReachVerdicts(verdicts: readonly StoredReachVerdict[]): Promise<void>;
}

export function createAutomationRunStore(rootPath: string): AutomationRunStore {
  // Writes queue behind each other, so two saves never race one rename.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const base = async () => realFolder(join(await resolveWorkspaceMetadataDir(rootPath), "automations"));
  const runsFolder = async (automationId: string) =>
    realFolder(join(await realFolder(join(await base(), "runs")), hashName(automationId)));
  const runFile = (folder: string, claimId: string, hash: string) =>
    join(folder, `${hashName(claimId)}-${hash.replace(/[^a-f0-9]/g, "")}.json`);

  async function readRuns(automationId: string): Promise<StoredRun[]> {
    const folder = await runsFolder(automationId);
    const names = (await readdir(folder)).filter((name) => name.endsWith(".json"));
    const runs: StoredRun[] = [];
    for (const name of names) {
      const parsed = StoredRunSchema.safeParse(await readJson(join(folder, name)));
      if (parsed.success && parsed.data.automationId === automationId) runs.push(parsed.data);
    }
    return runs.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }

  return {
    async runsOf(automationId, claimId) {
      const folder = await runsFolder(automationId);
      const prefix = `${hashName(claimId)}-`;
      const runs: StoredRun[] = [];
      for (const name of await readdir(folder)) {
        if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
        const parsed = StoredRunSchema.safeParse(await readJson(join(folder, name)));
        if (parsed.success && parsed.data.claimId === claimId && parsed.data.automationId === automationId) {
          runs.push(parsed.data);
        }
      }
      return runs;
    },
    save(run) {
      return serial(async () => {
        const folder = await runsFolder(run.automationId);
        await writeDurably(runFile(folder, run.claimId, run.definitionHash), run);
      });
    },
    async list(automationId, limit) {
      return (await readRuns(automationId)).slice(0, limit);
    },
    prune(automationId) {
      return serial(async () => {
        const folder = await runsFolder(automationId);
        if ((await readdir(folder)).length < PRUNE_AFTER_FILES) return;
        const runs = await readRuns(automationId);
        const finished = runs.filter((run) => run.outcome !== null && run.outcome.state !== "failed");
        const unfinished = runs.filter((run) => run.outcome === null || run.outcome.state === "failed");
        const dropped = [...finished.slice(KEEP_FINISHED_RUNS), ...unfinished.slice(KEEP_UNFINISHED_RUNS)];
        for (const run of dropped) {
          await rm(runFile(folder, run.claimId, run.definitionHash), { force: true });
        }
      });
    },
    async readSubscriptions() {
      const parsed = SubscriptionsSchema.safeParse(await readJson(join(await base(), "subscriptions.json")));
      return parsed.success ? parsed.data.subscriptions : [];
    },
    saveSubscriptions(subscriptions) {
      return serial(async () => {
        await writeDurably(join(await base(), "subscriptions.json"), { version: 1, subscriptions });
      });
    },
    async readReachVerdicts() {
      const parsed = ReachVerdictsSchema.safeParse(await readJson(join(await base(), "reach.json")));
      return parsed.success ? parsed.data.verdicts : [];
    },
    saveReachVerdicts(verdicts) {
      return serial(async () => {
        await writeDurably(join(await base(), "reach.json"), { version: 1, verdicts });
      });
    },
  };
}

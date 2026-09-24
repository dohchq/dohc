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
// and each effect is saved as it lands, before the next one starts. A run
// that stops part way, from a crash or a failed write, resumes from here
// instead of evaluating again, so no effect lands twice. Undo and run
// history read the same records.
//
// Every file is written to a temporary name, flushed to disk, and renamed
// over the old one, so a crash leaves the old record or the new one.

// A run of 200 field writes with values near the claim's value bound stays
// under this. The executor refuses a larger plan before it writes anything.
export const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;
// Run history keeps this many finished runs per automation. A run a claim
// may still resume is never dropped.
const KEEP_FINISHED_RUNS = 20;
// Pruning reads every run of the automation, so it waits for this many.
const PRUNE_AFTER_FILES = KEEP_FINISHED_RUNS * 2;

// Values are this computer's own writes, read back as JSON.parse left them;
// the write seam checks each one again before it writes.
const JsonValueSchema = z.custom<JsonValue>((value) => value !== undefined);
const TargetSchema = z.union([
  z.object({ recordId: z.string(), collectionPath: z.string(), path: z.string() }),
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
  z.object({
    kind: z.literal("kept"),
    recordId: z.string(),
    path: z.string(),
    field: z.string(),
    planned: JsonValueSchema,
    current: JsonValueSchema,
  }),
  z.object({ kind: z.literal("skipped"), recordId: z.string(), path: z.string(), reason: z.string() }),
]);
const StoredRunSchema = z.object({
  version: z.literal(1),
  claimId: z.string().min(1),
  automationId: z.string().min(1),
  definitionHash: z.string().min(1),
  startedAtMs: z.number(),
  updatedAtMs: z.number(),
  plan: z.array(z.object({ ordinal: z.number().int().nonnegative(), effects: z.array(EffectSchema) })).nullable(),
  applied: z.array(z.object({ ordinal: z.number().int().nonnegative(), writes: z.array(WriteSchema) })),
  superseded: z.boolean(),
  settled: z.boolean(),
  outcome: z.union([
    z.object({ state: z.literal("done") }),
    z.object({ state: z.literal("failed"), error: z.string() }),
  ]).nullable(),
});

/**
 * What one effect did: a field the automation wrote, a record it added, a
 * field someone else had changed since the plan (kept as they left it), or a
 * record it could no longer find.
 */
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
  /** What each effect that landed did, in plan order, one entry per effect. */
  applied: Array<{ ordinal: number; writes: RunWrite[] }>;
  /** A person chose to run the claim again from the start under a newer definition. */
  superseded: boolean;
  /** The engine accepted this run's claim as done, so nothing will resume it. */
  settled: boolean;
  outcome: { state: "done" } | { state: "failed"; error: string } | null;
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

const TimeoutsSchema = z.object({
  version: z.literal(1),
  timeouts: z.array(z.object({ automationId: z.string().min(1), count: z.number().int().nonnegative() })),
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

// A file's JSON, undefined when it does not exist, or null when it cannot be
// read as JSON within the size bound.
async function readJson(path: string): Promise<unknown> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_RUN_FILE_BYTES) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export interface AutomationRunStore {
  /**
   * Every run of one claim, one per definition it ran under. `unreadable`
   * is true when a saved run exists that cannot be read: the claim must not
   * start over as if it had none.
   */
  runsOf(automationId: string, claimId: string): Promise<{ runs: StoredRun[]; unreadable: boolean }>;
  /** Saves a run before the executor goes on. */
  save(run: StoredRun): Promise<void>;
  /** Drops the oldest settled or superseded runs past the history bound. */
  prune(automationId: string): Promise<void>;
  readSubscriptions(): Promise<StoredSubscription[]>;
  saveSubscriptions(subscriptions: readonly StoredSubscription[]): Promise<void>;
  readReachVerdicts(): Promise<StoredReachVerdict[]>;
  saveReachVerdicts(verdicts: readonly StoredReachVerdict[]): Promise<void>;
  /** Consecutive timed-out runs per automation, for the circuit breaker. */
  readTimeouts(): Promise<Map<string, number>>;
  saveTimeouts(timeouts: ReadonlyMap<string, number>): Promise<void>;
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
  const readRun = async (path: string, automationId: string): Promise<StoredRun | null> => {
    const parsed = StoredRunSchema.safeParse(await readJson(path));
    return parsed.success && parsed.data.automationId === automationId ? parsed.data : null;
  };

  return {
    async runsOf(automationId, claimId) {
      const folder = await runsFolder(automationId);
      const prefix = `${hashName(claimId)}-`;
      const runs: StoredRun[] = [];
      let unreadable = false;
      for (const name of await readdir(folder)) {
        if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
        const run = await readRun(join(folder, name), automationId);
        if (run?.claimId === claimId) runs.push(run);
        else unreadable = true;
      }
      return { runs, unreadable };
    },
    save(run) {
      return serial(async () => {
        const folder = await runsFolder(run.automationId);
        await writeDurably(runFile(folder, run.claimId, run.definitionHash), run);
      });
    },
    prune(automationId) {
      return serial(async () => {
        const folder = await runsFolder(automationId);
        const names = (await readdir(folder)).filter((name) => name.endsWith(".json"));
        if (names.length < PRUNE_AFTER_FILES) return;
        const history: StoredRun[] = [];
        for (const name of names) {
          const run = await readRun(join(folder, name), automationId);
          // Only a run nothing can resume leaves: its claim settled done, or
          // a person chose to start it over.
          if (run && ((run.settled && run.outcome?.state === "done") || run.superseded)) history.push(run);
        }
        history.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
        for (const run of history.slice(KEEP_FINISHED_RUNS)) {
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
    async readTimeouts() {
      const parsed = TimeoutsSchema.safeParse(await readJson(join(await base(), "timeouts.json")));
      return new Map(parsed.success ? parsed.data.timeouts.map((entry) => [entry.automationId, entry.count]) : []);
    },
    saveTimeouts(timeouts) {
      return serial(async () => {
        const entries = [...timeouts].map(([automationId, count]) => ({ automationId, count }));
        await writeDurably(join(await base(), "timeouts.json"), { version: 1, timeouts: entries });
      });
    },
  };
}

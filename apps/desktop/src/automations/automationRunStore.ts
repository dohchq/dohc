import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { AutomationChangeKind } from "@dohc/workspace-engine-client";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import type { PlannedEffect } from "./automationPlan";
import type { StoredReachVerdict } from "./reachVerdicts";

// This computer's record of each Collection automation run, under
// <workspace>/.dohc/automations. Claims are local to the computer that ran
// them, so their runs are too. A run's plan is saved once, before its first
// write, and each effect is appended to its progress as it lands, before the
// next one starts. A run that stops part way, from a crash or a failed
// write, resumes from here instead of evaluating again, so no effect lands
// twice. Undo and run history read the same records.
//
// A whole file is written to a temporary name, flushed to disk, and renamed
// over the old one, so a crash leaves the old record or the new one. An
// appended line is flushed before the next effect starts.

// The executor refuses a run whose plan, with every effect recorded as
// planned, is larger than this, before it writes anything.
export const RUN_PLAN_BUDGET_BYTES = 4 * 1024 * 1024;
// The largest saved run this store writes or reads. It leaves room for
// values other people changed that are larger than the plan expected.
export const MAX_RUN_FILE_BYTES = 4 * RUN_PLAN_BUDGET_BYTES;
// Run history keeps this many finished runs per automation. A run a claim
// may still resume is never dropped.
const KEEP_FINISHED_RUNS = 20;
// Compacted failures kept per automation, so an old claim's Try again still
// refuses instead of starting over. Beyond this, only the engine's failure
// row remains.
const KEEP_COMPACTED_RUNS = 100;

// Values are this computer's own writes, read back as JSON.parse left them;
// the write seam checks each one again before it writes.
const JsonValueSchema = z.custom<JsonValue>((value) => value !== undefined);
const TargetSchema = z.union([
  z.object({ recordId: z.string(), collectionPath: z.string(), path: z.string() }),
  z.object({ addedBy: z.number().int().nonnegative() }),
]);
const DatasetRecordIdSchema = z.union([z.string(), z.number()]);
// The approved rules a dataset effect was planned under. It runs under them
// or not at all.
const DatasetRulesSchema = z.object({ datasetId: z.string(), revision: z.number().int().positive(), revisionSha256: z.string() });
const DatasetFieldSchema = z.object({ fieldId: z.string(), field: z.string(), before: JsonValueSchema, after: JsonValueSchema });
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
  z.object({
    kind: z.literal("dataset-edit"),
    rules: DatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    // A record the plan read, at the version it read; or one an earlier step adds.
    target: z.union([z.object({ recordId: DatasetRecordIdSchema, version: z.number().int().positive() }), z.object({ addedBy: z.number().int().nonnegative() })]),
    fields: z.array(DatasetFieldSchema),
  }),
  z.object({
    kind: z.literal("dataset-create"),
    rules: DatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    values: z.array(z.object({ fieldId: z.string(), field: z.string(), value: JsonValueSchema })),
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
  // A dataset edit that landed: each field's value before (the operation's
  // priorValues) and after, and the record's version after it.
  z.object({
    kind: z.literal("dataset-edit"),
    rules: DatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    recordId: DatasetRecordIdSchema,
    version: z.number().int().positive(),
    fields: z.array(DatasetFieldSchema),
  }),
  z.object({
    kind: z.literal("dataset-created"),
    rules: DatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    recordId: DatasetRecordIdSchema,
    version: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("dataset-kept"), recordId: DatasetRecordIdSchema, fieldId: z.string(), field: z.string(), planned: JsonValueSchema, current: JsonValueSchema }),
  z.object({ kind: z.literal("dataset-skipped"), recordId: DatasetRecordIdSchema, reason: z.string() }),
]);
// A dataset edit refused because its record changed, sent again: the record's
// new version, the fields still to write, and what the re-read kept.
const ReplanSchema = z.object({
  effect: z.number().int().nonnegative(),
  replan: z.number().int().positive(),
  version: z.number().int().positive(),
  fields: z.array(DatasetFieldSchema),
  kept: z.array(WriteSchema),
});
// Version 2 keeps progress in a file beside the plan. A run in any other
// format cannot be read, and the claim fails instead of starting over.
const StoredRunSchema = z.object({
  version: z.literal(2),
  claimId: z.string().min(1),
  automationId: z.string().min(1),
  definitionHash: z.string().min(1),
  keySeed: z.string().min(1),
  startedAtMs: z.number(),
  updatedAtMs: z.number(),
  plan: z.array(z.object({ ordinal: z.number().int().nonnegative(), effects: z.array(EffectSchema) })).nullable(),
  applied: z.array(z.object({ ordinal: z.number().int().nonnegative(), writes: z.array(WriteSchema) })),
  created: z.array(z.object({ ordinal: z.number().int().nonnegative(), recordId: z.string(), path: z.string() })),
  replans: z.array(ReplanSchema),
  readableFields: z.array(z.string()).nullable(),
  superseded: z.boolean(),
  undo: z.enum(["started", "done"]).nullable(),
  settled: z.boolean(),
  compacted: z.boolean(),
  outcome: z.union([
    z.object({ state: z.literal("done") }),
    z.object({ state: z.literal("failed"), error: z.string(), run: z.number().int().positive() }),
  ]).nullable(),
});

/**
 * What one effect did: a field the automation wrote, a record it added, a
 * field someone else had changed since the plan (kept as they left it), or a
 * record it could no longer find.
 */
export type RunWrite = z.infer<typeof WriteSchema>;
/** A planned effect on a dataset record, through one of its approved operations. */
export type DatasetEffect = Extract<z.infer<typeof EffectSchema>, { kind: "dataset-edit" | "dataset-create" }>;
export type DatasetReplan = z.infer<typeof ReplanSchema>;
/** One step's effects, on document records or on dataset records. */
export interface StoredStep {
  ordinal: number;
  effects: Array<PlannedEffect | DatasetEffect>;
}

/** One run of one claim under one definition of its automation. */
export interface StoredRun {
  version: 2;
  claimId: string;
  /** The engine automation id, "collection:<collection path>#<id>". */
  automationId: string;
  definitionHash: string;
  /** What the run's idempotency keys and added record ids derive from: the definition hash and the claim's run. */
  keySeed: string;
  startedAtMs: number;
  updatedAtMs: number;
  /**
   * The steps' planned effects, saved once every formula has an answer and
   * dropped when the run is done. Its writes stay.
   */
  plan: StoredStep[] | null;
  /** What each effect that landed did, in plan order, one entry per effect. */
  applied: Array<{ ordinal: number; writes: RunWrite[] }>;
  /**
   * Records add-record steps created, with the id the engine gave each,
   * saved before their fields are written.
   */
  created: Array<{ ordinal: number; recordId: string; path: string }>;
  /** Dataset edits sent again after their record changed, saved before each is sent. */
  replans: DatasetReplan[];
  /**
   * The dataset fields the plan's formulas could see, or null for a document
   * Collection. A run resumes only while every one of them is still readable.
   */
  readableFields: string[] | null;
  /** A person chose to run the claim again from the start under a newer definition. */
  superseded: boolean;
  /**
   * A person's Undo of what this run changed: "started" is saved before it
   * reverses anything, and "done" once it has. Either way the run's keys
   * and record ids are spent, so the claim never runs again, and an Undo
   * that stopped part way resumes.
   */
  undo: "started" | "done" | null;
  /** The engine accepted this run's claim as done, so nothing will resume it. */
  settled: boolean;
  /**
   * The run failed long ago, and run history no longer shows its claim, so
   * its plan and progress were dropped. It cannot resume.
   */
  compacted: boolean;
  /** A failed run names the claim's run it failed in: 1, plus one per Try again. */
  outcome: { state: "done" } | { state: "failed"; error: string; run: number } | null;
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
    step: z.string().min(1).max(512),
    verdict: z.enum(["allowed", "stopped", "held"]),
    stoppedFor: z.string().nullable(),
    narrowed: z.literal(true).optional(),
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

const HEADER_SUFFIX = ".json";
const PROGRESS_SUFFIX = ".progress.jsonl";

function hashName(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// Makes a new directory entry durable. On POSIX that is an fsync of the
// folder that holds it. Node cannot open a folder for fsync on Windows, where
// NTFS journals the rename or create itself, so a flushed file plus the
// rename is the strongest guarantee there.
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// A folder under the metadata folder: made when missing, never a symlink,
// so a planted link cannot send run records outside the workspace.
async function realFolder(path: string): Promise<string> {
  let stats = await lstat(path).catch(() => null);
  if (stats === null) {
    // Two readers can both find it missing; the second finds the first's folder.
    await mkdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await syncFolder(dirname(path));
    stats = await lstat(path);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${path} must be a folder inside this workspace.`);
  }
  return path;
}

// A folder that must already exist, for reads that change nothing: null when
// it does not, and "unusable" when something other than a real folder is there.
async function existingFolder(path: string): Promise<string | null | "unusable"> {
  const stats = await lstat(path).catch(() => null);
  if (stats === null) return null;
  return stats.isSymbolicLink() || !stats.isDirectory() ? "unusable" : path;
}

async function writeDurably(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(temp, "w");
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    await syncFolder(dirname(path));
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

// A file's text, undefined when it does not exist, or null when it is not a
// plain file within the size bound.
async function readBounded(path: string): Promise<string | undefined | null> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_RUN_FILE_BYTES) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// A file's JSON, undefined when it does not exist, or null when it cannot be
// read as JSON within the size bound.
async function readJson(path: string): Promise<unknown> {
  const text = await readBounded(path);
  if (text === undefined || text === null) return text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const tooLarge = () =>
  new Error("This run's progress is too large for dohc to save, so it stopped. Narrow its Find steps, or split it into smaller automations.");

export interface AutomationRunStore {
  /**
   * Every run of one claim, one per run it was planned in. `unreadable` is
   * true when a saved run exists that cannot be read: the claim must not
   * start over as if it had none. Reads only: it makes no folder.
   */
  runsOf(automationId: string, claimId: string): Promise<{ runs: StoredRun[]; unreadable: boolean }>;
  /**
   * Saves a run: its plan and state, and its progress as `applied` holds
   * it. Refuses a run too large to read back.
   */
  save(run: StoredRun): Promise<void>;
  /** Records one landed effect after the run's saved progress, without writing the plan again. */
  appendEffect(run: StoredRun, applied: StoredRun["applied"][number]): Promise<void>;
  /**
   * Records the record an add-record step created, with the id the engine
   * gave it, before its fields are written.
   */
  recordCreated(run: StoredRun, created: StoredRun["created"][number]): Promise<void>;
  /** Records a dataset edit's replan before it is sent under its new key. */
  recordReplan(run: StoredRun, replan: DatasetReplan): Promise<void>;
  /**
   * Drops the oldest settled or superseded runs past the history bound,
   * compacts failed runs whose claims are not in `resumableClaims`, and
   * drops the oldest compacted runs past their bound. It reads the folder
   * only once it has grown by the history bound since the last prune.
   */
  prune(automationId: string, resumableClaims: () => Promise<ReadonlySet<string> | null>): Promise<void>;
  readSubscriptions(): Promise<StoredSubscription[]>;
  saveSubscriptions(subscriptions: readonly StoredSubscription[]): Promise<void>;
  /**
   * Each step's last reach verdict. `unreadable` is true when the file is
   * there and cannot be read, so no step can be treated as seen before.
   */
  readReachVerdicts(): Promise<{ verdicts: StoredReachVerdict[]; unreadable: boolean }>;
  saveReachVerdicts(verdicts: readonly StoredReachVerdict[]): Promise<void>;
  /** Where the reach verdicts are saved, for a person to look at. */
  reachVerdictsPath(): Promise<string>;
  /** Consecutive timed-out runs per automation, for the circuit breaker. */
  readTimeouts(): Promise<Map<string, number>>;
  saveTimeouts(timeouts: ReadonlyMap<string, number>): Promise<void>;
}

type ProgressLine =
  | ({ kind: "effect" } & StoredRun["applied"][number])
  | ({ kind: "created" } & StoredRun["created"][number])
  | ({ kind: "replan" } & DatasetReplan);

const ProgressLineSchema = z.union([
  z.object({ kind: z.literal("effect"), ordinal: z.number().int().nonnegative(), writes: z.array(WriteSchema) }),
  z.object({ kind: z.literal("created"), ordinal: z.number().int().nonnegative(), recordId: z.string(), path: z.string() }),
  ReplanSchema.extend({ kind: z.literal("replan") }),
]);

function progressText(run: StoredRun): string {
  const lines: ProgressLine[] = [
    ...run.created.map((created) => ({ kind: "created" as const, ...created })),
    ...run.replans.map((replan) => ({ kind: "replan" as const, ...replan })),
    ...run.applied.map((applied) => ({ kind: "effect" as const, ...applied })),
  ];
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

export function createAutomationRunStore(rootPath: string): AutomationRunStore {
  // The file count at which each automation's folder is pruned next.
  const pruneAt = new Map<string, number>();
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
  const runName = (claimId: string, keySeed: string) => `${hashName(claimId)}-${keySeed.replace(/[^a-z0-9-]/g, "")}`;
  // Every run keeps its plan and state in one file, written whole, and its
  // progress in a second, one line per landed effect.
  const readRun = async (folder: string, name: string, automationId: string): Promise<StoredRun | null> => {
    const header = StoredRunSchema.omit({ applied: true, created: true, replans: true }).safeParse(await readJson(join(folder, `${name}${HEADER_SUFFIX}`)));
    if (!header.success || header.data.automationId !== automationId) return null;
    if (runName(header.data.claimId, header.data.keySeed) !== name) return null;
    const run: StoredRun = { ...header.data, applied: [], created: [], replans: [] };
    if (run.compacted) return run;
    // A run that can resume always has its progress file, empty or not.
    const progress = await readBounded(join(folder, `${name}${PROGRESS_SUFFIX}`));
    if (progress === null || progress === undefined) return null;
    // A line cut short by a crash is an effect that may have landed and was
    // not recorded; the run resumes it as one.
    const lines = progress.split("\n").slice(0, -1);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return null;
      }
      const entry = ProgressLineSchema.safeParse(parsed);
      if (!entry.success) return null;
      if (entry.data.kind === "effect") run.applied.push({ ordinal: entry.data.ordinal, writes: entry.data.writes });
      else if (entry.data.kind === "replan") run.replans.push({ effect: entry.data.effect, replan: entry.data.replan, version: entry.data.version, fields: entry.data.fields, kept: entry.data.kept });
      else {
        // The newest line for a step is the record it created.
        const { ordinal, recordId, path } = entry.data;
        run.created = [...run.created.filter((created) => created.ordinal !== ordinal), { ordinal, recordId, path }];
      }
    }
    return run;
  };
  // Appends one line durably. A torn line a crash left at the end goes first,
  // so the new line starts on a line of its own.
  const appendLine = async (run: StoredRun, line: ProgressLine) => {
    const folder = await runsFolder(run.automationId);
    const path = join(folder, `${runName(run.claimId, run.keySeed)}${PROGRESS_SUFFIX}`);
    const text = `${JSON.stringify(line)}\n`;
    const existing = await lstat(path).catch(() => null);
    if (existing !== null) {
      if (existing.size + Buffer.byteLength(text) > MAX_RUN_FILE_BYTES) throw tooLarge();
      const file = await open(path, "r+");
      try {
        const last = Buffer.alloc(1);
        if (existing.size > 0 && (await file.read(last, 0, 1, existing.size - 1)).bytesRead === 1 && last[0] !== 0x0a) {
          const whole = await readFile(path);
          await file.truncate(whole.lastIndexOf(0x0a) + 1);
          await file.sync();
        }
      } finally {
        await file.close();
      }
    }
    const file = await open(path, "a");
    try {
      await file.appendFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    if (existing === null) await syncFolder(folder);
  };
  const removeRun = async (folder: string, name: string) => {
    await rm(join(folder, `${name}${PROGRESS_SUFFIX}`), { force: true });
    await rm(join(folder, `${name}${HEADER_SUFFIX}`), { force: true });
  };
  const header = (run: StoredRun) => {
    const { applied: _applied, created: _created, replans: _replans, ...rest } = run;
    return rest;
  };

  return {
    async runsOf(automationId, claimId) {
      let folder = rootPath;
      for (const segment of [".dohc", "automations", "runs", hashName(automationId)]) {
        const found = await existingFolder(join(folder, segment));
        if (found === null) return { runs: [], unreadable: false };
        if (found === "unusable") return { runs: [], unreadable: true };
        folder = found;
      }
      const prefix = `${hashName(claimId)}-`;
      const found: StoredRun[] = [];
      let unreadable = false;
      for (const file of await readdir(folder)) {
        if (!file.startsWith(prefix) || !file.endsWith(HEADER_SUFFIX) || file.endsWith(PROGRESS_SUFFIX)) continue;
        const run = await readRun(folder, file.slice(0, -HEADER_SUFFIX.length), automationId);
        if (run?.claimId === claimId) found.push(run);
        else unreadable = true;
      }
      return { runs: found, unreadable };
    },
    save(run) {
      return serial(async () => {
        const plan = `${JSON.stringify(header(run))}\n`;
        const progress = progressText(run);
        if (Buffer.byteLength(plan) > MAX_RUN_FILE_BYTES || Buffer.byteLength(progress) > MAX_RUN_FILE_BYTES) throw tooLarge();
        const folder = await runsFolder(run.automationId);
        const name = runName(run.claimId, run.keySeed);
        await writeDurably(join(folder, `${name}${PROGRESS_SUFFIX}`), progress);
        await writeDurably(join(folder, `${name}${HEADER_SUFFIX}`), plan);
      });
    },
    appendEffect(run, applied) {
      return serial(() => appendLine(run, { kind: "effect", ...applied }));
    },
    recordCreated(run, created) {
      return serial(() => appendLine(run, { kind: "created", ...created }));
    },
    recordReplan(run, replan) {
      return serial(() => appendLine(run, { kind: "replan", ...replan }));
    },
    prune(automationId, resumableClaims) {
      return serial(async () => {
        const folder = await runsFolder(automationId);
        const names = (await readdir(folder))
          .filter((file) => file.endsWith(HEADER_SUFFIX) && !file.endsWith(PROGRESS_SUFFIX))
          .map((file) => file.slice(0, -HEADER_SUFFIX.length));
        if (names.length < (pruneAt.get(automationId) ?? KEEP_FINISHED_RUNS * 2)) return;
        const resumable = await resumableClaims();
        const history: Array<{ name: string; run: StoredRun }> = [];
        const compacted: Array<{ name: string; run: StoredRun }> = [];
        let kept = names.length;
        for (const name of names) {
          const run = await readRun(folder, name, automationId);
          if (!run) continue;
          // Only a run nothing can resume leaves: its claim settled done, or
          // a person chose to start it over.
          if ((run.settled && run.outcome?.state === "done") || run.superseded) {
            history.push({ name, run });
          } else if (run.compacted) {
            compacted.push({ name, run });
          } else if (resumable !== null && run.outcome?.state === "failed" && !resumable.has(run.claimId)) {
            // Nothing offers its Try again any more, so only its failure stays.
            const tombstone = { ...run, plan: null, applied: [], created: [], replans: [], compacted: true };
            await writeDurably(join(folder, `${name}${HEADER_SUFFIX}`), `${JSON.stringify(header(tombstone))}\n`);
            await rm(join(folder, `${name}${PROGRESS_SUFFIX}`), { force: true });
            compacted.push({ name, run: tombstone });
          }
        }
        const newestFirst = (left: { run: StoredRun }, right: { run: StoredRun }) => right.run.updatedAtMs - left.run.updatedAtMs;
        for (const { name } of [
          ...history.sort(newestFirst).slice(KEEP_FINISHED_RUNS),
          ...compacted.sort(newestFirst).slice(KEEP_COMPACTED_RUNS),
        ]) {
          await removeRun(folder, name);
          kept -= 1;
        }
        pruneAt.set(automationId, kept + KEEP_FINISHED_RUNS);
      });
    },
    async readSubscriptions() {
      const parsed = SubscriptionsSchema.safeParse(await readJson(join(await base(), "subscriptions.json")));
      return parsed.success ? parsed.data.subscriptions : [];
    },
    saveSubscriptions(subscriptions) {
      return serial(async () => {
        await writeDurably(join(await base(), "subscriptions.json"), `${JSON.stringify({ version: 1, subscriptions })}\n`);
      });
    },
    async readReachVerdicts() {
      const read = await readJson(join(await base(), "reach.json"));
      if (read === undefined) return { verdicts: [], unreadable: false };
      const parsed = ReachVerdictsSchema.safeParse(read);
      return parsed.success ? { verdicts: parsed.data.verdicts, unreadable: false } : { verdicts: [], unreadable: true };
    },
    saveReachVerdicts(verdicts) {
      return serial(async () => {
        await writeDurably(join(await base(), "reach.json"), `${JSON.stringify({ version: 1, verdicts })}\n`);
      });
    },
    async reachVerdictsPath() {
      return join(await base(), "reach.json");
    },
    async readTimeouts() {
      const parsed = TimeoutsSchema.safeParse(await readJson(join(await base(), "timeouts.json")));
      return new Map(parsed.success ? parsed.data.timeouts.map((entry) => [entry.automationId, entry.count]) : []);
    },
    saveTimeouts(timeouts) {
      return serial(async () => {
        const entries = [...timeouts].map(([automationId, count]) => ({ automationId, count }));
        await writeDurably(join(await base(), "timeouts.json"), `${JSON.stringify({ version: 1, timeouts: entries })}\n`);
      });
    },
  };
}

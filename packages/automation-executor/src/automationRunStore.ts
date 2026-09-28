import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { AutomationChangeKind } from "@dohc/workspace-engine-client";
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
// Run history keeps a claim's saved runs this long after its last run
// ended, as both ledgers keep the claim itself.
const RUN_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
// A folder is read whole at most this often, so a busy automation's runs
// are not all read every pass; a run may stay this much past its 30 days.
const WHOLE_READ_MS = 24 * 60 * 60 * 1000;
// The most plan files one expiry batch reads.
const EXPIRE_BATCH_RUNS = 200;

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
  // An action to run with the input its formulas gave, saved before it is
  // sent so a resumed run sends the same input under the same key.
  z.object({
    kind: z.literal("dataset-action"),
    rules: DatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    input: z.record(z.string(), JsonValueSchema),
  }),
  z.object({
    kind: z.literal("message"),
    effectId: z.string(),
    messageId: z.string(),
    threadId: z.string(),
    to: z.union([
      z.object({ kind: z.literal("group"), channelId: z.string(), lane: z.enum(["posts", "chat"]) }),
      z.object({ kind: z.literal("direct-message"), userId: z.string(), threadId: z.string() }),
    ]),
    name: z.string(),
    channelWireId: z.string(),
    body: z.string(),
    byFormula: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("wake"),
    effectId: z.string(),
    messageId: z.string(),
    threadId: z.string(),
    person: z.string(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("notice"),
    name: z.string(),
    notice: z.object({
      noticeId: z.string(),
      kind: z.literal("automation-notify"),
      title: z.string(),
      body: z.string(),
      target: z.object({ path: z.string(), record: z.string().optional(), automation: z.string(), run: z.string() }),
      recipientUserId: z.string(),
    }),
    byFormula: z.boolean().optional(),
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
  // An action that ran, by its label then, and the dataset revision its
  // commit made. `undo` is what its reverse action takes, for an action the
  // rules say can be reversed, and `reverseOperationId` is that reverse.
  z.object({
    kind: z.literal("dataset-action"),
    rules: DatasetRulesSchema,
    operationId: z.string(),
    tableId: z.string(),
    name: z.string(),
    revision: z.number().int().nonnegative(),
    undo: JsonValueSchema.optional(),
    // The reverse action the rules named when this one ran; Undo runs that one or none.
    reverseOperationId: z.string().optional(),
  }),
  z.object({ kind: z.literal("dataset-kept"), recordId: DatasetRecordIdSchema, fieldId: z.string(), field: z.string(), planned: JsonValueSchema, current: JsonValueSchema }),
  z.object({ kind: z.literal("dataset-skipped"), recordId: DatasetRecordIdSchema, reason: z.string() }),
  // A post or direct message the automation wrote, and where it went.
  z.object({ kind: z.literal("message"), messageId: z.string(), name: z.string() }),
  // A notice the automation sent, and to whom.
  z.object({ kind: z.literal("notice"), noticeId: z.string(), name: z.string() }),
]);
// A record the run created: the id its plan gave it, which finds it again on
// a retry, and the id and path the engine gave it.
const CreatedSchema = z.object({ ordinal: z.number().int().nonnegative(), planned: z.string(), recordId: z.string(), path: z.string() });
// A dataset edit refused because its record changed, sent again: the record's
// new version, the fields still to write, and what the re-read kept.
const ReplanSchema = z.object({
  effect: z.number().int().nonnegative(),
  replan: z.number().int().positive(),
  version: z.number().int().positive(),
  fields: z.array(DatasetFieldSchema),
  kept: z.array(WriteSchema),
});
// A dataset Undo's request sent again after its record changed: saved before
// it is sent, so an Undo that stops part way sends it again under the same key.
const UndoRequestSchema = z.object({
  datasetId: z.string(),
  tableId: z.string(),
  recordId: DatasetRecordIdSchema,
  operationId: z.string(),
  version: z.number().int().positive(),
  values: z.record(z.string(), JsonValueSchema),
});
// Version 4 keeps progress in a file beside the plan, names each Collection
// the plan writes by its Collection id, and records when the run ended. A
// run in any other format cannot be read, and the claim fails instead of
// starting over.
const StoredRunSchema = z.object({
  version: z.literal(4),
  claimId: z.string().min(1),
  automationId: z.string().min(1),
  definitionHash: z.string().min(1),
  keySeed: z.string().min(1),
  startedAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
  plan: z.array(z.object({ ordinal: z.number().int().nonnegative(), effects: z.array(EffectSchema) })).nullable(),
  applied: z.array(z.object({ ordinal: z.number().int().nonnegative(), writes: z.array(WriteSchema) })),
  created: z.array(CreatedSchema),
  replans: z.array(ReplanSchema),
  undoRequests: z.array(UndoRequestSchema),
  readableFields: z.array(z.string()).nullable(),
  collections: z.array(z.object({ collectionId: z.string().min(1), path: z.string().min(1) })),
  datasetId: z.string().min(1).nullable(),
  superseded: z.boolean(),
  undo: z.enum(["started", "done"]).nullable(),
  settled: z.boolean(),
  outcome: z.union([
    z.object({ state: z.literal("done") }),
    z.object({ state: z.literal("failed"), error: z.string(), run: z.number().int().positive() }),
  ]).nullable(),
});

// A saved run's plan file: everything but its progress.
const HeaderSchema = StoredRunSchema.omit({ applied: true, created: true, replans: true, undoRequests: true });
// What run history's expiry reads of a run.
const RunEndSchema = StoredRunSchema.pick({
  version: true, claimId: true, automationId: true, keySeed: true, datasetId: true, finishedAtMs: true, undo: true,
});
// A plan file in an earlier format that still names its claim. Expiry
// counts its 30 days from when the file last changed.
const OlderRunSchema = z.object({
  claimId: z.string().min(1),
  automationId: z.string().min(1),
  keySeed: z.string().min(1),
  datasetId: z.string().min(1).nullable().optional(),
  undo: z.enum(["started", "done"]).nullable().optional(),
});
// When each folder of saved runs next holds a claim past its 30 days, and
// the claims in it that expiry asks about on every pass.
const ExpirySchema = z.object({
  version: z.literal(1),
  folders: z.array(z.object({ folder: z.string().min(1), until: z.number(), recheck: z.array(z.string().min(1)) })),
});

/**
 * What one effect did: a field the automation wrote, a record it added, a
 * field someone else had changed since the plan (kept as they left it), or a
 * record it could no longer find.
 */
export type RunWrite = z.infer<typeof WriteSchema>;
/** A planned effect on a dataset record, through one of its approved operations. */
export type DatasetEffect = Extract<z.infer<typeof EffectSchema>, { kind: "dataset-edit" | "dataset-create" | "dataset-action" }>;
export type DatasetReplan = z.infer<typeof ReplanSchema>;
export type DatasetUndoRequest = z.infer<typeof UndoRequestSchema>;
/** One step's effects, on document records or on dataset records. */
export interface StoredStep {
  ordinal: number;
  effects: Array<PlannedEffect | DatasetEffect>;
}

/** One run of one claim under one definition of its automation. */
export interface StoredRun {
  version: 4;
  claimId: string;
  /** The engine automation id, "collection:<collection id>#<id>". */
  automationId: string;
  definitionHash: string;
  /** What the run's idempotency keys and added record ids derive from: the definition hash and the claim's run. */
  keySeed: string;
  startedAtMs: number;
  /**
   * When the run ended: its outcome was saved, or a person started its claim
   * over. Null while it can still go on. An Undo leaves it, so an undone run
   * leaves run history when it would have anyway.
   */
  finishedAtMs: number | null;
  /**
   * The steps' planned effects, saved once every formula has an answer and
   * dropped when the run is done. Its writes stay.
   */
  plan: StoredStep[] | null;
  /** What each effect that landed did, in plan order, one entry per effect. */
  applied: Array<{ ordinal: number; writes: RunWrite[] }>;
  /**
   * Records the run created, each under the id its plan gave it and the id
   * the engine gave it, saved before their fields are written.
   */
  created: Array<{ ordinal: number; planned: string; recordId: string; path: string }>;
  /** Dataset edits sent again after their record changed, saved before each is sent. */
  replans: DatasetReplan[];
  /** Dataset Undo requests sent again after their record changed, saved before each is sent. */
  undoRequests: DatasetUndoRequest[];
  /**
   * The dataset fields the plan's formulas could see, or null for a document
   * Collection. A run resumes only while every one of them is still readable.
   */
  readableFields: string[] | null;
  /**
   * Each document Collection the plan writes, by its Collection id and its
   * path when the run last saw it. A resume or an Undo moves the run's
   * paths to where each Collection is now.
   */
  collections: Array<{ collectionId: string; path: string }>;
  /**
   * The dataset a dataset Collection's plan read and writes, or null for a
   * document Collection. A plan resumes only while its Collection keeps
   * that dataset.
   */
  datasetId: string | null;
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
  /** A failed run names the claim's run it failed in: 1, plus one per Try again. */
  outcome: { state: "done" } | { state: "failed"; error: string; run: number } | null;
}

const SubscriptionsSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(z.union([
    z.object({
      automationId: z.string().min(1),
      path: z.string().min(1),
      kinds: z.array(z.enum(["added", "changed", "removed"])),
      fields: z.array(z.string()).optional(),
    }),
    z.object({
      automationId: z.string().min(1),
      groupId: z.string().min(1),
      startsWith: z.string().optional(),
    }),
  ])),
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
    accountedLinks: z.array(z.string().min(1)).optional(),
    seq: z.number().int().nonnegative(),
    recipient: z.object({ id: z.string(), name: z.string(), action: z.enum(["post", "notify", "change"]) }).optional(),
  })),
});

const TimeoutsSchema = z.object({
  version: z.literal(1),
  timeouts: z.array(z.object({ automationId: z.string().min(1), count: z.number().int().nonnegative() })),
});

const ReportedFailuresSchema = z.object({
  version: z.literal(1),
  failures: z.array(z.object({
    automationId: z.string().min(1),
    datasetInstance: z.string().min(1).nullable(),
    // The failed run the notice names.
    claimId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    open: z.boolean(),
  })),
});

// The runs whose Undo started and has not finished, so run history keeps
// their claims. One entry per run, since each of a claim's runs is saved
// undone in turn.
const UnfinishedUndosSchema = z.object({
  version: z.literal(1),
  runs: z.array(z.object({ automationId: z.string().min(1), claimId: z.string().min(1), run: z.string().min(1) })),
});

const EnabledAutomationsSchema = z.object({
  version: z.literal(1),
  collections: z.array(z.object({ path: z.string().min(1), enabled: z.array(z.string().min(1)) })),
});

/** The newest failure of one automation this computer sent a notice for. */
export type ReportedFailure = z.infer<typeof ReportedFailuresSchema>["failures"][number];

/** A claim whose saved runs expiry weighs. */
export interface ExpiringClaim {
  automationId: string;
  claimId: string;
  /** The dataset its Collection kept, whose own ledger may hold the claim. */
  datasetId: string | null;
}

/**
 * What the ledgers say of a claim expiry weighs. `open`: it may still run
 * or change, as while it is pending or running, or an Undo or Try again is
 * changing it. `settled`: a ledger holds it done or failed. `gone`: no
 * ledger holds it. `unknown`: a ledger that may hold it cannot say.
 */
export type ClaimStanding = "open" | "settled" | "gone" | "unknown";

/** An engine subscription this computer holds: records under a path, or one Group's messages. */
export type StoredSubscription =
  | { automationId: string; path: string; kinds: AutomationChangeKind[]; fields?: string[] }
  | { automationId: string; groupId: string; startsWith?: string };

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
  /** Records a dataset Undo request before it is sent again at a record's new version. */
  recordUndoRequest(run: StoredRun, request: DatasetUndoRequest): Promise<void>;
  /**
   * Removes one batch of saved runs past run history's 30 days: every run
   * of a claim, once each ended 30 days before `now`, none has an
   * unfinished Undo, and no ledger holds the claim. A run that has not
   * ended stays while its claim is open; once it is not, it ended `now`.
   * Reads only plan files, never progress, and skips a folder until it
   * holds a claim that can go. It asks `standing` and reads each plan
   * file outside the write queue, then removes or ends a claim inside it
   * only when its plan files are as it read them. `from` is what the
   * batch before answered; the answer is null after the last batch.
   */
  expire(now: number, standing: (claim: ExpiringClaim) => Promise<ClaimStanding>, from: string | null): Promise<string | null>;
  /**
   * The claims of the runs whose Undo started and has not finished, as each
   * run was last saved, or null when their list cannot be read.
   */
  unfinishedUndos(): Promise<ReadonlySet<string> | null>;
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
  /**
   * The newest failure this computer sent a notice for, per automation, so
   * a failure is sent once. `open` is false once its notice was taken back.
   */
  readReportedFailures(): Promise<ReportedFailure[]>;
  saveReportedFailures(reported: readonly ReportedFailure[]): Promise<void>;
  /**
   * The ids of the switched-on automations in each Collection, as this
   * computer last read them, or null before the first save. A switch off
   * made while dohc was closed shows against these.
   */
  readEnabledAutomations(): Promise<Map<string, string[]> | null>;
  saveEnabledAutomations(enabled: ReadonlyMap<string, readonly string[]>): Promise<void>;
}

type ProgressLine =
  | ({ kind: "effect" } & StoredRun["applied"][number])
  | ({ kind: "created" } & StoredRun["created"][number])
  | ({ kind: "replan" } & DatasetReplan)
  | ({ kind: "undo-request" } & DatasetUndoRequest);

const ProgressLineSchema = z.union([
  z.object({ kind: z.literal("effect"), ordinal: z.number().int().nonnegative(), writes: z.array(WriteSchema) }),
  CreatedSchema.extend({ kind: z.literal("created") }),
  ReplanSchema.extend({ kind: z.literal("replan") }),
  UndoRequestSchema.extend({ kind: z.literal("undo-request") }),
]);

function progressText(run: StoredRun): string {
  const lines: ProgressLine[] = [
    ...run.created.map((created) => ({ kind: "created" as const, ...created })),
    ...run.replans.map((replan) => ({ kind: "replan" as const, ...replan })),
    ...run.applied.map((applied) => ({ kind: "effect" as const, ...applied })),
    ...run.undoRequests.map((request) => ({ kind: "undo-request" as const, ...request })),
  ];
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/**
 * Where a host keeps a workspace's metadata, the desktop's `<root>/.dohc`:
 * made if missing, and refused when it is not a real folder the host allows.
 * With `create: false` it makes nothing and answers null when the folder does
 * not exist, for reads that change nothing.
 */
export interface MetadataDirResolver {
  (rootPath: string): Promise<string>;
  (rootPath: string, options: { create: false }): Promise<string | null>;
}

/**
 * The run store of the workspace at `rootPath`, under `automations` in the
 * folder `resolveMetadataDir` answers. Reads that change nothing make no
 * folders.
 */
export function createAutomationRunStore(rootPath: string, resolveMetadataDir: MetadataDirResolver): AutomationRunStore {
  // Writes queue behind each other, so two saves never race one rename.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const base = async () => realFolder(join(await resolveMetadataDir(rootPath), "automations"));
  const runsFolder = async (automationId: string) =>
    realFolder(join(await realFolder(join(await base(), "runs")), hashName(automationId)));
  const runName = (claimId: string, keySeed: string) => `${hashName(claimId)}-${keySeed.replace(/[^a-z0-9-]/g, "")}`;
  // The unfinished Undos, keyed by automation and run, read once; null when
  // their file cannot be read, so nothing counts as finished.
  let undos: Map<string, { automationId: string; claimId: string; run: string }> | null | undefined;
  const undosFile = async () => join(await base(), "undoing.json");
  const readUndos = async () => {
    if (undos !== undefined) return undos;
    const read = await readJson(await undosFile());
    const parsed = read === undefined ? { success: true as const, data: { version: 1 as const, runs: [] } } : UnfinishedUndosSchema.safeParse(read);
    undos = parsed.success ? new Map(parsed.data.runs.map((entry) => [`${entry.automationId}\n${entry.run}`, entry])) : null;
    return undos;
  };
  // Records whether a saved run's Undo is unfinished, before the run itself is saved.
  const noteUndo = async (run: StoredRun, name: string) => {
    const known = await readUndos();
    if (known === null) return;
    const key = `${run.automationId}\n${name}`;
    if ((run.undo === "started") === known.has(key)) return;
    const next = new Map(known);
    if (run.undo === "started") next.set(key, { automationId: run.automationId, claimId: run.claimId, run: name });
    else next.delete(key);
    await writeDurably(await undosFile(), `${JSON.stringify({ version: 1, runs: [...next.values()] })}\n`);
    undos = next;
  };
  // Every run keeps its plan and state in one file, written whole, and its
  // progress in a second, one line per landed effect.
  const readRun = async (folder: string, name: string, automationId: string): Promise<StoredRun | null> => {
    const header = HeaderSchema.safeParse(await readJson(join(folder, `${name}${HEADER_SUFFIX}`)));
    if (!header.success || header.data.automationId !== automationId) return null;
    if (runName(header.data.claimId, header.data.keySeed) !== name) return null;
    const run: StoredRun = { ...header.data, applied: [], created: [], replans: [], undoRequests: [] };
    // Every saved run has its progress file, empty or not.
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
      else if (entry.data.kind === "undo-request") {
        const { kind: _kind, ...request } = entry.data;
        run.undoRequests.push(request);
      }
      else {
        // The newest line for a planned record is the record it created.
        const { ordinal, planned, recordId, path } = entry.data;
        run.created = [...run.created.filter((created) => created.planned !== planned), { ordinal, planned, recordId, path }];
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
  // When each folder next holds a claim past its 30 days, and the claims in
  // it asked about on every pass: read from expiry.json when a pass starts,
  // saved when it ends.
  let schedule: Map<string, { until: number; recheck: string[] }> | null = null;
  const scheduleFile = async () => join(await base(), "expiry.json");
  // The folder a pass is going through: the claims it weighs, grouped from
  // one listing, and what it learned so far. A run saved there meanwhile
  // joins its claim.
  let expiring: {
    folder: string;
    path: string;
    claims: string[][];
    groups: Map<string, string[]>;
    until: number;
    recheck: string[];
  } | null = null;
  const claimOf = (run: string) => run.slice(0, run.indexOf("-"));
  // What to do with one claim's runs, from their plan files as read now.
  type Weighed =
    | { kind: "keep"; until?: number; recheck?: true }
    | { kind: "remove" | "end"; texts: Map<string, string | null | undefined> };
  const weigh = async (folder: string, names: readonly string[], now: number, standing: (claim: ExpiringClaim) => Promise<ClaimStanding>): Promise<Weighed> => {
    const texts = new Map<string, string | null | undefined>();
    const runs: Array<{ claimId: string; automationId: string; datasetId: string | null; undo: StoredRun["undo"]; finishedAtMs: number | null }> = [];
    for (const name of names) {
      const path = join(folder, `${name}${HEADER_SUFFIX}`);
      const text = await readBounded(path);
      texts.set(name, text);
      // Removed since the folder was listed.
      if (text === undefined) continue;
      let json: unknown = null;
      try {
        json = text === null ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      const current = RunEndSchema.safeParse(json);
      if (current.success && runName(current.data.claimId, current.data.keySeed) === name) {
        runs.push(current.data);
        continue;
      }
      const older = OlderRunSchema.safeParse(json);
      const stats = await lstat(path).catch(() => null);
      // A file that names no claim stays; the folder's next full pass reads it again.
      if (!older.success || runName(older.data.claimId, older.data.keySeed) !== name || stats === null) return { kind: "keep" };
      runs.push({ ...older.data, datasetId: older.data.datasetId ?? null, undo: older.data.undo ?? null, finishedAtMs: stats.mtimeMs });
    }
    const [first] = runs;
    if (first === undefined || runs.some((run) => run.claimId !== first.claimId || run.automationId !== first.automationId)) return { kind: "keep" };
    if (runs.some((run) => run.undo === "started")) return { kind: "keep", recheck: true };
    const claim = { automationId: first.automationId, claimId: first.claimId, datasetId: runs.find((run) => run.datasetId !== null)?.datasetId ?? null };
    if (runs.some((run) => run.finishedAtMs === null)) {
      const state = await standing(claim);
      return state === "open" || state === "unknown" ? { kind: "keep", recheck: true } : { kind: "end", texts };
    }
    const due = Math.max(...runs.map((run) => run.finishedAtMs!)) + RUN_HISTORY_MS;
    if (due > now) return { kind: "keep", until: due };
    return (await standing(claim)) === "gone" ? { kind: "remove", texts } : { kind: "keep", recheck: true };
  };
  // Removes a claim's runs, or records that its unended runs ended `now`,
  // only while its plan files are as expiry read them and no run joined it.
  const apply = (folder: string, names: readonly string[], weighed: Extract<Weighed, { texts: unknown }>, now: number) => serial(async () => {
    for (const name of names) {
      if (await readBounded(join(folder, `${name}${HEADER_SUFFIX}`)) !== weighed.texts.get(name)) return false;
    }
    if (names.length !== weighed.texts.size) return false;
    for (const name of names) {
      if (weighed.kind === "remove") {
        await removeRun(folder, name);
        continue;
      }
      const text = weighed.texts.get(name);
      const header = typeof text === "string" ? HeaderSchema.safeParse(JSON.parse(text)) : null;
      if (header?.success && header.data.finishedAtMs === null) {
        await writeDurably(join(folder, `${name}${HEADER_SUFFIX}`), `${JSON.stringify({ ...header.data, finishedAtMs: now })}\n`);
      }
    }
    return true;
  });
  const header = (run: StoredRun) => {
    const { applied: _applied, created: _created, replans: _replans, undoRequests: _undoRequests, ...rest } = run;
    return rest;
  };

  return {
    async runsOf(automationId, claimId) {
      let folder: string | null;
      try {
        folder = await resolveMetadataDir(rootPath, { create: false });
      } catch {
        return { runs: [], unreadable: true };
      }
      if (folder === null) return { runs: [], unreadable: false };
      for (const segment of ["automations", "runs", hashName(automationId)]) {
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
        if (expiring?.folder === hashName(run.automationId)) {
          const group = expiring.groups.get(hashName(run.claimId));
          if (group === undefined) {
            const added = [name];
            expiring.groups.set(hashName(run.claimId), added);
            expiring.claims.push(added);
          } else if (!group.includes(name)) group.push(name);
        }
        // Saved first, so a run saved with its Undo started is always listed.
        if (run.undo === "started") await noteUndo(run, name);
        await writeDurably(join(folder, `${name}${PROGRESS_SUFFIX}`), progress);
        await writeDurably(join(folder, `${name}${HEADER_SUFFIX}`), plan);
        if (run.undo !== "started") await noteUndo(run, name);
      });
    },
    unfinishedUndos() {
      return serial(async () => {
        const known = await readUndos();
        return known === null ? null : new Set([...known.values()].map((entry) => entry.claimId));
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
    recordUndoRequest(run, request) {
      return serial(() => appendLine(run, { kind: "undo-request", ...request }));
    },
    async expire(now, standing, from) {
      const runs = await serial(async () => {
        let found: string | null;
        try {
          found = await resolveMetadataDir(rootPath, { create: false });
        } catch {
          return null;
        }
        for (const segment of ["automations", "runs"]) {
          const next = found === null ? null : await existingFolder(join(found, segment));
          if (next === null || next === "unusable") return null;
          found = next;
        }
        if (from === null) {
          expiring = null;
          if (schedule === null) {
            const read = ExpirySchema.safeParse(await readJson(await scheduleFile()));
            schedule = new Map(read.success ? read.data.folders.map(({ folder, ...rest }) => [folder, rest]) : []);
          }
        }
        return found;
      });
      if (runs === null || schedule === null) return null;
      const planned = schedule;
      // Folders in name order, and each folder's claims in the order its
      // listing gave, so `from` names where to go on.
      const [fromFolder = "", fromIndex = "0"] = from?.split("/") ?? [];
      const folders = (await readdir(runs)).sort();
      let read = 0;
      for (const name of folders.filter((entry) => entry >= fromFolder)) {
        if (expiring?.folder !== name) {
          const plan = planned.get(name);
          // Before a folder's first claim can go, only the claims asked about on every pass are read.
          const whole = plan === undefined || plan.until <= now;
          if (!whole && plan.recheck.length === 0) continue;
          const recheck = new Set(plan?.recheck);
          const listed = await serial(async () => {
            const path = await existingFolder(join(runs, name));
            if (path === null || path === "unusable") return null;
            const groups = new Map<string, string[]>();
            for (const file of await readdir(path)) {
              if (!file.endsWith(HEADER_SUFFIX) || file.endsWith(PROGRESS_SUFFIX)) continue;
              const run = file.slice(0, -HEADER_SUFFIX.length);
              if (!whole && !recheck.has(claimOf(run))) continue;
              groups.set(claimOf(run), [...(groups.get(claimOf(run)) ?? []), run]);
            }
            // A folder read whole is read whole again 30 days on, at the latest.
            expiring = { folder: name, path, claims: [...groups.values()], groups, until: whole ? now + RUN_HISTORY_MS : plan.until, recheck: [] };
            return expiring;
          });
          if (listed === null) continue;
        }
        const current = expiring!;
        for (let index = name === fromFolder ? Number(fromIndex) : 0; index < current.claims.length; index += 1) {
          if (read >= EXPIRE_BATCH_RUNS) return `${name}/${index}`;
          const names = current.claims[index]!;
          read += names.length;
          let weighed = await weigh(current.path, names, now, standing);
          if (weighed.kind !== "keep") {
            const ended: Weighed = { kind: "keep", until: now + RUN_HISTORY_MS };
            weighed = !(await apply(current.path, names, weighed, now)) ? { kind: "keep", recheck: true } : weighed.kind === "end" ? ended : weighed;
          }
          if (weighed.kind !== "keep") continue;
          if (weighed.until !== undefined) current.until = Math.min(current.until, Math.max(weighed.until, now + WHOLE_READ_MS));
          if (weighed.recheck) current.recheck.push(claimOf(names[0]!));
        }
        await serial(async () => {
          expiring = null;
          // An automation whose every run left, such as one deleted since, leaves no folder.
          if ((await readdir(current.path)).length === 0) {
            await rmdir(current.path).catch(() => undefined);
            planned.delete(name);
          } else {
            planned.set(name, { until: current.until, recheck: current.recheck });
          }
        });
      }
      await serial(async () => {
        for (const folder of planned.keys()) if (!folders.includes(folder)) planned.delete(folder);
        const entries = [...planned].map(([folder, plan]) => ({ folder, ...plan }));
        await writeDurably(await scheduleFile(), `${JSON.stringify({ version: 1, folders: entries })}\n`);
      });
      return null;
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
    async readReportedFailures() {
      const parsed = ReportedFailuresSchema.safeParse(await readJson(join(await base(), "failures.json")));
      return parsed.success ? parsed.data.failures : [];
    },
    saveReportedFailures(failures) {
      return serial(async () => {
        await writeDurably(join(await base(), "failures.json"), `${JSON.stringify({ version: 1, failures })}\n`);
      });
    },
    async readEnabledAutomations() {
      const read = await readJson(join(await base(), "enabled.json"));
      if (read === undefined) return null;
      const parsed = EnabledAutomationsSchema.safeParse(read);
      // A damaged file counts as none: nothing is reported until the next save.
      return parsed.success ? new Map(parsed.data.collections.map((entry) => [entry.path, entry.enabled])) : null;
    },
    saveEnabledAutomations(enabled) {
      return serial(async () => {
        const collections = [...enabled].map(([path, ids]) => ({ path, enabled: [...ids] }));
        await writeDurably(join(await base(), "enabled.json"), `${JSON.stringify({ version: 1, collections })}\n`);
      });
    },
  };
}

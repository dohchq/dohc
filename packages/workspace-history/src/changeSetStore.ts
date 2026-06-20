import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BoundaryCrossing,
  ChangeAuthor,
  ChangeProvenance,
  ChangeSet,
  ChangeSetKind,
  FileChange,
} from "@dohc/workspace-core";

// One persisted change set. Mirrors ChangeSet but adds the identity and
// timestamp the store assigns, so each record is self-describing on disk.
export interface HistoryRecord {
  id: string;
  recordedAtMs: number;
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: FileChange[];
  provenance?: ChangeProvenance;
  boundaryCrossings: BoundaryCrossing[];
}

// The index is a lightweight, ordered table of contents — enough to render a
// timeline without opening every per-record file. Ordering source of truth.
interface IndexEntry {
  id: string;
  recordedAtMs: number;
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  fileCount: number;
}

export interface IndexedHistoryRecord {
  index: number;
  record: HistoryRecord;
}

export interface ChangeSetStore {
  record(
    set: ChangeSet,
    opts: { id: string; recordedAtMs: number },
  ): Promise<HistoryRecord>;
  list(): Promise<HistoryRecord[]>;
  listIndexed(): Promise<IndexedHistoryRecord[]>;
  // Records strictly newer than afterMs, oldest first — the cloud sync cursor
  // ("everything not yet uploaded") without loading the whole timeline.
  listSince(afterMs: number): Promise<HistoryRecord[]>;
  get(id: string): Promise<HistoryRecord | null>;
}

// Each record lives in its own file so history is inspectable: open
// .dohc/history/<recordedAtMs>-<id>.json and read what changed and why.
const HISTORY_ID_RE = /^[A-Za-z0-9._-]+$/;
const VALID_CHANGE_SET_KINDS = new Set<ChangeSetKind>([
  "user-edit",
  "agent-run",
  "import",
  "sync",
  "site-build",
  "history-restore",
]);
const VALID_BOUNDARY_CROSSINGS = new Set<BoundaryCrossing>([
  "public-share",
  "external-export",
  "permission-change",
  "bulk-delete",
  "site-publish",
  "private-to-shared",
  "unmergeable-overwrite",
]);

function assertSafeHistoryId(id: string): string {
  if (!HISTORY_ID_RE.test(id)) {
    throw new Error(`Invalid history record id: ${id}`);
  }
  return id;
}

function recordFileName(opts: { id: string; recordedAtMs: number }): string {
  return `${opts.recordedAtMs}-${assertSafeHistoryId(opts.id)}.json`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    // A missing file is the empty case (no history yet), not an error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizeKind(kind: unknown): ChangeSetKind {
  const normalized = kind === "app-build" ? "site-build" : kind;
  if (!VALID_CHANGE_SET_KINDS.has(normalized as ChangeSetKind)) {
    throw new Error(`Unknown history change set kind: ${String(kind)}`);
  }
  return normalized as ChangeSetKind;
}

function normalizeBoundaryCrossing(value: unknown): BoundaryCrossing {
  const normalized = value === "app-trust" ? "site-publish" : value;
  if (!VALID_BOUNDARY_CROSSINGS.has(normalized as BoundaryCrossing)) {
    throw new Error(`Unknown history boundary crossing: ${String(value)}`);
  }
  return normalized as BoundaryCrossing;
}

function normalizeHistoryRecord(record: HistoryRecord): HistoryRecord {
  return {
    ...record,
    kind: normalizeKind(record.kind),
    boundaryCrossings: record.boundaryCrossings.map(normalizeBoundaryCrossing),
    ...(record.provenance
      ? {
          provenance: {
            ...record.provenance,
            source: normalizeKind(record.provenance.source),
          },
        }
      : {}),
  };
}

function normalizeIndexEntry(entry: IndexEntry): IndexEntry {
  return {
    ...entry,
    kind: normalizeKind(entry.kind),
  };
}

// Atomic write: serialize to a temp file then rename over the target so a
// concurrent reader never sees a half-written index, and a crash can't leave
// a truncated file.
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

export function createChangeSetStore(rootDir: string): ChangeSetStore {
  // All history stays inside .dohc/history — never written outside it.
  const historyDir = join(rootDir, ".dohc", "history");
  const indexPath = join(historyDir, "index.json");

  async function readIndex(): Promise<IndexEntry[]> {
    return ((await readJson<IndexEntry[]>(indexPath)) ?? []).map(normalizeIndexEntry);
  }

  // Serialize record() within this store instance: the index is a
  // read-modify-write, and the live watcher fires records fire-and-forget, so
  // two close-together batches would race and the second writeFile would drop
  // the first's index entry (silent timeline loss). This promise chain makes
  // index updates strictly sequential.
  let writeChain: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = writeChain.then(task, task);
    // Keep the chain alive even if a task rejects, without unhandled rejection.
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    record(set, opts) {
      return serialize(async () => {
        const record: HistoryRecord = {
          id: opts.id,
          recordedAtMs: opts.recordedAtMs,
          kind: set.kind,
          author: set.author,
          summary: set.summary,
          files: set.files,
          boundaryCrossings: set.boundaryCrossings,
          ...(set.provenance ? { provenance: set.provenance } : {}),
        };

        await mkdir(historyDir, { recursive: true });
        // Pretty JSON: history is meant to be opened and read by a person.
        await writeFile(
          join(historyDir, recordFileName(opts)),
          `${JSON.stringify(record, null, 2)}\n`,
          "utf8",
        );

        const entry: IndexEntry = {
          id: record.id,
          recordedAtMs: record.recordedAtMs,
          kind: record.kind,
          author: record.author,
          summary: record.summary,
          fileCount: record.files.length,
        };
        const index = await readIndex();
        index.push(entry);
        await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);

        return record;
      });
    },

    async listIndexed() {
      const index = await readIndex();
      // The index is the ordering source; sort newest first by timestamp,
      // breaking ties on id so ordering is stable within the same ms.
      const ordered = index
        .map((entry, index) => ({ entry, index }))
        .sort(
          (a, b) =>
            b.entry.recordedAtMs - a.entry.recordedAtMs ||
            (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0),
        );
      const records: IndexedHistoryRecord[] = [];
      for (const item of ordered) {
        // Read the full record from its own file — the index only holds a
        // summary, the per-record file is the source of full detail. One
        // corrupt/truncated record (crash mid-write, hand edit) must cost that
        // one entry, never brick the entire timeline.
        try {
          const record = await readJson<HistoryRecord>(
            join(historyDir, recordFileName(item.entry)),
          );
          if (record) {
            records.push({ index: item.index, record: normalizeHistoryRecord(record) });
          }
        } catch (error) {
          console.error(
            `[workspace-history] skipping unreadable record ${item.entry.id}:`,
            error,
          );
        }
      }
      return records;
    },

    async list() {
      return (await this.listIndexed()).map((entry) => entry.record);
    },

    async listSince(afterMs) {
      const index = await readIndex();
      const ordered = index
        .filter((entry) => entry.recordedAtMs > afterMs)
        .sort(
          (a, b) =>
            a.recordedAtMs - b.recordedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      const records: HistoryRecord[] = [];
      for (const entry of ordered) {
        try {
          const record = await readJson<HistoryRecord>(
            join(historyDir, recordFileName(entry)),
          );
          if (record) records.push(normalizeHistoryRecord(record));
        } catch (error) {
          console.error(
            `[workspace-history] skipping unreadable record ${entry.id}:`,
            error,
          );
        }
      }
      return records;
    },

    async get(id) {
      assertSafeHistoryId(id);
      const index = await readIndex();
      const entry = index.find((e) => e.id === id);
      if (!entry) return null;
      const record = await readJson<HistoryRecord>(join(historyDir, recordFileName(entry)));
      return record ? normalizeHistoryRecord(record) : null;
    },
  };
}

// Plain-language attribution: who did what, to how many files. Author-aware so
// a user edit and an agent run read differently. Deliberately prose, never Git
// conflict markers — history is for humans to skim.
export function humanSummary(record: HistoryRecord): string {
  const count = record.files.length;
  const noun = count === 1 ? "file" : "files";
  const verb = verbForKind(record.kind);

  if (record.provenance?.source === "history-restore") {
    const path = record.provenance.restoreOfPath ?? record.files[0]?.path;
    const action =
      record.provenance.restoreDirection === "undo" ? "undid restore for" : "restored";
    return path ? `You ${action} ${path}` : `You ${action} ${count} ${noun}`;
  }

  if (record.author.kind === "agent") {
    // Attribute to the person the agent acted for, e.g. "Maya's agent".
    return `${record.author.onBehalfOf}'s agent ${verb} ${count} ${noun}`;
  }

  // A single, named file reads better than a count for solo user edits.
  if (count === 1) {
    return `You ${verb} ${record.files[0].path}`;
  }
  return `You ${verb} ${count} ${noun}`;
}

export function verbForKind(kind: ChangeSetKind): string {
  switch (kind) {
    case "import":
      return "imported";
    case "agent-run":
      return "ran an agent over";
    case "sync":
      return "synced";
    case "site-build":
      return "built";
    case "history-restore":
      return "restored";
    case "user-edit":
    default:
      return "edited";
  }
}

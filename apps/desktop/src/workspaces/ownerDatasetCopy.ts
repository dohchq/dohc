import {
  createDatasetReplica,
  equalRecoveryCursor,
  parseRecoveryCursor,
  parseRecoveryJournalRecord,
  type DatasetReplicaSource,
} from "@dohc/app-backend-runtime/replica";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { DatasetCursor, JournalExportRecord } from "@dohc/app-backend-runtime/journal";
import {
  describeApprovedDataset,
  parseDatasetRevision,
  parseDatasetDescription,
  type DatasetDescription,
} from "@dohc/security-contract/dataset";
import { createHash } from "node:crypto";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { mkdtemp, open, rename, rm } from "node:fs/promises";
import { readOwnedFile } from "@dohc/workspace-core/owned-file";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { DatasetCatchUp, OwnerDatasetData } from "./remoteDataset";
import { DatasetCopyOfflineError } from "./remoteDatasetReplica";
import { CollectionServerUnreachableError } from "../ipc/errorWords";

// A read this soon after this computer's own change brought the copy to the
// server's head needs no update from the server.
const FRESH_AFTER_CHANGE_MS = 1000;

// A copy that can't reach its server asks again this often, so it shows the
// server coming back without anyone asking.
const RETRY_MS = 10_000;

// A server that has not answered within this long reads as out of reach until it does.
const SLOW_MS = 2_000;

// A computer with no copy yet waits this long for the server, once.
const FIRST_OPEN_MS = 15_000;

const CHUNK = 1024 * 1024;

// The connection never opened, so the server cannot have the change.
const NEVER_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
/** A change made while the server is out of reach: refused here, so nothing ran and nothing waits to be sent. */
const offline = (host: string) =>
  new AppBackendRuntimeError({
    code: "offline",
    message: `dohc didn't save this change. This Collection is read-only until ${host} is reachable.`,
  });
/** A change made while this computer can't bring its copy up to date, refused the same way. */
const copyNotUpdated = () =>
  new AppBackendRuntimeError({
    code: "offline",
    message:
      "dohc didn't save this change. This Collection is read-only until dohc can update its copy on this device.",
  });
/** A change made with no one signed in, refused the same way. */
const signedOutChange = () =>
  new AppBackendRuntimeError({
    code: "offline",
    message:
      "dohc didn't save this change. This Collection is read-only until you connect your server.",
  });
/** A signed-out read of what this computer did not keep, refused as any read that needs a session. */
const signInFirst = () => new Error("Sign in to your server first.");
function neverSent(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause: unknown = error.cause;
  const code = (value: unknown) =>
    value instanceof Error && NEVER_SENT.has(String(Reflect.get(value, "code")));
  return cause instanceof AggregateError ? cause.errors.every(code) : code(cause);
}

type Capture = Awaited<ReturnType<DatasetReplicaSource["capture"]>>;
type Page = Awaited<ReturnType<DatasetReplicaSource["page"]>>;

/**
 * Brings in everything the copy's catch-up needs from the server into files in
 * `directory`: the captured checkpoint for a copy that has none, then the
 * journal from there or from `after` to the captured head. The catch-up, which
 * reads wait behind, then takes it from those files instead of the network,
 * and checks everything it applies. Anything not fetched here is left to the
 * catch-up to fetch.
 */
async function prefetch(
  source: DatasetReplicaSource,
  head: Capture,
  after: DatasetCursor | undefined,
  directory: string,
  signal: AbortSignal,
): Promise<DatasetReplicaSource> {
  const pages: Array<{ page: Page; first: number }> = [],
    files = new Map<number, string>(),
    through = parseRecoveryCursor(head.head);
  const fetchRecord = async (record: JournalExportRecord) => {
    const path = join(directory, `${record.cursor.revision}`),
      file = await open(path, "wx", 0o600);
    try {
      for (let offset = 0; offset < record.byteLength; offset += CHUNK) {
        const length = Math.min(CHUNK, record.byteLength - offset),
          chunk = await source.blob({ record, offset, length, signal });
        if (!(chunk instanceof Uint8Array) || chunk.length !== length) return false;
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    files.set(record.cursor.revision, path);
    return true;
  };
  fetching: {
    if (!after) {
      const checkpoint = parseRecoveryJournalRecord(head.checkpoint);
      if (!(await fetchRecord(checkpoint))) break fetching;
      after = checkpoint.cursor;
    }
    while (after.revision < through.revision) {
      const page = await source.page({ through: head.head, after, limit: 32, signal });
      const records = page.records.map((raw) => parseRecoveryJournalRecord(raw));
      if (!records.length) break;
      for (const record of records) if (!(await fetchRecord(record))) break fetching;
      pages.push({ page, first: records[0]!.cursor.revision });
      after = records.at(-1)!.cursor;
    }
  }
  return {
    capture: async () => head,
    // A change's own answer can move the copy partway into a page, so a page is
    // served from wherever the copy's cursor now is.
    async page(input) {
      const next = input.after.revision + 1,
        staged = pages.find(
          ({ page, first }) => first <= next && next < first + page.records.length,
        );
      if (!staged || input.after.hostEpoch !== through.hostEpoch) return source.page(input);
      return {
        through: staged.page.through,
        after: input.after,
        records: staged.page.records.slice(next - staged.first),
      };
    },
    async blob(input) {
      const path = files.get(input.record.cursor.revision);
      if (!path) return source.blob(input);
      const file = await open(path, "r");
      try {
        const bytes = Buffer.alloc(input.length),
          { bytesRead } = await file.read(bytes, 0, input.length, input.offset);
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
  };
}

/**
 * An owner-bound copy retains committed reads only. It never becomes a second
 * writer. A read shows what the copy kept at once and brings the copy up to
 * date from the server afterwards; `onChanged` hears when that changed what a
 * read shows. Only a computer with no copy yet waits for the server to read.
 */
export async function createOwnerDatasetCopy(
  options: Parameters<typeof createDatasetReplica>[0] & {
    onChanged?(): void;
    /** Opened with no one signed in: it shows what this computer kept, asks the server nothing, and changes nothing. */
    signedOut?: boolean;
    retryMs?: number;
    slowMs?: number;
    firstOpenMs?: number;
  },
) {
  const {
    onChanged,
    signedOut = false,
    retryMs = RETRY_MS,
    slowMs = SLOW_MS,
    firstOpenMs = FIRST_OPEN_MS,
    ...replicaOptions
  } = options;
  const replica = await createDatasetReplica(replicaOptions);
  // The replica removes a leftover work- folder when it opens, so an update's spool never outlives a crash.
  const replicaRoot = resolve(options.directory);
  let denied = false,
    closing = false,
    confirmed: { cursor: DatasetCursor; atMs: number } | null = null,
    changes = 0,
    pending = 0,
    // Whether the server answered the last time the copy asked; null before it asks.
    reachable: boolean | null = null,
    // The server answered, but the last update could not bring the copy up to date.
    updateFailed = false,
    // The server has not answered the running update for `slowMs`.
    slow = false,
    // Why the last update failed, for a read that has no copy to show.
    failure: unknown = null,
    // The server and session of the latest request, which updates use.
    latest: {
      remote: OwnerDatasetData;
      source: DatasetReplicaSource;
      signal: AbortSignal;
    } | null = null,
    updating: Promise<void> | null = null,
    retry: ReturnType<typeof setTimeout> | undefined;
  const lifetime = new AbortController();
  const confirmations = new Set<Promise<unknown>>();
  const trackConfirmation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = work();
    confirmations.add(result);
    void result.then(
      () => confirmations.delete(result),
      () => confirmations.delete(result),
    );
    return result;
  };
  // The server that holds this Collection, which it needs to change.
  const host = new URL(options.origin).host;
  const unreachable = () =>
    new CollectionServerUnreachableError(`This Collection needs ${host}, which dohc can't reach.`);
  const refused = () =>
    signedOut ? signedOutChange() : notUpdated() ? copyNotUpdated() : offline(host);
  const markerPath = join(options.directory, "archived.json");
  const binding = createHash("sha256")
    .update(JSON.stringify([options.scope, options.ownerKey, new URL(options.origin).origin]))
    .digest("hex");
  const markerSchema = z
    .object({
      binding: z.literal(binding),
      dataset: z.unknown().transform((value) => parseDatasetDescription(value)),
      savedAtMs: z.number().int().nonnegative(),
    })
    .strict();
  let archived: z.infer<typeof markerSchema> | null = null,
    metadataPending: Promise<unknown> = Promise.resolve();
  try {
    // The saved status only marks the copy archived and describes it while
    // offline, and the server says again once online. So a file dohc can't
    // trust, being another user's, writable by others, linked, not a file or
    // too large, reads as no saved status.
    const read = await readOwnedFile(markerPath, 1024 * 1024);
    if (read.status === "read") {
      archived = markerSchema.parse(JSON.parse(read.content));
      if (archived.dataset.datasetId !== options.scope.datasetId)
        throw Error("The saved status belongs to another Collection.");
    }
  } catch (error) {
    await replica.close();
    throw error;
  }
  const enqueueMetadata = <T>(work: () => Promise<T>): Promise<T> => {
    const result = metadataPending.then(work, work);
    metadataPending = result.catch(() => undefined);
    return result;
  };
  const clearArchive = async () => {
    await rm(markerPath, { force: true });
    archived = null;
  };
  const revoke = async () => {
    denied = true;
    clearTimeout(retry);
    await metadataPending;
    await replica.revoke();
    await clearArchive();
  };
  const authorize = (signal: AbortSignal) => {
    options.assertOwner();
    signal.throwIfAborted();
    if (denied || closing)
      throw Error(
        "This Collection copy is unavailable. Restore access, then reopen the workspace.",
      );
  };
  const describe = (definitionJson: string): DatasetDescription => {
    const approved = parseDatasetRevision(JSON.parse(definitionJson));
    // The authority's own description projection: schema-only fields are not Collection controls.
    return parseDatasetDescription(
      describeApprovedDataset(approved, approved.definition.operations),
    );
  };
  const describeRemote = (
    remote: OwnerDatasetData,
    signal: AbortSignal,
    datasetId: string,
    metadata?: { includeArchived?: boolean },
  ) =>
    enqueueMetadata(async () => {
      authorize(signal);
      const dataset = await remote.describe(datasetId, metadata);
      authorize(signal);
      if ("archived" in dataset && dataset.archived === true) {
        const value = markerSchema.parse({ binding, dataset, savedAtMs: Date.now() });
        let temporary: string | undefined;
        try {
          await atomicReplaceFile(
            markerPath,
            async (path) => {
              temporary = path;
              const file = await open(path, "wx", 0o600);
              try {
                await file.writeFile(JSON.stringify(value));
                await file.sync();
              } finally {
                await file.close();
              }
            },
            {
              rename: async (source, target) => {
                authorize(signal);
                await rename(source, target);
              },
            },
          );
          archived = value;
        } finally {
          if (temporary) await rm(temporary, { force: true });
        }
      } else if (archived) await clearArchive();
      authorize(signal);
      return dataset;
    });
  // What a read shows now, without asking the server. A copy that can't be
  // brought up to date takes no change either, as the page would not show it.
  const notUpdated = () => updateFailed && !signedOut && reachable !== false && !slow;
  const offlineNow = () => signedOut || reachable === false || slow || updateFailed;
  const kept = () => {
    const copy = (savedAtMs: number) => ({
      offline: offlineNow(),
      savedAtMs,
      host,
      ...(signedOut ? { signedOut: true as const } : {}),
      ...(notUpdated() ? { updateFailed: true as const } : {}),
    });
    if (archived)
      return {
        dataset: { ...archived.dataset, archived: true },
        copy: copy(archived.savedAtMs),
      };
    const state = replica.state();
    return (
      state && { dataset: describe(state.checkpoint.definitionJson), copy: copy(state.savedAtMs) }
    );
  };
  const fresh = () => {
    const state = replica.state();
    return (
      !!state &&
      !!confirmed &&
      equalRecoveryCursor(state.cursor, confirmed.cursor) &&
      Date.now() - confirmed.atMs < FRESH_AFTER_CHANGE_MS
    );
  };
  const tellChanged = () => {
    if (!closing) onChanged?.();
  };
  const scheduleRetry = () => {
    if (retry !== undefined || closing || denied) return;
    retry = setTimeout(() => {
      retry = undefined;
      void update();
    }, retryMs);
    retry.unref?.();
  };
  const unreachableNow = () => {
    const was = reachable;
    reachable = false;
    scheduleRetry();
    if (was !== false) tellChanged();
  };
  // Whether the copy moved from at or behind the captured head to past it.
  const passed = (captured: Capture | undefined, from: DatasetCursor | undefined) => {
    const cursor = replica.state()?.cursor;
    if (!captured || !cursor) return false;
    const through = parseRecoveryCursor(captured.head);
    const at = (c: DatasetCursor) => c.hostEpoch === through.hostEpoch;
    return (
      (!from || (at(from) && from.revision <= through.revision)) &&
      at(cursor) &&
      cursor.revision >= through.revision
    );
  };
  const updateOnce = async ({ remote, source, signal }: NonNullable<typeof latest>) => {
    const before = {
      cursor: replica.state()?.cursor,
      offline: offlineNow(),
      updateFailed: notUpdated(),
      archived: archived !== null,
    };
    const both = AbortSignal.any([signal, lifetime.signal]);
    const waiting = setTimeout(() => {
      if (reachable === false || closing) return;
      slow = true;
      tellChanged();
    }, slowMs);
    waiting.unref?.();
    let head: Capture | undefined;
    try {
      authorize(signal);
      // Reads wait for the copy's catch-up, so the copy fetches what it needs first.
      head = await source.capture(both);
      const spool = await mkdtemp(join(replicaRoot, "work-"));
      try {
        const fetched = await prefetch(source, head, replica.state()?.cursor, spool, both);
        clearTimeout(waiting);
        await replica.catchUp(fetched, both);
      } finally {
        await rm(spool, { recursive: true, force: true });
      }
      // The host refuses capture while archived; a successful capture confirms restoration.
      if (archived)
        await enqueueMetadata(async () => {
          authorize(signal);
          if (archived) await clearArchive();
        });
      reachable = true;
      updateFailed = false;
      failure = null;
    } catch (error) {
      if (denied) {
        failure = error;
        await revoke();
        tellChanged();
        return;
      }
      if (closing || both.aborted) return;
      failure = error;
      if (passed(head, before.cursor)) {
        // This computer's own change took the copy past the head this update
        // captured, so the catch-up had nothing to bring in.
        reachable = true;
        updateFailed = false;
        failure = null;
      } else if (error instanceof DatasetCopyOfflineError) reachable = false;
      else {
        // The server answered with an error, as a front whose server is down
        // does, or this computer could not write what it sent, as on a full
        // disk. An archived Collection, whose capture the host refuses,
        // explains it. Otherwise the server is there but the copy may not be
        // current, so it asks again.
        try {
          await describeRemote(remote, signal, options.scope.datasetId, { includeArchived: true });
          reachable = true;
          updateFailed = archived === null;
          if (archived) failure = null;
        } catch {
          if (closing || both.aborted) return;
          reachable = false;
        }
      }
    } finally {
      clearTimeout(waiting);
      // A cancelled update says the copy is no longer waiting on the server.
      if (slow && (closing || both.aborted)) {
        slow = false;
        tellChanged();
      }
    }
    const shownOffline = before.offline || slow;
    slow = false;
    if (reachable === false || updateFailed) scheduleRetry();
    const cursor = replica.state()?.cursor;
    if (
      shownOffline !== offlineNow() ||
      before.updateFailed !== notUpdated() ||
      before.archived !== (archived !== null) ||
      (before.cursor && cursor
        ? !equalRecoveryCursor(before.cursor, cursor)
        : before.cursor !== cursor)
    )
      tellChanged();
  };
  // Brings the copy up to date from the server, one update at a time. It never
  // fails: `failure` and `reachable` say how it went.
  const update = (): Promise<void> => {
    if (!latest || closing || denied || signedOut) return Promise.resolve();
    return (updating ??= updateOnce(latest)
      .catch(() => undefined)
      .finally(() => {
        updating = null;
      }));
  };
  // What a read shows: the copy at once, while an update runs. Only a computer
  // with no copy yet waits for the server, once, up to `firstOpenMs`.
  const current = async (signal: AbortSignal) => {
    authorize(signal);
    const shown = kept();
    if (shown) {
      if (!fresh()) void update();
      return shown;
    }
    if (signedOut) throw signInFirst();
    let limit: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      update().then(() => true),
      new Promise<false>((resolve) => {
        limit = setTimeout(() => resolve(false), firstOpenMs);
      }),
    ]).finally(() => clearTimeout(limit));
    authorize(signal);
    const now = kept();
    if (now) return now;
    if (!answered || failure === null || failure instanceof DatasetCopyOfflineError)
      throw unreachable();
    throw failure;
  };
  return {
    // Called inside source requests. Revoke after catchUp settles, avoiding its serialized work queue.
    accessLost() {
      denied = true;
    },
    revoke,
    close: async () => {
      closing = true;
      clearTimeout(retry);
      lifetime.abort();
      await updating;
      await Promise.allSettled([...confirmations]);
      await metadataPending;
      await replica.close();
    },
    data(
      remote: OwnerDatasetData,
      source: DatasetReplicaSource,
      signal: AbortSignal,
    ): OwnerDatasetData {
      latest = { remote, source, signal };
      const selected = (datasetId: string) => {
        authorize(signal);
        if (datasetId !== options.scope.datasetId)
          throw Error("This copy belongs to another Collection.");
      };
      // The change's response carries the journal after the copy's cursor, which the
      // copy checks and applies as if it had asked for it. Anything else waits for
      // the next update.
      const applyCatchUp = async (catchUp: DatasetCatchUp) => {
        const saved = replica.state();
        if (!saved || catchUp.records.length !== catchUp.changesets.length) return;
        const head = parseRecoveryCursor(catchUp.head),
          records = catchUp.records.map((raw) => parseRecoveryJournalRecord(raw)),
          bytes = catchUp.changesets.map((value) => Buffer.from(value, "base64"));
        const inline: DatasetReplicaSource = {
          capture: async () => ({ head, checkpoint: saved.checkpoint }),
          page: async ({ through, after }) => ({
            through,
            after,
            records: records.filter((record) => record.cursor.revision > after.revision),
          }),
          blob: async ({ record, offset, length }) => {
            const value =
              bytes[records.findIndex((item) => item.cursor.revision === record.cursor.revision)];
            if (!value) throw Error("The change's response is missing a record.");
            return value.subarray(offset, offset + length);
          },
        };
        const state = await replica.catchUp(inline, signal);
        return equalRecoveryCursor(state.cursor, head) ? head : null;
      };
      const change = async (
        input: Parameters<OwnerDatasetData["invoke"]>[0],
        after: DatasetCursor,
      ) => {
        // Until this change's own journal reaches the head, a read waits for the server.
        // Changes in flight together can commit in any order, so only a change that
        // overlapped no other can vouch for the head its journal reached.
        const alone = pending++ === 0,
          mine = ++changes;
        confirmed = null;
        try {
          let result: Awaited<ReturnType<OwnerDatasetData["invoke"]>>;
          try {
            result = await remote.invoke({ ...input, after });
          } catch (error) {
            authorize(signal);
            if (neverSent(error)) {
              unreachableNow();
              throw offline(host);
            }
            if (error instanceof TypeError) {
              // The server may have taken it; the copy shows it once the server answers.
              unreachableNow();
              throw unreachable();
            }
            // Any other answer, as from a front whose server is down, may mean the
            // server is gone, which an update finds out.
            void update();
            throw error;
          }
          if (reachable === false) {
            reachable = true;
            tellChanged();
          } else reachable = true;
          authorize(signal);
          const { catchUp, ...committed } = result;
          const head = catchUp
            ? await applyCatchUp(catchUp).catch(() => {
                // The change is saved on the server; the next update brings the copy up to date.
                return null;
              })
            : null;
          if (head && alone && mine === changes) {
            confirmed = { cursor: head, atMs: Date.now() };
            // Windows showing the copy read it again, as for a change an agent made.
            tellChanged();
          }
          // An update that starts after this change brings it in, and says so.
          else void (updating ?? Promise.resolve()).then(update);
          authorize(signal);
          return committed;
        } finally {
          pending--;
        }
      };
      return {
        ...remote,
        ...(remote.deleteDataset
          ? {
              async deleteDataset(
                input: Parameters<NonNullable<OwnerDatasetData["deleteDataset"]>>[0],
              ) {
                selected(input.datasetId);
                return trackConfirmation(async () => {
                  const result = await remote.deleteDataset!(input);
                  // A confirmed deletion invalidates local data even if its caller was cancelled meanwhile.
                  if (result.deleted && result.datasetId === options.scope.datasetId)
                    await revoke();
                  return result;
                });
              },
            }
          : {}),
        ...(remote.deletionStatus
          ? {
              async deletionStatus(
                input: Parameters<NonNullable<OwnerDatasetData["deletionStatus"]>>[0],
              ) {
                options.assertOwner();
                signal.throwIfAborted();
                if (closing)
                  throw Error("This Collection copy is unavailable. Reopen the workspace.");
                if (input.datasetId !== options.scope.datasetId)
                  throw Error("This copy belongs to another Collection.");
                return trackConfirmation(async () => {
                  const result = await remote.deletionStatus!(input);
                  if (result.deleted) await revoke();
                  else authorize(signal);
                  return result;
                });
              },
            }
          : {}),
        async inspect(datasetId) {
          selected(datasetId);
          return current(signal);
        },
        async describe(datasetId, metadata?: { includeArchived?: boolean }) {
          selected(datasetId);
          // Sidebar discovery reads bounded metadata, never every Collection's database bytes.
          const shown = kept();
          if (shown) {
            if (!fresh()) void update();
            return shown.dataset;
          }
          if (signedOut) throw signInFirst();
          try {
            const dataset = await describeRemote(remote, signal, datasetId, metadata);
            authorize(signal);
            return dataset;
          } catch (error) {
            authorize(signal);
            // Not answering is not a refusal, and asking again would wait as long.
            if (error instanceof TypeError) throw unreachable();
            // The replica source independently detects revoked access.
            await source.capture(signal).catch(async (captureError: unknown) => {
              if (!denied) return;
              await revoke();
              throw captureError;
            });
            throw error;
          }
        },
        async invoke(input) {
          selected(input.datasetId);
          // A change takes its rules from the saved copy, so it needs no request first.
          // The server refuses a change made under rules it no longer has.
          const saved = archived ? null : replica.state();
          if (
            saved &&
            describe(saved.checkpoint.definitionJson).operations.some(
              (operation) => operation.operationId === input.operationId && !operation.readOnly,
            )
          ) {
            if (signedOut) throw refused();
            return change(input, saved.cursor);
          }
          const state = await current(signal);
          if ("archived" in state.dataset && state.dataset.archived === true)
            throw Error(
              "This Collection is archived. Reconnect and restore it before using its records.",
            );
          const operation = state.dataset.operations.find(
            (operation) => operation.operationId === input.operationId,
          );
          if (!operation?.readOnly) {
            if (state.copy.offline) throw refused();
            return change(input, replica.state()!.cursor);
          }
          const result = await replica.read(input);
          authorize(signal);
          return {
            result: result.result,
            revision: result.revision,
            replayed: false,
            copy: state.copy,
          };
        },
      };
    },
  };
}

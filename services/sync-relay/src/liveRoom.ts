// A live room: one shared note's live copy in memory, plus the edits taken and not yet saved.
//
// An edit is admitted, written down, applied, answered and passed on, in that order. The room
// saves what it holds every few seconds as one write on the owner's capture, which names every
// sender in it. The saved rows are deleted in the save's own journal transaction. Everything
// else that changes the note reaches the room through that capture's feed of applied changes.
//
// The note's owner edits in the room too, but keeps the feed of its own capture: the owner's
// computer holds the note as saved and, on top, the room's unsaved edits at their positions.
// Each save tells it the last position the save holds, so it can let go of those.
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { liveEditFitsNote } from "@dohc/ydoc-projection/live-journal-validation";
import type { LiveFrameLease } from "@dohc/live-session-contract/live-frame";
import {
  liveAuthorIdentity,
  MAX_LIVE_AUTHOR_BYTES,
  MAX_LIVE_AUTHOR_IDENTITIES,
  type LiveAuthorEntry,
  type LiveAuthorSnapshot,
} from "@dohc/live-session-contract/live-authorship";
import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  type LiveDocumentKey,
  type LiveUpdateRefusal,
} from "@dohc/live-session-contract/live-update-admission";
import type { NamedFrameRoomHost } from "./namedLiveFrameHost.js";
import type {
  NamedFrameAppliedUpdate,
  NamedFrameHostSession,
  NamedFrameSubmissionResult,
  NamedFrameSync,
} from "./namedLiveFrameSession.js";
import type { SyncRelayStorage } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import { SyncRelayQuotaExceededError } from "./storage/errors.js";
import {
  advanceLiveRoomPosition,
  appendLiveRoomEdit,
  deleteSavedLiveRoomEdits,
  liveRoomDocuments,
  liveRoomEdits,
  liveRoomLineageIsCurrent,
  liveRoomPosition,
} from "./storage/liveRoomEdits.js";
import {
  liveRoomPaused,
  liveRoomSavedState,
  pauseLiveRoom,
  type LiveRoomPauseCause,
} from "./storage/liveRoomPauses.js";
import { documentParams, liveJournalSeedClientId } from "./storage/liveUpdateJournal.js";

const EMPTY_VECTOR = Y.encodeStateVector(new Y.Doc());
const FEED = Symbol("live-room-feed");

export interface LiveRoomsOptions {
  readonly storage: SyncRelayStorage;
  /** The owner's capture of a note. It carries the room's saves and its feed of other changes. */
  openSaver(document: LiveDocumentKey, signal: AbortSignal): Promise<NamedFrameHostSession>;
  /** The largest edit taken. Each must fit in one save. */
  readonly maxUpdateBytes: number;
  readonly maxNoteBytes: number;
  /** The largest update passed on, and the largest save. */
  readonly maxAppliedBytes: number;
  /** Whether one save names every sender in it, which needs an engine that credits the list. */
  readonly namesEverySender?: boolean;
  readonly saveEveryMs?: number;
  /** How long one save, or opening the owner's capture, may take before it is tried again. */
  readonly saveTimeoutMs?: number;
  /** How long saves may keep failing before the note pauses. */
  readonly pauseAfterMs?: number;
  readonly log?: (line: string, detail: Record<string, unknown>) => void;
}
export interface LiveRooms {
  /**
   * Puts an editor's connection in its note's room. The capture still decides its access. The
   * owner's connection keeps its capture's feed and is sent the room's unsaved edits as rows.
   */
  join(host: NamedFrameRoomHost, options?: { readonly owner?: boolean }): NamedFrameHostSession;
  /**
   * Saves every edit the note's rooms hold, taking no new ones until `then` ends, then ends the
   * rooms: for a step that closes the note to them, such as a restore's fence or the owner's
   * Stop. A refused save pauses the note, which keeps its edits in the copy, and `then` still
   * runs. Throws `LiveRoomUnsavedError` without running `then` if the edits could not be saved yet.
   */
  saveFirst<T>(
    note: { readonly workspaceId: string; readonly objectId: string },
    then: () => T | Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  /** Takes no new edits, saves what each room holds, and ends every room. */
  close(): Promise<void>;
}

interface Subscriber {
  readonly queue: NamedFrameAppliedUpdate[];
  /** About how many bytes its queue holds that were passed on to it. */
  bytes: number;
  /** It fell a whole note behind, so its session ends and the page syncs afresh. */
  behind?: true;
  /** Gets only the edits the room takes, as rows, and none of the room's feed. */
  readonly owner?: true;
  wake?: () => void;
}
/** How many recent saves the owner's feed can still look up. A later save lets go of more. */
const REMEMBERED_SAVES = 64;
/** How often frames handed to a reader read its access again, for access that ends with time. */
const ACCESS_READ_EVERY_MS = 1_000;

/**
 * A room session's access between the edits it sends. Each edit reads access in full when it is
 * taken (`sender`), and a write that changes access ends the capture at once (`invalidated`). The
 * frames a reader is handed read it again at most once a second, so a link session that expires
 * stops them too. A read on every frame grew with readers times edits.
 */
function accessBetweenEdits(host: NamedFrameRoomHost): () => void {
  let readAt = -Infinity;
  return () => {
    host.invalidated.throwIfAborted();
    const now = Date.now();
    if (now >= readAt && now - readAt < ACCESS_READ_EVERY_MS) return;
    host.assertCurrent();
    readAt = now;
  };
}
interface Unsaved {
  readonly position: number;
  readonly sender: LiveAuthorSnapshot;
  readonly bytes: Uint8Array;
}
interface Room {
  readonly key: string;
  readonly document: LiveDocumentKey;
  readonly doc: Y.Doc;
  readonly subscribers: Set<Subscriber>;
  readonly unsaved: Unsaved[];
  readonly lifetime: AbortController;
  /** Seeded from the owner's capture, with any edits a stopped relay left saved. */
  opened: Promise<void>;
  /** The last position passed on. */
  position: number;
  /** About how large the note is now. */
  bytes: number;
  members: number;
  saver?: { readonly host: NamedFrameHostSession; readonly sync: NamedFrameSync };
  connecting?: Promise<NonNullable<Room["saver"]>>;
  timer?: ReturnType<typeof setTimeout>;
  saving?: Promise<unknown>;
  /** The last position a committed save held. */
  savedThrough: number;
  /** Recent saves' journal cursors, each with the last position it holds. */
  readonly saves: Map<number, number>;
  /** When saves started failing, until one is taken. */
  failingSince?: number;
  /** How many callers are saving everything first; while any is, the room takes no edits. */
  closing: number;
}

/** Why a note that paused takes no edits. Its owner's Resume lifts it. */
export class LiveRoomPausedError extends Error {
  constructor() {
    super("Live editing of this note is paused.");
  }
}
export class LiveRoomUnsavedError extends Error {
  constructor() {
    super("The note's live edits are not saved yet.");
  }
}
/**
 * What one save came to. A refusal that will not clear by itself pauses the note; the engine
 * busy or restarting, a capture gone stale, or a save that failed, is tried again.
 */
type SaveOutcome =
  | "saved"
  | "retry"
  | { readonly refusal: LiveUpdateRefusal; readonly named: LiveAuthorSnapshot[] };
// A capture that went stale is replaced, and the next save goes through the new one.
const STALE_CAPTURE: ReadonlySet<LiveUpdateRefusal> = new Set(["stale-session", "stale-binding"]);
/** Each sender in some edits, once, up to the most one save can name. */
function senders(edits: readonly { readonly sender: LiveAuthorSnapshot }[]): LiveAuthorSnapshot[] {
  const named = new Map<string, LiveAuthorSnapshot>();
  for (const { sender } of edits) {
    if (named.size >= MAX_LIVE_AUTHOR_IDENTITIES) break;
    named.set(JSON.stringify(sender), sender);
  }
  return [...named.values()];
}

const refused = (reason: Extract<NamedFrameSubmissionResult, { result: "refused" }>["reason"]) =>
  ({ result: "refused", reason }) as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });

/**
 * Whether an update builds only on what `doc` has, and which editor ids it adds content under.
 * Null when it can't be decoded or needs something the room does not have.
 */
export function roomAdmissible(doc: Y.Doc, update: Uint8Array): { clients: number[] } | null {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return null;
  }
  const have = Y.decodeStateVector(Y.encodeStateVector(doc));
  const reach = new Map(have);
  const clients = new Set<number>();
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) return null;
    const { client, clock } = struct.id;
    const at = reach.get(client) ?? 0;
    if (clock > at) return null;
    const end = clock + struct.length;
    if (end > at) reach.set(client, end);
    if (end > (have.get(client) ?? 0)) clients.add(client);
  }
  const covered = (id: Y.ID) => id.clock < (reach.get(id.client) ?? 0);
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue;
    if (struct.origin && !covered(struct.origin)) return null;
    if (struct.rightOrigin && !covered(struct.rightOrigin)) return null;
    if (struct.parent instanceof Y.ID && !covered(struct.parent)) return null;
  }
  for (const [client, ranges] of decoded.ds.clients)
    for (const range of ranges) if (range.clock + range.len > (reach.get(client) ?? 0)) return null;
  return { clients: [...clients] };
}

const sameSender = (a: LiveAuthorSnapshot, b: LiveAuthorSnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);
// An automation commits outside the room, and an unattributed edit names nobody, so neither
// shares a save with anyone else.
const savesAlone = (sender: LiveAuthorSnapshot) =>
  sender.some((author) => author.kind === "automation" || author.kind === "unattributed");

/**
 * How many of the oldest unsaved edits one save holds, and who it names. With `everySender`
 * a save names everyone whose edits it holds, each once. Without it, a save holds one sender's
 * run of edits, as the engine credits only one person per save.
 */
export function nextSave(
  unsaved: readonly { readonly sender: LiveAuthorSnapshot; readonly bytes: Uint8Array }[],
  everySender: boolean,
  maxBytes: number,
): { count: number; authors: LiveAuthorSnapshot } {
  const first = unsaved[0];
  if (!first) return { count: 0, authors: [] };
  const named = new Map<string, LiveAuthorEntry>();
  let count = 0,
    bytes = 0,
    authorBytes = 2,
    one = true;
  for (const edit of unsaved) {
    const same = sameSender(edit.sender, first.sender);
    if (count && !same && (!everySender || savesAlone(first.sender) || savesAlone(edit.sender)))
      break;
    const added = edit.sender.filter((author) => !named.has(liveAuthorIdentity(author)));
    const addedBytes = added.reduce((sum, a) => sum + Buffer.byteLength(JSON.stringify(a)) + 1, 0);
    if (
      count &&
      (bytes + edit.bytes.byteLength > maxBytes ||
        named.size + added.length > MAX_LIVE_AUTHOR_IDENTITIES ||
        authorBytes + addedBytes > MAX_LIVE_AUTHOR_BYTES)
    )
      break;
    for (const author of added) named.set(liveAuthorIdentity(author), author);
    bytes += edit.bytes.byteLength;
    authorBytes += addedBytes;
    one &&= same;
    count += 1;
  }
  if (one) return { count, authors: first.sender };
  const authors = [...named].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, a]) => a);
  return { count, authors };
}

export function createLiveRooms(options: LiveRoomsOptions): LiveRooms {
  const storage = options.storage as StorageContext;
  const saveEveryMs = options.saveEveryMs ?? 5_000;
  const saveTimeoutMs = options.saveTimeoutMs ?? 30_000;
  const pauseAfterMs = options.pauseAfterMs ?? 10 * 60_000;
  const everySender = options.namesEverySender === true;
  const write = options.log ?? ((line, detail) => console.error(`[live-room] ${line}`, detail));
  const log = (room: Room, line: string, detail: Record<string, unknown> = {}) =>
    write(line, { objectId: room.document.objectId, unsaved: room.unsaved.length, ...detail });
  const rooms = new Map<string, Room>();
  // When each note with leftover edits first failed to open, by room key.
  const unopened = new Map<string, number>();
  // Notes whose rooms take no edits while a step that closes them runs, by workspace and object.
  const holding = new Map<string, number>();
  const noteKey = (note: { readonly workspaceId: string; readonly objectId: string }) =>
    JSON.stringify([note.workspaceId, note.objectId]);
  let closed = false;

  function passOn(
    room: Room,
    update: NamedFrameAppliedUpdate,
    from: { readonly taken: boolean; readonly except?: Subscriber },
  ) {
    room.position = update.journalCursor;
    const size = update.updateBytes.byteLength;
    for (const subscriber of room.subscribers) {
      if (subscriber === from.except || subscriber.behind) continue;
      // The owner's own capture already brings it every change the journal took.
      if (subscriber.owner && !from.taken) continue;
      // A page that stops reading is never ended by its frame session, which only stops pulling.
      // Past a whole note's worth, a fresh sync is the cheaper way to catch it up.
      if (subscriber.queue.length && subscriber.bytes + size > options.maxNoteBytes) {
        subscriber.behind = true;
        subscriber.queue.length = 0;
        subscriber.bytes = 0;
      } else {
        subscriber.queue.push(subscriber.owner ? { ...update, roomRow: true } : update);
        subscriber.bytes += size;
      }
      subscriber.wake?.();
    }
  }
  /** A change the journal took from some other writer. Passed on only if it is new to the room. */
  function applyFeed(room: Room, bytes: Uint8Array) {
    let changed: Uint8Array | undefined;
    const observe = (update: Uint8Array, origin: unknown) => {
      if (origin === FEED) changed = update;
    };
    room.doc.on("update", observe);
    try {
      Y.applyUpdate(room.doc, bytes, FEED);
    } finally {
      room.doc.off("update", observe);
    }
    if (!changed) return;
    room.bytes += changed.byteLength;
    passOn(
      room,
      { journalCursor: advanceLiveRoomPosition(storage), updateBytes: changed },
      { taken: false },
    );
  }

  function ensureSaver(room: Room): Promise<NonNullable<Room["saver"]>> {
    if (room.saver && !room.saver.host.invalidated.aborted) return Promise.resolve(room.saver);
    if (room.saver) dropSaver(room);
    room.connecting ??= (async () => {
      const signal = room.lifetime.signal;
      // The time limit is for opening only. The capture's feed lasts as long as the signal it
      // was opened with, so the limit is cleared once it is open.
      const limit = new AbortController();
      const timer = setTimeout(
        () => limit.abort(new Error("Opening the capture timed out.")),
        saveTimeoutMs,
      );
      const opening = AbortSignal.any([signal, limit.signal]);
      let host: NamedFrameHostSession;
      let sync: NamedFrameSync;
      try {
        host = await options.openSaver(room.document, opening);
        try {
          sync = await host.openSync(EMPTY_VECTOR, opening);
        } catch (error) {
          host.close();
          throw error;
        }
      } finally {
        clearTimeout(timer);
      }
      const saver = { host, sync };
      room.saver = saver;
      applyFeed(room, sync.missingStateUpdate);
      void (async () => {
        for (;;) {
          const lease = await sync.nextApplied(signal);
          try {
            applyFeed(room, lease.value.updateBytes);
          } finally {
            lease.release();
          }
        }
      })().catch(() => {
        // The capture ended. Another one brings the room up to date.
        if (room.saver === saver) dropSaver(room);
        rejoin(room);
      });
      return saver;
    })().finally(() => {
      room.connecting = undefined;
    });
    return room.connecting;
  }
  /** Opens another capture for a room people are in, so their pages keep getting outside edits. */
  function rejoin(room: Room) {
    if (room.lifetime.signal.aborted || !room.members || room.saver || room.timer || room.saving)
      return;
    // A save opens one itself.
    if (room.unsaved.length) return scheduleSave(room, saveEveryMs);
    room.timer = setTimeout(() => {
      room.timer = undefined;
      if (room.unsaved.length) runSave(room);
      else ensureSaver(room).catch(() => rejoin(room));
    }, saveEveryMs);
    room.timer.unref?.();
  }
  function dropSaver(room: Room) {
    const saver = room.saver;
    room.saver = undefined;
    try {
      saver?.sync.close();
    } finally {
      saver?.host.close();
    }
  }

  /** One save of the oldest unsaved edits. */
  async function saveOnce(room: Room): Promise<SaveOutcome> {
    const { count, authors } = nextSave(room.unsaved, everySender, options.maxAppliedBytes);
    if (!count) return "saved";
    const batch = room.unsaved.slice(0, count);
    const merged = count === 1 ? batch[0]!.bytes : Y.mergeUpdates(batch.map((edit) => edit.bytes));
    const through = batch.at(-1)!.position;
    // The journal's commit makes the save durable. Waiting past it is only for the engine's
    // answer, so a save that commits and then runs out of time still counts as saved.
    const deadline = AbortSignal.any([room.lifetime.signal, AbortSignal.timeout(saveTimeoutMs)]);
    let committed = false;
    let answer: NamedFrameSubmissionResult | undefined;
    try {
      const saver = await raceAbort(ensureSaver(room), deadline);
      answer = await saver.host.submit(
        {
          deliveryId: randomUUID(),
          updateDigest: sha256(merged),
          updateBytes: merged,
          room: {
            authors,
            committed(journalCursor) {
              deleteSavedLiveRoomEdits(storage, room.document, through);
              room.savedThrough = through;
              room.saves.set(journalCursor, through);
              if (room.saves.size > REMEMBERED_SAVES)
                room.saves.delete(room.saves.keys().next().value!);
              committed = true;
            },
          },
        },
        deadline,
      );
    } catch (error) {
      // A capture that ran out of time is not trusted with the next save.
      if (deadline.aborted && !room.lifetime.signal.aborted && room.saver) dropSaver(room);
      if (!committed) {
        log(room, "save failed", { edits: count, error: String(error).slice(0, 200) });
        return "retry";
      }
    }
    if (!committed) {
      log(room, "save not taken", { edits: count, answer });
      if (answer?.result !== "refused") return "retry";
      if (!STALE_CAPTURE.has(answer.reason))
        return { refusal: answer.reason, named: senders(batch) };
      if (room.saver) dropSaver(room);
      return "retry";
    }
    room.unsaved.splice(0, count);
    room.bytes = Y.encodeStateAsUpdate(room.doc).byteLength;
    return "saved";
  }
  /**
   * Pauses the note: its whole live state goes into a copy, stored in the transaction that deletes
   * its rows, and every session in the room ends. Tickets for it are refused until its owner
   * resumes it. If the copy can't be stored, the rows stay and saves go on being tried.
   */
  function pause(
    room: Room,
    cause: LiveRoomPauseCause,
    refusal: LiveUpdateRefusal | null,
    named: LiveAuthorSnapshot[],
    copy = Y.encodeStateAsUpdate(room.doc),
  ): boolean {
    try {
      pauseLiveRoom(storage, {
        document: room.document,
        cause,
        refusal,
        named,
        copy,
        pausedAtMs: Date.now(),
      });
    } catch (error) {
      log(room, "pause failed", { cause, refusal, error: String(error).slice(0, 200) });
      scheduleSave(room, saveEveryMs);
      return false;
    }
    log(room, "paused", { cause, refusal, named: named.length });
    room.unsaved.length = 0;
    dispose(room, new LiveRoomPausedError());
    return true;
  }
  /** Saves until the room holds nothing, it ends, or two saves in a row take nothing. */
  async function drain(room: Room, signal: AbortSignal) {
    room.closing += 1;
    try {
      await raceAbort(room.opened, signal);
      for (let failed = 0; room.unsaved.length && !room.lifetime.signal.aborted && failed < 2;) {
        const before = room.unsaved.length;
        if (!room.saving) runSave(room);
        await raceAbort(Promise.resolve(room.saving), signal);
        failed = room.unsaved.length < before ? 0 : failed + 1;
      }
    } finally {
      room.closing -= 1;
    }
  }
  function scheduleSave(room: Room, wait: number) {
    if (room.timer || room.saving || room.lifetime.signal.aborted) return;
    room.timer = setTimeout(() => {
      room.timer = undefined;
      runSave(room);
    }, wait);
    room.timer.unref?.();
  }
  function runSave(room: Room) {
    if (room.saving || room.lifetime.signal.aborted) return;
    clearTimeout(room.timer);
    room.timer = undefined;
    room.saving = saveOnce(room)
      .catch((error: unknown): SaveOutcome => {
        log(room, "save failed", { error: String(error).slice(0, 200) });
        return "retry";
      })
      .then((outcome) => {
        room.saving = undefined;
        if (room.lifetime.signal.aborted) return;
        // The first failure in a run is tried again at once, through a new capture if the old
        // one closed, as the owner's capture does whenever its host moves on. Later ones wait.
        const first = outcome === "retry" && room.failingSince === undefined;
        if (outcome === "saved") room.failingSince = undefined;
        else if (outcome !== "retry") return pause(room, "refused", outcome.refusal, outcome.named);
        else if (Date.now() - (room.failingSince ??= Date.now()) >= pauseAfterMs)
          return pause(room, "failing", null, senders(room.unsaved));
        if (room.unsaved.length) scheduleSave(room, outcome === "saved" || first ? 0 : saveEveryMs);
        else {
          disposeIfIdle(room);
          // The capture may have ended during the save.
          rejoin(room);
        }
      });
  }
  function disposeIfIdle(room: Room) {
    if (room.members || room.unsaved.length || room.saving) return;
    dispose(room);
  }
  function dispose(room: Room, reason: Error = new Error("Live room closed.")) {
    clearTimeout(room.timer);
    room.timer = undefined;
    room.lifetime.abort(reason);
    if (room.saver) dropSaver(room);
    for (const subscriber of room.subscribers) subscriber.wake?.();
    room.subscribers.clear();
    room.doc.destroy();
    if (rooms.get(room.key) === room) rooms.delete(room.key);
  }

  function openRoom(document: LiveDocumentKey): Room {
    const key = JSON.stringify(documentParams(document));
    const existing = rooms.get(key);
    if (existing) return existing;
    if (closed) throw new Error("Live rooms are closed.");
    if (liveRoomPaused(storage, document)) throw new LiveRoomPausedError();
    const room: Room = {
      key,
      document,
      doc: new Y.Doc({ gc: false }),
      subscribers: new Set(),
      unsaved: [],
      lifetime: new AbortController(),
      opened: Promise.resolve(),
      position: liveRoomPosition(storage),
      bytes: 0,
      members: 0,
      savedThrough: 0,
      saves: new Map(),
      closing: 0,
    };
    rooms.set(key, room);
    room.opened = (async () => {
      try {
        await ensureSaver(room);
        unopened.delete(key);
      } catch (error) {
        // Edits a stopped relay left go into a copy once their note has failed to open for as
        // long as saves may fail, as they would in a room that opened. The copy holds the note
        // as saved under them, so it opens on its own even when their lineage has ended.
        const left = liveRoomEdits(storage, document);
        if (!left.length) throw error;
        const since = unopened.get(key) ?? Date.now();
        unopened.set(key, since);
        if (Date.now() - since < pauseAfterMs) throw error;
        const copy = Y.mergeUpdates([
          ...liveRoomSavedState(storage, document),
          ...left.map((row) => row.updateBytes),
        ]);
        if (!pause(room, "failing", null, senders(left), copy)) throw error;
        unopened.delete(key);
        return;
      }
      // Edits a stopped relay had taken and not saved are in the note a page is given, and are
      // saved first, in the order they were taken. New edits follow them in the list.
      const left = liveRoomEdits(storage, document);
      for (const [index, edit] of left.entries()) {
        if (!roomAdmissible(room.doc, edit.updateBytes)) {
          // A taken edit is never skipped. The note pauses with every one left in its copy.
          const copy = Y.mergeUpdates([
            Y.encodeStateAsUpdate(room.doc),
            ...left.slice(index).map((row) => row.updateBytes),
          ]);
          if (pause(room, "refused", "invalid-update", senders(left), copy)) return;
          throw new Error(
            "A taken edit no longer applies to its note, and the note did not pause.",
          );
        }
        Y.applyUpdate(room.doc, edit.updateBytes, FEED);
        room.unsaved.push({
          position: edit.position,
          sender: edit.sender,
          bytes: edit.updateBytes,
        });
      }
      room.bytes = Y.encodeStateAsUpdate(room.doc).byteLength;
      if (room.unsaved.length) runSave(room);
      else disposeIfIdle(room);
    })();
    room.opened.catch((error: unknown) => {
      log(room, "room did not open", { error: String(error).slice(0, 200) });
      dispose(room);
    });
    return room;
  }

  // A note whose taken edits outlived their room, because the relay stopped or the room could
  // not open, gets a room that saves them, whoever is connected.
  function recover() {
    if (closed) return;
    try {
      for (const document of liveRoomDocuments(storage))
        if (!liveRoomPaused(storage, document)) openRoom(document);
    } catch (error) {
      write("recovery failed", { error: String(error).slice(0, 200) });
    }
  }
  const sweep = setInterval(recover, Math.max(saveEveryMs, 60_000));
  sweep.unref?.();
  setImmediate(recover);

  function leave(room: Room, subscriber: Subscriber | undefined) {
    if (subscriber) {
      room.subscribers.delete(subscriber);
      subscriber.wake?.();
    }
    room.members -= 1;
    if (room.members) return;
    // The last editor leaving saves at once.
    if (room.unsaved.length) runSave(room);
    else disposeIfIdle(room);
  }

  async function nextFor(
    room: Room,
    subscriber: Subscriber,
    current: () => void,
    signal: AbortSignal,
  ): Promise<LiveFrameLease<NamedFrameAppliedUpdate>> {
    for (;;) {
      signal.throwIfAborted();
      room.lifetime.signal.throwIfAborted();
      current();
      if (subscriber.behind) throw new Error("This page fell too far behind the live note.");
      if (subscriber.queue.length) {
        // Everything waiting leaves as one update, up to the applied-update bound.
        let take = 0,
          size = 0;
        for (const update of subscriber.queue) {
          if (take && size + update.updateBytes.byteLength > options.maxAppliedBytes) break;
          size += update.updateBytes.byteLength;
          take += 1;
        }
        const waiting = subscriber.queue.splice(0, take);
        subscriber.bytes = Math.max(0, subscriber.bytes - size);
        const updateBytes =
          take === 1 ? waiting[0]!.updateBytes : Y.mergeUpdates(waiting.map((u) => u.updateBytes));
        return {
          value: { journalCursor: waiting.at(-1)!.journalCursor, updateBytes },
          release() {},
        };
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          subscriber.wake = undefined;
          signal.removeEventListener("abort", done);
          resolve();
        };
        subscriber.wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /**
   * The owner's feed: its capture's applied changes, each save naming the last position it holds,
   * and between them the room's unsaved edits as rows. A row always leaves before the save that
   * holds it, because it is queued when taken and a save is cut only from taken edits.
   */
  function ownerFeed(
    room: Room,
    subscriber: Subscriber,
    current: () => void,
    sync: NamedFrameSync,
    lifetime: AbortSignal,
  ) {
    let reading = false;
    let read: LiveFrameLease<NamedFrameAppliedUpdate> | undefined;
    let failed: { error: unknown } | undefined;
    function startRead() {
      if (reading || read || failed) return;
      reading = true;
      sync.nextApplied(lifetime).then(
        (lease) => {
          reading = false;
          try {
            // The room takes the owner's next edits against all the owner has been shown.
            applyFeed(room, lease.value.updateBytes);
            read = lease;
          } catch (error) {
            lease.release();
            failed = { error };
          }
          subscriber.wake?.();
        },
        (error: unknown) => {
          reading = false;
          failed = { error };
          subscriber.wake?.();
        },
      );
    }
    return async (signal: AbortSignal): Promise<LiveFrameLease<NamedFrameAppliedUpdate>> => {
      for (;;) {
        signal.throwIfAborted();
        room.lifetime.signal.throwIfAborted();
        current();
        if (subscriber.behind) throw new Error("This page fell too far behind the live note.");
        const row = subscriber.queue.shift();
        if (row) {
          subscriber.bytes = Math.max(0, subscriber.bytes - row.updateBytes.byteLength);
          return { value: row, release() {} };
        }
        if (read) {
          const lease = read;
          read = undefined;
          const through = room.saves.get(lease.value.journalCursor);
          return through === undefined
            ? lease
            : { value: { ...lease.value, rowsThrough: through }, release: () => lease.release() };
        }
        if (failed) throw failed.error;
        startRead();
        await new Promise<void>((resolve) => {
          const done = () => {
            subscriber.wake = undefined;
            signal.removeEventListener("abort", done);
            room.lifetime.signal.removeEventListener("abort", done);
            resolve();
          };
          subscriber.wake = done;
          signal.addEventListener("abort", done, { once: true });
          room.lifetime.signal.addEventListener("abort", done, { once: true });
        });
      }
    };
  }

  return {
    join(host, joinOptions) {
      const owner = joinOptions?.owner === true;
      let room: Room | undefined;
      let subscriber: Subscriber | undefined;
      let left = false;
      /** The owner of a paused note, which reads every save the room made and sends nothing. */
      let paused = false;
      const current = accessBetweenEdits(host);
      return {
        hostEpoch: host.hostEpoch,
        invalidated: host.invalidated,
        assertCurrent: current,
        close() {
          if (left) return;
          left = true;
          try {
            host.close();
          } finally {
            if (room) leave(room, subscriber);
          }
        },
        async openSync(clientVector, signal): Promise<NamedFrameSync> {
          host.assertCurrent();
          if (room || paused || left) throw new Error("Live room sync is unavailable.");
          // A paused note's owner still catches up on every save the room made before it paused,
          // so the owner's file holds all that anyone was told was saved. Only its edits wait.
          if (owner && liveRoomPaused(storage, host.room.document)) {
            paused = true;
            return host.openSync(clientVector, signal);
          }
          const held = openRoom(host.room.document);
          room = held;
          held.members += 1;
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            held.opened.then(resolve, reject).finally(() => {
              signal.removeEventListener("abort", abort);
            });
          });
          held.lifetime.signal.throwIfAborted();
          host.assertCurrent();
          if (owner) {
            const feed = new AbortController();
            const sync = await host.openSync(clientVector, signal);
            held.lifetime.signal.throwIfAborted();
            host.assertCurrent();
            // Every edit the room took and no committed save holds, oldest first. They are the
            // room's own, so they don't count toward how far behind it may fall.
            const own: Subscriber = {
              owner: true,
              bytes: 0,
              queue: held.unsaved
                .filter((edit) => edit.position > held.savedThrough)
                .map((edit) => ({
                  journalCursor: edit.position,
                  updateBytes: edit.bytes,
                  roomRow: true as const,
                })),
            };
            subscriber = own;
            held.subscribers.add(own);
            return {
              binding: sync.binding,
              hostVector: sync.hostVector,
              missingStateUpdate: sync.missingStateUpdate,
              appliedThroughJournalCursor: sync.appliedThroughJournalCursor,
              close() {
                held.subscribers.delete(own);
                feed.abort();
                sync.close();
              },
              nextApplied: ownerFeed(
                held,
                own,
                current,
                sync,
                AbortSignal.any([feed.signal, held.lifetime.signal]),
              ),
            };
          }
          const own: Subscriber = { queue: [], bytes: 0 };
          subscriber = own;
          held.subscribers.add(own);
          return {
            binding: host.room.view(),
            hostVector: Y.encodeStateVector(held.doc),
            missingStateUpdate: Y.encodeStateAsUpdate(held.doc, clientVector),
            appliedThroughJournalCursor: held.position,
            close() {
              held.subscribers.delete(own);
            },
            nextApplied: (waitSignal) => nextFor(held, own, current, waitSignal),
          };
        },
        async submit(input, signal): Promise<NamedFrameSubmissionResult> {
          signal.throwIfAborted();
          // `sender` below reads this editor's access in full for each edit.
          current();
          // Until the owner resumes, its edits wait. A retry keeps them pending on its computer,
          // which puts them in the copy; a refusal would set them aside as a restore does.
          if (paused) return { result: "retry", reason: "admission-unavailable" };
          const held = room;
          if (!held || !subscriber || held.lifetime.signal.aborted)
            throw new Error("Live room is not open.");
          // The room is saving everything before the note closes; this edit waits on its page.
          if (held.closing || holding.has(noteKey(held.document)))
            return { result: "retry", reason: "admission-unavailable" };
          if (
            input.trustedAutomation ||
            input.trustedAutomationPress ||
            input.trustedAutomationGrant ||
            input.room
          )
            return refused("authority-refused");
          const deliveryId = parseLiveUpdateIdentifier(input.deliveryId),
            updateDigest = parseLiveUpdateDigest(input.updateDigest);
          const bytes = input.updateBytes;
          if (bytes.byteLength < 1) return refused("invalid-update");
          if (
            bytes.byteLength > options.maxUpdateBytes ||
            held.bytes + bytes.byteLength > options.maxNoteBytes
          )
            return refused("capacity-refused");
          if (sha256(bytes) !== updateDigest) return refused("invalid-update");
          // From here to the answer nothing waits, so the room cannot change under the checks.
          const sender = host.room.sender(input.authorContext);
          if (!sender) return refused("provenance-refused");
          const plan = roomAdmissible(held.doc, bytes);
          if (!plan || !liveEditFitsNote(held.doc, bytes)) return refused("invalid-update");
          const seed = liveJournalSeedClientId(storage, held.document);
          if (plan.clients.some((clientId) => clientId === seed))
            return refused("provenance-refused");
          const have = Y.decodeStateVector(Y.encodeStateVector(held.doc));
          let written: ReturnType<typeof appendLiveRoomEdit>;
          try {
            written = appendLiveRoomEdit(storage, {
              document: held.document,
              sender,
              clients: plan.clients.map((clientId) => ({
                clientId,
                inNote: (have.get(clientId) ?? 0) > 0,
              })),
              updateBytes: bytes.slice(),
              receivedAtMs: Date.now(),
            });
          } catch (error) {
            if (error instanceof SyncRelayQuotaExceededError) return refused("capacity-refused");
            throw error;
          }
          if (written.kind === "refused") return refused("provenance-refused");
          Y.applyUpdate(held.doc, bytes, subscriber);
          held.bytes += bytes.byteLength;
          held.unsaved.push({ position: written.position, sender, bytes });
          passOn(
            held,
            { journalCursor: written.position, updateBytes: bytes },
            { taken: true, except: subscriber },
          );
          scheduleSave(held, saveEveryMs);
          return {
            result: "success",
            ack: {
              deliveryId,
              updateDigest,
              journalCursor: written.position,
              acceptingHostEpoch: host.hostEpoch,
              localYDocSequence: written.position,
              applicationReplayed: false,
            },
          };
        },
      };
    },
    async saveFirst(note, then, signal) {
      if (closed) throw new Error("Live rooms are closed.");
      const key = noteKey(note);
      holding.set(key, (holding.get(key) ?? 0) + 1);
      try {
        // The note's current lineage, if it has a room or taken edits. A pause took its own
        // lineage's edits into the copy, and an ended lineage's can't be saved, so neither holds
        // the step up.
        const held = new Map<string, LiveDocumentKey>();
        for (const document of [
          ...[...rooms.values()].map((room) => room.document),
          ...liveRoomDocuments(storage),
        ])
          if (noteKey(document) === key && liveRoomLineageIsCurrent(storage, document))
            held.set(JSON.stringify(documentParams(document)), document);
        let saving: Room[];
        try {
          saving = await Promise.all(
            [...held.values()].map(async (document) => {
              const room = openRoom(document);
              await drain(room, signal);
              return room;
            }),
          );
        } catch {
          // A room that could not open, such as one a pause keeps shut, holds edits it can't save.
          signal.throwIfAborted();
          throw new LiveRoomUnsavedError();
        }
        if (saving.some((room) => room.unsaved.length)) throw new LiveRoomUnsavedError();
        const result = await then();
        for (const room of [...rooms.values()])
          if (noteKey(room.document) === key && !room.lifetime.signal.aborted) dispose(room);
        return result;
      } finally {
        const left = holding.get(key)! - 1;
        if (left) holding.set(key, left);
        else holding.delete(key);
      }
    },
    async close() {
      closed = true;
      clearInterval(sweep);
      // Whatever does not save in time stays in its table and is saved when the note next opens.
      const deadline = AbortSignal.timeout(saveTimeoutMs);
      await Promise.all(
        [...rooms.values()].map((room) =>
          drain(room, deadline)
            .catch(() => {})
            .finally(() => {
              if (!room.lifetime.signal.aborted) dispose(room);
            }),
        ),
      );
    },
  };
}

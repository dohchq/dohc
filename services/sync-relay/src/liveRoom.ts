// A live room: one shared note's live copy in memory, plus the edits taken and not yet saved.
//
// An edit is admitted, written down, applied, answered and passed on, in that order. The room
// saves what it holds every few seconds as one write on the owner's capture, which names every
// sender in it. The saved rows are deleted in the save's own journal transaction. Everything
// else that changes the note reaches the room through that capture's feed of applied changes.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import type { LiveFrameLease } from "@dohc/live-session-contract/live-frame";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  type LiveDocumentKey,
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
  liveRoomEdits,
  liveRoomPosition,
} from "./storage/liveRoomEdits.js";
import { documentParams, liveJournalSeedClientId } from "./storage/liveUpdateJournal.js";

const EMPTY_VECTOR = Y.encodeStateVector(new Y.Doc());
const FEED = Symbol("live-room-feed");

export interface LiveRoomsOptions {
  readonly storage: SyncRelayStorage;
  /** The owner's capture of a note. It carries the room's saves and its feed of other changes. */
  openSaver(document: LiveDocumentKey, signal: AbortSignal): Promise<NamedFrameHostSession>;
  readonly maxUpdateBytes: number;
  readonly maxNoteBytes: number;
  readonly maxAppliedBytes: number;
  readonly saveEveryMs?: number;
  readonly log?: (line: string, detail: Record<string, unknown>) => void;
}
export interface LiveRooms {
  /** Puts an editor's connection in its note's room. The capture still decides its access. */
  join(host: NamedFrameRoomHost): NamedFrameHostSession;
  close(): void;
}

interface Subscriber {
  readonly queue: NamedFrameAppliedUpdate[];
  wake?: () => void;
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
}

const refused = (reason: Extract<NamedFrameSubmissionResult, { result: "refused" }>["reason"]) =>
  ({ result: "refused", reason }) as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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

/**
 * How many of the oldest unsaved edits one save holds, and who it names. A saved snapshot names
 * one person, with the agent acting for them, until the engine credits a longer list; so one
 * save holds one sender's run of edits.
 */
function nextSave(unsaved: readonly Unsaved[]): { count: number; authors: LiveAuthorSnapshot } {
  const authors = unsaved[0]?.sender ?? [];
  const sender = JSON.stringify(authors);
  let count = 0;
  while (count < unsaved.length && JSON.stringify(unsaved[count]!.sender) === sender) count += 1;
  return { count, authors };
}

export function createLiveRooms(options: LiveRoomsOptions): LiveRooms {
  const storage = options.storage as StorageContext;
  const saveEveryMs = options.saveEveryMs ?? 5_000;
  const log = options.log ?? ((line, detail) => console.error(`[live-room] ${line}`, detail));
  const rooms = new Map<string, Room>();
  let closed = false;

  function passOn(room: Room, update: NamedFrameAppliedUpdate, except?: Subscriber) {
    room.position = update.journalCursor;
    for (const subscriber of room.subscribers) {
      if (subscriber === except) continue;
      subscriber.queue.push(update);
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
    passOn(room, { journalCursor: advanceLiveRoomPosition(storage), updateBytes: changed });
  }

  function ensureSaver(room: Room): Promise<NonNullable<Room["saver"]>> {
    if (room.saver && !room.saver.host.invalidated.aborted) return Promise.resolve(room.saver);
    if (room.saver) dropSaver(room);
    room.connecting ??= (async () => {
      const signal = room.lifetime.signal;
      const host = await options.openSaver(room.document, signal);
      let sync: NamedFrameSync;
      try {
        sync = await host.openSync(EMPTY_VECTOR, signal);
      } catch (error) {
        host.close();
        throw error;
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
        // The capture ended. The next save opens another, which brings the room up to date.
        if (room.saver === saver) dropSaver(room);
        if (!room.lifetime.signal.aborted && !room.timer && !room.saving && room.members)
          scheduleSave(room, saveEveryMs);
      });
      return saver;
    })().finally(() => {
      room.connecting = undefined;
    });
    return room.connecting;
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

  /** One save of the oldest unsaved edits. True when the journal took it. */
  async function saveOnce(room: Room): Promise<boolean> {
    const { count, authors } = nextSave(room.unsaved);
    if (!count) return true;
    const batch = room.unsaved.slice(0, count);
    const merged = count === 1 ? batch[0]!.bytes : Y.mergeUpdates(batch.map((edit) => edit.bytes));
    const through = batch.at(-1)!.position;
    let committed = false;
    let answer: NamedFrameSubmissionResult | undefined;
    try {
      const saver = await ensureSaver(room);
      answer = await saver.host.submit(
        {
          deliveryId: randomUUID(),
          updateDigest: sha256(merged),
          updateBytes: merged,
          room: {
            authors,
            committed() {
              deleteSavedLiveRoomEdits(storage, room.document, through);
              committed = true;
            },
          },
        },
        room.lifetime.signal,
      );
    } catch (error) {
      if (!committed) {
        log("save failed", { edits: count, error: String(error).slice(0, 200) });
        return false;
      }
    }
    if (!committed) {
      log("save not taken", { edits: count, answer });
      return false;
    }
    room.unsaved.splice(0, count);
    room.bytes = Y.encodeStateAsUpdate(room.doc).byteLength;
    return true;
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
    room.saving = saveOnce(room).then((saved) => {
      room.saving = undefined;
      if (room.lifetime.signal.aborted) return;
      if (room.unsaved.length) scheduleSave(room, saved ? 0 : saveEveryMs);
      else disposeIfIdle(room);
    });
  }
  function disposeIfIdle(room: Room) {
    if (room.members || room.unsaved.length || room.saving) return;
    dispose(room);
  }
  function dispose(room: Room) {
    clearTimeout(room.timer);
    room.timer = undefined;
    room.lifetime.abort(new Error("Live room closed."));
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
    };
    rooms.set(key, room);
    room.opened = (async () => {
      await ensureSaver(room);
      room.bytes = Y.encodeStateAsUpdate(room.doc).byteLength;
      // Edits a stopped relay had taken and not saved are saved before any new edit is taken.
      for (const edit of liveRoomEdits(storage, document)) {
        if (!roomAdmissible(room.doc, edit.updateBytes))
          throw new Error("A taken edit no longer applies to its note.");
        Y.applyUpdate(room.doc, edit.updateBytes, FEED);
        room.unsaved.push({
          position: edit.position,
          sender: edit.sender,
          bytes: edit.updateBytes,
        });
      }
      while (room.unsaved.length)
        if (!(await saveOnce(room))) await delay(saveEveryMs, undefined, room.lifetime);
      room.bytes = Y.encodeStateAsUpdate(room.doc).byteLength;
    })();
    room.opened.catch((error: unknown) => {
      log("room did not open", { error: String(error).slice(0, 200) });
      dispose(room);
    });
    return room;
  }

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
    host: NamedFrameRoomHost,
    signal: AbortSignal,
  ): Promise<LiveFrameLease<NamedFrameAppliedUpdate>> {
    for (;;) {
      signal.throwIfAborted();
      room.lifetime.signal.throwIfAborted();
      host.assertCurrent();
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

  return {
    join(host) {
      let room: Room | undefined;
      let subscriber: Subscriber | undefined;
      let left = false;
      return {
        hostEpoch: host.hostEpoch,
        invalidated: host.invalidated,
        assertCurrent: () => host.assertCurrent(),
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
          if (room || left) throw new Error("Live room sync is unavailable.");
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
          const own: Subscriber = { queue: [] };
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
            nextApplied: (waitSignal) => nextFor(held, own, host, waitSignal),
          };
        },
        async submit(input, signal): Promise<NamedFrameSubmissionResult> {
          signal.throwIfAborted();
          host.assertCurrent();
          const held = room;
          if (!held || !subscriber || held.lifetime.signal.aborted)
            throw new Error("Live room is not open.");
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
          if (!plan) return refused("invalid-update");
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
          passOn(held, { journalCursor: written.position, updateBytes: bytes }, subscriber);
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
    close() {
      closed = true;
      // Taken edits stay in their table and are saved when the note next opens.
      for (const room of [...rooms.values()]) dispose(room);
    },
  };
}

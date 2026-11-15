import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { createLiveRooms, roomAdmissible } from "./liveRoom.js";
import type { NamedFrameRoomHost } from "./namedLiveFrameHost.js";
import type { NamedFrameHostSession, NamedFrameSync } from "./namedLiveFrameSession.js";
import type { StorageContext } from "./storage/context.js";
import { appendLiveRoomEdit, liveRoomEdits } from "./storage/liveRoomEdits.js";
import { liveJournalSeedClientId } from "./storage/liveUpdateJournal.js";

const open: Fixture[] = [];
const rooms_: { close(): void }[] = [];
afterEach(() => {
  for (const room of rooms_.splice(0)) room.close();
  for (const f of open.splice(0)) f.close();
  cleanupLiveDeliveryFixtures();
});
function note() {
  const f = registered({ deployment: true });
  open.push(f);
  return f;
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hostEpoch = parseHostEpoch(1);
const ana: LiveAuthorSnapshot = [{ kind: "human", humanId: "ana", humanName: "Ana" }];
const ben: LiveAuthorSnapshot = [{ kind: "human", humanId: "ben", humanName: "Ben" }];
type Fixture = ReturnType<typeof registered>;

/** The owner's capture of the note, saving through the real journal. Its feed stays quiet. */
function ownerCapture(f: Fixture): NamedFrameHostSession {
  const lifetime = new AbortController();
  const binding = f.storage.resolveCurrentLiveDocumentBinding({
    document: f.input.evidence.document,
    actor: f.actor,
  });
  if (binding.kind !== "current") throw new Error("The owner's binding is not current.");
  return {
    hostEpoch,
    invalidated: lifetime.signal,
    assertCurrent() {},
    close: () => lifetime.abort(),
    async openSync(): Promise<NamedFrameSync> {
      return {
        binding: binding.binding,
        hostVector: Y.encodeStateVector(f.doc),
        missingStateUpdate: Y.encodeStateAsUpdate(f.doc),
        appliedThroughJournalCursor: 0,
        close() {},
        nextApplied: (signal) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      };
    },
    async submit(input) {
      const { result } = f.storage.commitLiveUpdateJournal({
        ...f.capture(input.updateBytes, input.deliveryId),
        ...(input.room ? { room: input.room } : {}),
      });
      if (result.kind !== "accepted") return { result: "refused", reason: result.reason } as never;
      return {
        result: "success",
        ack: {
          deliveryId: input.deliveryId,
          updateDigest: input.updateDigest,
          journalCursor: 1,
          acceptingHostEpoch: hostEpoch,
          localYDocSequence: 1,
          applicationReplayed: false,
        },
      } as never;
    },
  };
}

function rooms(f: Fixture, limits: { maxUpdateBytes?: number } = {}) {
  const created = createLiveRooms({
    storage: f.storage,
    maxUpdateBytes: limits.maxUpdateBytes ?? 1 << 20,
    maxNoteBytes: 1 << 22,
    maxAppliedBytes: 1 << 20,
    // Tests save by leaving, never on the timer.
    saveEveryMs: 3_600_000,
    log() {},
    openSaver: async () => ownerCapture(f),
  });
  rooms_.push(created);
  return created;
}

/** An editor's connection: a page's own Y.Doc behind its capture's access check. */
function editor(f: Fixture, room: ReturnType<typeof rooms>, sender: LiveAuthorSnapshot) {
  const lifetime = new AbortController();
  const binding = f.storage.resolveCurrentLiveDocumentBinding({
    document: f.input.evidence.document,
    actor: f.actor,
  });
  if (binding.kind !== "current") throw new Error("Binding is not current.");
  const inner = {
    hostEpoch,
    invalidated: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    close: () => lifetime.abort(),
    openSync: () => Promise.reject(new Error("The room opens no inner sync.")),
    submit: () => Promise.reject(new Error("The room submits nothing inner.")),
    room: {
      document: f.input.evidence.document,
      view: () => binding.binding,
      sender: () => sender,
    },
  } as unknown as NamedFrameRoomHost;
  const session = room.join(inner);
  const doc = new Y.Doc();
  const signal = new AbortController().signal;
  let sync: NamedFrameSync | undefined;
  return {
    session,
    doc,
    async open() {
      sync = await session.openSync(Y.encodeStateVector(doc), signal);
      Y.applyUpdate(doc, sync.missingStateUpdate);
      return sync;
    },
    async next() {
      const lease = await sync!.nextApplied(signal);
      Y.applyUpdate(doc, lease.value.updateBytes);
      lease.release();
      return lease.value.journalCursor;
    },
    change(key: string, value: string) {
      const before = Y.encodeStateVector(doc);
      doc.getMap("frontmatter").set(key, value);
      return Y.encodeStateAsUpdate(doc, before);
    },
    submit(bytes: Uint8Array) {
      return session.submit(
        { deliveryId: randomUUID(), updateDigest: hash(bytes), updateBytes: bytes },
        signal,
      );
    },
  };
}

const unsaved = (f: Fixture) =>
  liveRoomEdits(f.storage as StorageContext, f.input.evidence.document);
const savedAuthors = (f: Fixture) =>
  f.journalRows().journal.map((row) => JSON.parse(String(row.author_snapshot_json)));

it("writes an edit down before answering, passes it on, and saves it under its sender", async () => {
  const f = note();
  const room = rooms(f);
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  const answer = await a.submit(a.change("title", "Lisbon"));
  expect(answer.result).toBe("success");
  const cursor = answer.result === "success" ? answer.ack.journalCursor : 0;
  expect(unsaved(f).map((edit) => [edit.position, edit.sender])).toEqual([[cursor, ana]]);
  expect(await b.next()).toBe(cursor);
  expect(b.doc.getMap("frontmatter").get("title")).toBe("Lisbon");
  expect(f.journalRows().journal).toEqual([]);

  a.session.close();
  b.session.close();
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(savedAuthors(f)).toEqual([ana]);
});

it("saves each sender's run of edits under that sender alone", async () => {
  const f = note();
  const room = rooms(f);
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  for (const [person, other, key] of [
    [a, b, "title"],
    [a, b, "subtitle"],
    [b, a, "place"],
  ] as const) {
    expect((await person.submit(person.change(key, "v"))).result).toBe("success");
    await other.next();
  }
  a.session.close();
  b.session.close();
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(savedAuthors(f)).toEqual([ana, ben]);
});

it("refuses an edit under an editor id tied to someone else and writes nothing", async () => {
  const f = note();
  const room = rooms(f);
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await b.next();
  b.doc.clientID = a.doc.clientID;
  expect(await b.submit(b.change("title", "Porto"))).toEqual({
    result: "refused",
    reason: "provenance-refused",
  });
  expect(unsaved(f)).toHaveLength(1);
});

it("refuses an edit under the note's own editor id", async () => {
  const f = note();
  const room = rooms(f);
  const seed = liveJournalSeedClientId(f.storage as StorageContext, f.input.evidence.document);
  expect(seed).not.toBeNull();
  const noteIds = Y.decodeStateVector(Y.encodeStateVector(f.doc)).keys();
  for (const clientId of new Set([seed!, ...noteIds])) {
    const a = editor(f, room, ana);
    await a.open();
    a.doc.clientID = clientId;
    expect(await a.submit(a.change("title", "Lisbon" + clientId))).toEqual({
      result: "refused",
      reason: "provenance-refused",
    });
  }
  expect(unsaved(f)).toEqual([]);
});

it("refuses an edit that builds on something the room does not have, or is too large", async () => {
  const f = note();
  const room = rooms(f, { maxUpdateBytes: 64 });
  const a = editor(f, room, ana);
  await a.open();
  a.change("title", "kept on the page");
  expect(await a.submit(a.change("title", "Porto"))).toEqual({
    result: "refused",
    reason: "invalid-update",
  });
  expect(await a.submit(a.change("body", "x".repeat(200)))).toEqual({
    result: "refused",
    reason: "capacity-refused",
  });
  expect(unsaved(f)).toEqual([]);
});

it("saves edits a stopped relay took before it takes a new one", async () => {
  const f = note();
  const first = rooms(f);
  const a = editor(f, first, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  first.close();
  expect(unsaved(f)).toHaveLength(1);
  expect(f.journalRows().journal).toEqual([]);

  const again = editor(f, rooms(f), ben);
  await again.open();
  expect(unsaved(f)).toEqual([]);
  expect(savedAuthors(f)).toEqual([ana]);
  expect(again.doc.getMap("frontmatter").get("title")).toBe("Lisbon");
});

it("refuses a room save that leaves out someone whose edit it holds", () => {
  const f = note();
  const storage = f.storage as StorageContext;
  const document = f.input.evidence.document;
  const page = new Y.Doc();
  Y.applyUpdate(page, Y.encodeStateAsUpdate(f.doc));
  const before = Y.encodeStateVector(page);
  page.getMap("frontmatter").set("title", "Lisbon");
  const bytes = Y.encodeStateAsUpdate(page, before);
  expect(
    appendLiveRoomEdit(storage, {
      document,
      sender: ana,
      clients: [{ clientId: page.clientID, inNote: false }],
      updateBytes: bytes,
      receivedAtMs: 1,
    }).kind,
  ).toBe("written");
  const committed = vi.fn();
  expect(
    f.storage.commitLiveUpdateJournal({
      ...f.capture(bytes, "room-save"),
      room: { authors: ben, committed },
    }).result,
  ).toEqual({ kind: "refused", reason: "provenance-refused" });
  expect(committed).not.toHaveBeenCalled();
  expect(unsaved(f)).toHaveLength(1);
  // A browser's own submission cannot carry a room save.
  expect(
    f.storage.commitLiveUpdateJournal({
      ...f.capture(bytes, "named-save", { kind: "named", userId: "reader", grantId: "grant" }),
      room: { authors: ana, committed },
    }).result,
  ).toEqual({ kind: "refused", reason: "authority-refused" });
});

it("takes only updates that build on what the room has", () => {
  const room = new Y.Doc(),
    page = new Y.Doc();
  const first = (() => {
    const before = Y.encodeStateVector(page);
    page.getText("t").insert(0, "ab");
    return Y.encodeStateAsUpdate(page, before);
  })();
  const second = (() => {
    const before = Y.encodeStateVector(page);
    page.getText("t").insert(1, "x");
    return Y.encodeStateAsUpdate(page, before);
  })();
  const removal = (() => {
    const before = Y.encodeStateVector(page);
    page.getText("t").delete(0, 1);
    return Y.encodeStateAsUpdate(page, before);
  })();
  expect(roomAdmissible(room, second)).toBeNull();
  expect(roomAdmissible(room, removal)).toBeNull();
  expect(roomAdmissible(room, Uint8Array.of(1, 2, 3))).toBeNull();
  expect(roomAdmissible(room, first)).toEqual({ clients: [page.clientID] });
  Y.applyUpdate(room, first);
  expect(roomAdmissible(room, second)).toEqual({ clients: [page.clientID] });
});

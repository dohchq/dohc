import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { createLiveRooms, nextSave, roomAdmissible } from "./liveRoom.js";
import type { NamedFrameRoomHost } from "./namedLiveFrameHost.js";
import type {
  NamedFrameAppliedUpdate,
  NamedFrameHostSession,
  NamedFrameSync,
} from "./namedLiveFrameSession.js";
import type { StorageContext } from "./storage/context.js";
import { observeRelayWrites } from "./relayWriteChanges.js";
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
const olu: LiveAuthorSnapshot = [{ kind: "human", humanId: "olu", humanName: "Olu" }];
type Fixture = ReturnType<typeof registered>;

interface Engine {
  /** Waited on before each save is committed. */
  hold?: Promise<void>;
  /** The engine never answers a committed save. */
  silent?: boolean;
}

/** The owner's capture of the note, saving through the real journal. Its feed stays quiet. */
function ownerCapture(f: Fixture, engine: Engine = {}): NamedFrameHostSession {
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
        // The note as saved: its baseline and every journal row.
        missingStateUpdate: Y.mergeUpdates([
          Y.encodeStateAsUpdate(f.doc),
          ...f.journalRows().journal.map((row) => new Uint8Array(row.update_bytes as Uint8Array)),
        ]),
        appliedThroughJournalCursor: 0,
        close() {},
        nextApplied: (signal) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      };
    },
    async submit(input, signal) {
      await engine.hold;
      const { result } = f.storage.commitLiveUpdateJournal({
        ...f.capture(input.updateBytes, input.deliveryId),
        ...(input.room ? { room: input.room } : {}),
      });
      if (result.kind !== "accepted") return { result: "refused", reason: result.reason } as never;
      if (engine.silent)
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
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

function rooms(
  f: Fixture,
  limits: {
    maxUpdateBytes?: number;
    names?: boolean;
    saveTimeoutMs?: number;
    saveEveryMs?: number;
  } = {},
  engine: Engine = {},
) {
  const created = createLiveRooms({
    storage: f.storage,
    maxUpdateBytes: limits.maxUpdateBytes ?? 1 << 20,
    maxNoteBytes: 1 << 22,
    maxAppliedBytes: 1 << 20,
    namesEverySender: limits.names ?? false,
    // Tests save by leaving unless they set the timer.
    saveEveryMs: limits.saveEveryMs ?? 3_600_000,
    ...(limits.saveTimeoutMs ? { saveTimeoutMs: limits.saveTimeoutMs } : {}),
    log() {},
    openSaver: async () => ownerCapture(f, engine),
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
  /** Full reads of this editor's access, and whether it has ended, as a link session expiring. */
  const access = { reads: 0, ended: false };
  const inner = {
    hostEpoch,
    invalidated: lifetime.signal,
    assertCurrent() {
      lifetime.signal.throwIfAborted();
      access.reads += 1;
      if (!access.ended) return;
      // As the capture does: a failed read closes it.
      lifetime.abort(new Error("Access ended."));
      lifetime.signal.throwIfAborted();
    },
    close: () => lifetime.abort(),
    openSync: () => Promise.reject(new Error("The room opens no inner sync.")),
    submit: () => Promise.reject(new Error("The room submits nothing inner.")),
    room: {
      document: f.input.evidence.document,
      view: () => binding.binding,
      sender: () => (access.ended ? null : sender),
    },
  } as unknown as NamedFrameRoomHost;
  const session = room.join(inner);
  const doc = new Y.Doc();
  const signal = new AbortController().signal;
  let sync: NamedFrameSync | undefined;
  return {
    session,
    doc,
    access,
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

const rowBytes = (row: Record<string, unknown>) => new Uint8Array(row.update_bytes as Uint8Array);

/** The owner's computer. Its own capture's feed brings every journal row as it is committed. */
function ownerDesktop(f: Fixture, room: ReturnType<typeof rooms>) {
  const lifetime = new AbortController();
  const binding = f.storage.resolveCurrentLiveDocumentBinding({
    document: f.input.evidence.document,
    actor: f.actor,
  });
  if (binding.kind !== "current") throw new Error("Binding is not current.");
  let fed = 0;
  const inner = {
    hostEpoch,
    invalidated: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    close: () => lifetime.abort(),
    async openSync(): Promise<NamedFrameSync> {
      const journal = f.journalRows().journal;
      fed = journal.length ? Number(journal.at(-1)!.journal_cursor) : 0;
      return {
        binding: binding.binding,
        hostVector: Y.encodeStateVector(f.doc),
        missingStateUpdate: Y.mergeUpdates([
          Y.encodeStateAsUpdate(f.doc),
          ...journal.map(rowBytes),
        ]),
        appliedThroughJournalCursor: fed,
        close() {},
        async nextApplied(signal) {
          for (;;) {
            signal.throwIfAborted();
            const row = f.journalRows().journal.find((r) => Number(r.journal_cursor) > fed);
            if (row) {
              fed = Number(row.journal_cursor);
              return { value: { journalCursor: fed, updateBytes: rowBytes(row) }, release() {} };
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      };
    },
    submit: () => Promise.reject(new Error("The room submits nothing inner.")),
    room: {
      document: f.input.evidence.document,
      view: () => binding.binding,
      sender: () => olu,
    },
  } as unknown as NamedFrameRoomHost;
  const session = room.join(inner, { owner: true });
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
    async next(): Promise<Omit<NamedFrameAppliedUpdate, "updateBytes">> {
      const lease = await sync!.nextApplied(signal);
      Y.applyUpdate(doc, lease.value.updateBytes);
      lease.release();
      const { updateBytes: _, ...frame } = lease.value;
      return frame;
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
const position = (answer: Awaited<ReturnType<NamedFrameHostSession["submit"]>>) =>
  answer.result === "success" ? answer.ack.journalCursor : 0;

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

it("with names on, saves everyone's edits at once and names each person once", async () => {
  const f = note();
  const room = rooms(f, { names: true });
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  for (const [person, other, key] of [
    [b, a, "title"],
    [a, b, "subtitle"],
    [b, a, "place"],
  ] as const) {
    expect((await person.submit(person.change(key, "v"))).result).toBe("success");
    await other.next();
  }
  a.session.close();
  b.session.close();
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(savedAuthors(f)).toEqual([[...ana, ...ben]]);
});

it("keeps one sender's own snapshot, and saves an automation or unattributed edit alone", () => {
  const edit = (sender: LiveAuthorSnapshot, size = 1) => ({ sender, bytes: new Uint8Array(size) });
  const pair: LiveAuthorSnapshot = [
    ...ben,
    { kind: "agent", agentId: "helper", agentName: "Helper", onBehalfOf: "ben" },
  ] as LiveAuthorSnapshot;
  expect(nextSave([edit(pair), edit(pair)], true, 100)).toEqual({ count: 2, authors: pair });
  expect(nextSave([edit(pair), edit(ana)], true, 100).authors).toHaveLength(3);
  const nobody: LiveAuthorSnapshot = [{ kind: "unattributed" }];
  expect(nextSave([edit(ana), edit(nobody), edit(ana)], true, 100)).toEqual({
    count: 1,
    authors: ana,
  });
  expect(nextSave([edit(nobody), edit(ana)], true, 100)).toEqual({ count: 1, authors: nobody });
  // A save stays under the largest update the engine passes on, whatever its first edit.
  expect(nextSave([edit(ana, 60), edit(ben, 60)], true, 100).count).toBe(1);
  expect(nextSave([edit(ana, 60), edit(ana, 60)], false, 100).count).toBe(1);
  expect(nextSave([edit(ana, 160)], true, 100).count).toBe(1);
});

it("counts a committed save whose engine answer never comes, and goes on saving", async () => {
  const f = note();
  const room = rooms(f, { saveTimeoutMs: 50 }, { silent: true });
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await b.next();
  expect((await b.submit(b.change("place", "Porto"))).result).toBe("success");
  a.session.close();
  b.session.close();
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(savedAuthors(f)).toEqual([ana, ben]);
});

it("gives the owner others' edits as rows, and each save the last row it holds, below its cursor", async () => {
  const f = note();
  const room = rooms(f, { saveEveryMs: 20 });
  const owner = ownerDesktop(f, room),
    a = editor(f, room, ana);
  await owner.open();
  await a.open();
  const first = position(await a.submit(a.change("title", "Lisbon")));
  expect(await owner.next()).toEqual({ journalCursor: first, roomRow: true });
  // The owner's own edit is answered with its room position and not sent back to it.
  const own = position(await owner.submit(owner.change("place", "Porto")));
  expect(own).toBeGreaterThan(first);
  expect(await a.next()).toBe(own);
  expect(a.doc.getMap("frontmatter").get("place")).toBe("Porto");

  // One save for each sender's run: Ana's, then the owner's.
  const saved = [await owner.next(), await owner.next()];
  expect(saved.map((frame) => frame.rowsThrough)).toEqual([first, own]);
  for (const frame of saved) {
    expect(frame.roomRow).toBeUndefined();
    expect(frame.journalCursor).toBeGreaterThan(own);
  }
  expect(savedAuthors(f)).toEqual([ana, olu]);
  expect(unsaved(f)).toEqual([]);
  expect(owner.doc.getMap("frontmatter").toJSON()).toEqual({ title: "Lisbon", place: "Porto" });
});

it("sends an owner who reconnects the rows no save holds, oldest first", async () => {
  const f = note();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const room = rooms(f, {}, { hold });
  const a = editor(f, room, ana);
  await a.open();
  const rows = [
    position(await a.submit(a.change("title", "Lisbon"))),
    position(await a.submit(a.change("place", "Porto"))),
  ];
  const first = ownerDesktop(f, room);
  await first.open();
  expect([await first.next(), await first.next()]).toEqual(
    rows.map((journalCursor) => ({ journalCursor, roomRow: true })),
  );
  first.session.close();
  const again = ownerDesktop(f, room);
  await again.open();
  expect([await again.next(), await again.next()]).toEqual(
    rows.map((journalCursor) => ({ journalCursor, roomRow: true })),
  );
  expect(again.doc.getMap("frontmatter").toJSON()).toEqual({ title: "Lisbon", place: "Porto" });

  // Once saved, a reconnecting owner has them in the note, and is sent only what comes next.
  again.session.close();
  release();
  a.session.close();
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  const later = ownerDesktop(f, room);
  await later.open();
  expect(later.doc.getMap("frontmatter").toJSON()).toEqual({ title: "Lisbon", place: "Porto" });
  const b = editor(f, room, ben);
  await b.open();
  const next = position(await b.submit(b.change("note", "x")));
  expect(await later.next()).toEqual({ journalCursor: next, roomRow: true });
});

it("takes an owner's edit built on a change the owner's own feed brought first", async () => {
  const f = note();
  const room = rooms(f);
  const owner = ownerDesktop(f, room);
  await owner.open();
  // Another writer commits straight to the journal. The room's own feed stays quiet in these
  // tests, so only the owner's capture brings it.
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(owner.doc));
  const before = Y.encodeStateVector(other);
  other.getMap("frontmatter").set("status", "drafted elsewhere");
  const committed = f.storage.commitLiveUpdateJournal(
    f.capture(Y.encodeStateAsUpdate(other, before), "elsewhere"),
  );
  expect(committed.result.kind).toBe("accepted");
  expect((await owner.next()).roomRow).toBeUndefined();
  // Overwriting the key builds on the change the room had not seen until the owner's feed did.
  expect((await owner.submit(owner.change("status", "checked"))).result).toBe("success");
});

it("reads a reader's access at most once a second while others' edits reach it, not once a frame", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const f = note();
    const room = rooms(f);
    const a = editor(f, room, ana);
    const readers = [editor(f, room, ben), editor(f, room, ben), editor(f, room, ben)];
    await a.open();
    for (const reader of readers) await reader.open();
    const before = readers.map((reader) => reader.access.reads);
    for (let index = 0; index < 20; index++) {
      expect((await a.submit(a.change("title", `v${index}`))).result).toBe("success");
      for (const reader of readers) await reader.next();
    }
    expect(readers.map((reader, index) => reader.access.reads - before[index]!)).toEqual([1, 1, 1]);
  } finally {
    vi.useRealTimers();
  }
});

it("stops handing others' edits to a reader whose access ended with time, within a second", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const f = note();
    const room = rooms(f);
    const a = editor(f, room, ana),
      b = editor(f, room, ben);
    await a.open();
    await b.open();
    await a.submit(a.change("title", "Lisbon"));
    await b.next();
    b.access.ended = true;
    // Its own edits are refused at once.
    expect((await b.submit(b.change("note", "late"))).result).toBe("refused");
    vi.setSystemTime(Date.now() + 1_000);
    await a.submit(a.change("place", "Porto"));
    await expect(b.next()).rejects.toThrow("Access ended.");
  } finally {
    vi.useRealTimers();
  }
});

it("wakes no live host when it takes an edit, and wakes them when it saves", async () => {
  const f = note();
  const room = rooms(f);
  const a = editor(f, room, ana);
  await a.open();
  let wakes = 0;
  const stop = observeRelayWrites(f.storage, () => {
    wakes += 1;
  });
  try {
    for (const value of ["Lisbon", "Porto"])
      expect((await a.submit(a.change("title", value))).result).toBe("success");
    await new Promise((resolve) => setImmediate(resolve));
    expect(wakes).toBe(0);
    a.session.close();
    await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
    await vi.waitFor(() => expect(wakes).toBeGreaterThan(0));
  } finally {
    stop();
  }
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

it("gives the next page every taken edit before they are saved, and saves them with nobody there", async () => {
  const f = note();
  const first = rooms(f);
  const a = editor(f, first, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  first.close();

  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const again = rooms(f, {}, { hold });
  const page = editor(f, again, ben);
  await page.open();
  expect(page.doc.getMap("frontmatter").get("title")).toBe("Lisbon");
  expect(unsaved(f)).toHaveLength(1);
  // The page edits on top while the taken edit is still saving.
  expect((await page.submit(page.change("place", "Porto"))).result).toBe("success");
  release();
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  page.session.close();
  expect(savedAuthors(f)).toEqual([ana, ben]);

  // Taken edits a stopped relay left are saved when it starts, with nobody connected.
  const later = rooms(f);
  const b = editor(f, later, ben);
  await b.open();
  expect((await b.submit(b.change("note", "x"))).result).toBe("success");
  later.close();
  rooms(f);
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(savedAuthors(f)).toEqual([ana, ben, ben]);
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

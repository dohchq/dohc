import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import {
  changeMadeBy,
  openPerson,
  random,
  randomChange,
  seededNote,
  storedReading,
} from "../../../packages/ydoc-projection/src/bodySequenceChecksTestSupport.js";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { createLiveRooms } from "./liveRoom.js";
import type { NamedFrameRoomHost } from "./namedLiveFrameHost.js";
import type { NamedFrameHostSession, NamedFrameSync } from "./namedLiveFrameSession.js";
import type { StorageContext } from "./storage/context.js";
import { liveRoomPauseCopy, liveRoomPaused, liveRoomPauses } from "./storage/liveRoomPauses.js";
import type { LiveRoomAuthority } from "./storage/types.js";

type Fixture = ReturnType<typeof registered>;
const open: Fixture[] = [];
const rooms: { close(): Promise<void> }[] = [];
beforeAll(() => admitBodySequenceNotes(true));
afterAll(() => admitBodySequenceNotes(false));
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((room) => room.close()));
  for (const fixture of open.splice(0)) fixture.close();
  cleanupLiveDeliveryFixtures();
});

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hostEpoch = parseHostEpoch(1);
const owner: LiveRoomAuthority = {
  principalKind: "owner",
  principalId: "owner",
  grantId: null,
  grantGeneration: null,
};
const rowBytes = (row: Record<string, unknown>) => new Uint8Array(row.update_bytes as Uint8Array);

/** The owner's capture of the note, which saves through the real journal and its real check. */
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
    async openSync(_vector, opening): Promise<NamedFrameSync> {
      return {
        binding: binding.binding,
        hostVector: Y.encodeStateVector(f.doc),
        missingStateUpdate: Y.mergeUpdates([
          Y.encodeStateAsUpdate(f.doc),
          ...f.journalRows().journal.map(rowBytes),
        ]),
        appliedThroughJournalCursor: 0,
        close() {},
        nextApplied: (signal) =>
          new Promise((_, reject) => {
            const both = AbortSignal.any([opening, signal]);
            both.addEventListener("abort", () => reject(both.reason), { once: true });
          }),
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

function join(f: Fixture, room: ReturnType<typeof createLiveRooms>, sender: LiveAuthorSnapshot) {
  const lifetime = new AbortController();
  const binding = f.storage.resolveCurrentLiveDocumentBinding({
    document: f.input.evidence.document,
    actor: f.actor,
  });
  if (binding.kind !== "current") throw new Error("Binding is not current.");
  return room.join({
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
      authority: () => owner,
    },
  } as unknown as NamedFrameRoomHost);
}

/** A format-2 note registered on the relay, and a room for it that saves when its people leave. */
function noteInARoom(options: { pauseAfterMs?: number } = {}) {
  const baseline = seededNote();
  const f = registered({ deployment: true, baselineBytes: baseline });
  open.push(f);
  const room = createLiveRooms({
    storage: f.storage,
    maxUpdateBytes: 1 << 20,
    maxNoteBytes: 1 << 22,
    maxAppliedBytes: 1 << 20,
    saveEveryMs: 3_600_000,
    ...options,
    log() {},
    openSaver: async () => ownerCapture(f),
  });
  rooms.push(room);
  return { baseline, f, room };
}
const signal = new AbortController().signal;
const submitted = (session: NamedFrameHostSession, bytes: Uint8Array) =>
  session.submit(
    { deliveryId: randomUUID(), updateDigest: hash(bytes), updateBytes: bytes },
    signal,
  );
const paused = (f: Fixture) =>
  liveRoomPaused(f.storage as StorageContext, f.input.evidence.document);

it("a room takes what three people do to a format-2 note, and every save passes the journal's check", async () => {
  const { baseline, f, room } = noteInARoom();
  const people = ["Ana", "Ben", "Olu"].map((name, index) => ({
    person: openPerson(baseline, 10 * (index + 1)),
    session: join(f, room, [{ kind: "human", humanId: name.toLowerCase(), humanName: name }]),
  }));
  for (const { person, session } of people)
    await session.openSync(Y.encodeStateVector(person.doc), signal);
  const next = random(5);
  let taken = 0;
  for (let round = 0; round < 4; round++) {
    for (const { person } of people)
      for (let changes = 0; changes < 2; changes++) randomChange(person, next);
    for (;;) {
      const from = people.find(({ person }) => person.waiting.length > 0);
      if (!from) break;
      const change = from.person.waiting.shift()!;
      expect(await submitted(from.session, change.bytes), change.kind).toMatchObject({
        result: "success",
      });
      taken++;
      for (const other of people) if (other !== from) other.person.receive(change.bytes);
    }
  }
  expect(taken).toBeGreaterThan(20);
  for (const { session } of people) session.close();
  await room.close();
  expect(paused(f)).toBe(false);
  const saves = f.journalRows().journal.map(rowBytes);
  expect(saves.length).toBeGreaterThan(0);
  const saved = new Y.Doc({ gc: false });
  for (const bytes of [baseline, ...saves]) Y.applyUpdate(saved, bytes);
  for (const { person } of people) expect(storedReading(person.doc)).toEqual(storedReading(saved));
  saved.destroy();
});

it("saves two changes of 90,000 values each as one batch, and the note is not paused", async () => {
  const { baseline, f, room } = noteInARoom();
  const session = join(f, room, [{ kind: "human", humanId: "ana", humanName: "Ana" }]);
  await session.openSync(Y.encodeStateVector(new Y.Doc()), signal);
  let note = baseline;
  for (const key of ["X.title", "Y.title"]) {
    const change = changeMadeBy(note, 77, ({ records }) =>
      records.set(
        key,
        Array.from({ length: 90_000 }, () => null),
      ),
    )!;
    expect(await submitted(session, change)).toMatchObject({ result: "success" });
    note = Y.mergeUpdates([note, change]);
  }
  session.close();
  await room.close();
  expect(paused(f)).toBe(false);
  const saves = f.journalRows().journal.map(rowBytes);
  expect(saves).toHaveLength(1);
  const saved = new Y.Doc({ gc: false });
  for (const bytes of [baseline, ...saves]) Y.applyUpdate(saved, bytes);
  for (const key of ["X.title", "Y.title"])
    expect(saved.getMap("containers").get(key)).toHaveLength(90_000);
  saved.destroy();
});

it("a room refuses one change of 400,000 values at once, keeps taking others, and saves without a pause", async () => {
  const { baseline, f, room } = noteInARoom();
  const session = join(f, room, [{ kind: "human", humanId: "ana", humanName: "Ana" }]);
  await session.openSync(Y.encodeStateVector(new Y.Doc()), signal);
  const large = changeMadeBy(baseline, 77, ({ records }) =>
    records.set(
      "X.title",
      Array.from({ length: 400_000 }, () => null),
    ),
  )!;
  expect(large.length).toBeLessThan(1 << 20);
  expect(await submitted(session, large)).toEqual({ result: "refused", reason: "invalid-update" });
  const typed = changeMadeBy(baseline, 78, ({ sequence }) => sequence.insert(2, "kept"))!;
  expect(await submitted(session, typed)).toMatchObject({ result: "success" });
  session.close();
  await room.close();
  expect(paused(f)).toBe(false);
  const saves = f.journalRows().journal.map(rowBytes);
  expect(saves).toHaveLength(1);
  const saved = new Y.Doc({ gc: false });
  for (const bytes of [baseline, ...saves]) Y.applyUpdate(saved, bytes);
  expect(saved.getMap("containers").has("X.title")).toBe(false);
  saved.destroy();
});

it("with the setting turned off, a room refuses each change to a format-2 note at once and does not pause it; on again, it takes them", async () => {
  const { baseline, f, room } = noteInARoom();
  const session = join(f, room, [{ kind: "human", humanId: "ana", humanName: "Ana" }]);
  await session.openSync(Y.encodeStateVector(new Y.Doc()), signal);
  const changes = [
    changeMadeBy(baseline, 77, ({ sequence }) => sequence.insert(2, "x"))!,
    changeMadeBy(baseline, 78, ({ doc }) => doc.getMap("frontmatter").set("status", "done"))!,
  ];
  admitBodySequenceNotes(false);
  try {
    for (const change of changes)
      expect(await submitted(session, change)).toEqual({
        result: "refused",
        reason: "invalid-update",
      });
  } finally {
    admitBodySequenceNotes(true);
  }
  expect(paused(f)).toBe(false);
  for (const change of changes)
    expect(await submitted(session, change)).toMatchObject({ result: "success" });
  session.close();
  await room.close();
  expect(paused(f)).toBe(false);
  expect(f.journalRows().journal).toHaveLength(1);
});

it("after the setting goes off, a room cannot save the changes it had taken to a format-2 note, and pauses the note with them in its copy", async () => {
  const { baseline, f, room } = noteInARoom({ pauseAfterMs: 0 });
  const session = join(f, room, [{ kind: "human", humanId: "ana", humanName: "Ana" }]);
  await session.openSync(Y.encodeStateVector(new Y.Doc()), signal);
  const typed = changeMadeBy(baseline, 77, ({ sequence }) => sequence.insert(2, "kept"))!;
  expect(await submitted(session, typed)).toMatchObject({ result: "success" });
  admitBodySequenceNotes(false);
  try {
    session.close();
    await vi.waitFor(() => expect(paused(f)).toBe(true));
  } finally {
    admitBodySequenceNotes(true);
  }
  const storage = f.storage as StorageContext;
  const [pause] = liveRoomPauses(storage, "workspace");
  expect(pause).toMatchObject({ cause: "failing", refusal: null });
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, liveRoomPauseCopy(storage, "workspace", pause!.pauseId)!);
  const kept = new Y.Doc({ gc: false });
  Y.applyUpdate(kept, baseline);
  Y.applyUpdate(kept, typed);
  expect(storedReading(copy)).toEqual(storedReading(kept));
  expect(f.journalRows().journal).toHaveLength(0);
  copy.destroy();
  kept.destroy();
});

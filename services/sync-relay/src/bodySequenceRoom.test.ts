import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import {
  openPerson,
  random,
  randomChange,
  seededNote,
  storedReading,
} from "../../../packages/ydoc-projection/src/bodySequenceTestSupport.js";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { createLiveRooms } from "./liveRoom.js";
import type { NamedFrameRoomHost } from "./namedLiveFrameHost.js";
import type { NamedFrameHostSession, NamedFrameSync } from "./namedLiveFrameSession.js";
import type { StorageContext } from "./storage/context.js";
import { liveRoomPaused } from "./storage/liveRoomPauses.js";
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

it("a room takes what three people do to a format-2 note, and every save passes the journal's check", async () => {
  const baseline = seededNote();
  const f = registered({ deployment: true, baselineBytes: baseline });
  open.push(f);
  const room = createLiveRooms({
    storage: f.storage,
    maxUpdateBytes: 1 << 20,
    maxNoteBytes: 1 << 22,
    maxAppliedBytes: 1 << 20,
    saveEveryMs: 3_600_000,
    log() {},
    openSaver: async () => ownerCapture(f),
  });
  rooms.push(room);
  const signal = new AbortController().signal;
  const people = ["Ana", "Ben", "Olu"].map((name, index) => ({
    person: openPerson(baseline, 10 * (index + 1)),
    session: join(f, room, [{ kind: "human", humanId: name.toLowerCase(), humanName: name }]),
  }));
  for (const { person, session } of people)
    await session.openSync(Y.encodeStateVector(person.doc), signal);
  const next = random(5);
  let submitted = 0;
  for (let round = 0; round < 4; round++) {
    for (const { person } of people)
      for (let changes = 0; changes < 2; changes++) randomChange(person, next);
    for (;;) {
      const from = people.find(({ person }) => person.waiting.length > 0);
      if (!from) break;
      const change = from.person.waiting.shift()!;
      const answer = await from.session.submit(
        { deliveryId: randomUUID(), updateDigest: hash(change.bytes), updateBytes: change.bytes },
        signal,
      );
      expect(answer, change.kind).toMatchObject({ result: "success" });
      submitted++;
      for (const other of people) if (other !== from) other.person.receive(change.bytes);
    }
  }
  expect(submitted).toBeGreaterThan(20);
  for (const { session } of people) session.close();
  await room.close();
  expect(liveRoomPaused(f.storage as StorageContext, f.input.evidence.document)).toBe(false);
  const saves = f.journalRows().journal.map(rowBytes);
  expect(saves.length).toBeGreaterThan(0);
  const saved = new Y.Doc({ gc: false });
  for (const bytes of [baseline, ...saves]) Y.applyUpdate(saved, bytes);
  for (const { person } of people) expect(storedReading(person.doc)).toEqual(storedReading(saved));
  saved.destroy();
});

import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import type { LiveUpdateRefusal } from "@dohc/live-session-contract/live-update-admission";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import {
  createLiveRooms,
  LiveRoomBindingEndedError,
  LiveRoomPausedError,
  LiveRoomUnsavedError,
  nextSave,
  roomAdmissible,
} from "./liveRoom.js";
import { createLiveRoomPauseRoutes } from "./liveRoomPauseRoutes.js";
import type { NamedFrameRoomHost } from "./namedLiveFrameHost.js";
import type {
  NamedFrameAppliedUpdate,
  NamedFrameHostSession,
  NamedFrameSync,
} from "./namedLiveFrameSession.js";
import type { StorageContext } from "./storage/context.js";
import { observeRelayWrites } from "./relayWriteChanges.js";
import { appendLiveRoomEdit, liveRoomEdits } from "./storage/liveRoomEdits.js";
import { liveRoomPaused, liveRoomPauses, pauseLiveRoom } from "./storage/liveRoomPauses.js";
import { liveJournalSeedClientId } from "./storage/liveUpdateJournal.js";
import { readRetiredJournalPage } from "./storage/serviceActivationRetirement.js";

const open: Fixture[] = [];
const rooms_: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(rooms_.splice(0).map((room) => room.close()));
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
  /** The engine's next answers, each given instead of committing; then it commits. */
  answers?: (LiveUpdateRefusal | "retry")[];
  /** How many saves reached the engine. */
  saves?: number;
  /** Changes other writers made to the note, which the capture's feed brings in turn. */
  outside?: Uint8Array[];
  /** Ends the capture's current feed, as a capture that closes. */
  endFeed?: () => void;
  /** How many times a capture was opened. */
  opens?: number;
  /** The owner's capture can't be opened, as when the note's hosting ended. */
  unopened?: boolean;
  /** How many times opening one failed. */
  tries?: number;
}

/**
 * The owner's capture of the note, saving through the real journal. As the real one, its feed
 * ends with the signal it was opened with. It stays quiet unless the test gives outside changes.
 */
function ownerCapture(f: Fixture, engine: Engine = {}): NamedFrameHostSession {
  const lifetime = new AbortController();
  const binding = f.storage.resolveCurrentLiveDocumentBinding({
    document: f.input.evidence.document,
    actor: f.actor,
  });
  // As the relay's own saver opens it.
  if (binding.kind !== "current")
    throw binding.reason === "stale-document"
      ? new LiveRoomBindingEndedError()
      : new Error("The owner's binding is not current.");
  return {
    hostEpoch,
    invalidated: lifetime.signal,
    assertCurrent() {},
    close: () => lifetime.abort(),
    async openSync(_vector, opening): Promise<NamedFrameSync> {
      engine.opens = (engine.opens ?? 0) + 1;
      const feed = new AbortController();
      engine.endFeed = () => feed.abort(new Error("Capture closed."));
      const ends = AbortSignal.any([opening, feed.signal]);
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
        async nextApplied(signal) {
          const both = AbortSignal.any([ends, signal]);
          for (;;) {
            both.throwIfAborted();
            const next = engine.outside?.shift();
            if (next) return { value: { journalCursor: 0, updateBytes: next }, release() {} };
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                both.removeEventListener("abort", done);
                resolve();
              };
              const timer = engine.outside ? setTimeout(done, 5) : undefined;
              both.addEventListener("abort", done);
            });
          }
        },
      };
    },
    async submit(input, signal) {
      await engine.hold;
      engine.saves = (engine.saves ?? 0) + 1;
      const next = engine.answers?.shift();
      if (next === "retry") return { result: "retry", reason: "host-unavailable" } as never;
      if (next) return { result: "refused", reason: next } as never;
      // As the journal does once the binding a capture holds is gone.
      const now = f.storage.resolveCurrentLiveDocumentBinding({
        document: f.input.evidence.document,
        actor: f.actor,
      });
      if (now.kind !== "current") return { result: "refused", reason: "stale-binding" } as never;
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
    pauseAfterMs?: number;
    maxNoteBytes?: number;
  } = {},
  engine: Engine = {},
) {
  const created = createLiveRooms({
    storage: f.storage,
    maxUpdateBytes: limits.maxUpdateBytes ?? 1 << 20,
    maxNoteBytes: limits.maxNoteBytes ?? 1 << 22,
    maxAppliedBytes: 1 << 20,
    namesEverySender: limits.names ?? false,
    // Tests save by leaving unless they set the timer.
    saveEveryMs: limits.saveEveryMs ?? 3_600_000,
    ...(limits.saveTimeoutMs ? { saveTimeoutMs: limits.saveTimeoutMs } : {}),
    ...(limits.pauseAfterMs === undefined ? {} : { pauseAfterMs: limits.pauseAfterMs }),
    log() {},
    openSaver: async () => {
      if (!engine.unopened) return ownerCapture(f, engine);
      engine.tries = (engine.tries ?? 0) + 1;
      throw new Error("The owner's binding is not current.");
    },
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
    /** Ends this editor's access as a write that changes it does: its capture closes at once. */
    end() {
      access.ended = true;
      lifetime.abort(new Error("Access ended."));
    },
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

/**
 * The owner's computer. Its own capture's feed brings every journal row as it is committed, and
 * counts the leases it hands out and those released.
 */
function ownerDesktop(
  f: Fixture,
  room: ReturnType<typeof rooms>,
  leases = { out: 0, released: 0 },
) {
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
              leases.out += 1;
              return {
                value: { journalCursor: fed, updateBytes: rowBytes(row) },
                release: () => void (leases.released += 1),
              };
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

const liveRoomCopy = (f: Fixture, pauseId: string) =>
  new Uint8Array(
    (f.storage as StorageContext).db
      .prepare("SELECT copy_bytes FROM sync_relay_live_room_pauses WHERE pause_id=?")
      .get(pauseId)!.copy_bytes as Uint8Array,
  );
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

// Proves: each save's last room row outlives the room, so an owner who catches up on a retired
// note's journal once its room is gone still lets go of the room rows each save holds.
it("keeps each save's last row with its journal row, for a retired note's journal pages", async () => {
  const f = note();
  const room = rooms(f, { saveEveryMs: 20 });
  const owner = ownerDesktop(f, room),
    a = editor(f, room, ana);
  await owner.open();
  await a.open();
  const first = position(await a.submit(a.change("title", "Lisbon")));
  await owner.next();
  const own = position(await owner.submit(owner.change("place", "Porto")));
  const saved = [await owner.next(), await owner.next()];
  const storage = f.storage as StorageContext,
    document = f.input.evidence.document;
  const page = (input: { restoreFenceGeneration?: number; after?: number; budgetBytes?: number }) =>
    readRetiredJournalPage(storage, {
      workspaceId: document.workspaceId,
      objectId: document.objectId,
      lineageClaimId: document.lineageClaimId,
      restoreFenceGeneration: 0,
      after: 0,
      budgetBytes: 1 << 20,
      ...input,
    });
  expect(page({})).toBeNull();
  // The note's activation retired at F, the last of its journal rows.
  const journal = storage.db
    .prepare("SELECT journal_cursor FROM sync_relay_live_update_journal ORDER BY journal_cursor")
    .all()
    .map((row) => Number(row.journal_cursor));
  const acceptedCursor = journal.at(-1)!;
  expect(acceptedCursor).toBe(saved[1]!.journalCursor);
  storage.db
    .prepare(`INSERT INTO sync_relay_service_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,
      object_id,lineage_claim_id,source_json,binding_json,state_digest,owner_user_id,completion_json,accounted_bytes,
      retire_requested_at_ms,retire_restore_generation,retire_accepted_cursor,retired_at_ms,retired_boundary_json)
      VALUES ('namespace','activation','workspace','main',?,?,'{}','{}',?,'owner','{}',1,1,0,?,2,'{}')`)
    .run(document.objectId, document.lineageClaimId, "a".repeat(64), acceptedCursor);
  const all = page({})!;
  expect(all.acceptedCursor).toBe(acceptedCursor);
  expect(all.nextAfter).toBeNull();
  expect(all.rows.map((row) => row.journalCursor)).toEqual(journal);
  expect(all.rows.filter((row) => row.rowsThrough !== undefined)).toEqual(
    saved.map((frame, index) => ({
      journalCursor: frame.journalCursor,
      rowsThrough: [first, own][index],
      updateBytes: expect.any(Uint8Array),
    })),
  );
  // A small budget still takes one row a page, and the last page ends at F.
  const pages = [page({ budgetBytes: 1 })!];
  while (pages.at(-1)!.nextAfter !== null)
    pages.push(page({ budgetBytes: 1, after: pages.at(-1)!.nextAfter! })!);
  expect(pages.map((next) => next.rows.map((row) => row.journalCursor))).toEqual(
    journal.map((cursor) => [cursor]),
  );
  expect(page({ restoreFenceGeneration: 1 })).toBeNull();
});

// Proves: a save whose transaction rolls back after the room was told of it leaves the room's edits
// unsaved, so the room saves them again.
it("saves an edit again when its save's transaction rolls back", async () => {
  const f = note();
  const room = rooms(f, { saveEveryMs: 20 });
  const a = editor(f, room, ana);
  await a.open();
  // The first journal commit fails after its last write, as a failed continuity marker update
  // does: the transaction rolls back and storage stays open.
  const storage = f.storage as StorageContext;
  const tx = storage.tx.bind(storage);
  let failures = 1;
  storage.tx = <T>(run: () => T) =>
    tx(() => {
      const result = run();
      if (failures && typeof result === "object" && result !== null && "reply" in result) {
        failures -= 1;
        throw new Error("The write failed.");
      }
      return result;
    });
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await vi.waitFor(() => expect(savedAuthors(f)).toEqual([ana]));
  expect(failures).toBe(0);
  expect(unsaved(f)).toEqual([]);
});

// Proves: a save that committed is not saved again when a read the storage makes after its
// commit fails.
it("saves an edit once when a read after its save's commit fails", async () => {
  const f = note();
  const room = rooms(f, { saveEveryMs: 20 });
  const a = editor(f, room, ana);
  await a.open();
  // A host listening for writes makes each one read the database's revision before and after.
  // The first such write is the save's, and its read after the commit fails.
  const stop = observeRelayWrites(f.storage, () => {});
  const storage = f.storage as StorageContext;
  const prepare = storage.db.prepare.bind(storage.db);
  let reads = 0;
  storage.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT total_changes()")) return statement;
    return {
      get: () => {
        reads += 1;
        if (reads === 2) throw new Error("The read failed.");
        return statement.get();
      },
    };
  }) as typeof storage.db.prepare;
  try {
    expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
    await vi.waitFor(() => expect(savedAuthors(f)).toEqual([ana]));
    // Saving what the room holds would save the edit again if the room still counted it unsaved.
    await room.saveFirst(f.input.evidence.document, () => {}, AbortSignal.timeout(5_000));
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(savedAuthors(f)).toEqual([ana]);
    expect(unsaved(f)).toEqual([]);
  } finally {
    storage.db.prepare = prepare;
    stop();
  }
});

// Proves: a lease the owner's feed read and holds for the owner's next read is released when the
// owner closes, as each holds reserved output bytes.
it("releases the owner's held feed lease when the owner closes", async () => {
  const f = note();
  const room = rooms(f, { saveEveryMs: 20 });
  const leases = { out: 0, released: 0 };
  const owner = ownerDesktop(f, room, leases),
    a = editor(f, room, ana);
  const sync = await owner.open();
  await a.open();
  // The owner waits on its feed, and Ana's edit reaches it first as a room row.
  const next = owner.next();
  const first = position(await a.submit(a.change("title", "Lisbon")));
  expect(await next).toEqual({ journalCursor: first, roomRow: true });
  // The save's row then comes on the feed, and waits for a read the owner never makes.
  await vi.waitFor(() => expect(leases.out).toBe(1));
  sync.close();
  expect(leases.released).toBe(1);
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

it("keeps bringing a page other writers' changes past the capture's opening time and after it closes", async () => {
  const f = note();
  const outside: Uint8Array[] = [];
  const engine: Engine = { outside };
  const room = rooms(f, { saveTimeoutMs: 20, saveEveryMs: 10 }, engine);
  const reader = editor(f, room, ana);
  await reader.open();
  const elsewhere = (key: string) => {
    const other = new Y.Doc();
    other.getMap("frontmatter").set(key, "owner");
    return Y.encodeStateAsUpdate(other);
  };
  const has = (key: string) => reader.doc.getMap("frontmatter").has(key);

  // Well past the time the capture had to open.
  await new Promise((resolve) => setTimeout(resolve, 100));
  outside.push(elsewhere("first"));
  await reader.next();
  expect(has("first")).toBe(true);
  expect(engine.opens).toBe(1);

  // The capture closes while nobody has an edit waiting; the room opens another.
  engine.endFeed!();
  outside.push(elsewhere("second"));
  await reader.next();
  expect(has("second")).toBe(true);
  expect(engine.opens).toBe(2);
});

const pauses = (f: Fixture) => liveRoomPauses(f.storage as StorageContext, "workspace");
const usage = (f: Fixture) =>
  Number(
    (f.storage as StorageContext).db
      .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?")
      .get("workspace")?.usage_bytes ?? 0,
  );

it("pauses a note whose save is refused for good: its copy holds every taken edit, its rows go, and every session ends", async () => {
  const f = note();
  const room = rooms(f, { names: true, saveEveryMs: 10 }, { answers: ["invalid-update"] });
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await b.next();
  expect((await b.submit(b.change("place", "Porto"))).result).toBe("success");
  await vi.waitFor(() => expect(pauses(f)).toHaveLength(1));
  const [paused] = pauses(f);
  expect(paused).toMatchObject({ cause: "refused", refusal: "invalid-update", named: [ana, ben] });
  expect(unsaved(f)).toEqual([]);
  expect(f.journalRows().journal).toEqual([]);
  // The copy is the room's whole note as it was, with both edits.
  const copy = new Y.Doc();
  Y.applyUpdate(copy, liveRoomCopy(f, paused!.pauseId));
  expect(copy.getMap("frontmatter").toJSON()).toMatchObject({ title: "Lisbon", place: "Porto" });
  await expect(b.next()).rejects.toThrow(LiveRoomPausedError);
  await expect(a.submit(a.change("note", "late"))).rejects.toThrow();
  await expect(editor(f, room, olu).open()).rejects.toThrow(LiveRoomPausedError);
  expect(liveRoomPaused(f.storage as StorageContext, f.input.evidence.document)).toBe(true);
});

it("still gives a paused note's owner every save made before the pause, and takes none of its edits", async () => {
  const f = note();
  const engine: Engine = {};
  const room = rooms(f, { saveEveryMs: 5 }, engine);
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  const saved = Number(f.journalRows().journal.at(-1)!.journal_cursor);
  engine.answers = ["invalid-update"];
  expect((await a.submit(a.change("place", "Porto"))).result).toBe("success");
  await vi.waitFor(() => expect(pauses(f)).toHaveLength(1));
  expect(pauses(f)[0]!.savedCursor).toBe(saved);

  // An owner who missed the last save while away gets it, and not the edit that never saved.
  const owner = ownerDesktop(f, room);
  const sync = await owner.open();
  expect(sync.appliedThroughJournalCursor).toBe(saved);
  expect(owner.doc.getMap("frontmatter").get("title")).toBe("Lisbon");
  expect(owner.doc.getMap("frontmatter").get("place")).toBeUndefined();
  expect(await owner.submit(owner.change("note", "mine"))).toEqual({
    result: "retry",
    reason: "admission-unavailable",
  });
  expect(unsaved(f)).toEqual([]);
});

it("tries a busy engine again without pausing, and pauses once saves have failed for the whole window", async () => {
  const f = note();
  const busy: Engine = { answers: Array<"retry">(100).fill("retry") };
  const room = rooms(f, { saveEveryMs: 5, pauseAfterMs: 3_600_000 }, busy);
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await vi.waitFor(() => expect(busy.saves).toBeGreaterThanOrEqual(3));
  expect(pauses(f)).toEqual([]);
  expect(unsaved(f)).toHaveLength(1);

  const g = note();
  const failing = rooms(
    g,
    { saveEveryMs: 5, pauseAfterMs: 40 },
    { answers: Array<"retry">(100).fill("retry") },
  );
  const c = editor(g, failing, ana);
  await c.open();
  expect((await c.submit(c.change("title", "Porto"))).result).toBe("success");
  await vi.waitFor(() => expect(pauses(g)).toHaveLength(1));
  expect(pauses(g)[0]).toMatchObject({ cause: "failing", refusal: null, named: [ana] });
  expect(unsaved(g)).toEqual([]);
});

it("tries a failed save again at once, then waits between later tries", async () => {
  const once: Engine = { answers: ["retry"] };
  const f = note();
  const a = editor(f, rooms(f, { saveEveryMs: 60_000 }, once), ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  a.session.close();
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(once.saves).toBe(2);

  const twice: Engine = { answers: ["retry", "retry"] };
  const g = note();
  const b = editor(g, rooms(g, { saveEveryMs: 60_000 }, twice), ana);
  await b.open();
  expect((await b.submit(b.change("title", "Porto"))).result).toBe("success");
  b.session.close();
  await vi.waitFor(() => expect(twice.saves).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(twice.saves).toBe(2);
  expect(unsaved(g)).toHaveLength(1);
});

it("saves through a new capture when the old one went stale, without pausing", async () => {
  const f = note();
  const engine: Engine = { answers: ["stale-binding"] };
  const room = rooms(f, { saveEveryMs: 5 }, engine);
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(engine.saves).toBe(2);
  expect(pauses(f)).toEqual([]);
  expect(savedAuthors(f)).toEqual([ana]);
});

it("keeps a pause's copy until the owner's desktop records it written, and resumes only then", async () => {
  const f = note();
  const storage = f.storage as StorageContext;
  const before = usage(f);
  const copy = new Uint8Array([1, 2, 3, 4]);
  pauseLiveRoom(storage, {
    document: f.input.evidence.document,
    cause: "refused",
    refusal: "provenance-refused",
    named: [ben],
    copy,
    pausedAtMs: 1,
  });
  expect(usage(f)).toBeGreaterThan(before + copy.byteLength);
  const respond = createLiveRoomPauseRoutes(f.storage);
  const call = (
    method: string,
    pauseId?: string,
    action?: "copy" | "copy-written" | "resume",
    body?: unknown,
    owner = "owner",
  ) =>
    respond(
      new Request("https://relay.invalid/", {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      {
        route: "live-pauses",
        workspaceId: "workspace",
        ...(pauseId ? { pauseId } : {}),
        ...(action ? { action } : {}),
      },
      owner,
    );
  await expect(call("GET", undefined, undefined, undefined, "someone")).rejects.toMatchObject({
    code: "not_found",
  });
  const listed = (await (await call("GET")).json()) as {
    pauses: { pauseId: string; copy: unknown }[];
  };
  const sha256 = hash(copy);
  expect(listed.pauses).toMatchObject([
    { cause: "refused", named: [ben], copy: { sha256, byteLength: 4 } },
  ]);
  const { pauseId } = listed.pauses[0]!;
  expect(new Uint8Array(await (await call("GET", pauseId, "copy")).arrayBuffer())).toEqual(copy);
  await expect(call("POST", pauseId, "resume")).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringContaining("copy"),
  });
  await expect(
    call("POST", pauseId, "copy-written", { sha256: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "conflict" });
  // Ownership that ends while the body is read, as when the owner's account is being deleted,
  // records nothing.
  let owned = true;
  const ending = createLiveRoomPauseRoutes(
    Object.assign(Object.create(f.storage), {
      workspaceIsOwnedBy: (workspaceId: string, userId: string) =>
        owned && f.storage.workspaceIsOwnedBy(workspaceId, userId),
    }),
  );
  const body = new ReadableStream(
    {
      pull(controller) {
        owned = false;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ sha256 })));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  await expect(
    ending(
      new Request("https://relay.invalid/", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
      { route: "live-pauses", workspaceId: "workspace", pauseId, action: "copy-written" },
      "owner",
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(new Uint8Array(await (await call("GET", pauseId, "copy")).arrayBuffer())).toEqual(copy);
  expect((await call("POST", pauseId, "copy-written", { sha256 })).status).toBe(200);
  await expect(call("GET", pauseId, "copy")).rejects.toMatchObject({ code: "not_found" });
  expect(liveRoomPaused(storage, f.input.evidence.document)).toBe(true);
  expect((await call("POST", pauseId, "resume")).status).toBe(200);
  expect(liveRoomPaused(storage, f.input.evidence.document)).toBe(false);
  expect(pauses(f)).toEqual([]);
  expect(usage(f)).toBe(before);
});

it("ends a page that stops reading once it falls a note behind, and goes on for everyone else", async () => {
  const f = note();
  const room = rooms(f, { saveEveryMs: 5, maxNoteBytes: 4_000 });
  const a = editor(f, room, ana),
    b = editor(f, room, ben),
    stalled = editor(f, room, olu);
  await a.open();
  await b.open();
  await stalled.open();
  // One letter at a time, as typing is: each edit is about 30 bytes and adds a few to the note,
  // so the stalled page's queue outgrows the note while the note stays well inside its bound.
  for (let sent = 0; sent < 200; sent++) {
    expect((await a.submit(a.change("title", String(sent % 10)))).result).toBe("success");
    await b.next();
    if (sent % 50 === 49) await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  }
  await expect(stalled.next()).rejects.toThrow("fell too far behind");
  expect((await a.submit(a.change("place", "Porto"))).result).toBe("success");
  await b.next();
  expect(b.doc.getMap("frontmatter").get("place")).toBe("Porto");
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

it("refuses an edit that adds what a note can't hold, before it writes or passes it on", async () => {
  const f = note();
  const room = rooms(f);
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  const before = Y.encodeStateVector(a.doc);
  a.doc.getMap("extra").set("hidden", "x");
  expect(await a.submit(Y.encodeStateAsUpdate(a.doc, before))).toEqual({
    result: "refused",
    reason: "invalid-update",
  });
  expect(unsaved(f)).toEqual([]);
  expect((await b.submit(b.change("title", "Lisbon"))).result).toBe("success");
  expect(unsaved(f)).toHaveLength(1);
});

// Proves: the room checks each edit on its copy of the note, which holds the owner's changes too.
it("checks an edit on the owner's changes the room took", async () => {
  const f = note();
  const outside: Uint8Array[] = [];
  const room = rooms(f, {}, { outside });
  const a = editor(f, room, ana);
  await a.open();
  // The owner adds a list of days; the page gets it.
  const owner = new Y.Doc();
  Y.applyUpdate(owner, Y.encodeStateAsUpdate(a.doc));
  const start = Y.encodeStateVector(owner);
  owner.getMap("frontmatter").set("days", new Y.Map());
  outside.push(Y.encodeStateAsUpdate(owner, start));
  await a.next();
  const days = a.doc.getMap("frontmatter").get("days") as Y.Map<unknown>;
  const edit = (change: () => void) => {
    const before = Y.encodeStateVector(a.doc);
    change();
    return Y.encodeStateAsUpdate(a.doc, before);
  };
  expect((await a.submit(edit(() => days.set("one", "Lisbon")))).result).toBe("success");
  expect(await a.submit(edit(() => days.set("two", new Y.XmlHook("h") as never)))).toEqual({
    result: "refused",
    reason: "invalid-update",
  });
  expect(unsaved(f)).toHaveLength(1);
});

it("saves every taken edit before a step that closes the note, taking none until the step ends, then ends the room", async () => {
  const f = note();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const room = rooms(f, {}, { hold });
  const a = editor(f, room, ana),
    b = editor(f, room, ben);
  await a.open();
  await b.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await b.next();
  let finish!: () => void;
  const stepEnds = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let found: unknown;
  const done = room.saveFirst(
    f.input.evidence.document,
    async () => {
      found = { unsaved: unsaved(f).length, saved: savedAuthors(f) };
      await stepEnds;
      return "stopped";
    },
    new AbortController().signal,
  );
  const waits = { result: "retry", reason: "admission-unavailable" };
  // While the room saves, a new edit waits on its page.
  expect(await b.submit(b.change("place", "Porto"))).toEqual(waits);
  release();
  await vi.waitFor(() => expect(found).toEqual({ unsaved: 0, saved: [ana] }));
  // And while a step that waits runs, as the owner's Stop waits for the engine.
  expect(await b.submit(b.change("note", "late"))).toEqual(waits);
  finish();
  expect(await done).toBe("stopped");
  await expect(a.next()).rejects.toThrow();
});

it("keeps the room open after one person's access ends while the note is still hosted", async () => {
  const f = note();
  const room = rooms(f);
  const a = editor(f, room, ana),
    b = editor(f, room, ben),
    c = editor(f, room, olu);
  await a.open();
  await b.open();
  await c.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await b.next();
  await c.next();
  const signal = new AbortController().signal;
  const whileHosted = { whileHosted: true };
  const endAna = () => {
    a.end();
    return "ended";
  };
  expect(await room.saveFirst(f.input.evidence.document, endAna, signal, whileHosted)).toBe(
    "ended",
  );
  expect(savedAuthors(f)).toEqual([ana]);
  // Ana is cut off: her edits are refused and she is handed nothing more.
  const late = await a.submit(a.change("note", "late")).then(
    (taken) => taken.result,
    () => "refused",
  );
  expect(late).toBe("refused");
  await expect(a.next()).rejects.toThrow("Access ended.");
  // The others stay connected and keep editing together.
  expect((await b.submit(b.change("place", "Porto"))).result).toBe("success");
  await c.next();
  expect(c.doc.getMap("frontmatter").toJSON()).toEqual({ title: "Lisbon", place: "Porto" });
  // Once the note's hosting ends with the access, the room ends.
  vi.spyOn(f.storage, "serviceHostDocumentEnabled").mockReturnValue(false);
  expect(await room.saveFirst(f.input.evidence.document, () => "ended", signal, whileHosted)).toBe(
    "ended",
  );
  await expect(c.next()).rejects.toThrow();
});

it("runs a step at once when the note's taken edits are on a lineage that ended", async () => {
  const f = note();
  const room = rooms(f, {}, { answers: Array<"retry">(100).fill("retry") });
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  const signal = new AbortController().signal;
  await expect(room.saveFirst(f.input.evidence.document, () => "ran", signal)).rejects.toThrow(
    LiveRoomUnsavedError,
  );
  (f.storage as StorageContext).db
    .prepare(
      "UPDATE sync_relay_live_documents SET lineage_state='retired', admission_state='closed', retired_at_ms=1 WHERE object_id=?",
    )
    .run(f.input.evidence.document.objectId);
  expect(await room.saveFirst(f.input.evidence.document, () => "ran", signal)).toBe("ran");
});

it("runs no step while a room's edits can't be saved, and runs it once a refused save pauses the note", async () => {
  const f = note();
  const room = rooms(f, {}, { answers: ["retry", "retry"] });
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  let ran = 0;
  const step = () => (ran += 1);
  const signal = new AbortController().signal;
  await expect(room.saveFirst(f.input.evidence.document, step, signal)).rejects.toThrow(
    LiveRoomUnsavedError,
  );
  expect(ran).toBe(0);
  expect(unsaved(f)).toHaveLength(1);
  expect((await a.submit(a.change("place", "Porto"))).result).toBe("success");

  const g = note();
  const refusing = rooms(g, {}, { answers: ["invalid-update"] });
  const b = editor(g, refusing, ben);
  await b.open();
  expect((await b.submit(b.change("title", "Lisbon"))).result).toBe("success");
  await refusing.saveFirst(g.input.evidence.document, step, signal);
  expect(ran).toBe(1);
  expect(pauses(g)).toMatchObject([{ cause: "refused", named: [ben] }]);
  // A paused note holds no taken edits, so the step runs at once.
  await refusing.saveFirst(g.input.evidence.document, step, signal);
  expect(ran).toBe(2);
});

it("saves what each room holds when the relay shuts down", async () => {
  const f = note();
  const room = rooms(f);
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await room.close();
  expect(unsaved(f)).toEqual([]);
  expect(savedAuthors(f)).toEqual([ana]);
  await expect(a.submit(a.change("place", "Porto"))).rejects.toThrow();
});

it("pauses a note whose leftover edit no longer applies, keeping every leftover edit in the copy", async () => {
  const f = note();
  const storage = f.storage as StorageContext;
  const document = f.input.evidence.document;
  const step = (page: Y.Doc, key: string) => {
    const before = Y.encodeStateVector(page);
    page.getMap("frontmatter").set(key, key);
    return Y.encodeStateAsUpdate(page, before);
  };
  const benPage = new Y.Doc(),
    anaPage = new Y.Doc();
  // Ana's edit builds on one of hers the note never got.
  const first = step(anaPage, "title");
  const rows = [
    { sender: ben, page: benPage, bytes: step(benPage, "note") },
    { sender: ana, page: anaPage, bytes: step(anaPage, "place") },
  ];
  for (const row of rows)
    expect(
      appendLiveRoomEdit(storage, {
        document,
        sender: row.sender,
        clients: [{ clientId: row.page.clientID, inNote: false }],
        updateBytes: row.bytes,
        receivedAtMs: 1,
      }).kind,
    ).toBe("written");
  const room = rooms(f);
  await expect(editor(f, room, olu).open()).rejects.toThrow(LiveRoomPausedError);
  expect(unsaved(f)).toEqual([]);
  expect(f.journalRows().journal).toEqual([]);
  const [paused] = pauses(f);
  expect(paused).toMatchObject({ cause: "refused", refusal: "invalid-update", named: [ben, ana] });
  const copy = new Y.Doc();
  Y.applyUpdate(copy, liveRoomCopy(f, paused!.pauseId));
  Y.applyUpdate(copy, first);
  expect(copy.getMap("frontmatter").toJSON()).toEqual({
    title: "title",
    place: "place",
    note: "note",
  });
});

it("saves edits a stopped relay took before it takes a new one", async () => {
  const f = note();
  const first = rooms(f, {}, { answers: ["retry", "retry"] });
  const a = editor(f, first, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await first.close();
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
  const first = rooms(f, {}, { answers: ["retry", "retry"] });
  const a = editor(f, first, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await first.close();

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
  const later = rooms(f, {}, { answers: ["retry", "retry"] });
  const b = editor(f, later, ben);
  await b.open();
  expect((await b.submit(b.change("note", "x"))).result).toBe("success");
  await later.close();
  rooms(f);
  await vi.waitFor(() => expect(unsaved(f)).toEqual([]));
  expect(savedAuthors(f)).toEqual([ana, ben, ben]);
});

it("tells a page that joins after a save that the note it gets holds that save", async () => {
  const f = note();
  const room = rooms(f, { saveEveryMs: 10 });
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await vi.waitFor(() => expect(f.journalRows().journal).toHaveLength(1));
  // A page that read the note as saved first would otherwise stop as given an older cut.
  const late = await editor(f, room, ben).open();
  expect(late.appliedThroughJournalCursor).toBe(Number(f.journalRows().journal[0]!.journal_cursor));
});

it("puts a stopped relay's leftover edits in a copy once their note has failed to open for long enough", async () => {
  const f = note();
  const saved = rooms(f);
  const a = editor(f, saved, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  await saved.close();
  // The edit left builds on the saved one, so the copy needs the note as saved under it.
  const first = rooms(f, {}, { answers: ["retry", "retry"] });
  const b = editor(f, first, ben);
  await b.open();
  expect((await b.submit(b.change("title", "Porto"))).result).toBe("success");
  await first.close();
  expect(unsaved(f)).toHaveLength(1);

  // The note's capture can't open. One failure leaves the edits where they are.
  const waiting: Engine = { unopened: true };
  rooms(f, {}, waiting);
  await vi.waitFor(() => expect(waiting.tries).toBe(1));
  expect(pauses(f)).toEqual([]);
  expect(unsaved(f)).toHaveLength(1);

  // Once it has failed for as long as saves may, they go into the copy.
  rooms(f, { pauseAfterMs: 0 }, { unopened: true });
  await vi.waitFor(() => expect(pauses(f)).toHaveLength(1));
  expect(unsaved(f)).toEqual([]);
  const [paused] = pauses(f);
  expect(paused).toMatchObject({ cause: "failing", refusal: null, named: [ben] });
  const copy = new Y.Doc();
  Y.applyUpdate(copy, liveRoomCopy(f, paused!.pauseId));
  expect(copy.getMap("frontmatter").get("title")).toBe("Porto");
});

it("pauses at once when the owner moves or deletes the note's file, with every unsaved edit in the copy", async () => {
  // The note's file moves while Ana's edit waits to be saved.
  const f = note();
  const a = editor(f, rooms(f), ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  f.moment(f.input, 1_000, { path: "docs/moved.md" });
  a.session.close();
  await vi.waitFor(() => expect(pauses(f)).toHaveLength(1));
  const [moved] = pauses(f);
  expect(moved).toMatchObject({ cause: "refused", refusal: "stale-binding", named: [ana] });
  expect(unsaved(f)).toEqual([]);
  const copy = new Y.Doc();
  Y.applyUpdate(copy, liveRoomCopy(f, moved!.pauseId));
  expect(copy.getMap("frontmatter").get("title")).toBe("Lisbon");

  // The file is deleted while a stopped relay holds Ben's edit.
  const g = note();
  const first = rooms(g, {}, { answers: ["retry", "retry"] });
  const b = editor(g, first, ben);
  await b.open();
  expect((await b.submit(b.change("title", "Porto"))).result).toBe("success");
  await first.close();
  g.moment(g.input, 1_000, {
    path: null,
    content_kind: null,
    blob_sha256: null,
    byte_length: null,
  });
  rooms(g);
  await vi.waitFor(() => expect(pauses(g)).toHaveLength(1));
  expect(pauses(g)[0]).toMatchObject({ cause: "refused", refusal: "stale-binding", named: [ben] });
  expect(unsaved(g)).toEqual([]);
});

it("saves a note's taken edits before a step, and lets editors in, while a lineage it ended is paused", async () => {
  const f = note();
  const document = f.input.evidence.document;
  const room = rooms(f);
  const a = editor(f, room, ana);
  await a.open();
  expect((await a.submit(a.change("title", "Lisbon"))).result).toBe("success");
  pauseLiveRoom(f.storage as StorageContext, {
    document: { ...document, lineageClaimId: "ended-lineage" },
    cause: "failing",
    refusal: null,
    named: [],
    copy: Y.encodeStateAsUpdate(new Y.Doc()),
    pausedAtMs: 1,
  });
  // That pause holds back only its own lineage.
  const storage = f.storage as StorageContext;
  expect(liveRoomPaused(storage, { ...document, lineageClaimId: "ended-lineage" })).toBe(true);
  expect(liveRoomPaused(storage, document)).toBe(false);
  expect(
    liveRoomPaused(storage, { workspaceId: document.workspaceId, objectId: document.objectId }),
  ).toBe(false);
  const left = await room.saveFirst(
    document,
    () => unsaved(f).length,
    new AbortController().signal,
  );
  expect(left).toBe(0);
  expect(savedAuthors(f)).toEqual([ana]);
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

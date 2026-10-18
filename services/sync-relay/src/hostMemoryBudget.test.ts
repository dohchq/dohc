import {describe, expect, it} from "vitest";
import {createHostMemoryBudget, HOST_MEMORY_DEFAULTS, readHostMemoryBudgetSetting, resolveHostMemoryBudget, type HostMemoryCoefficients} from "./hostMemoryBudget";
import {startHostMemoryMeasurement} from "./hostMemoryMeasurement";

const MiB = 1024 * 1024;
const FULL = {ok: false, reason: "host-memory-full"};
const workspace = (workspaceId = "w1") => ({workspaceId, replicationEpoch: "e1", streamIdentity: "s1"});
const document = (objectId = "o1", workspaceId = "w1") => ({...workspace(workspaceId), objectId});
// Whole-MiB charges keep the arithmetic readable: each document charges 1 MiB per 1024 encoded bytes, and nothing else.
const flat: HostMemoryCoefficients = {workspaceBytes: 0, documentBaseBytes: 0, documentBytesPerEncodedByte: 1024, temporaryMinimumBytes: 0, temporaryBytesPerInputByte: 1};
// 100 MiB effective, 10 MiB baseline, 25 MiB headroom: 65 MiB for ordinary work.
const budget = (coefficients = flat) => createHostMemoryBudget({effectiveBytes: 100 * MiB, baselineBytes: 10 * MiB, coefficients});
const used = (memory: ReturnType<typeof budget>) => {
  const {residentBytes, temporaryBytes} = memory.snapshot();
  return residentBytes + temporaryBytes;
};

describe("admission", () => {
  it("grants a request that exactly fits and refuses one byte more", () => {
    const memory = budget(), engine = memory.startEngine();
    expect(engine.reserveTemporary(65 * MiB + 1)).toEqual(FULL);
    const exact = engine.reserveTemporary(65 * MiB);
    expect(exact.ok).toBe(true);
    expect(engine.reserveTemporary(1)).toEqual(FULL);
    expect(memory.snapshot()).toMatchObject({effectiveBytes: 100 * MiB, baselineBytes: 10 * MiB, headroomBytes: 25 * MiB, temporaryBytes: 65 * MiB});
  });

  it("uses the named starting coefficients by default", () => {
    const memory = createHostMemoryBudget({effectiveBytes: 1024 * MiB, baselineBytes: 0}), engine = memory.startEngine();
    expect(engine.attachWorkspace(workspace())).toEqual({ok: true});
    expect(engine.reserveDocument(document(), 1)).toEqual({ok: true});
    // 8 MiB + 32 bytes rounds up to 9 MiB.
    expect(memory.snapshot()).toMatchObject({residentBytes: (8 + 9) * MiB, workspaces: 1, documents: 1});
    const small = engine.reserveTemporary(1), large = engine.reserveTemporary(MiB);
    expect(small.ok && large.ok).toBe(true);
    expect(memory.snapshot().temporaryBytes).toBe(16 * MiB + 32 * MiB);
    expect(HOST_MEMORY_DEFAULTS.coefficients).toEqual({workspaceBytes: 8 * MiB, documentBaseBytes: 8 * MiB, documentBytesPerEncodedByte: 32,
      temporaryMinimumBytes: 16 * MiB, temporaryBytesPerInputByte: 32});
  });

  it("never overgrants across interleaved callers", () => {
    const memory = budget(), engines = [memory.startEngine(), memory.startEngine(), memory.startEngine()];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const held = engines.map(() => [] as {finished(): void}[]);
    for (let step = 0; step < 2_000; step++) {
      const caller = next() % engines.length;
      if (next() % 3 === 0 && held[caller]!.length) held[caller]!.splice(next() % held[caller]!.length, 1)[0]!.finished();
      else {
        const result = engines[caller]!.reserveTemporary((1 + (next() % 9)) * MiB);
        if (result.ok) held[caller]!.push(result.reservation);
      }
      expect(10 * MiB + used(memory) + 25 * MiB).toBeLessThanOrEqual(100 * MiB);
    }
    for (const reservations of held) for (const reservation of reservations) reservation.finished();
    expect(used(memory)).toBe(0);
  });

  it("refuses validly but rejects malformed sizes", () => {
    const engine = budget().startEngine();
    for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => engine.reserveTemporary(size)).toThrow(RangeError);
    expect(() => engine.reserveDocument(document(), 1)).toThrow("Attach the workspace");
    for (const coefficients of [{...flat, workspaceBytes: 0.5}, {...flat, temporaryMinimumBytes: -1}, {...flat, documentBytesPerEncodedByte: Number.POSITIVE_INFINITY}]) {
      expect(() => budget(coefficients)).toThrow(RangeError);
    }
    expect(() => createHostMemoryBudget({effectiveBytes: 1.5, baselineBytes: 0})).toThrow(RangeError);
    expect(budget({...flat, temporaryBytesPerInputByte: 1.5}).headroomBytes).toBe(25 * MiB);
  });
});

describe("release", () => {
  it("is idempotent, ignores unknown reservations, and never makes a total negative", () => {
    const memory = budget(), engine = memory.startEngine();
    engine.attachWorkspace(workspace());
    engine.reserveDocument(document(), 1024);
    const temporary = engine.reserveTemporary(MiB);
    if (!temporary.ok) throw new Error("refused");
    temporary.reservation.finished(); temporary.reservation.finished();
    engine.confirmUnload(document()); engine.confirmUnload(document());
    engine.confirmUnload(document("unknown")); engine.confirmDetach(workspace("unknown"));
    engine.confirmDetach(workspace()); engine.confirmDetach(workspace());
    engine.exited(); engine.exited();
    expect(memory.snapshot()).toMatchObject({residentBytes: 0, temporaryBytes: 0, workspaces: 0, documents: 0, temporaryReservations: 0});
  });

  it("keeps a charge whose reply was lost until a confirmed release", () => {
    const memory = budget(), engine = memory.startEngine();
    engine.attachWorkspace(workspace());
    expect(engine.reserveDocument(document(), 60 * 1024)).toEqual({ok: true});
    // The load request timed out or its reply never came. Nothing is confirmed, so the charge stays.
    expect(engine.reserveDocument(document("o2"), 10 * 1024)).toEqual(FULL);
    expect(memory.snapshot().residentBytes).toBe(60 * MiB);
    engine.confirmUnload(document());
    expect(engine.reserveDocument(document("o2"), 10 * 1024)).toEqual({ok: true});
  });

  it("releases a workspace's documents with its confirmed detach, and leaves temporary work charged", () => {
    const memory = budget({...flat, workspaceBytes: MiB}), engine = memory.startEngine();
    engine.attachWorkspace(workspace()); engine.attachWorkspace(workspace("w2"));
    engine.reserveDocument(document("o1"), 1024); engine.reserveDocument(document("o2", "w2"), 2048);
    const temporary = engine.reserveTemporary(MiB);
    engine.confirmDetach(workspace());
    expect(memory.snapshot()).toMatchObject({residentBytes: 3 * MiB, temporaryBytes: MiB, workspaces: 1, documents: 1});
    if (temporary.ok) temporary.reservation.finished();
    expect(memory.snapshot().temporaryBytes).toBe(0);
  });

  it("makes room again after a confirmed unload while measured memory stays flat", async () => {
    // Allocators keep freed pages, so measured use does not fall after an unload.
    const measurement = startHostMemoryMeasurement({cgroup: undefined, rss: () => 99 * MiB, now: () => 0, intervalMs: 60_000});
    try {
      await measurement.sampleNow();
      const memory = budget(), engine = memory.startEngine();
      engine.attachWorkspace(workspace());
      expect(engine.reserveDocument(document(), 65 * 1024)).toEqual({ok: true});
      expect(engine.reserveDocument(document("o2"), 1024)).toEqual(FULL);
      engine.confirmUnload(document());
      await measurement.sampleNow();
      expect(measurement.latest()?.sample.relayRssBytes).toBe(99 * MiB);
      expect(engine.reserveDocument(document("o2"), 65 * 1024)).toEqual({ok: true});
    } finally {await measurement.close();}
  });
});

describe("document growth", () => {
  it("rolls back a refused growth and keeps the high-water mark until unload", () => {
    const memory = budget(), engine = memory.startEngine();
    engine.attachWorkspace(workspace());
    expect(engine.reserveDocument(document(), 20 * 1024)).toEqual({ok: true});
    expect(engine.reserveDocument(document(), 66 * 1024)).toEqual(FULL);
    expect(memory.snapshot().residentBytes).toBe(20 * MiB);
    expect(engine.reserveDocument(document(), 40 * 1024)).toEqual({ok: true});
    expect(engine.reserveDocument(document(), 1024)).toEqual({ok: true});
    expect(memory.snapshot()).toMatchObject({residentBytes: 40 * MiB, documents: 1});
    engine.confirmUnload(document());
    expect(memory.snapshot()).toMatchObject({residentBytes: 0, documents: 0});
  });

  it("rounds a document's charge up to whole MiB", () => {
    const memory = budget({...flat, documentBytesPerEncodedByte: 1}), engine = memory.startEngine();
    engine.attachWorkspace(workspace());
    engine.reserveDocument(document(), 1);
    expect(memory.snapshot().residentBytes).toBe(MiB);
  });
});

describe("engine incarnations", () => {
  it("starts a replacement clean, and the old incarnation's exit releases only its own charges", () => {
    const memory = budget(), old = memory.startEngine();
    old.attachWorkspace(workspace());
    old.reserveDocument(document(), 30 * 1024);
    const replacement = memory.startEngine();
    expect(replacement.editorsBarred(document())).toBe(false);
    // The replacement owns nothing yet, so an unload it confirms releases nothing.
    replacement.confirmUnload(document()); replacement.confirmDetach(workspace());
    expect(memory.snapshot().residentBytes).toBe(30 * MiB);
    replacement.attachWorkspace(workspace());
    expect(replacement.reserveDocument(document(), 30 * 1024)).toEqual({ok: true});
    expect(memory.snapshot()).toMatchObject({residentBytes: 60 * MiB, documents: 2});
    old.exited();
    expect(memory.snapshot()).toMatchObject({residentBytes: 30 * MiB, documents: 1, workspaces: 1});
    expect(() => old.attachWorkspace(workspace())).toThrow("exited");
    expect(() => old.borrowDurability()).toThrow("exited");
  });

  it("releases an exited incarnation's temporary charges and ignores their late finish", () => {
    const memory = budget(), engine = memory.startEngine(), other = memory.startEngine();
    const mine = engine.reserveTemporary(10 * MiB), theirs = other.reserveTemporary(10 * MiB);
    engine.exited();
    expect(memory.snapshot().temporaryBytes).toBe(10 * MiB);
    if (mine.ok) mine.reservation.finished();
    expect(memory.snapshot().temporaryBytes).toBe(10 * MiB);
    if (theirs.ok) theirs.reservation.finished();
    expect(memory.snapshot().temporaryBytes).toBe(0);
  });
});

describe("durability lane", () => {
  it("keeps ordinary reservations out of the headroom", () => {
    const memory = budget(), engine = memory.startEngine();
    expect(engine.reserveTemporary(65 * MiB).ok).toBe(true);
    expect(engine.reserveTemporary(1)).toEqual(FULL);
    const borrowed = engine.borrowDurability();
    if (!borrowed.ok) throw new Error("refused");
    expect(borrowed.lease.reserveTemporary(25 * MiB + 1)).toEqual(FULL);
    expect(borrowed.lease.reserveTemporary(25 * MiB).ok).toBe(true);
    expect(memory.snapshot()).toMatchObject({borrowedBytes: 25 * MiB, borrowedReservations: 1, durabilityLaneHeld: true});
  });

  it("lends the headroom to one operation at a time, across engines", () => {
    const memory = budget(), engine = memory.startEngine(), other = memory.startEngine();
    const first = engine.borrowDurability();
    expect(first.ok).toBe(true);
    expect(engine.borrowDurability()).toEqual(FULL);
    expect(other.borrowDurability()).toEqual(FULL);
    if (first.ok) first.lease.end();
    expect(other.borrowDurability().ok).toBe(true);
  });

  it("stays held after a timeout until the borrowed state is released", () => {
    const memory = budget(), engine = memory.startEngine();
    const borrowed = engine.borrowDurability();
    if (!borrowed.ok) throw new Error("refused");
    const {lease} = borrowed;
    lease.attachWorkspace(workspace());
    lease.reserveDocument(document(), 1024);
    const decoding = lease.reserveTemporary(MiB);
    // The operation timed out. Ending it stops new borrowing but frees nothing still charged.
    lease.end();
    expect(() => lease.reserveTemporary(1)).toThrow("ended");
    expect(engine.borrowDurability()).toEqual(FULL);
    if (decoding.ok) decoding.reservation.finished();
    expect(engine.borrowDurability()).toEqual(FULL);
    engine.confirmUnload(document());
    expect(engine.borrowDurability()).toEqual(FULL);
    engine.confirmDetach(workspace());
    expect(memory.snapshot()).toMatchObject({durabilityLaneHeld: false, borrowedBytes: 0});
    expect(engine.borrowDurability().ok).toBe(true);
  });

  it("frees the lane when the borrowing engine exits", () => {
    const memory = budget(), engine = memory.startEngine();
    const borrowed = engine.borrowDurability();
    if (!borrowed.ok) throw new Error("refused");
    borrowed.lease.reserveTemporary(MiB);
    engine.exited();
    expect(memory.snapshot()).toMatchObject({durabilityLaneHeld: false, borrowedBytes: 0, temporaryBytes: 0});
    expect(memory.startEngine().borrowDurability().ok).toBe(true);
  });

  it("transfers borrowed charges to ordinary reservations only when room exists", () => {
    const memory = budget(), engine = memory.startEngine();
    const filler = engine.reserveTemporary(50 * MiB);
    const borrowed = engine.borrowDurability();
    if (!borrowed.ok || !filler.ok) throw new Error("refused");
    borrowed.lease.attachWorkspace(workspace());
    expect(borrowed.lease.reserveDocument(document(), 30 * 1024, {editors: false})).toEqual({ok: true});
    expect(engine.editorsBarred(document())).toBe(true);
    expect(borrowed.lease.transfer()).toBe(false);
    expect(memory.snapshot()).toMatchObject({durabilityLaneHeld: true, borrowedBytes: 30 * MiB});
    filler.reservation.finished();
    expect(borrowed.lease.transfer()).toBe(true);
    expect(memory.snapshot()).toMatchObject({durabilityLaneHeld: false, borrowedBytes: 0, residentBytes: 30 * MiB});
    expect(engine.editorsBarred(document())).toBe(false);
    expect(() => borrowed.lease.reserveTemporary(1)).toThrow("ended");
    // The transferred document is now an ordinary reservation and stays charged until its unload.
    engine.confirmUnload(document());
    expect(memory.snapshot().residentBytes).toBe(0);
  });

  it("records the no-editors flag only on borrowed document charges", () => {
    const memory = budget(), engine = memory.startEngine();
    engine.attachWorkspace(workspace());
    engine.reserveDocument(document("ordinary"), 1024);
    const borrowed = engine.borrowDurability();
    if (!borrowed.ok) throw new Error("refused");
    // Without growth the ordinary charge stays ordinary, so the flag does not apply.
    borrowed.lease.reserveDocument(document("ordinary"), 1024, {editors: false});
    expect(engine.editorsBarred(document("ordinary"))).toBe(false);
    borrowed.lease.reserveDocument(document("settling"), 1024, {editors: false});
    borrowed.lease.reserveDocument(document("open"), 1024);
    expect(engine.editorsBarred(document("settling"))).toBe(true);
    expect(engine.editorsBarred(document("open"))).toBe(false);
    expect(engine.editorsBarred(document("absent"))).toBe(false);
  });
});

describe("snapshot", () => {
  it("counts each kind and holds no identities", () => {
    const memory = budget({...flat, workspaceBytes: MiB}), engine = memory.startEngine();
    engine.attachWorkspace(workspace());
    engine.reserveDocument(document(), 2048);
    engine.reserveTemporary(3 * MiB);
    const snapshot = memory.snapshot();
    expect(snapshot).toEqual({effectiveBytes: 100 * MiB, baselineBytes: 10 * MiB, headroomBytes: 25 * MiB,
      residentBytes: 3 * MiB, temporaryBytes: 3 * MiB, borrowedBytes: 0,
      workspaces: 1, documents: 1, temporaryReservations: 1, borrowedReservations: 0, durabilityLaneHeld: false});
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/w1|o1|e1|s1/u);
  });
});

describe("operator setting", () => {
  it("reads a whole number of MiB of at least 512 as bytes", () => {
    expect(readHostMemoryBudgetSetting(undefined)).toBeUndefined();
    expect(readHostMemoryBudgetSetting("512")).toBe(512 * MiB);
    expect(readHostMemoryBudgetSetting("8192")).toBe(8192 * MiB);
    expect(readHostMemoryBudgetSetting("8589934591")).toBe(8589934591 * MiB);
    expect(Number.isSafeInteger(readHostMemoryBudgetSetting("8589934591"))).toBe(true);
  });

  it("rejects every invalid value", () => {
    for (const value of ["", " ", "0", "-512", "511", "512.0", "1.5", "1e3", " 512", "512 ", "0512", "+512", "abc", "512MiB", "8589934592", "99999999999999999999"]) {
      expect(() => readHostMemoryBudgetSetting(value), value).toThrow("DOHC_RELAY_HOST_MEMORY_BUDGET_MIB must be a whole number of MiB from 512");
    }
  });

  it("uses the setting, the container limit, or the fallback, and clamps the setting to the container limit", () => {
    expect(resolveHostMemoryBudget(2048 * MiB, undefined)).toEqual({bytes: 2048 * MiB, source: "setting"});
    expect(resolveHostMemoryBudget(undefined, 3000 * MiB)).toEqual({bytes: 3000 * MiB, source: "cgroup"});
    expect(resolveHostMemoryBudget(undefined, undefined)).toEqual({bytes: HOST_MEMORY_DEFAULTS.fallbackBudgetBytes, source: "fallback"});
    expect(HOST_MEMORY_DEFAULTS.fallbackBudgetBytes).toBe(1024 * MiB);
    expect(resolveHostMemoryBudget(4096 * MiB, 2048 * MiB)).toEqual({bytes: 2048 * MiB, source: "cgroup"});
    expect(resolveHostMemoryBudget(2048 * MiB, 2048 * MiB)).toEqual({bytes: 2048 * MiB, source: "setting"});
    expect(resolveHostMemoryBudget(1024 * MiB, 2048 * MiB)).toEqual({bytes: 1024 * MiB, source: "setting"});
  });
});

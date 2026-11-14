import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  asRelayWrite,
  loopHeldBetween,
  recordLiveSubmit,
  startRelayMainThreadTiming,
  stopRelayMainThreadTiming,
} from "./relayMainThreadTiming";
import { RelayWriteOwner } from "./storage/writeOwner";
import type { SqliteDb } from "./storage/types";

const folders: string[] = [];
afterEach(() => {
  stopRelayMainThreadTiming();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function store(autocheckpointPages: number) {
  const folder = mkdtempSync(join(tmpdir(), "relay-timing-"));
  folders.push(folder);
  const raw = new DatabaseSync(join(folder, "relay.db"));
  raw.exec(
    `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=${autocheckpointPages};
     CREATE TABLE work(value INTEGER); CREATE TABLE sync_relay_continuity(singleton INTEGER,stamp INTEGER,nonce TEXT,previous_nonce TEXT);
     INSERT INTO sync_relay_continuity VALUES(1,0,'initial',NULL)`,
  );
  const db: SqliteDb = {
    prepare: (sql) => raw.prepare(sql) as unknown as ReturnType<SqliteDb["prepare"]>,
    close: () => raw.close(),
    exec: (sql) => raw.exec(sql),
  };
  const owner = new RelayWriteOwner(db, { confirm() {}, close() {} }, 0, "initial");
  return {
    owner,
    insert: () => owner.write(() => raw.exec("INSERT INTO work VALUES(1)")),
    read: () => owner.write(() => raw.prepare("SELECT count(*) AS count FROM work").get()),
  };
}

type Summary = { writes: Record<string, { count: number; checkpoints: number }> };

function lastMinute(write: (checkpointing: ReturnType<typeof store>) => void): Summary {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  startRelayMainThreadTiming();
  const checkpointing = store(1);
  try {
    write(checkpointing);
  } finally {
    checkpointing.owner.close();
  }
  vi.advanceTimersByTime(60_025);
  const summaries = log.mock.calls.filter(([line]) => line === "Relay main thread, last minute.");
  expect(summaries).toHaveLength(1);
  return summaries[0]![1] as Summary;
}

it("counts each write under its kind once a minute, with the checkpoints that wrote the file", () => {
  const summary = lastMinute(({ insert, read }) => {
    for (let i = 0; i < 4; i++) asRelayWrite("save", insert);
    read();
    asRelayWrite("pass", insert);
    insert();
  });
  // The read changed nothing, so it is not a write. Every commit checkpoints at one page, but the first
  // write of the store only learns the file's time.
  expect(summary.writes).toMatchObject({
    save: { count: 4, checkpoints: 3 },
    pass: { count: 1, checkpoints: 1 },
    other: { count: 1, checkpoints: 1 },
  });
  expect(Object.keys(summary.writes).sort()).toEqual(["other", "pass", "save"]);
});

it("counts no checkpoint while commits only append to the log", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  startRelayMainThreadTiming();
  const appending = store(0);
  try {
    for (let i = 0; i < 4; i++) asRelayWrite("save", appending.insert);
  } finally {
    appending.owner.close();
  }
  vi.advanceTimersByTime(60_025);
  expect(log.mock.calls[0]?.[1]).toMatchObject({ writes: { save: { count: 4, checkpoints: 0 } } });
});

it("records nothing and logs nothing until started", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const quiet = store(1);
  try {
    asRelayWrite("save", quiet.insert);
  } finally {
    quiet.owner.close();
  }
  vi.advanceTimersByTime(60_025);
  expect(log).not.toHaveBeenCalled();
  expect(loopHeldBetween(0, performance.now())).toBeNull();
});

it("reports how long the loop was held between two times", async () => {
  startRelayMainThreadTiming();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const from = performance.now();
  const until = Date.now() + 150;
  while (Date.now() < until) {
    /* Hold the loop. */
  }
  // Before the sampler has run again, as when a save ends straight after a long synchronous step.
  expect(loopHeldBetween(from, performance.now())?.loopMaxMs).toBeGreaterThanOrEqual(120);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const held = loopHeldBetween(from, performance.now());
  // The sampler runs every 25 ms, so at least 125 of the 150 ms show as one late sample.
  expect(held?.loopMaxMs).toBeGreaterThanOrEqual(120);
  expect(held!.loopHeldMs).toBeGreaterThanOrEqual(held!.loopMaxMs);
});

it("keeps each save result's figures apart, so fast refusals do not move successful saves", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  startRelayMainThreadTiming();
  recordLiveSubmit("success", { checkMs: 40, rows: 3, loopMaxMs: null });
  recordLiveSubmit("success", { checkMs: 60, rows: 3, loopMaxMs: null });
  for (let i = 0; i < 5; i++) recordLiveSubmit("capacity-refused", { checkMs: 1, rows: null });
  vi.advanceTimersByTime(60_025);
  const summary = log.mock.calls[0]?.[1] as { saves: Record<string, unknown> };
  expect(summary.saves).toEqual({
    success: { count: 2, checkMs: { p50: 60, p90: 60, max: 60 }, rows: { p50: 3, p90: 3, max: 3 } },
    "capacity-refused": { count: 5, checkMs: { p50: 1, p90: 1, max: 1 } },
  });
});

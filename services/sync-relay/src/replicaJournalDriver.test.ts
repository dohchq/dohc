import { expect, it, vi } from "vitest";
import { drainReplicaJournal } from "./replicaEngine";
import type { ReplicaPageResult } from "@dohc/workspace-engine-client/daemon";
import type { ReplicaLiveJournalPage } from "./storage/liveUpdateJournal";

const page = (cursor: number, hasMore = false): ReplicaLiveJournalPage => ({ rows: [{journalCursor: cursor} as never], nextCursor: cursor, hasMore });
const result = (journalCursor: number, blockedCursor: number | null = null): ReplicaPageResult => ({revision: 1, logCursor: 2, journalCursor, applied: blockedCursor ? 0 : 1, skipped: 0, blockedCursor});

it("stops with a specific error after one ordinary retry of an impossible journal row", async () => {
  const pull = vi.fn(async () => {}), read = vi.fn(async () => page(8)), apply = vi.fn(async () => result(0, 8));
  await expect(drainReplicaJournal(0, read, apply, pull)).rejects.toThrow("Replica journal cursor 8 cannot apply after ordinary catch-up.");
  expect(pull).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(2);
});
it("accepts relay-wide cursor gaps and drains every page", async () => {
  const read = vi.fn(async (after: number) => page(after === 0 ? 9 : 30, after === 0));
  const apply = vi.fn(async (after: number) => result(after === 0 ? 9 : 30));
  await drainReplicaJournal(0, read, apply, vi.fn());
  expect(apply.mock.calls.map(c => c[0])).toEqual([0, 9]);
});
it("retries from the durable prefix when a later row blocks", async () => {
  const read = vi.fn(async (after: number) => page(after === 0 ? 9 : 30)), pull = vi.fn(async () => {});
  const apply = vi.fn().mockResolvedValueOnce(result(9, 30)).mockResolvedValueOnce(result(30));
  await drainReplicaJournal(0, read, apply, pull);
  expect(read.mock.calls.map(c => c[0])).toEqual([0, 9]); expect(pull).toHaveBeenCalledTimes(1);
});
it("rejects an empty nonterminal page instead of looping", async () => {
  await expect(drainReplicaJournal(0, async () => ({rows: [], nextCursor: 0, hasMore: true}), vi.fn(), vi.fn())).rejects.toThrow("Replica journal page did not progress");
});

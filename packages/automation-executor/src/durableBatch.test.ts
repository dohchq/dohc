import {expect, it} from "vitest";
import {durableBatch} from "./durableBatch";

it("saves bounded batches and flushes the remaining partial batch", async () => {
  const saved: number[][] = [];
  const batch = durableBatch<number>(async items => {saved.push([...items]);});
  for (let i = 0; i < 201; i++) await batch.add(i);
  expect(saved.map(items => items.length)).toEqual([100, 100]);
  await batch.flush(); await batch.flush();
  expect(saved.map(items => items.length)).toEqual([100, 100, 1]);
  expect(saved.flat()).toEqual(Array.from({length: 201}, (_, i) => i));
});

it("does not retry or publish a failed batch while returning an earlier partial success", async () => {
  const saved: number[] = [];
  let calls = 0;
  const batch = durableBatch<number>(async items => {
    if (++calls === 2) throw Error("sync failed");
    saved.push(...items);
  });
  for (let i = 0; i < 199; i++) await batch.add(i);
  await expect(batch.add(199)).rejects.toThrow("sync failed");
  await expect(batch.flush()).rejects.toThrow("sync failed");
  await expect(batch.add(200)).rejects.toThrow("sync failed");
  expect(calls).toBe(2); expect(saved).toHaveLength(100);
});

import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import { waitForEnginePublicationGate } from "./testEnginePublicationGate";

it("refuses replacement publication when shutdown aborts the readiness gate", async () => {
  const directory = await createTestScratch("publication-gate-");
  const gate = join(directory, "gate");
  await writeFile(gate, "held");
  const shutdown = new AbortController();
  const reason = new Error("shutdown");
  const waiting = waitForEnginePublicationGate(gate, shutdown.signal);
  const refused = expect(waiting).rejects.toBe(reason);
  await expect.poll(() => access(gate + ".waiting").then(() => true, () => false)).toBe(true);
  shutdown.abort(reason);
  await refused;
});

it("publishes only after the test releases readiness", async () => {
  const directory = await createTestScratch("publication-ready-");
  const gate = join(directory, "gate");
  await writeFile(gate, "held");
  let published = false;
  const waiting = waitForEnginePublicationGate(gate, new AbortController().signal).then(() => {published = true;});
  await expect.poll(() => access(gate + ".waiting").then(() => true, () => false)).toBe(true);
  expect(published).toBe(false);
  await rm(gate);
  await waiting;
  expect(published).toBe(true);
});

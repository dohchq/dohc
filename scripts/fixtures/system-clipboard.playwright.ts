import { test } from "../../apps/desktop/e2e/helpers/systemClipboard";
import { systemClipboardLockPath } from "../../apps/desktop/e2e/helpers/systemClipboardLock.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

test.setTimeout(1_000);

function assertHeldBy(title: string) {
  const record = JSON.parse(readFileSync(join(systemClipboardLockPath(), "holder.json"), "utf8"));
  assert.equal(record.pid, process.pid);
  assert.ok(record.holder.includes(title));
}

test("intentional failure", async () => {
  assertHeldBy("intentional failure");
  throw new Error("intentional fixture failure");
});

test("acquires after failure", async () => {
  assertHeldBy("acquires after failure");
});

test("intentional timeout", async () => {
  assertHeldBy("intentional timeout");
  await new Promise(() => {});
});

test("acquires after timeout", async () => {
  assertHeldBy("acquires after timeout");
});

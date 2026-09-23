import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistrationAttempt } from "./client.ts";
import { parseRecovery, recoveryText, readRecoveryFile } from "./recovery.ts";

async function attempt() {
  return createRegistrationAttempt({fullName: "Sample Person", mobile: "09171234567", paymentMethod: "gcash",
    sessions: [{sessionId: "s1", players: ["Sample Person"], spectators: []}]},
    {name: "sample.png", contentType: "image/png", bytesBase64: "AA=="});
}

test("recovery preserves uncertain request identity, payload and uploaded file", async () => {
  const original = await attempt(); original.fileId = "uploaded-file-reference";
  assert.deepEqual(parseRecovery(recoveryText(original)), original);
});

test("import keeps app retry authority but refreshes expired or foreign staged files", async () => {
  const original = await attempt(); original.fileId = "expired-file-reference";
  const imported = await readRecoveryFile(new File([recoveryText(original)], "recovery.json"));
  assert.deepEqual(imported.input, original.input);
  assert.equal(imported.fileId, null);
  assert.notEqual(imported.registerKey, original.registerKey);
  assert.notEqual(imported.uploadKey, original.uploadKey);
  original.receipt.bytesBase64 = "AQ==";
  await assert.rejects(readRecoveryFile(new File([recoveryText(original)], "corrupted.json")), /receipt.*changed/);
});

test("a maximum-sized receipt round trips without recursive regexp failure", async () => {
  const original = await attempt(); original.receipt.bytesBase64 = Buffer.alloc(5 * 1024 * 1024).toString("base64");
  assert.deepEqual(parseRecovery(recoveryText(original)), original);
});

test("recovery refuses malformed files and injected fields before network work", async () => {
  const original = await attempt();
  const encoded = JSON.parse(recoveryText(original));
  for (const update of [
    (value: typeof encoded) => { value.attempt.input.caller = {kind: "owner"}; },
    (value: typeof encoded) => { value.attempt.receipt.name = "../receipt.png"; },
    (value: typeof encoded) => { value.attempt.receipt.bytesBase64 = "%%%="; },
    (value: typeof encoded) => { value.attempt.input.sessions.push(value.attempt.input.sessions[0]); },
    (value: typeof encoded) => { value.attempt.registerKey = "new key with spaces"; },
    (value: typeof encoded) => { value.version = 2; },
  ]) {
    const value = structuredClone(encoded); update(value);
    assert.throws(() => parseRecovery(JSON.stringify(value)), /invalid/);
  }
  assert.throws(() => parseRecovery("not json"), /recovery JSON/);
  assert.throws(() => parseRecovery("x".repeat(8 * 1024 * 1024 + 1)), /too large/);
});

import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { actOnTypingCopy } from "./typingRecoveryActions";
import { readTypingCheckpoints, writeTypingCheckpoint, type OutageTypingCheckpoint } from "./outageTypingRecovery";

const checkpoint: OutageTypingCheckpoint = {version: 2, checkpointId: "one", workspaceId: "workspace", versionId: "main", objectId: "object", path: "note.md", expectedClaimId: null,
  expectedStateVectorSha256: "a".repeat(64), expectedDiskSha256: null, text: "KEPT_TYPING", admittedBaseBase64: "AAA=", updateBase64: "AAA=", updates: []};
async function copyFixture() {
  const directory = join(await createTestScratch("typing-actions-"), "recovery");
  await writeTypingCheckpoint(directory, checkpoint);
  return {directory, workspaceId: "workspace", checkpointId: "one", assertCurrent: vi.fn(), copyText: vi.fn()};
}
it("copies typing while retaining the only durable copy for a later retry", async () => {
  const input = await copyFixture();
  await expect(actOnTypingCopy({...input, action: "copy"})).resolves.toBe("copied");
  expect(input.copyText).toHaveBeenCalledExactlyOnceWith("KEPT_TYPING");
  expect((await readTypingCheckpoints(input.directory, input.workspaceId))[0]!.checkpoint).toEqual(checkpoint);
});
it("keeps the checkpoint when the clipboard write fails", async () => {
  const input = await copyFixture(); input.copyText.mockImplementation(() => {throw Error("clipboard unavailable");});
  await expect(actOnTypingCopy({...input, action: "copy"})).rejects.toThrow("clipboard unavailable");
  expect(await readTypingCheckpoints(input.directory, input.workspaceId)).toHaveLength(1);
});
it("only the explicit discard operation removes the kept copy", async () => {
  const input = await copyFixture();
  await expect(actOnTypingCopy({...input, action: "discard"})).resolves.toBe("discarded");
  expect(input.copyText).not.toHaveBeenCalled();
  expect(await readTypingCheckpoints(input.directory, input.workspaceId)).toEqual([]);
  await expect(actOnTypingCopy({...input, action: "copy"})).resolves.toBe("missing");
  expect(input.copyText).not.toHaveBeenCalled();
});
it("does not act on a kept copy after a workspace switch", async () => {
  const input = await copyFixture(); input.assertCurrent.mockImplementation(() => {throw Error("workspace changed");});
  await expect(actOnTypingCopy({...input, action: "copy"})).rejects.toThrow("workspace changed");
  expect(input.copyText).not.toHaveBeenCalled();
  expect(await readTypingCheckpoints(input.directory, input.workspaceId)).toHaveLength(1);
});

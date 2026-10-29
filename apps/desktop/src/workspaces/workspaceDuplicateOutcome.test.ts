import { expect, it } from "vitest";
import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { duplicateWithRecovery } from "./workspaceDuplicateOutcome";

it.each([
  {code: "CONFLICT", message: "Undo in progress"},
  {code: "INVALID_PARAMS", message: "live-document-binding-active"},
  {code: "METHOD_NOT_FOUND", message: "Restart dohc before duplicating this file."},
  {code: "DEADLINE_EXCEEDED", message: "The request expired before it ran."},
] as const)("preserves a definite refusal: $message", async ({code, message}) => {
  const error = new DaemonRefusalError({code, message, retry: "no"}, null);
  await expect(duplicateWithRecovery("copy.md", async () => {throw error;})).rejects.toBe(error);
});
it("preserves a translated admission refusal", async () => {
  const error = new VersionedTextStoreError("target-path-exists", "Choose another destination.");
  error.cause = new DaemonRefusalError({code: "CONFLICT", message: error.message, retry: "no"}, null);
  await expect(duplicateWithRecovery("copy.md", async () => {throw error;})).rejects.toBe(error);
});
it.each([new Error("lost reply"), new DaemonRefusalError({code: "INTERNAL", message: "failed after commit", retry: "no"}, null)])(
  "explains recovery when the commit outcome is uncertain", async error => {
    await expect(duplicateWithRecovery("copy.md", async () => {throw error;})).rejects.toThrow("could not confirm Duplicate for copy.md");
  },
);

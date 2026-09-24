import { readFileSync } from "node:fs";
import { PersistentRuntimeError } from "@dohc/app-backend-runtime/persistent";
import { DaemonRefusalError, type DaemonErrorCode } from "@dohc/workspace-engine-client";
import { describe, expect, it } from "vitest";
import { CompilerProcessError } from "../workspaces/compilerProcessSupervisor";
import { ERROR_WORDS, ipcWireError, isWorkspaceUpdatingError, readError } from "./errorWords";

// What the renderer receives when a main-process handler rejects: Electron
// sends `error.toString()` and prefixes the channel.
function acrossIpc(error: unknown, channel = "desktop:list-workspace-versions"): Error {
  return new Error(`Error invoking remote method '${channel}': ${String(ipcWireError(error))}`);
}

function refusal(code: DaemonErrorCode, message: string): DaemonRefusalError {
  return new DaemonRefusalError({ code, message, retry: "no" }, null);
}

// The engine's own list: every `ErrorCode` arm of `as_str`.
const engineCodes = [
  ...readFileSync(new URL("../../../../crates/dohc-engine-protocol/src/error.rs", import.meta.url), "utf8")
    .matchAll(/ErrorCode::\w+ => "([A-Z_]+)"/g),
].map((match) => match[1]!);

describe("error words", () => {
  it("has words, or the caller's words by decision, for every code the engine refuses with", () => {
    expect(engineCodes.length).toBeGreaterThan(30);
    const refusals = ERROR_WORDS.DaemonRefusalError!;
    expect(engineCodes.filter((code) => !Object.hasOwn(refusals, code))).toEqual([]);
  });

  it("writes every entry the way the interface skill asks", () => {
    const words = Object.values(ERROR_WORDS).flatMap((entry) => Object.values(entry))
      .filter((value): value is string => value !== null);
    for (const text of new Set(words)) {
      expect(text, text).toMatch(/^(?:[A-Z]|dohc )[^]*\.$/);
      for (const sentence of text.split(/(?<=\.) /)) {
        expect(sentence.split(" ").length, sentence).toBeLessThanOrEqual(20);
      }
      expect(text, text).not.toMatch(/[A-Z]{2,}_[A-Z]|Error\b|[a-z]+_[a-z]+/);
      expect(text, text).not.toMatch(/dataset|journal/i);
    }
  });

  it("turns a-01's refusal into words and keeps the refusal for Copy", () => {
    const received = acrossIpc(refusal("OVERLOADED", "Workspace is still updating. Try again."));
    expect(received.message).toBe(
      "Error invoking remote method 'desktop:list-workspace-versions': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    );
    expect(readError(received)).toEqual({
      words: "dohc is still reading this workspace's files. Try again when it finishes.",
      cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    });
    expect(isWorkspaceUpdatingError(received)).toBe(true);
    expect(isWorkspaceUpdatingError(acrossIpc(refusal("OVERLOADED", "engine-store-busy")))).toBe(false);
    expect(isWorkspaceUpdatingError(acrossIpc(new Error("Workspace is still updating. Try again.")))).toBe(false);
  });

  it("leaves the caller's words for a refusal that names nothing a person can act on", () => {
    expect(readError(acrossIpc(refusal("INVALID_PARAMS", "invalid-input")))).toEqual({
      words: null,
      cause: "DaemonRefusalError [INVALID_PARAMS]: invalid-input",
    });
    expect(readError(acrossIpc(refusal("SHARE_READ_ONLY", "workspace operation failed"))).words)
      .toBe("This share is read-only.");
  });

  it("reads the app compiler and the Collection worker by their codes", () => {
    expect(readError(acrossIpc(new CompilerProcessError("exit", "Compiler exited (1).")))).toEqual({
      words: "The app's code did not build.",
      cause: "CompilerProcessError [exit]: Compiler exited (1).",
    });
    const worker = new PersistentRuntimeError(
      "worker_deadline",
      "The dataset worker exceeded its deadline. Reopen it from the journal.",
    );
    expect(readError(acrossIpc(worker, "desktop:dataset")).words).toBe("It took too long to finish. Try again.");
    expect(readError(acrossIpc(new PersistentRuntimeError("worker_stalled", "The dataset worker stopped."))).words)
      .toBeNull();
  });

  it("keeps a sentence written for a person and drops only what is not", () => {
    expect(readError(acrossIpc(new Error("Sync this workspace before sharing.")))).toEqual({
      words: "Sync this workspace before sharing.",
      cause: null,
    });
    const named = Object.assign(new Error("dohc could not open notes.md. It is being moved."), {
      name: "YDocRemovalInProgressError",
    });
    expect(readError(acrossIpc(named))).toEqual({
      words: "dohc could not open notes.md. It is being moved.",
      cause: "YDocRemovalInProgressError: dohc could not open notes.md. It is being moved.",
    });
    expect(readError(acrossIpc(new Error("Dataset operation expired while waiting for a worker.")))).toEqual({
      words: null,
      cause: "Dataset operation expired while waiting for a worker.",
    });
    for (const raw of ["invalid-input", "EPIPE", "ENOENT: no such file or directory, open 'a.md'"]) {
      expect(readError(acrossIpc(new Error(raw))).words, raw).toBeNull();
    }
    const denied = Object.assign(new Error("EACCES: permission denied, open 'a.md'"), { code: "EACCES" });
    expect(readError(acrossIpc(denied))).toEqual({
      words: "dohc does not have permission to use this file or folder.",
      cause: "Error [EACCES]: EACCES: permission denied, open 'a.md'",
    });
    expect(readError(new TypeError("Cannot read properties of undefined"))).toEqual({
      words: null,
      cause: "TypeError: Cannot read properties of undefined",
    });
    expect(readError({})).toEqual({ words: null, cause: null });
  });
});

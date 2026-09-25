import { readFileSync } from "node:fs";
import { PersistentRuntimeError } from "@dohc/app-backend-runtime/persistent";
import { DaemonRefusalError, type DaemonErrorCode } from "@dohc/workspace-engine-client";
import { describe, expect, it } from "vitest";
import { CompilerProcessError } from "../workspaces/compilerProcessSupervisor";
import { ERROR_WORDS, ipcWireError, isWorkspaceUpdatingError, readError, withErrorWords } from "./errorWords";

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
      mapped: true,
      cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    });
    expect(isWorkspaceUpdatingError(received)).toBe(true);
    expect(isWorkspaceUpdatingError(acrossIpc(refusal("OVERLOADED", "engine-store-busy")))).toBe(false);
    expect(isWorkspaceUpdatingError(acrossIpc(new Error("Workspace is still updating. Try again.")))).toBe(false);
  });

  it("leaves the caller's words for a refusal that names nothing a person can act on", () => {
    expect(readError(acrossIpc(refusal("INVALID_PARAMS", "invalid-input")))).toEqual({
      words: null,
      mapped: false,
      cause: "DaemonRefusalError [INVALID_PARAMS]: invalid-input",
    });
    expect(readError(acrossIpc(refusal("SHARE_READ_ONLY", "workspace operation failed"))).words)
      .toBe("This share is read-only.");
  });

  it("reads the app compiler and the Collection worker by their codes", () => {
    expect(readError(acrossIpc(new CompilerProcessError("exit", "Compiler exited (1).")))).toEqual({
      words: "The app's code did not build.",
      mapped: true,
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
      mapped: false,
      cause: null,
    });
    const named = Object.assign(new Error("dohc could not open notes.md. It is being moved."), {
      name: "YDocRemovalInProgressError",
    });
    expect(readError(acrossIpc(named))).toEqual({
      words: "dohc could not open notes.md. It is being moved.",
      mapped: false,
      cause: "YDocRemovalInProgressError: dohc could not open notes.md. It is being moved.",
    });
    for (const raw of ["invalid-input", "EPIPE", "EPIPE: broken pipe, write"]) {
      expect(readError(acrossIpc(new Error(raw))).words, raw).toBeNull();
    }
    // A file-system error that lost its code still leads with it.
    expect(readError(acrossIpc(new Error("ENOENT: no such file or directory, open 'a.md'"))).words)
      .toBe("The file or folder is not there anymore.");
    const denied = Object.assign(new Error("EACCES: permission denied, open 'a.md'"), { code: "EACCES" });
    expect(readError(acrossIpc(denied))).toEqual({
      words: "dohc does not have permission to use this file or folder.",
      mapped: true,
      cause: "Error [EACCES]: EACCES: permission denied, open 'a.md'",
    });
    expect(readError(new TypeError("Cannot read properties of undefined"))).toEqual({
      words: null,
      mapped: false,
      cause: "TypeError: Cannot read properties of undefined",
    });
    expect(readError({})).toEqual({ words: null, mapped: false, cause: null });
  });

  it("hides the Collection worker's internal text only on the Collection channel", () => {
    const worker = acrossIpc(new Error("Dataset operation expired while waiting for a worker."), "desktop:dataset");
    expect(readError(worker)).toEqual({
      words: null,
      mapped: false,
      cause: "Dataset operation expired while waiting for a worker.",
    });
    for (const internal of [
      "The dataset worker stopped. Reopen it from the journal.",
      "Dataset host is closed.",
      "Dataset access is not permitted.",
      "Materialization is truncated.",
      "Invalid dataset scope.",
      "Unknown dataset worker directory; inspect it before cleanup: C:\\w\\.dohc\\workers\\a",
    ]) {
      expect(readError(acrossIpc(new Error(internal), "desktop:dataset")).words, internal).toBeNull();
    }
    // A person's own names and an instruction written for them stay, even
    // when a field, a folder or a file is named Dataset or Journal.
    for (const [message, channel] of [
      ["Journal.md changed on disk. Open it again.", "desktop:read-workspace-text"],
      ["A Collection named Dataset already exists in Journal.", "desktop:create-collection"],
      ["The server returned an invalid Collection checkpoint.", "desktop:dataset"],
      [
        "Dataset uses custom rules in Edit. Update ops/dataset/operations.ts, then choose Review source change.",
        "desktop:dataset",
      ],
      ["Status uses custom rules. Update dataset/operations.ts, then choose Review source change.", "desktop:dataset"],
    ] as const) {
      expect(readError(acrossIpc(new Error(message), channel)).words, message).toBe(message);
    }
  });

  it("tells a person what to do for each way the engine can be unavailable", () => {
    const unavailable = (message: string) =>
      readError(acrossIpc(Object.assign(new Error(message), { name: "EngineDaemonUnavailableError" }))).words;
    expect(unavailable("Rust engine daemon is not available.")).toBe("Try again in a moment.");
    expect(unavailable("Rust engine workspace.open timed out after 30000ms.")).toBe("Try again in a moment.");
    expect(unavailable("Rust engine exited during its startup handshake.")).toBe("Try again in a moment.");
    expect(unavailable("Rust engine lifecycle is already stopping.")).toBeNull();
    expect(unavailable("Rust engine binary not found: C:\\dohc\\dohc-workspace-engine.exe"))
      .toBe("This copy of dohc is missing a file it needs. Reinstall dohc.");
    expect(unavailable("Electron resources path is unavailable for the packaged Rust engine."))
      .toBe("This copy of dohc is missing a file it needs. Reinstall dohc.");
  });

  it("puts the caller's sentence before the words the map adds", () => {
    const stopped = acrossIpc(new PersistentRuntimeError("worker_stopped", "The dataset worker stopped."));
    expect(withErrorWords("Could not open this Collection.", stopped))
      .toBe("Could not open this Collection. It stopped before it finished. Try again.");
    expect(withErrorWords("Could not open this Collection.", acrossIpc(refusal("INTERNAL", "workspace operation failed"))))
      .toBe("Could not open this Collection.");
    expect(withErrorWords("Could not share.", acrossIpc(new Error("Sync this workspace before sharing."))))
      .toBe("Could not share. Sync this workspace before sharing.");
  });
});

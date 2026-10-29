import { SyncedDeletionRevivalError } from "../workspaces/syncedDeletionRefusal";
import { installWorkspaceDataKey, SECRET_KEY_RELATIVE_PATH } from "../workspaces/workspaceDataKey";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicCreateFile } from "../atomicReplaceFile";
import { createTestScratch } from "../workspaces/testTemp";
import { ipcErrorMessage } from "../renderer/ipcError";
import { CollectionsRefusalError } from "../workspaces/collectionsHolder";
import { ServerCollectionsUnavailableError } from "../workspaces/remoteDataset";
import { ReservedWorkspaceIdError } from "@dohc/workspace-core";
import { RelayUnauthorizedError, RelayUnreachableError, SharedFileReadOnlyError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { readFileSync } from "node:fs";
import { PersistentRuntimeError } from "@dohc/app-backend-runtime/persistent";
import { DatasetReopenWaitError } from "@dohc/app-backend-runtime/supervisor";
import { DaemonRefusalError, type DaemonErrorCode } from "@dohc/workspace-engine-client";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CompilerProcessError } from "../workspaces/compilerProcessSupervisor";
import { WorkspaceManifestError } from "../workspaces/createWorkspaceFolder";
import { LiveDocumentMutationError, RestorePolicyRefusalError } from "../workspaces/workspaceEngineCapture";
import type { WorkspacePolicyPath } from "./bridgeContract";
import {
  ERROR_WORDS,
  ipcWireError,
  isChatMentionPageChanged,
  isPrivacyDenied,
  isShareReadOnlyRefusal,
  isSharedLiveFileRefusal,
  isWorkspaceUpdatingError,
  needsNewerDohc,
  PRIVACY_DENIED_WORDS,
  readCollectionReopenWait,
  readCollectionsRefusal,
  readServerCollectionsUnavailable,
  readError,
  shouldRecheckShareAccess,
  versionNameRefusal,
  VOLUME_SHARES_NEW_FILES_WORDS,
  withErrorWords,
} from "./errorWords";

vi.mock("../atomicReplaceFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomicReplaceFile")>();
  return { ...actual, atomicCreateFile: vi.fn(actual.atomicCreateFile) };
});

it("explains the held-file live-open refusal after Electron serializes it", () => {
  const error = new Error("Error invoking remote method 'desktop:engine-ydoc-open': DaemonRefusalError [CONFLICT]: capture-file-held: notes/held.md");
  expect(readError(error).words).toBe('dohc cannot open "notes/held.md" for live editing. dohc cannot take in this file\'s Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Restore the file\'s exact contents from before that edit. For nested lists, make the edit in dohc after the file opens again.');
});

// What the renderer receives when a main-process handler rejects: Electron
// sends `error.toString()` and prefixes the channel.
function acrossIpc(error: unknown, channel = "desktop:list-workspace-versions"): Error {
  return new Error(`Error invoking remote method '${channel}': ${String(ipcWireError(error))}`);
}

function refusal(code: DaemonErrorCode, message: string): DaemonRefusalError {
  return new DaemonRefusalError({ code, message, retry: "no" }, null);
}

it("keeps the synced deletion refusal words across Electron for History and conflict choices", () => {
  const received = acrossIpc(refusal("INVALID_PARAMS", "synced-deletion-revival-refused"));
  expect(readError(received).title).toBe("dohc can't bring back this file, because that could stop sync");
  expect(ipcErrorMessage(received, "Could not restore this file.")).toContain("Choose Keep this machine's copy, then copy its text from its History into a file with a new name.");
  expect(readError(acrossIpc(new SyncedDeletionRevivalError())).words).toBe(readError(received).words);
});

it("uses History instructions for restore refusals without changing conflict instructions", () => {
  const restore = readError(new SyncedDeletionRevivalError("tasks/trip.txt", undefined, true));
  expect(restore.title).toBe("dohc can't bring back trip.txt, because that could stop sync");
  expect(restore.words).toBe("Copy its text from its History into a file with a new name.");
  expect(restore.canRetry).toBe(false);
  expect(readError(new SyncedDeletionRevivalError("tasks/trip.txt")).words).toBe("Choose Keep this machine's copy, then copy its text from its History into a file with a new name. When your other machine shows a conflict for trip.txt, keep the removal there.");
});

// The engine's own list: every `ErrorCode` arm of `as_str`.
const engineCodes = [
  ...readFileSync(new URL("../../../../crates/dohc-engine-protocol/src/error.rs", import.meta.url), "utf8")
    .matchAll(/ErrorCode::\w+ => "([A-Z_]+)"/g),
].map((match) => match[1]!);

describe("error words", () => {
  it.each([
    ["desktop:cloud-enable-sync", "dohc could not enable sync for this workspace."],
    ["desktop:cloud-join-workspace", "Couldn't join the workspace."],
  ])("keeps the key-install refusal unchanged across %s", async (channel, prefix) => {
    const root = await createTestScratch("dohc-key-ipc-words-");
    await mkdir(dirname(join(root, SECRET_KEY_RELATIVE_PATH)), { recursive: true });
    vi.mocked(atomicCreateFile).mockRejectedValueOnce(
      Object.assign(new Error("link failed"), { code: "ENOTSUP", syscall: "link" }),
    );
    const failure = await installWorkspaceDataKey(root, Buffer.alloc(32, 7)).catch(error => error);
    const sentence = "This drive can't store the workspace's secret key safely. Move the workspace to an NTFS, APFS or ext4 drive, then try again.";
    const received = acrossIpc(failure, channel);
    expect(readError(received).words).toBe(sentence);
    expect(ipcErrorMessage(received, prefix)).toBe(sentence);
  });

  it.each([
    ["chat-mention-access-changed", "Chat access changed. Try again."],
    ["chat-mention-version-changed", "It changed while dohc was working on it. Try again."],
  ])("keeps the restartable chat page reason across IPC: %s", (reason, words) => {
    const received = acrossIpc(refusal("CONFLICT", reason!));
    expect(isChatMentionPageChanged(received)).toBe(true);
    expect(readError(received).words).toBe(words);
    expect(isChatMentionPageChanged(acrossIpc(new Error(reason)))).toBe(true);
  });

  it.each([
    refusal("CONFLICT", "A different conflict"),
    refusal("FORBIDDEN", "chat-mention-access-changed"),
    refusal("CONFLICT", "chat-mention-access-changed: extra"),
    new Error("Chat access changed. Try again."),
  ])("does not restart a chat page for %s", error => {
    expect(isChatMentionPageChanged(acrossIpc(error))).toBe(false);
  });

  it.each([
    "Each choice is one line of at most 200 characters.",
    "Each choice appears once.",
  ])("keeps the engine poll sentence across IPC: %s", sentence => {
    const received = acrossIpc(refusal("INVALID_PARAMS", sentence));
    expect(readError(received)).toEqual({
      words: sentence,
      mapped: false,
      cause: `DaemonRefusalError [INVALID_PARAMS]: ${sentence}`,
    });
  });

  it.each(["A new poll rule.", "A poll has at most twelve choices."])(
    "uses the caller's words for an unknown poll sentence: %s", sentence => {
      const received = acrossIpc(refusal("INVALID_PARAMS", sentence));
      expect(readError(received)).toEqual({
        words: null,
        mapped: false,
        cause: `DaemonRefusalError [INVALID_PARAMS]: ${sentence}`,
      });
      expect(withErrorWords("Could not send that message.", received)).toBe("Could not send that message.");
    },
  );

  it.each([
    new RelayUnauthorizedError(),
    new SharedFileReadOnlyError(),
    new ShareUnavailableError(),
    new RelayUnreachableError(),
    new DOMException("The request timed out.", "TimeoutError"),
    new TypeError("Failed to fetch"),
    new Error("Share request failed (403)"),
    new Error("This Collection does not have Edit access."),
    new Error("Your access to this share ended."),
    new Error("connect ECONNREFUSED 127.0.0.1:3000"),
  ])("rechecks share access for %s across IPC", error => {
    expect(shouldRecheckShareAccess(acrossIpc(error))).toBe(true);
  });

  it.each(["FORBIDDEN", "AUTH_FAILED", "SHARE_UNAVAILABLE", "SHARE_READ_ONLY"] as const)(
    "rechecks share access for engine %s across IPC", code => {
      expect(shouldRecheckShareAccess(acrossIpc(refusal(code, "The request was rejected.")))).toBe(true);
    },
  );

  it.each([
    "The shared file session changed.",
    "The shared file session changed. Open the Collection again.",
    "The shared file session changed. Read the automations again.",
  ])("rechecks share access for %s across IPC", message => {
    expect(shouldRecheckShareAccess(acrossIpc(new Error(message)))).toBe(true);
  });

  it.each([
    new Error("tasks/Untitled.md already exists. Choose another record name."),
    new Error("network/Untitled.md already exists. Choose another record name."),
    new Error("This Collection does not have a current document schema."),
    new TypeError("Cannot read properties of undefined"),
    refusal("CONFLICT", "The record changed."),
  ])("does not recheck share access for %s", error => {
    expect(shouldRecheckShareAccess(acrossIpc(error))).toBe(false);
  });

  it.each([
    [new SharedFileReadOnlyError(), true],
    [refusal("SHARE_READ_ONLY", "The share is read-only."), true],
    [Object.assign(new Error("EPERM: operation not permitted, rename 'a' -> 'b'"), { code: "EPERM" }), false],
    [refusal("FORBIDDEN", "The request was rejected."), false],
  ] as const)("reads %s as a share's write refusal across IPC: %s", (error, refused) => {
    expect(isShareReadOnlyRefusal(acrossIpc(error, "desktop:write-workspace-text"))).toBe(refused);
  });

  it.each([
    [new VersionedTextStoreError("version-name-conflict", "version-name-conflict"), "taken"],
    [new VersionedTextStoreError("invalid-version-name", "invalid-version-name"), "invalid"],
    [new VersionedTextStoreError("version-not-found", "version-not-found"), null],
    [refusal("INVALID_PARAMS", "version-name-conflict"), null],
  ] as const)("reads %s as a refusal of a version's name across IPC: %s", (error, refused) => {
    expect(versionNameRefusal(acrossIpc(error, "desktop:create-workspace-version"))).toBe(refused);
  });

  it.each(["link", "shares", "notices"])("keeps the reserved-ID refusal title and body across IPC for %s", (workspaceId) => {
    const error = new ReservedWorkspaceIdError(workspaceId);
    const expected = {
      title: "dohc can't open this folder",
      words: `Its workspace ID, ${workspaceId}, is reserved. Change workspaceId in .dohc/manifest.json, then open the folder again.`,
      mapped: false,
      cause: error.toString(),
    };
    expect(readError(error)).toEqual(expected);
    expect(readError(acrossIpc(error, "desktop:attach-workspace-folder"))).toEqual(expected);
  });

  it("says why a folder's manifest stops it opening, and keeps the parser's reason for Copy", () => {
    const unreadable = new WorkspaceManifestError("unreadable", "this folder has an invalid .dohc/manifest.json: manifest kind is invalid");
    expect(readError(acrossIpc(unreadable, "desktop:attach-workspace-folder"))).toEqual({
      words: "dohc can't read its .dohc/manifest.json. Fix the file, then try again.",
      mapped: true,
      cause: "WorkspaceManifestError [unreadable]: this folder has an invalid .dohc/manifest.json: manifest kind is invalid",
    });
    const newer = new WorkspaceManifestError("newer-version", "this workspace was created by a newer version of dohc (manifest v2)");
    // Main sends a failed launch open's cause as this one string.
    expect(withErrorWords("dohc could not open Trips.", String(ipcWireError(newer))))
      .toBe("dohc could not open Trips. It needs a newer version of dohc. Update dohc to open it.");
    expect(needsNewerDohc(String(ipcWireError(newer)))).toBe(true);
    expect(needsNewerDohc(acrossIpc(newer))).toBe(true);
    expect(needsNewerDohc(acrossIpc(unreadable))).toBe(false);
    expect(needsNewerDohc(new ReservedWorkspaceIdError("link"))).toBe(false);
  });

  it("names a macOS privacy refusal the engine sends, after the caller's sentence", () => {
    const engine = acrossIpc(refusal("INTERNAL", "privacy-denied"), "desktop:list-workspace-files");
    expect(readError(engine)).toEqual({
      words: PRIVACY_DENIED_WORDS,
      mapped: true,
      cause: "DaemonRefusalError [INTERNAL]: privacy-denied",
    });
    expect(isPrivacyDenied(engine)).toBe(true);
    expect(withErrorWords("Could not refresh workspace files.", engine))
      .toBe(`Could not refresh workspace files. ${PRIVACY_DENIED_WORDS}`);
    expect(PRIVACY_DENIED_WORDS).toBe(
      "macOS blocked dohc from this folder. Allow dohc in System Settings › Privacy & Security › Files & Folders.",
    );
  });

  it("says why dohc can't keep a file private on a volume that shares new files, after the caller's sentence", () => {
    const engine = acrossIpc(refusal("INTERNAL", "volume-shares-new-files"), "desktop:write-workspace-file");
    expect(readError(engine)).toEqual({
      words: VOLUME_SHARES_NEW_FILES_WORDS,
      mapped: true,
      cause: "DaemonRefusalError [INTERNAL]: volume-shares-new-files",
    });
    expect(withErrorWords("Couldn't save .env.", engine)).toBe(
      "Couldn't save .env. The disk this workspace is on adds sharing permissions to new files, so dohc can't keep this file private. Move the workspace to a disk on this Mac.",
    );
  });

  const LINK = "Put what it links to in its place, then try again.";
  const OTHER_OWNER = "Make it yours again, then try again.";
  const OTHER_OWNER_FOLDER = "Make it and everything in it yours again, then try again.";
  const MOVE_ASIDE = "Rename or move it, then try again.";
  const NOT_CHANGEABLE = "Give your account full control of this folder and everything in it, then try again.";
  it.each([
    ["link .dohc", `This workspace's .dohc is a link, so dohc can't keep its History private. ${LINK}`],
    ["link .dohc/engine/engine.db-journal", `This workspace's .dohc/engine/engine.db-journal is a link, so dohc can't keep its History private. ${LINK}`],
    ["not-folder .dohc/engine", `This workspace's .dohc/engine is not a folder, so dohc can't keep its History private. ${MOVE_ASIDE}`],
    ["not-file .dohc/engine/engine.db-wal", `This workspace's .dohc/engine/engine.db-wal is not a file, so dohc can't keep its History private. ${MOVE_ASIDE}`],
    ["other-owner .dohc", `This workspace's .dohc belongs to another user, so dohc can't keep its History private. ${OTHER_OWNER_FOLDER}`],
    ["other-owner .dohc/engine", `This workspace's .dohc/engine belongs to another user, so dohc can't keep its History private. ${OTHER_OWNER_FOLDER}`],
    ["other-owner .dohc/engine/engine.db", `This workspace's .dohc/engine/engine.db belongs to another user, so dohc can't keep its History private. ${OTHER_OWNER}`],
    ["unchecked-volume .dohc/engine", "This workspace's .dohc/engine is on a disk dohc can't check, so dohc can't keep its History private. Move the workspace to a disk formatted as APFS, then try again."],
    ["unchecked-system .dohc/engine", "This workspace's .dohc/engine is on a system where dohc can't check it, so dohc can't keep its History private. Run dohc where it can read its own /proc/self/fd, then try again."],
    ["link .dohc/engine/engine.db-shm", `This workspace's .dohc/engine/engine.db-shm is a link, so dohc can't keep its History private. ${LINK}`],
    ["link .dohc/local", `This workspace's .dohc/local is a link, so dohc can't keep this computer's own data private. ${LINK}`],
    ["not-folder .dohc/local", `This workspace's .dohc/local is not a folder, so dohc can't keep this computer's own data private. ${MOVE_ASIDE}`],
    ["other-owner .dohc/local", `This workspace's .dohc/local belongs to another user, so dohc can't keep this computer's own data private. ${OTHER_OWNER_FOLDER}`],
    ["not-changeable .dohc", `This workspace's .dohc has permissions dohc can't use, so dohc can't keep its History private. ${NOT_CHANGEABLE}`],
    ["not-changeable .dohc/local", `This workspace's .dohc/local has permissions dohc can't use, so dohc can't keep this computer's own data private. ${NOT_CHANGEABLE}`],
  ])("names what keeps a workspace's History from being private, where, and the fix that keeps it: %s", (detail, words) => {
    const message = `engine-folder-not-private: ${detail}`;
    expect(readError(acrossIpc(refusal("INTERNAL", message), "desktop:open-workspace"))).toEqual({
      words,
      mapped: true,
      cause: `DaemonRefusalError [INTERNAL]: ${message}`,
    });
    for (const sentence of words.split(/(?<=\.) /)) {
      expect(sentence.split(" ").length, sentence).toBeLessThanOrEqual(20);
    }
  });

  it("leaves a refusal of the engine's folder it has no words for to the caller", () => {
    for (const detail of [
      "constructor .dohc",
      "link /Users/me",
      "link .dohc/trash",
      "other-owner .dohc/engine/ROOT_BINDING",
      "link .dohc/engine/engine.db-wal/x",
      "link .dohc/local/ui-state.json",
      "link ../.dohc",
    ]) {
      expect(readError(acrossIpc(refusal("INTERNAL", `engine-folder-not-private: ${detail}`))).words).toBeNull();
    }
  });

  it("keeps an EPERM main did not name a privacy refusal as a permission problem", () => {
    const eperm = acrossIpc(Object.assign(new Error("EPERM: operation not permitted, rename 'a' -> 'b'"), { code: "EPERM" }));
    expect(isPrivacyDenied(eperm)).toBe(false);
    expect(readError(eperm).words).toBe("dohc does not have permission to use this file or folder.");
  });

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

  it("says a file is not read yet without promising that the workspace will finish", () => {
    const received = acrossIpc(refusal("OVERLOADED", "dohc has not read this file yet. Open it again once dohc has read it."));
    expect(readError(received)).toEqual({
      words: "dohc has not read this file yet. Try again when it has.",
      mapped: true,
      cause: "DaemonRefusalError [OVERLOADED]: dohc has not read this file yet. Open it again once dohc has read it.",
    });
    expect(isWorkspaceUpdatingError(received)).toBe(false);
  });

  it("knows a shared live file's restore refusal across IPC, and keeps its words", () => {
    const refused = new LiveDocumentMutationError(
      "dohc could not restore notes/plan.md. This action is unavailable for shared live files. Continue editing at the current location.",
    );
    const received = acrossIpc(refused, "desktop:restore-engine-moment-file");
    expect(isSharedLiveFileRefusal(received)).toBe(true);
    expect(readError(received).words).toBe(refused.message);
    expect(isSharedLiveFileRefusal(acrossIpc(new Error(refused.message), "desktop:restore-engine-moment-file"))).toBe(false);
    expect(isSharedLiveFileRefusal(acrossIpc(refusal("INVALID_PARAMS", "live-document-binding-active")))).toBe(false);
  });

  it("explains an open editing session across IPC and keeps its refusal for Copy", () => {
    const received = acrossIpc(refusal("INVALID_PARAMS", "ydoc-session-busy"), "desktop:restore-engine-moment-file");
    expect(received.message).toBe(
      "Error invoking remote method 'desktop:restore-engine-moment-file': DaemonRefusalError [INVALID_PARAMS]: ydoc-session-busy",
    );
    const words = "This file is open for editing. Close its tabs, then try again.";
    expect(readError(received)).toEqual({
      words,
      mapped: true,
      cause: "DaemonRefusalError [INVALID_PARAMS]: ydoc-session-busy",
    });
    for (const sentence of ["dohc could not restore kyoto.md.", "dohc could not undo the restore of kyoto.md."]) {
      expect(withErrorWords(sentence, received)).toBe(`${sentence} ${words}`);
      expect(ipcErrorMessage(received, sentence)).toBe(`${sentence} ${words}`);
    }
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

  it("names https when the engine refuses a server address", () => {
    expect(readError(acrossIpc(refusal("RELAY_HTTPS_REQUIRED", "workspace operation failed"))).words)
      .toBe("Your server's address does not use https. Disconnect, then connect your server again with its https address.");
  });

  it("reads the app compiler and the Collection worker by their codes", () => {
    const timeout = Object.assign(new CompilerProcessError("timeout", "Compiler timed out."), { details: "Supervisor-only details" });
    expect(String(ipcWireError(timeout))).not.toContain(timeout.details);
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

  it("keeps data and a stack for Copy, after the caller's sentence alone", () => {
    const invalid = z.uuid().safeParse("not-an-id").error!;
    const sentence = "dohc could not read this Collection's automations.";
    expect(readError(acrossIpc(invalid, "desktop:dataset"))).toEqual({ words: null, mapped: false, cause: invalid.message });
    expect(withErrorWords(sentence, acrossIpc(invalid, "desktop:dataset"))).toBe(sentence);
    for (const dump of ['{"error":"bad"}', "Sync failed.\n    at run (main.js:1:1)"]) {
      expect(readError(acrossIpc(new Error(dump))), dump).toEqual({ words: null, mapped: false, cause: dump });
    }
    // Words stay words when they start with a bracket or a path makes them long.
    const pressed = "[Send] changed after it was pressed. Press it again.";
    expect(readError(acrossIpc(new Error(pressed))).words).toBe(pressed);
    const held = `dohc did not record the outside edit to "notes/${"a".repeat(500)}.md". Restore the file, then try again.`;
    expect(readError(held).words).toBe(held);
  });

  it("shows a plain Collection reply as written, names and instructions included", () => {
    for (const message of [
      "The Collection changed after this preview. Preview the change again.",
      "The Collection's rules changed. Reload the Collection. Then try again.",
      "Journal.md changed on disk. Open it again.",
      "Dataset uses custom rules in Edit. Update ops/dataset/operations.ts, then choose Review source change.",
      ...["Materialization", "Checkpoint", "Materialization is truncated.: Status", "Dataset operation"].map((field) =>
        `${field} uses custom rules in Edit. Update Dataset host/operations.ts, then choose Review source change.`),
    ]) {
      expect(readError(acrossIpc(new Error(message), "desktop:dataset")), message).toEqual({
        words: message,
        mapped: false,
        cause: null,
      });
    }
    expect(withErrorWords("dohc could not prepare this review.", acrossIpc(
      new Error("The Collection changed after this preview. Preview the change again."),
      "desktop:dataset",
    ))).toBe("dohc could not prepare this review. The Collection changed after this preview. Preview the change again.");
  });

  it("carries a refusal to use the Collections here across IPC, with its kind, its words and the computer that keeps them", () => {
    const elsewhere = new CollectionsRefusalError({ kind: "elsewhere", computer: { installId: "install-laptop", label: "Laptop" }, sameName: false });
    expect(String(ipcWireError(elsewhere))).toBe(`CollectionsRefusalError [collections-elsewhere] [computer=Laptop]: ${elsewhere.message}`);
    expect(readCollectionsRefusal(acrossIpc(elsewhere, "desktop:dataset"))).toEqual({ kind: "elsewhere", words: elsewhere.message, computer: "Laptop" });
    // A name with spaces and brackets crosses whole.
    const studio = new CollectionsRefusalError({ kind: "elsewhere", computer: { installId: "install-studio", label: "Sam's Studio [2]" }, sameName: false });
    expect(readCollectionsRefusal(acrossIpc(studio, "desktop:dataset"))).toEqual({ kind: "elsewhere", words: studio.message, computer: "Sam's Studio [2]" });
    // A refusal with no name, or one that doesn't decode, stays a refusal and names no computer.
    for (const wire of ["", " [computer=%ZZ]"]) {
      expect(readCollectionsRefusal(`Error invoking remote method 'desktop:dataset': CollectionsRefusalError [collections-elsewhere]${wire}: ${elsewhere.message}`))
        .toEqual({ kind: "elsewhere", words: elsewhere.message, computer: null });
    }
    expect(readCollectionsRefusal(acrossIpc(new CollectionsRefusalError({ kind: "unclaimed" }), "desktop:dataset"))).toEqual({
      kind: "unclaimed", words: new CollectionsRefusalError({ kind: "unclaimed" }).message,
    });
    expect(withErrorWords("Could not read Collections.", acrossIpc(elsewhere, "desktop:dataset"))).toBe(`Could not read Collections. ${elsewhere.message}`);
    // Another error with the same words is not a refusal.
    expect(readCollectionsRefusal(acrossIpc(new Error(elsewhere.message), "desktop:dataset"))).toBeNull();
    expect(readCollectionsRefusal(acrossIpc(Object.assign(new Error("x"), { name: "CollectionsRefusalError", code: "collections-other" })))).toBeNull();
  });

  it("carries where the Collections are with a server list that failed, across IPC, apart from why", () => {
    const elsewhere = new CollectionsRefusalError({ kind: "elsewhere", computer: { installId: "install-laptop", label: "Laptop" }, sameName: false });
    const failed = new ServerCollectionsUnavailableError(elsewhere, new TypeError("fetch failed"));
    const read = readServerCollectionsUnavailable(acrossIpc(failed, "desktop:dataset"));
    expect(read).toEqual({ elsewhere: elsewhere.message, computer: "Laptop", failure: "TypeError: fetch failed" });
    // The server's error reads as it would have alone.
    for (const cause of [new TypeError("fetch failed"), new CollectionsRefusalError({ kind: "unclaimed" }), new Error("Your server session changed. Try again.")]) {
      const failure = readServerCollectionsUnavailable(acrossIpc(new ServerCollectionsUnavailableError(elsewhere, cause), "desktop:dataset"))!.failure;
      expect(readError(new Error(failure))).toEqual(readError(acrossIpc(cause, "desktop:dataset")));
    }
    expect(readServerCollectionsUnavailable(acrossIpc(new ServerCollectionsUnavailableError(elsewhere, new Error()), "desktop:dataset")))
      .toEqual({ elsewhere: elsewhere.message, computer: "Laptop", failure: "" });
    for (const wire of ["", " [computer=%ZZ]"]) {
      expect(readServerCollectionsUnavailable(`ServerCollectionsUnavailableError [server-collections-unavailable]${wire}: ${elsewhere.message}\nTypeError: fetch failed`))
        .toEqual({ elsewhere: elsewhere.message, computer: null, failure: "TypeError: fetch failed" });
    }
    expect(readCollectionsRefusal(acrossIpc(failed, "desktop:dataset"))).toBeNull();
    // The same words from another error are not that list.
    expect(readServerCollectionsUnavailable(acrossIpc(new Error(failed.message), "desktop:dataset"))).toBeNull();
    expect(readServerCollectionsUnavailable(acrossIpc(elsewhere, "desktop:dataset"))).toBeNull();
  });

  it("carries a Collection's reopen wait across IPC as a number beside its code", () => {
    for (const [retryAfterMs, words] of [[1, "1 second"], [4_200, "5 seconds"], [60_000, "1 minute"]] as const) {
      const wait = new DatasetReopenWaitError(retryAfterMs);
      expect(String(ipcWireError(wait))).toBe(`DatasetReopenWaitError [dataset_reopen_wait] [retryAfterMs=${retryAfterMs}]: ${wait.message}`);
      expect(readCollectionReopenWait(acrossIpc(wait, "desktop:dataset")))
        .toEqual({ words: `This Collection is waiting to reopen. Try again in ${words}.`, waitMs: retryAfterMs });
      expect(readCollectionReopenWait(wait)).toEqual({ words: wait.message, waitMs: retryAfterMs });
    }
    // A worker failure that starts a wait carries it too, and keeps its own words.
    const stopped = Object.assign(new PersistentRuntimeError("worker_stopped", "stopped"), { retryAfterMs: 5000 });
    expect(String(ipcWireError(stopped))).toBe("PersistentRuntimeError [worker_stopped] [retryAfterMs=5000]: stopped");
    expect(readError(acrossIpc(stopped, "desktop:dataset")).words).toBe(readError(acrossIpc(new PersistentRuntimeError("worker_stopped", "stopped"), "desktop:dataset")).words);
    expect(readCollectionReopenWait(acrossIpc(stopped, "desktop:dataset"))).toBeNull();
    expect(readCollectionReopenWait(new Error("This Collection is waiting to reopen. Try again in 5 seconds."))).toBeNull();
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

  it("names the rules file a refused restore could not read, and keeps the parser's text for Copy only", () => {
    const parser = "visibility.toml: TOML parse error at line 3, column 9";
    const refused = (unreadable: WorkspacePolicyPath[]) => acrossIpc(
      new RestorePolicyRefusalError({ reason: "policy-unreadable", unreadable, detail: parser }),
      "desktop:restore-engine-moment-file",
    );
    expect(readError(refused([".dohc/visibility.toml"]))).toEqual({
      words: "It can't read .dohc/visibility.toml. Fix the file, then try again.",
      mapped: true,
      cause: `RestorePolicyRefusalError [policy-unreadable]: .dohc/visibility.toml: ${parser}`,
    });
    expect(withErrorWords("dohc could not restore notes/plan.md.", refused([".dohc/visibility.toml"]))).toBe(
      "dohc could not restore notes/plan.md. It can't read .dohc/visibility.toml. Fix the file, then try again.",
    );
    expect(readError(refused([".dohc/files.toml"])).words).toBe("It can't read .dohc/files.toml. Fix the file, then try again.");
    expect(readError(refused([".dohc/files.toml", ".dohc/visibility.toml"])).words)
      .toBe("It can't read .dohc/files.toml and .dohc/visibility.toml. Fix the files, then try again.");
    expect(readError(refused([".dohc"])).words).toBe("It can't read this workspace's .dohc folder. Fix the folder, then try again.");
    // Main reads the class itself for Stop and restore's review rows.
    expect(readError(new RestorePolicyRefusalError({ reason: "path-not-admitted" })).words)
      .toBe("History no longer tracks this file. Track it in .dohc/files.toml, then try again.");
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

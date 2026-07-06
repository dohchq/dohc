import { describe, expect, it } from "vitest";
import {
  WORKSPACE_KINDS as CORE_WORKSPACE_KINDS,
  WORKSPACE_MODES as CORE_WORKSPACE_MODES,
  type WorkspaceKind,
  type WorkspaceMode,
} from "@dohc/workspace-core";
import type { UpdateState } from "../updates/updateMachine";
import {
  UPDATE_CHANNELS as UPDATER_UPDATE_CHANNELS,
  type UpdateChannel,
} from "../updates/electronUpdater";
import {
  EXPLORER_MENU_COMMANDS,
  isExplorerMenuCommand,
  isMenuCommand,
  isSafeRelativePath,
  isWorkbenchMenuCommand,
  MENU_COMMANDS,
  parseSearchResultsEvent,
  parseUpdateStateEvent,
  parseWorkspaceActivatedEvent,
  UPDATE_CHANNELS,
  UPDATE_STATUSES,
  WORKBENCH_MENU_COMMANDS,
  WORKSPACE_KINDS,
  WORKSPACE_MODES,
} from "./channels";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

const workspaceKindDriftGuard: Assert<
  Equal<(typeof WORKSPACE_KINDS)[number], WorkspaceKind>
> = true;
const workspaceModeDriftGuard: Assert<
  Equal<(typeof WORKSPACE_MODES)[number], WorkspaceMode>
> = true;

// The preload boundary for main→renderer menu events. These cases are the
// codex-review attack set: the check must accept ONLY exact primitive members
// of the closed tuple — not String objects, toString tricks, case variants,
// or lookalikes — because this predicate is all that stands between an ipc
// event payload and renderer code.
describe("isMenuCommand (preload boundary)", () => {
  it("accepts every member of the closed tuple", () => {
    for (const command of MENU_COMMANDS) {
      expect(isMenuCommand(command)).toBe(true);
    }
  });

  it("rejects case variants and unknown ids", () => {
    expect(isMenuCommand("NEW-FILE")).toBe(false);
    expect(isMenuCommand("New-File")).toBe(false);
    expect(isMenuCommand("new-file ")).toBe(false);
    expect(isMenuCommand("delete-everything")).toBe(false);
    expect(isMenuCommand("")).toBe(false);
  });

  it("rejects non-primitive impostors (String objects, toString tricks)", () => {
    expect(isMenuCommand(new String("new-file"))).toBe(false);
    expect(isMenuCommand({ toString: () => "new-file" })).toBe(false);
    expect(
      isMenuCommand(Object.assign(Object.create(null), { valueOf: () => "new-file" })),
    ).toBe(false);
    expect(isMenuCommand(["new-file"])).toBe(false);
  });

  it("rejects non-strings outright", () => {
    expect(isMenuCommand(null)).toBe(false);
    expect(isMenuCommand(undefined)).toBe(false);
    expect(isMenuCommand(0)).toBe(false);
    expect(isMenuCommand(Symbol("new-file"))).toBe(false);
  });
});

// The preload boundary for the explorer context-menu invoke RESULT — same
// attack set as isMenuCommand: a compromised/buggy responder can only ever
// deliver an exact member of the closed tuple to renderer code (anything
// else reads as null = "menu dismissed").
describe("isExplorerMenuCommand (preload boundary)", () => {
  it("accepts every member of the closed tuple", () => {
    for (const command of EXPLORER_MENU_COMMANDS) {
      expect(isExplorerMenuCommand(command)).toBe(true);
    }
  });

  it("rejects case variants, unknown ids, and non-primitive impostors", () => {
    expect(isExplorerMenuCommand("RENAME")).toBe(false);
    expect(isExplorerMenuCommand("rename ")).toBe(false);
    expect(isExplorerMenuCommand("rm -rf")).toBe(false);
    expect(isExplorerMenuCommand("")).toBe(false);
    expect(isExplorerMenuCommand(new String("rename"))).toBe(false);
    expect(isExplorerMenuCommand({ toString: () => "rename" })).toBe(false);
    expect(isExplorerMenuCommand(["rename"])).toBe(false);
    expect(isExplorerMenuCommand(null)).toBe(false);
    expect(isExplorerMenuCommand(undefined)).toBe(false);
  });
});

describe("isWorkbenchMenuCommand (preload boundary)", () => {
  it("accepts every member of the closed tuple", () => {
    for (const command of WORKBENCH_MENU_COMMANDS) {
      expect(isWorkbenchMenuCommand(command)).toBe(true);
    }
  });

  it("rejects case variants, unknown ids, and non-primitive impostors", () => {
    expect(isWorkbenchMenuCommand("CLOSE-TAB")).toBe(false);
    expect(isWorkbenchMenuCommand("close-tab ")).toBe(false);
    expect(isWorkbenchMenuCommand("open-terminal")).toBe(false);
    expect(isWorkbenchMenuCommand("")).toBe(false);
    expect(isWorkbenchMenuCommand(new String("close-tab"))).toBe(false);
    expect(isWorkbenchMenuCommand({ toString: () => "close-tab" })).toBe(false);
    expect(isWorkbenchMenuCommand(["close-tab"])).toBe(false);
    expect(isWorkbenchMenuCommand(null)).toBe(false);
    expect(isWorkbenchMenuCommand(undefined)).toBe(false);
  });
});

describe("parseWorkspaceActivatedEvent (preload boundary)", () => {
  it("keeps workspace kind and mode tuples in sync with workspace-core", () => {
    expect(workspaceKindDriftGuard).toBe(true);
    expect(workspaceModeDriftGuard).toBe(true);
    expect(WORKSPACE_KINDS).toEqual(CORE_WORKSPACE_KINDS);
    expect(WORKSPACE_MODES).toEqual(CORE_WORKSPACE_MODES);
  });

  it("accepts a workspace summary and strips extra fields", () => {
    expect(
      parseWorkspaceActivatedEvent({
        workspaceId: "ws-123",
        rootPath: "/home/ice/dohc",
        kind: "personal",
        mode: "local-first",
        extra: "ignored",
      }),
    ).toEqual({
      workspaceId: "ws-123",
      rootPath: "/home/ice/dohc",
      kind: "personal",
      mode: "local-first",
    });
  });

  it("rejects malformed ids, kinds, modes, and impostors", () => {
    expect(
      parseWorkspaceActivatedEvent({
        workspaceId: "WS-123",
        rootPath: "/home/ice/dohc",
        kind: "personal",
        mode: "local-first",
      }),
    ).toBeNull();
    expect(
      parseWorkspaceActivatedEvent({
        workspaceId: "ws-123",
        rootPath: "/home/ice/dohc",
        kind: "admin",
        mode: "local-first",
      }),
    ).toBeNull();
    expect(
      parseWorkspaceActivatedEvent({
        workspaceId: "ws-123",
        rootPath: "/home/ice/dohc",
        kind: "personal",
        mode: "remote-code-exec",
      }),
    ).toBeNull();
    expect(parseWorkspaceActivatedEvent(["ws-123"])).toBeNull();
    expect(parseWorkspaceActivatedEvent(new String("ws-123"))).toBeNull();
    expect(
      parseWorkspaceActivatedEvent(
        Object.create({
          workspaceId: "ws-123",
          rootPath: "/home/ice/dohc",
          kind: "personal",
          mode: "local-first",
        }),
      ),
    ).toBeNull();
  });
});

// The preload boundary for main→renderer update events — same attack set as
// isMenuCommand: only a plain object with exact tuple-member status/channel
// fields and bounded primitive public metadata passes.
describe("parseUpdateStateEvent (preload boundary)", () => {
  it("accepts every closed-tuple status and strips unknown fields", () => {
    for (const status of UPDATE_STATUSES) {
      expect(parseUpdateStateEvent({ status, message: "m" })).toEqual({
        status,
        message: "m",
      });
    }
    expect(
      parseUpdateStateEvent({ status: "ready", message: "m", evil: "x" }),
    ).toEqual({ status: "ready", message: "m" });
  });

  it("accepts validated public update metadata", () => {
    expect(
      parseUpdateStateEvent({
        status: "ready",
        message: "Update 1.2.4 is ready",
        currentVersion: "1.2.3",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.4",
        percent: 100,
        extra: "dropped",
      }),
    ).toEqual({
      status: "ready",
      message: "Update 1.2.4 is ready",
      currentVersion: "1.2.3",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.4",
      percent: 100,
    });
  });

  it("rejects unknown/case-variant statuses and non-primitive impostors", () => {
    expect(parseUpdateStateEvent({ status: "READY", message: "m" })).toBeNull();
    expect(parseUpdateStateEvent({ status: "pwn", message: "m" })).toBeNull();
    expect(
      parseUpdateStateEvent({ status: new String("ready"), message: "m" }),
    ).toBeNull();
    expect(
      parseUpdateStateEvent({ status: { toString: () => "ready" }, message: "m" }),
    ).toBeNull();
  });

  it("rejects missing, empty, oversized, or non-string messages", () => {
    expect(parseUpdateStateEvent({ status: "ready" })).toBeNull();
    expect(parseUpdateStateEvent({ status: "ready", message: "" })).toBeNull();
    expect(
      parseUpdateStateEvent({ status: "ready", message: "x".repeat(501) }),
    ).toBeNull();
    expect(parseUpdateStateEvent({ status: "ready", message: 42 })).toBeNull();
  });

  it("rejects malformed public update metadata", () => {
    const base = { status: "ready", message: "m" };
    expect(parseUpdateStateEvent({ ...base, currentVersion: "" })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, currentVersion: "x".repeat(201) })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, version: "" })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, channel: "beta" })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, canCheck: "true" })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, canInstall: 1 })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, percent: 0 })).toEqual({
      status: "ready",
      message: "m",
      percent: 0,
    });
    expect(parseUpdateStateEvent({ ...base, percent: -1 })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, percent: 101 })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, percent: Infinity })).toBeNull();
    expect(parseUpdateStateEvent({ ...base, percent: Number.NaN })).toBeNull();
  });

  it("rejects non-objects, null, and arrays", () => {
    expect(parseUpdateStateEvent(null)).toBeNull();
    expect(parseUpdateStateEvent("ready")).toBeNull();
    expect(parseUpdateStateEvent([{ status: "ready", message: "m" }])).toBeNull();
  });

  it("rejects INHERITED status/message — only own properties count as a plain object", () => {
    expect(
      parseUpdateStateEvent(Object.create({ status: "ready", message: "x" })),
    ).toBeNull();
    // One own + one inherited still fails: BOTH fields must be own.
    const halfOwn = Object.create({ message: "x" }) as { status?: string };
    halfOwn.status = "ready";
    expect(parseUpdateStateEvent(halfOwn)).toBeNull();
    // Null-prototype objects with own fields remain fine.
    expect(
      parseUpdateStateEvent(
        Object.assign(Object.create(null), { status: "ready", message: "x" }),
      ),
    ).toEqual({ status: "ready", message: "x" });
  });
});

// The preload boundary for main→renderer search-result events (Phase E5.0) —
// same attack set as parseUpdateStateEvent: only a plain object with a
// bounded primitive searchId and entries that ALL pass the closed shape gets
// through, rebuilt field by field so nothing extra ever crosses.
describe("parseSearchResultsEvent (preload boundary)", () => {
  const entry = {
    path: "notes/a.md",
    line: 3,
    column: 5,
    preview: "one needle two",
    matchStart: 4,
    matchEnd: 10,
  };
  const batch = { searchId: "s1", entries: [entry], done: false, limitHit: false };

  it("accepts a well-formed batch and rebuilds only the validated fields", () => {
    const parsed = parseSearchResultsEvent({
      ...batch,
      entries: [{ ...entry, extra: "dropped" }],
      injected: true,
    });
    expect(parsed).toEqual(batch);
    expect(parsed!.entries[0]).not.toHaveProperty("extra");
    expect(parsed).not.toHaveProperty("injected");
  });

  it("accepts optional engine result fields", () => {
    const engineEntry = {
      ...entry,
      surface: "chat",
      threadId: "thread-1",
      objectId: "object-1",
      title: "Planning chat",
    };
    expect(
      parseSearchResultsEvent({
        searchId: "s-engine",
        entries: [engineEntry],
        done: true,
        limitHit: false,
      }),
    ).toEqual({
      searchId: "s-engine",
      entries: [engineEntry],
      done: true,
      limitHit: false,
    });
  });

  it("accepts an empty done batch (the final flush)", () => {
    expect(
      parseSearchResultsEvent({ searchId: "s2", entries: [], done: true, limitHit: true }),
    ).toEqual({ searchId: "s2", entries: [], done: true, limitHit: true });
  });

  it("rejects unsafe paths: absolute, traversal, backslash, null byte, drive letter", () => {
    for (const path of [
      "/etc/passwd",
      "../escape.md",
      "a/../b.md",
      "a\\b.md",
      "a\0b.md",
      "C:evil.md",
      "",
      "x".repeat(5000),
    ]) {
      expect(
        parseSearchResultsEvent({ ...batch, entries: [{ ...entry, path }] }),
        JSON.stringify(path),
      ).toBeNull();
    }
  });

  it("rejects out-of-bounds offsets, non-integer lines, oversized previews", () => {
    expect(
      parseSearchResultsEvent({ ...batch, entries: [{ ...entry, matchEnd: 999 }] }),
    ).toBeNull();
    expect(
      parseSearchResultsEvent({ ...batch, entries: [{ ...entry, matchStart: -1 }] }),
    ).toBeNull();
    expect(
      parseSearchResultsEvent({ ...batch, entries: [{ ...entry, matchEnd: 2, matchStart: 4 }] }),
    ).toBeNull();
    expect(
      parseSearchResultsEvent({ ...batch, entries: [{ ...entry, line: 0 }] }),
    ).toBeNull();
    expect(
      parseSearchResultsEvent({ ...batch, entries: [{ ...entry, line: 1.5 }] }),
    ).toBeNull();
    expect(
      parseSearchResultsEvent({
        ...batch,
        entries: [{ ...entry, preview: "x".repeat(251), matchStart: 0, matchEnd: 1 }],
      }),
    ).toBeNull();
    expect(
      parseSearchResultsEvent({ ...batch, entries: [{ ...entry, surface: "agent" }] }),
    ).toBeNull();
    expect(
      parseSearchResultsEvent({ ...batch, entries: [{ ...entry, threadId: "" }] }),
    ).toBeNull();
  });

  it("rejects oversized batches, bad ids, and non-primitive impostors", () => {
    expect(
      parseSearchResultsEvent({ ...batch, entries: Array.from({ length: 51 }, () => entry) }),
    ).toBeNull();
    expect(parseSearchResultsEvent({ ...batch, searchId: "" })).toBeNull();
    expect(parseSearchResultsEvent({ ...batch, searchId: "x".repeat(65) })).toBeNull();
    expect(parseSearchResultsEvent({ ...batch, searchId: new String("s1") })).toBeNull();
    expect(parseSearchResultsEvent({ ...batch, done: "false" })).toBeNull();
    expect(parseSearchResultsEvent({ ...batch, entries: entry })).toBeNull();
    expect(parseSearchResultsEvent(null)).toBeNull();
    expect(parseSearchResultsEvent([batch])).toBeNull();
    expect(parseSearchResultsEvent("batch")).toBeNull();
  });

  it("rejects INHERITED fields — only own properties count as a plain object", () => {
    expect(parseSearchResultsEvent(Object.create(batch))).toBeNull();
  });
});

describe("isSafeRelativePath", () => {
  it("accepts plain relative forward-slashed paths", () => {
    expect(isSafeRelativePath("a.md")).toBe(true);
    expect(isSafeRelativePath("notes/deep/file.txt")).toBe(true);
    expect(isSafeRelativePath(".hidden.md")).toBe(true);
  });

  it("rejects traversal, absolute, separators-in-disguise, and non-strings", () => {
    expect(isSafeRelativePath("..")).toBe(false);
    expect(isSafeRelativePath("a//b")).toBe(false);
    expect(isSafeRelativePath("a/./b")).toBe(false);
    expect(isSafeRelativePath("/a")).toBe(false);
    expect(isSafeRelativePath("D:stuff")).toBe(false);
    expect(isSafeRelativePath(42)).toBe(false);
    expect(isSafeRelativePath(new String("a.md"))).toBe(false);
  });
});

// Compile-time both-ways drift guard: UPDATE_STATUSES must cover exactly the
// update machine's statuses. Either side growing a member the other lacks
// fails this file's typecheck.
const _tupleCoversMachine: readonly UpdateState["status"][] = UPDATE_STATUSES;
const _machineCoversTuple: (typeof UPDATE_STATUSES)[number] =
  null as unknown as UpdateState["status"];
const _tupleCoversUpdaterChannels: readonly UpdateChannel[] = UPDATE_CHANNELS;
const _updaterChannelsCoverTuple: (typeof UPDATE_CHANNELS)[number] =
  null as unknown as UpdateChannel;
void _tupleCoversMachine;
void _machineCoversTuple;
void _tupleCoversUpdaterChannels;
void _updaterChannelsCoverTuple;

describe("update channel drift guard", () => {
  it("keeps preload and updater channel tuples in sync", () => {
    expect(UPDATE_CHANNELS).toEqual(UPDATER_UPDATE_CHANNELS);
  });
});

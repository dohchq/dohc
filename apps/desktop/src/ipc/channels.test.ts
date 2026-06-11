import { describe, expect, it } from "vitest";
import type { UpdateState } from "../updates/updateMachine";
import {
  isMenuCommand,
  MENU_COMMANDS,
  parseUpdateStateEvent,
  UPDATE_STATUSES,
} from "./channels";

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

// The preload boundary for main→renderer update events — same attack set as
// isMenuCommand: only a plain object with an exact tuple-member status and a
// bounded primitive-string message passes, and only those two fields survive.
describe("parseUpdateStateEvent (preload boundary)", () => {
  it("accepts every closed-tuple status and strips extra fields", () => {
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

// Compile-time both-ways drift guard: UPDATE_STATUSES must cover exactly the
// update machine's statuses. Either side growing a member the other lacks
// fails this file's typecheck.
const _tupleCoversMachine: readonly UpdateState["status"][] = UPDATE_STATUSES;
const _machineCoversTuple: (typeof UPDATE_STATUSES)[number] =
  null as unknown as UpdateState["status"];
void _tupleCoversMachine;
void _machineCoversTuple;

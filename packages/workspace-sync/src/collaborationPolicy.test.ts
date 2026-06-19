import { describe, expect, it } from "vitest";
import type { ChangeSet } from "@dohc/workspace-core";
import { decideCollaboration, type CollaborationDecision } from "./collaborationPolicy";

// Only the non-sync decisions carry a reason; narrow for the assertions.
function reasonOf(decision: CollaborationDecision): string {
  return "reason" in decision ? decision.reason : "";
}

const user = { kind: "user" as const, userId: "maya" };
const agent = { kind: "agent" as const, agentId: "codex-local", onBehalfOf: "maya" };

function set(partial: Partial<ChangeSet> = {}): ChangeSet {
  return {
    kind: "user-edit",
    author: user,
    summary: "Edited 1 file",
    files: [{ path: "notes/today.md", operation: "write" }],
    boundaryCrossings: [],
    ...partial,
  };
}

describe("liberal collaboration policy", () => {
  it("allows normal user edits to sync with no ceremony", () => {
    expect(decideCollaboration({ set: set() })).toEqual({ action: "sync" });
  });

  it("allows normal agent edits to sync with no approval", () => {
    const decision = decideCollaboration({
      set: set({ kind: "agent-run", author: agent }),
    });
    expect(decision).toEqual({ action: "sync" });
  });

  it("proposes instead of writing when a change touches an explicitly protected target", () => {
    const decision = decideCollaboration({
      set: set({ files: [{ path: "finance/ledger.md", operation: "write" }] }),
      protectedPaths: ["finance"],
    });
    expect(decision.action).toBe("propose");
    expect(reasonOf(decision)).toMatch(/protected/i);
  });

  it("treats protected paths with trailing slashes as protected", () => {
    const decision = decideCollaboration({
      set: set({ files: [{ path: "finance/ledger.md", operation: "write" }] }),
      protectedPaths: ["finance/"],
    });
    expect(decision.action).toBe("propose");
  });

  it("does not treat sibling paths as protected (finance-notes is not finance/)", () => {
    const decision = decideCollaboration({
      set: set({ files: [{ path: "finance-notes/x.md", operation: "write" }] }),
      protectedPaths: ["finance"],
    });
    expect(decision).toEqual({ action: "sync" });
  });

  it("requires confirmation for boundary crossings", () => {
    const decision = decideCollaboration({
      set: set({ boundaryCrossings: ["permission-change"] }),
    });
    expect(decision.action).toBe("confirm");
    expect(reasonOf(decision)).toMatch(/permission/i);
  });

  it("keeps a permission-denied change local with a plain-language explanation", () => {
    const decision = decideCollaboration({ set: set(), permissionDenied: true });
    expect(decision.action).toBe("keep-local");
    expect(reasonOf(decision)).toMatch(/stays on this device|kept locally|don't have access/i);
    expect(reasonOf(decision)).not.toMatch(/403|forbidden|ERR/);
  });

  it("protection outranks liberal sync; denial outranks everything", () => {
    const denied = decideCollaboration({
      set: set({ boundaryCrossings: ["public-share"] }),
      protectedPaths: ["notes"],
      permissionDenied: true,
    });
    expect(denied.action).toBe("keep-local");

    const protectedAndCrossing = decideCollaboration({
      set: set({ boundaryCrossings: ["public-share"] }),
      protectedPaths: ["notes"],
    });
    // A crossing needs the human regardless of protection.
    expect(protectedAndCrossing.action).toBe("confirm");
  });
});

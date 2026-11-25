import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { expect, it, vi } from "vitest";
import { catchUpFromJournal } from "./ownerJournal";

const target = {
  binding: {
    workspaceId: "workspace",
    mainVersionId: "main",
    objectId: "note",
    lineageClaimId: "a".repeat(64),
    currentPath: "note.md",
    selectorPaths: ["note.md"],
    restoreFenceGeneration: 0,
  },
  relayDatabaseNamespace: "relay",
};
const catchUp = (acceptedCursor: number, through: number) => {
  const read = vi.fn(async () => "not-retired" as const);
  const client = {
    ownerYDocReadState: vi.fn(async () => ({ revision: 1, acceptedCursor, nativeHeadSequence: 1 })),
    ownerYDocApplyAcceptedFrame: vi.fn(),
  } as unknown as EngineClient;
  return {
    read,
    result: catchUpFromJournal({
      client,
      workspaceHandle: "handle",
      target,
      read,
      signal: new AbortController().signal,
      through,
    }),
  };
};

it("reads nothing for a note this computer applied through the server's last save", async () => {
  const { read, result } = catchUp(14, 14);
  expect(await result).toBe(14);
  expect(read).not.toHaveBeenCalled();
});

it("waits for the server to retire a note this computer has not applied through its last save", async () => {
  const { read, result } = catchUp(12, 14);
  expect(await result).toBeNull();
  expect(read).toHaveBeenCalledWith(12, expect.any(AbortSignal));
});

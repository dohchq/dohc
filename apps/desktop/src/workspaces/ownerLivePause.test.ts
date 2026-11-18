import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { settleOwnerLivePauses, type RelayLivePause } from "./ownerLivePause";

const binding = {
  workspaceId: "ws",
  mainVersionId: "main",
  objectId: "note",
  lineageClaimId: "lineage",
  currentPath: "notes/plan.md",
  restoreFenceGeneration: 0,
  selectorPaths: [],
} as never;
const roomCopy = Uint8Array.of(1, 2, 3);
const sha256 = createHash("sha256").update(roomCopy).digest("hex");
const pause: RelayLivePause = {
  pauseId: "pause",
  objectId: "note",
  lineageClaimId: "lineage",
  savedCursor: 7,
  cause: "refused",
  refusal: "capacity-refused",
  named: [
    [{ kind: "human", humanId: "h", humanName: "Ana" }],
    [
      { kind: "link", publicPrincipalId: "p", label: "Ben" },
      { kind: "human", humanId: "h", humanName: "Ana" },
    ],
  ],
  copy: { sha256, byteLength: roomCopy.byteLength },
};

/** An engine that holds one paused Stop once paused, and a folder of files. */
function fixture() {
  let stop: { copyPath: string; copyWritten: boolean; leftOut: boolean } | null = null;
  const files = new Map<string, string>([["notes/plan (unsaved edits).md", "older"]]);
  const held = () =>
    stop && {
      stop: { document: { currentPath: "notes/plan.md" }, paused: { ...stop } },
      bytes: Buffer.from("Ana's words and the owner's"),
    };
  const client = {
    ownerYDocPausedCopy: vi.fn(async () => held()),
    ownerYDocPause: vi.fn(async (_request: unknown, input: { copyPath: string }) => {
      stop = { copyPath: input.copyPath, copyWritten: false, leftOut: true };
      return {};
    }),
    ownerYDocPausedCopyWritten: vi.fn(
      async (_request: unknown, _document: unknown, copyPath: string) => {
        stop = { ...stop!, copyPath, copyWritten: true };
        return { paused: { ...stop } };
      },
    ),
  };
  const relay = {
    copy: vi.fn(async () => roomCopy),
    copyWritten: vi.fn(async () => {}),
  };
  const writes = {
    exists: async (path: string) => files.has(path),
    create: vi.fn(async (path: string, text: string) => {
      files.set(path, text);
      return path;
    }),
  };
  const errors: unknown[] = [];
  const settle = (pauses = [pause]) =>
    settleOwnerLivePauses({
      pauses,
      documents: [{ binding, relayDatabaseNamespace: "ns" }],
      client: client as never,
      workspaceHandle: "handle",
      relay,
      writes,
      signal: new AbortController().signal,
      onError: (_pause, error) => errors.push(error),
    });
  return { client, relay, files, errors, settle, setStop: (value: typeof stop) => (stop = value) };
}

describe("settleOwnerLivePauses", () => {
  it("pauses with the room's copy, writes the copy next to the note, then lets the server delete its own", async () => {
    const f = fixture();
    expect(await f.settle()).toEqual([
      {
        pauseId: "pause",
        objectId: "note",
        path: "notes/plan.md",
        cause: "refused",
        names: ["Ana", "Ben"],
        copyPath: "notes/plan (unsaved edits 2).md",
        leftOut: true,
      },
    ]);
    expect(f.client.ownerYDocPause).toHaveBeenCalledWith(
      expect.anything(),
      {
        binding,
        appliedCursor: 7,
        rowCursor: 7,
        copyPath: "notes/plan (unsaved edits 2).md",
        roomCopy,
      },
      expect.anything(),
    );
    expect(f.files.get("notes/plan (unsaved edits 2).md")).toBe("Ana's words and the owner's");
    expect(f.files.get("notes/plan (unsaved edits).md")).toBe("older");
    expect(f.relay.copyWritten).toHaveBeenCalledWith("pause", sha256, expect.anything());
    expect(f.errors).toEqual([]);
  });

  it("finishes a pause an earlier pass left with its copy unwritten, under a free name", async () => {
    const f = fixture();
    // The name picked at the pause was taken before the copy was written.
    f.setStop({ copyPath: "notes/plan (unsaved edits).md", copyWritten: false, leftOut: false });
    const [told] = await f.settle();
    expect(f.client.ownerYDocPause).not.toHaveBeenCalled();
    expect(f.relay.copy).not.toHaveBeenCalled();
    expect(told).toMatchObject({ copyPath: "notes/plan (unsaved edits 2).md", leftOut: false });
    expect(f.files.get("notes/plan (unsaved edits).md")).toBe("older");
    expect(f.relay.copyWritten).toHaveBeenCalledOnce();
  });

  it("tells the owner of a note whose copy is already written and the server's deleted, and calls no one", async () => {
    const f = fixture();
    f.setStop({ copyPath: "notes/plan (unsaved edits 2).md", copyWritten: true, leftOut: false });
    const [told] = await f.settle([{ ...pause, refusal: "stale-binding", copy: null }]);
    expect(told).toMatchObject({ cause: "moved", copyPath: "notes/plan (unsaved edits 2).md" });
    expect(f.client.ownerYDocPausedCopyWritten).not.toHaveBeenCalled();
    expect(f.relay.copyWritten).not.toHaveBeenCalled();
  });

  it("pauses nothing when the server's copy is not the one it listed, and tries again on the next pass", async () => {
    const f = fixture();
    f.relay.copy.mockResolvedValueOnce(Uint8Array.of(9));
    expect(await f.settle()).toEqual([]);
    expect(f.errors).toHaveLength(1);
    expect(f.client.ownerYDocPause).not.toHaveBeenCalled();
    expect(f.relay.copyWritten).not.toHaveBeenCalled();
    expect(await f.settle()).toHaveLength(1);
  });
});

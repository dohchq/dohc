import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { settleOwnerLivePauses, type OwnerLivePause, type RelayLivePause } from "./ownerLivePause";

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
  path: "notes/plan.md",
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
const document = { mainVersionId: "main", objectId: "note", currentPath: "notes/plan.md" };

type Stop = { copyPath: string; copyWritten: boolean; leftOut: boolean; appliedCursor?: number };

/** An engine that holds one paused Stop once paused, and a folder of files. */
function fixture() {
  let stop: Stop | null = null;
  const files = new Map<string, string>([["notes/plan (unsaved edits).md", "older"]]);
  const held = () =>
    stop && {
      stop: { document, paused: { ...stop } },
      bytes: Buffer.from("Ana's words and the owner's"),
    };
  const client = {
    ownerYDocPausedCopy: vi.fn(async () => held()),
    ownerYDocPause: vi.fn(async (_request: unknown, input: { copyPath: string }) => {
      stop = { copyPath: input.copyPath, copyWritten: false, leftOut: true, appliedCursor: 7 };
      return {};
    }),
    ownerYDocPausedCopyWritten: vi.fn(
      async (_request: unknown, _document: unknown, copyPath: string) => {
        stop = { ...stop!, copyPath, copyWritten: true };
        return { paused: { ...stop } };
      },
    ),
    ownerYDocStopList: vi.fn(async () => (stop ? [{ document, paused: { ...stop } }] : [])),
    ownerYDocStopClear: vi.fn(async () => {
      stop = null;
      return [];
    }),
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
  const render = vi.fn(async (_state: Uint8Array) => "The room's words");
  const errors: unknown[] = [];
  const settle = (
    pauses = [pause],
    options: { listed?: boolean; previous?: OwnerLivePause[] } = {},
  ) =>
    settleOwnerLivePauses({
      pauses,
      previous: options.previous ?? [],
      documents: options.listed === false ? [] : [{ binding, relayDatabaseNamespace: "ns" }],
      client: client as never,
      workspaceHandle: "handle",
      relay,
      writes,
      render,
      signal: new AbortController().signal,
      onError: (_pause, error) => errors.push(error),
    });
  return {
    client,
    relay,
    files,
    render,
    errors,
    settle,
    setStop: (value: Stop | null) => (stop = value),
  };
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
    expect(f.render).not.toHaveBeenCalled();
    expect(f.relay.copyWritten).toHaveBeenCalledWith("pause", sha256, expect.anything());
    // The Stop stays while the server holds the pause.
    expect(f.client.ownerYDocStopClear).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  });

  it("writes an earlier Stop's copy and the server's in files of their own, since the Stop may hold an earlier pause", async () => {
    const f = fixture();
    // The name picked at that pause was taken before its copy was written.
    f.setStop({ copyPath: "notes/plan (unsaved edits).md", copyWritten: false, leftOut: false });
    const [told] = await f.settle();
    expect(f.client.ownerYDocPause).not.toHaveBeenCalled();
    expect(f.files.get("notes/plan (unsaved edits).md")).toBe("older");
    expect(f.files.get("notes/plan (unsaved edits 2).md")).toBe("Ana's words and the owner's");
    expect(f.render).toHaveBeenCalledWith(roomCopy);
    expect(f.files.get("notes/plan (unsaved edits 3).md")).toBe("The room's words");
    expect(told).toMatchObject({ copyPath: "notes/plan (unsaved edits 3).md", leftOut: false });
    expect(f.relay.copyWritten).toHaveBeenCalledOnce();
  });

  it("never lets the server delete a copy that only an earlier pause's written Stop stands for", async () => {
    const f = fixture();
    f.setStop({ copyPath: "notes/plan (unsaved edits).md", copyWritten: true, leftOut: true });
    const [told] = await f.settle();
    expect(f.client.ownerYDocPause).not.toHaveBeenCalled();
    expect(f.files.get("notes/plan (unsaved edits 2).md")).toBe("The room's words");
    expect(told).toMatchObject({ copyPath: "notes/plan (unsaved edits 2).md", leftOut: false });
    expect(f.relay.copyWritten).toHaveBeenCalledOnce();
  });

  it("writes the server's copy of a note whose file was moved, deleted or replaced next to where it was", async () => {
    const f = fixture();
    const [told] = await f.settle([{ ...pause, refusal: "stale-binding" }], { listed: false });
    expect(f.client.ownerYDocPause).not.toHaveBeenCalled();
    expect(f.files.get("notes/plan (unsaved edits 2).md")).toBe("The room's words");
    expect(told).toMatchObject({ cause: "ended", copyPath: "notes/plan (unsaved edits 2).md" });
    expect(f.relay.copyWritten).toHaveBeenCalledWith("pause", sha256, expect.anything());
  });

  it("names a copy written earlier when the server's is already deleted, and writes nothing", async () => {
    const f = fixture();
    const previous = [
      {
        pauseId: "pause",
        objectId: "note",
        path: "notes/plan.md",
        cause: "refused" as const,
        names: [],
        copyPath: "notes/plan (unsaved edits 4).md",
        leftOut: false,
      },
    ];
    expect(await f.settle([{ ...pause, copy: null }], { previous })).toMatchObject([
      { copyPath: "notes/plan (unsaved edits 4).md" },
    ]);
    // After a restart only a Stop paused at this pause's save names its copy.
    expect(await f.settle([{ ...pause, copy: null }])).toMatchObject([{ copyPath: null }]);
    f.setStop({ copyPath: "notes/plan (unsaved edits 5).md", copyWritten: true, leftOut: true });
    expect(await f.settle([{ ...pause, copy: null }])).toMatchObject([{ copyPath: null }]);
    f.setStop({
      copyPath: "notes/plan (unsaved edits 5).md",
      copyWritten: true,
      leftOut: true,
      appliedCursor: 7,
    });
    expect(await f.settle([{ ...pause, copy: null }])).toMatchObject([
      { copyPath: "notes/plan (unsaved edits 5).md", leftOut: true },
    ]);
    expect(f.relay.copy).not.toHaveBeenCalled();
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

  it("writes the copy of a Stop whose pause ended elsewhere, then clears the Stop", async () => {
    const f = fixture();
    f.setStop({ copyPath: "notes/plan (unsaved edits).md", copyWritten: false, leftOut: false });
    expect(await f.settle([])).toEqual([]);
    expect(f.files.get("notes/plan (unsaved edits 2).md")).toBe("Ana's words and the owner's");
    expect(f.client.ownerYDocStopClear).toHaveBeenCalledWith(
      expect.anything(),
      document,
      expect.anything(),
    );
    expect(f.relay.copyWritten).not.toHaveBeenCalled();
  });

  it("clears no Stop while the server still holds its pause", async () => {
    const f = fixture();
    f.setStop({ copyPath: "notes/plan (unsaved edits).md", copyWritten: true, leftOut: false });
    await f.settle([{ ...pause, copy: null }]);
    expect(f.client.ownerYDocStopClear).not.toHaveBeenCalled();
  });
});

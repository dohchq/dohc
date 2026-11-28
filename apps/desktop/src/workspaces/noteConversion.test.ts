import { describe, expect, it, vi } from "vitest";
import {
  NOTE_CONVERSION_NOT_OWNER,
  NOTE_CONVERSION_OFF,
  NOTE_CONVERSION_PAUSED,
  NOTE_CONVERSION_RUNNING,
  NOTE_CONVERSION_SHARED_VIEW,
  RELAY_UNREACHABLE,
  createNoteConversion,
  noteConversionOffered,
  noteConversionReach,
  stopsOnceSyncStarts,
  type NoteConversionRelay,
} from "./noteConversion";

type Params = { after?: string; budget: number; relayLive: string[] };
type Outcome = Record<string, unknown> | Error;

function pass(overrides: Record<string, unknown> = {}) {
  return {
    off: false,
    converted: 0,
    unchanged: 0,
    skipped: [],
    doesNotFit: [],
    failed: [],
    resumeAfter: null,
    total: 3,
    ...overrides,
  };
}

function oneNoteAtATime(outcomes: Outcome[], seen?: string[]) {
  let index = 0;
  return vi.fn(async (_params: Params) => {
    const outcome = outcomes[index];
    index += 1;
    seen?.push("note");
    if (outcome instanceof Error) throw outcome;
    return pass({
      ...outcome,
      resumeAfter: index < outcomes.length ? `n${index}` : null,
      total: outcomes.length,
    });
  });
}

const converted = (count: number): Outcome[] =>
  Array.from({ length: count }, () => ({ converted: 1 }));

const live = (objectIds: string[], engineApiMin: unknown = 2) => ({
  engineApiMin,
  notes: objectIds.map((objectId) => ({ objectId })),
});

function relay(overrides: Partial<NoteConversionRelay> = {}) {
  return {
    liveNotes: vi.fn(async (): Promise<unknown> => live(["live-1"])),
    drainRecorded: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(error instanceof Error)) throw new Error("expected the run to fail");
  return error;
}

describe("note conversion run", () => {
  it("checks the relay's engine floor before it drains anything, and names the setting", async () => {
    const convert = vi.fn(async () => pass());
    const run = createNoteConversion();
    for (const [floor, words] of [
      [1, "is 1"],
      [null, "is not set"],
      [undefined, "is not set"],
      ["2", "is not a valid number"],
      [2.5, "is not a valid number"],
    ] as const) {
      const answer = floor === undefined ? { notes: [] } : live([], floor);
      const low = relay({ liveNotes: vi.fn(async () => answer) });
      await expect(
        run("ws", { relay: low, convert, assertCurrent: () => undefined }),
      ).rejects.toThrow(
        `dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN ${words}; it must be 2.`,
      );
      expect(low.drainRecorded).not.toHaveBeenCalled();
    }
    expect(convert).not.toHaveBeenCalled();

    const ready = relay();
    await expect(
      run("ws", { relay: ready, convert, assertCurrent: () => undefined }),
    ).resolves.toMatchObject({ sent: true });
    expect(convert).toHaveBeenCalledOnce();
  });

  it("refuses when the engine reports the format off and returns no result", async () => {
    const remote = relay();
    await expect(
      createNoteConversion()("ws", {
        relay: remote,
        convert: async () => pass({ off: true, resumeAfter: null }),
        assertCurrent: () => undefined,
      }),
    ).rejects.toThrow(NOTE_CONVERSION_OFF);
    expect(remote.drainRecorded).toHaveBeenCalledOnce();
  });

  it("skips the floor, the live list and every push for a local-only workspace", async () => {
    const convert = oneNoteAtATime([{ converted: 1 }, { converted: 1 }, { unchanged: 1 }]);
    await expect(
      createNoteConversion()("ws", { relay: null, convert, assertCurrent: () => undefined }),
    ).resolves.toEqual({
      converted: 2,
      unchanged: 1,
      skipped: [],
      doesNotFit: [],
      failed: [],
      sent: true,
    });
    expect(convert.mock.calls.map(([params]) => params)).toEqual([
      { budget: 1, relayLive: [] },
      { after: "n1", budget: 1, relayLive: [] },
      { after: "n2", budget: 1, relayLive: [] },
    ]);
  });

  it("converts one note per call, reads the live list once per batch, and keeps going past unreadable notes", async () => {
    const remote = relay({
      liveNotes: vi
        .fn<NoteConversionRelay["liveNotes"]>()
        .mockResolvedValueOnce(live([]))
        .mockResolvedValueOnce(live(["live-1"]))
        .mockResolvedValueOnce(live(["live-2"])),
    });
    const bad: Outcome[] = Array.from({ length: 10 }, (_, index) => ({
      failed: [
        { objectId: `bad-${index}`, path: "", reason: "object_id must be non-empty and bounded" },
      ],
    }));
    const convert = oneNoteAtATime([...bad, { converted: 1 }]);

    const result = await createNoteConversion()("ws", {
      relay: remote,
      convert,
      assertCurrent: () => undefined,
    });

    const calls = convert.mock.calls.map(([params]) => params);
    expect(calls).toHaveLength(11);
    expect(calls[0]).toEqual({ budget: 1, relayLive: ["live-1"] });
    expect(calls[9]).toEqual({ after: "n9", budget: 1, relayLive: ["live-1"] });
    expect(calls[10]).toEqual({ after: "n10", budget: 1, relayLive: ["live-2"] });
    expect(remote.liveNotes).toHaveBeenCalledTimes(3);
    expect(result.converted).toBe(1);
    expect(result.failed).toHaveLength(10);
    expect(result.failed[0]).toEqual({
      path: "",
      reason: "object_id must be non-empty and bounded",
    });
    expect(remote.drainRecorded).toHaveBeenCalledTimes(2);
  });

  it("drains between batches that converted notes and once more at the end", async () => {
    const order: string[] = [];
    const remote = relay({
      drainRecorded: vi.fn(async () => void order.push("drain")),
      liveNotes: vi.fn(async () => (order.push("live"), live([]))),
    });
    const unchanged: Outcome[] = Array.from({ length: 10 }, () => ({ unchanged: 1 }));
    const convert = oneNoteAtATime([...converted(10), ...unchanged, { converted: 1 }], order);

    await createNoteConversion()("ws", { relay: remote, convert, assertCurrent: () => undefined });

    const notes = (count: number) => Array.from({ length: count }, () => "note");
    expect(order).toEqual([
      "live",
      "drain",
      "live",
      ...notes(10),
      "drain",
      "live",
      ...notes(10),
      "live",
      "note",
      "drain",
    ]);
  });

  it("reports converted notes it could not send when the last drain fails", async () => {
    const drainRecorded = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("relay down"));
    const convert = oneNoteAtATime(converted(11));

    const result = await createNoteConversion()("ws", {
      relay: relay({ drainRecorded }),
      convert,
      assertCurrent: () => undefined,
    });

    expect(result).toMatchObject({ converted: 11, sent: false });
    expect(convert).toHaveBeenCalledTimes(11);
    expect(drainRecorded).toHaveBeenCalledTimes(3);
  });

  it("refuses to start when what the workspace recorded cannot be drained first", async () => {
    const convert = vi.fn(async () => pass());
    await expect(
      createNoteConversion()("ws", {
        relay: relay({
          drainRecorded: vi.fn(async () =>
            Promise.reject(new Error("dohc could not send changes to your server.")),
          ),
        }),
        convert,
        assertCurrent: () => undefined,
      }),
    ).rejects.toThrow("dohc could not send changes to your server.");
    expect(convert).not.toHaveBeenCalled();
  });

  it("says how many notes it converted when a later note fails", async () => {
    const fatal = new Error("dohc could not read the workspace database.");
    const convert = oneNoteAtATime([{ converted: 1 }, fatal, { converted: 1 }]);

    const error = await failure(
      createNoteConversion()("ws", { relay: null, convert, assertCurrent: () => undefined }),
    );

    expect(error.message).toBe(
      "dohc could not read the workspace database. dohc converted 1 note before it stopped. Run Convert notes again to finish.",
    );
    expect(error.cause).toBe(fatal);
    expect(convert).toHaveBeenCalledTimes(2);

    const first = await failure(
      createNoteConversion()("ws", {
        relay: null,
        convert: async () => Promise.reject(fatal),
        assertCurrent: () => undefined,
      }),
    );
    expect(first).toBe(fatal);
  });

  it("carries the running count into a live list failure after earlier batches", async () => {
    const convert = oneNoteAtATime(converted(12));
    const error = await failure(
      createNoteConversion()("ws", {
        relay: relay({
          liveNotes: vi
            .fn<NoteConversionRelay["liveNotes"]>()
            .mockResolvedValueOnce(live([]))
            .mockResolvedValueOnce(live(["live-1"]))
            .mockRejectedValueOnce(new Error("dohc could not reach your server.")),
        }),
        convert,
        assertCurrent: () => undefined,
      }),
    );

    expect(error.message).toBe(
      "dohc could not reach your server. dohc converted 10 notes before it stopped. Run Convert notes again to finish.",
    );
    expect(convert).toHaveBeenCalledTimes(10);
  });

  it("stops when a later live list drops the engine floor to 1, and says what it converted", async () => {
    const convert = oneNoteAtATime(converted(12));
    const error = await failure(
      createNoteConversion()("ws", {
        relay: relay({
          liveNotes: vi
            .fn<NoteConversionRelay["liveNotes"]>()
            .mockResolvedValueOnce(live([]))
            .mockResolvedValueOnce(live(["live-1"]))
            .mockResolvedValueOnce(live(["live-1"], 1)),
        }),
        convert,
        assertCurrent: () => undefined,
      }),
    );

    expect(error.message).toBe(
      "dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN is 1; it must be 2. dohc converted 10 notes before it stopped. Run Convert notes again to finish.",
    );
    expect(convert).toHaveBeenCalledTimes(10);
  });

  it("says the relay could not be reached when the live list request fails on the network", async () => {
    for (const lost of [
      new TypeError("fetch failed"),
      Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
    ]) {
      const error = await failure(
        createNoteConversion()("ws", {
          relay: relay({ liveNotes: vi.fn(async () => Promise.reject(lost)) }),
          convert: async () => pass(),
          assertCurrent: () => undefined,
        }),
      );
      expect(error.message).toBe(RELAY_UNREACHABLE);
    }
  });

  it("says it could not read the relay's open notes when the reply has the wrong shape", async () => {
    const error = await failure(
      createNoteConversion()("ws", {
        relay: relay({ liveNotes: vi.fn(async () => ({ engineApiMin: 2, notes: "none" })) }),
        convert: async () => pass(),
        assertCurrent: () => undefined,
      }),
    );
    expect(error.message).toBe("dohc could not read which notes are open on the relay.");
  });

  it("stops at the next batch once sync is paused, and says what it converted", async () => {
    const convert = oneNoteAtATime(converted(12));
    const error = await failure(
      createNoteConversion()("ws", {
        relay: relay({
          liveNotes: vi
            .fn<NoteConversionRelay["liveNotes"]>()
            .mockResolvedValueOnce(live([]))
            .mockResolvedValueOnce(live([]))
            .mockRejectedValueOnce(new Error(NOTE_CONVERSION_PAUSED)),
        }),
        convert,
        assertCurrent: () => undefined,
      }),
    );

    expect(error.message).toBe(
      `${NOTE_CONVERSION_PAUSED} dohc converted 10 notes before it stopped. Run Convert notes again to finish.`,
    );
    expect(convert).toHaveBeenCalledTimes(10);
  });

  it("stops when a drain between batches fails, and says what it converted", async () => {
    const convert = oneNoteAtATime(converted(12));
    const error = await failure(
      createNoteConversion()("ws", {
        relay: relay({
          drainRecorded: vi
            .fn<() => Promise<void>>()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("Another account already claimed this workspace.")),
        }),
        convert,
        assertCurrent: () => undefined,
      }),
    );

    expect(error.message).toBe(
      "Another account already claimed this workspace. dohc converted 10 notes before it stopped. Run Convert notes again to finish.",
    );
    expect(convert).toHaveBeenCalledTimes(10);
  });

  it("sends nothing at the end when it converted nothing", async () => {
    const remote = relay();
    await expect(
      createNoteConversion()("ws", {
        relay: remote,
        convert: oneNoteAtATime([{ unchanged: 1 }, { unchanged: 1 }]),
        assertCurrent: () => undefined,
      }),
    ).resolves.toMatchObject({ converted: 0, unchanged: 2, sent: true });
    expect(remote.drainRecorded).toHaveBeenCalledOnce();
  });

  it("stops when the engine hands back the place it was asked to resume from", async () => {
    const convert = vi
      .fn(async (_params: Params) => pass({ converted: 1, resumeAfter: null }))
      .mockResolvedValueOnce(pass({ converted: 1, resumeAfter: "n1" }))
      .mockResolvedValueOnce(pass({ converted: 1, resumeAfter: "n1" }));
    const error = await failure(
      createNoteConversion()("ws", { relay: null, convert, assertCurrent: () => undefined }),
    );
    expect(error.message).toBe(
      "dohc could not convert notes because the engine did not move past the last note it read. dohc converted 2 notes before it stopped. Run Convert notes again to finish.",
    );
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it("stops before the next note once the window leaves the workspace, and says what it converted", async () => {
    let current = true;
    const convert = vi.fn(async () => {
      current = false;
      return pass({ converted: 1, resumeAfter: "a" });
    });

    const error = await failure(
      createNoteConversion()("ws", {
        relay: relay(),
        convert,
        assertCurrent: () => {
          if (!current)
            throw new Error("Converting notes stopped because this window changed workspaces.");
        },
      }),
    );

    expect(error.message).toBe(
      "Converting notes stopped because this window changed workspaces. dohc converted 1 note before it stopped. Run Convert notes again to finish.",
    );
    expect(convert).toHaveBeenCalledOnce();
  });

  it("stops after the batch in which a local-only workspace starts syncing, and says what it converted", async () => {
    let syncing = false;
    const outcomes = oneNoteAtATime(converted(4));
    const convert = vi.fn(async (params: Params) => {
      const answer = await outcomes(params);
      if (outcomes.mock.calls.length === 2) syncing = true;
      return answer;
    });

    const error = await failure(
      createNoteConversion(2)("ws", {
        relay: null,
        convert,
        assertCurrent: stopsOnceSyncStarts(
          () => undefined,
          () => syncing,
        ),
      }),
    );

    expect(error.message).toBe(
      "Sync was turned on while dohc converted notes. dohc converted 2 notes before it stopped. Run Convert notes again to finish.",
    );
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it("refuses a second run in the same workspace while one runs, and allows another workspace", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const run = createNoteConversion();
    const first = run("ws", {
      relay: null,
      convert: async () => (await held, pass()),
      assertCurrent: () => undefined,
    });

    await expect(
      run("ws", { relay: null, convert: async () => pass(), assertCurrent: () => undefined }),
    ).rejects.toThrow(NOTE_CONVERSION_RUNNING);
    await expect(
      run("other", { relay: null, convert: async () => pass(), assertCurrent: () => undefined }),
    ).resolves.toMatchObject({ sent: true });
    release();
    await first;
    await expect(
      run("ws", { relay: null, convert: async () => pass(), assertCurrent: () => undefined }),
    ).resolves.toMatchObject({ sent: true });
  });

  it("stops without converting when the relay's first live list cannot be read", async () => {
    const convert = vi.fn(async () => pass());
    await expect(
      createNoteConversion()("ws", {
        relay: relay({ liveNotes: vi.fn(async () => Promise.reject(new Error("relay down"))) }),
        convert,
        assertCurrent: () => undefined,
      }),
    ).rejects.toThrow("relay down");
    expect(convert).not.toHaveBeenCalled();
  });

  it("reports progress after each note against the engine's total", async () => {
    const progress = vi.fn();
    await createNoteConversion()("ws", {
      relay: null,
      convert: oneNoteAtATime([
        { converted: 1 },
        { unchanged: 1 },
        { doesNotFit: [{ objectId: "c", path: "c.md" }] },
      ]),
      assertCurrent: () => undefined,
      progress,
    });
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe("who converts a workspace's notes", () => {
  const owner = { serverUrl: "https://relay.example", ownerUserId: "owner" };

  it("runs a local-only workspace without the relay and an owner's synced one through it", () => {
    expect(noteConversionReach({ sharedView: false }, null)).toBe("local");
    expect(noteConversionReach({ sharedView: false, remote: owner }, "owner")).toBe("relay");
  });

  it("refuses a member's own full copy of a synced workspace, a shared view, and paused sync", () => {
    expect(() => noteConversionReach({ sharedView: false, remote: owner }, "member")).toThrow(
      NOTE_CONVERSION_NOT_OWNER,
    );
    expect(() => noteConversionReach({ sharedView: true, remote: owner }, "owner")).toThrow(
      NOTE_CONVERSION_SHARED_VIEW,
    );
    expect(() => noteConversionReach({ sharedView: false, pausedRemote: owner }, "owner")).toThrow(
      NOTE_CONVERSION_PAUSED,
    );
    expect(() => noteConversionReach({ sharedView: false, pausedRemote: owner }, "member")).toThrow(
      NOTE_CONVERSION_NOT_OWNER,
    );
  });

  it("offers conversion only to the owner, and only while the engine reads and writes the new format", () => {
    const on = { DOHC_ENGINE_NOTE_BODY_SEQUENCE: "1", DOHC_ENGINE_NEW_NOTE_BODY_SEQUENCE: "1" };
    const local = { sharedView: false };
    expect(noteConversionOffered(on, local, null)).toBe(true);
    expect(noteConversionOffered(on, { sharedView: false, remote: owner }, "owner")).toBe(true);
    expect(noteConversionOffered(on, { sharedView: false, pausedRemote: owner }, "owner")).toBe(
      true,
    );

    expect(noteConversionOffered(on, { sharedView: false, remote: owner }, "member")).toBe(false);
    expect(noteConversionOffered(on, { sharedView: false, pausedRemote: owner }, "member")).toBe(
      false,
    );
    expect(noteConversionOffered(on, { sharedView: true, remote: owner }, "owner")).toBe(false);

    expect(
      noteConversionOffered({ ...on, DOHC_ENGINE_NEW_NOTE_BODY_SEQUENCE: "0" }, local, null),
    ).toBe(false);
    expect(noteConversionOffered({ DOHC_ENGINE_NOTE_BODY_SEQUENCE: "1" }, local, null)).toBe(false);
    expect(noteConversionOffered({}, local, null)).toBe(false);
  });
});

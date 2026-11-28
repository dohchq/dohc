import { describe, expect, it, vi } from "vitest";
import {
  NOTE_CONVERSION_OFF,
  NOTE_CONVERSION_RUNNING,
  createNoteConversion,
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

type LiveList = Awaited<ReturnType<NoteConversionRelay["liveNotes"]>>;
const live = (objectIds: string[], engineApiMin: number | null = 2): LiveList => ({
  engineApiMin,
  objectIds,
});

function relay(overrides: Partial<NoteConversionRelay> = {}) {
  return {
    liveNotes: vi.fn(async () => live(["live-1"])),
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
  it("refuses a relay whose live list names no engine floor or one below 2, and names the setting", async () => {
    const convert = vi.fn(async () => pass());
    const run = createNoteConversion();
    const low = relay({ liveNotes: vi.fn(async () => live([], 1)) });

    await expect(
      run("ws", { relay: low, convert, assertCurrent: () => undefined }),
    ).rejects.toThrow(
      "dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN is 1; it must be 2.",
    );
    expect(convert).not.toHaveBeenCalled();

    const unset = relay({ liveNotes: vi.fn(async () => live([], null)) });
    await expect(
      run("ws", { relay: unset, convert, assertCurrent: () => undefined }),
    ).rejects.toThrow("DOHC_RELAY_ENGINE_API_MIN is not set; it must be 2.");
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
    expect(remote.liveNotes).toHaveBeenCalledTimes(2);
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
      .mockRejectedValueOnce(new Error("relay down"))
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
});

import { describe, expect, it, vi } from "vitest";
import {
  NOTE_CONVERSION_OFF,
  NOTE_CONVERSION_RUNNING,
  createNoteConversion,
  type NoteConversionRelay,
} from "./noteConversion";

type Params = { after?: string; budget: number; relayLive: string[] };

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

function relay(overrides: Partial<NoteConversionRelay> = {}) {
  return {
    engineApiMin: vi.fn(async (): Promise<number | undefined> => 2),
    liveNotes: vi.fn(async () => ["live-1"]),
    pushRecorded: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("note conversion run", () => {
  it("refuses a relay whose engine floor is below 2 and names the setting", async () => {
    const convert = vi.fn(async () => pass());
    const run = createNoteConversion();
    const low = relay({ engineApiMin: vi.fn(async () => 1) });

    await expect(
      run("ws", { relay: low, convert, assertCurrent: () => undefined }),
    ).rejects.toThrow(
      "dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN is 1; it must be 2.",
    );
    expect(convert).not.toHaveBeenCalled();
    expect(low.pushRecorded).not.toHaveBeenCalled();

    const unset = relay({ engineApiMin: vi.fn(async () => undefined) });
    await expect(
      run("ws", { relay: unset, convert, assertCurrent: () => undefined }),
    ).rejects.toThrow("DOHC_RELAY_ENGINE_API_MIN is not set; it must be 2.");

    const ready = relay();
    await expect(
      run("ws", { relay: ready, convert, assertCurrent: () => undefined }),
    ).resolves.toMatchObject({ sent: true });
    expect(convert).toHaveBeenCalledOnce();
  });

  it("refuses when the engine reports the format off and returns no result", async () => {
    const progress = vi.fn();
    const remote = relay();
    await expect(
      createNoteConversion()("ws", {
        relay: remote,
        convert: async () => pass({ off: true, resumeAfter: null }),
        assertCurrent: () => undefined,
        progress,
      }),
    ).rejects.toThrow(NOTE_CONVERSION_OFF);
    expect(progress).not.toHaveBeenCalled();
    expect(remote.pushRecorded).toHaveBeenCalledOnce();
  });

  it("skips the floor, the live list and every push for a local-only workspace", async () => {
    const convert = vi.fn(async (_params: Params) => pass({ converted: 2, unchanged: 1 }));
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
    expect(convert).toHaveBeenCalledExactlyOnceWith({ budget: 10, relayLive: [] });
  });

  it("keeps going past a batch of unreadable notes and resumes after each batch", async () => {
    const remote = relay({
      liveNotes: vi
        .fn<() => Promise<string[]>>()
        .mockResolvedValueOnce(["live-1"])
        .mockResolvedValueOnce(["live-2"]),
    });
    const bad = Array.from({ length: 10 }, (_, index) => ({
      objectId: `bad-${index}`,
      path: "",
      reason: "object_id must be non-empty and bounded",
    }));
    const convert = vi
      .fn<(params: Params) => Promise<unknown>>()
      .mockResolvedValueOnce(pass({ failed: bad, resumeAfter: "bad-9", total: 11 }))
      .mockResolvedValueOnce(pass({ converted: 1, resumeAfter: null, total: 11 }));
    const progress = vi.fn();

    const result = await createNoteConversion()("ws", {
      relay: remote,
      convert,
      assertCurrent: () => undefined,
      progress,
    });

    expect(convert.mock.calls.map(([params]) => params)).toEqual([
      { budget: 10, relayLive: ["live-1"] },
      { after: "bad-9", budget: 10, relayLive: ["live-2"] },
    ]);
    expect(result.converted).toBe(1);
    expect(result.failed).toHaveLength(10);
    expect(result.failed[0]).toEqual({
      path: "",
      reason: "object_id must be non-empty and bounded",
    });
    expect(progress.mock.calls).toEqual([
      [10, 11],
      [11, 11],
    ]);
    expect(remote.pushRecorded).toHaveBeenCalledTimes(2);
  });

  it("pushes between batches that converted notes and once more at the end", async () => {
    const order: string[] = [];
    const remote = relay({
      pushRecorded: vi.fn(async () => void order.push("push")),
      liveNotes: vi.fn(async () => (order.push("live"), [])),
    });
    const convert = vi
      .fn<(params: Params) => Promise<unknown>>()
      .mockImplementationOnce(
        async () => (order.push("batch"), pass({ converted: 10, resumeAfter: "a" })),
      )
      .mockImplementationOnce(
        async () => (order.push("batch"), pass({ unchanged: 10, resumeAfter: "b" })),
      )
      .mockImplementationOnce(async () => (order.push("batch"), pass({ converted: 1 })));

    await createNoteConversion()("ws", { relay: remote, convert, assertCurrent: () => undefined });

    expect(order).toEqual([
      "push",
      "live",
      "batch",
      "push",
      "live",
      "batch",
      "live",
      "batch",
      "push",
    ]);
  });

  it("reports converted notes it could not send when the last push fails", async () => {
    const pushRecorded = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("relay down"))
      .mockRejectedValueOnce(new Error("relay down"));
    const convert = vi
      .fn<(params: Params) => Promise<unknown>>()
      .mockResolvedValueOnce(pass({ converted: 10, resumeAfter: "a" }))
      .mockResolvedValueOnce(pass({ converted: 1 }));

    const result = await createNoteConversion()("ws", {
      relay: relay({ pushRecorded }),
      convert,
      assertCurrent: () => undefined,
    });

    expect(result).toMatchObject({ converted: 11, sent: false });
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it("stops between batches once the window leaves the workspace", async () => {
    let current = true;
    const progress = vi.fn();
    const convert = vi.fn(async () => {
      current = false;
      return pass({ converted: 10, resumeAfter: "a" });
    });

    await expect(
      createNoteConversion()("ws", {
        relay: relay(),
        convert,
        assertCurrent: () => {
          if (!current)
            throw new Error("Converting notes stopped because this window changed workspaces.");
        },
        progress,
      }),
    ).rejects.toThrow("changed workspaces");
    expect(convert).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledOnce();
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

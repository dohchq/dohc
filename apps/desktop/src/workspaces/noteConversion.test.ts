import type { CloudCredentials } from "./cloudCredentialStore";
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
  engineNoteBodySequence,
  stopsOnceSyncStarts,
  type NoteConversionRelay,
} from "./noteConversion";

type Params = { after?: string; objectId?: string; budget: number; relayLive?: string[] };
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
      { budget: 1 },
      { after: "n1", budget: 1 },
      { after: "n2", budget: 1 },
    ]);
  });

  it("asks to turn sync back on when the engine refuses a folder that synced before", async () => {
    const convert = oneNoteAtATime([new Error("note-format-two-relay-unchecked")]);
    await expect(
      createNoteConversion()("ws", { relay: null, convert, assertCurrent: () => undefined }),
    ).rejects.toThrow(
      "dohc could not convert notes because this folder synced before. Turn sync back on in Settings, then try again.",
    );
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

    const run = await createNoteConversion()("ws", {
      relay: null,
      convert,
      assertCurrent: () => undefined,
    });

    expect(run).toMatchObject({
      converted: 1,
      sent: false,
      stopped: "dohc could not read the workspace database.",
    });
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
    const run = await createNoteConversion()("ws", {
      relay: relay({
        liveNotes: vi
          .fn<NoteConversionRelay["liveNotes"]>()
          .mockResolvedValueOnce(live([]))
          .mockResolvedValueOnce(live(["live-1"]))
          .mockRejectedValueOnce(new Error("dohc could not reach your server.")),
      }),
      convert,
      assertCurrent: () => undefined,
    });

    expect(run).toMatchObject({
      converted: 10,
      sent: false,
      stopped: "dohc could not reach your server.",
    });
    expect(convert).toHaveBeenCalledTimes(10);
  });

  it("stops when a later live list drops the engine floor to 1, and says what it converted", async () => {
    const convert = oneNoteAtATime(converted(12));
    const run = await createNoteConversion()("ws", {
      relay: relay({
        liveNotes: vi
          .fn<NoteConversionRelay["liveNotes"]>()
          .mockResolvedValueOnce(live([]))
          .mockResolvedValueOnce(live(["live-1"]))
          .mockResolvedValueOnce(live(["live-1"], 1)),
      }),
      convert,
      assertCurrent: () => undefined,
    });

    expect(run).toMatchObject({
      converted: 10,
      sent: false,
      stopped:
        "dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN is 1; it must be 2.",
    });
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
    const run = await createNoteConversion()("ws", {
      relay: relay({
        liveNotes: vi
          .fn<NoteConversionRelay["liveNotes"]>()
          .mockResolvedValueOnce(live([]))
          .mockResolvedValueOnce(live([]))
          .mockRejectedValueOnce(new Error(NOTE_CONVERSION_PAUSED)),
      }),
      convert,
      assertCurrent: () => undefined,
    });

    expect(run).toMatchObject({ converted: 10, sent: false, stopped: NOTE_CONVERSION_PAUSED });
    expect(convert).toHaveBeenCalledTimes(10);
  });

  it("stops when a drain between batches fails, and says what it converted", async () => {
    const convert = oneNoteAtATime(converted(12));
    const run = await createNoteConversion()("ws", {
      relay: relay({
        drainRecorded: vi
          .fn<() => Promise<void>>()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("Another account already claimed this workspace.")),
      }),
      convert,
      assertCurrent: () => undefined,
    });

    expect(run).toMatchObject({
      converted: 10,
      sent: false,
      stopped: "Another account already claimed this workspace.",
    });
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
    const run = await createNoteConversion()("ws", {
      relay: null,
      convert,
      assertCurrent: () => undefined,
    });
    expect(run).toMatchObject({
      converted: 2,
      sent: false,
      stopped:
        "dohc could not convert notes because the engine did not move past the last note it read.",
    });
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it("stops before the next note once the window leaves the workspace, and says what it converted", async () => {
    let current = true;
    const convert = vi.fn(async () => {
      current = false;
      return pass({ converted: 1, resumeAfter: "a" });
    });

    const run = await createNoteConversion()("ws", {
      relay: relay(),
      convert,
      assertCurrent: () => {
        if (!current)
          throw new Error("Converting notes stopped because this window changed workspaces.");
      },
    });

    expect(run).toMatchObject({
      converted: 1,
      sent: false,
      stopped: "Converting notes stopped because this window changed workspaces.",
    });
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

    const run = await createNoteConversion(2)("ws", {
      relay: null,
      convert,
      assertCurrent: stopsOnceSyncStarts(
        () => undefined,
        () => syncing,
      ),
    });

    expect(run).toMatchObject({
      converted: 2,
      sent: false,
      stopped: "Sync was turned on while dohc converted notes.",
    });
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

  it("keeps converting when a progress report fails", async () => {
    const progress = vi.fn(() => {
      throw new Error("Object has been destroyed");
    });
    await expect(
      createNoteConversion()("ws", {
        relay: null,
        convert: oneNoteAtATime([{ converted: 1 }, { converted: 1 }]),
        assertCurrent: () => undefined,
        progress,
      }),
    ).resolves.toMatchObject({ converted: 2 });
    expect(progress).toHaveBeenCalledTimes(2);
  });
});

describe("converting a note once its editor closes", () => {
  const skippedAs = (objectId: string, reason: string) => ({
    skipped: [{ objectId, path: `${objectId}.md`, reason }],
  });

  async function afterRun(outcomes: Outcome[]) {
    const conversion = createNoteConversion();
    await conversion("ws", {
      relay: relay(),
      convert: oneNoteAtATime(outcomes),
      assertCurrent: () => undefined,
    });
    return conversion;
  }

  function closing(
    conversion: Awaited<ReturnType<typeof afterRun>>,
    path: string,
    answer: Outcome | (() => Promise<unknown>),
    remote = relay(),
  ) {
    const convert = vi.fn(async (_params: Params) => {
      if (typeof answer === "function") return answer();
      if (answer instanceof Error) throw answer;
      return pass(answer);
    });
    const done = conversion.closed("ws", path, (use) =>
      use({ relay: remote, convert, assertCurrent: () => undefined }),
    );
    return { convert, done, remote };
  }

  it("pushes, reads the live list, converts that one note, then pushes again", async () => {
    const conversion = await afterRun([skippedAs("a", "open-here"), { converted: 1 }]);
    const order: string[] = [];
    const remote = relay({
      drainRecorded: vi.fn(async () => void order.push("push")),
      liveNotes: vi.fn(async () => (order.push("live"), live(["live-1"]))),
    });
    const { convert, done } = closing(conversion, "a.md", { converted: 1 }, remote);
    await expect(done).resolves.toEqual({
      converted: 1,
      unchanged: 0,
      skipped: [],
      doesNotFit: [],
      failed: [],
      sent: true,
    });
    expect(convert).toHaveBeenCalledExactlyOnceWith({
      objectId: "a",
      budget: 1,
      relayLive: ["live-1"],
    });
    expect(order).toEqual(["push", "live", "push"]);
    await expect(closing(conversion, "a.md", { converted: 1 }).done).resolves.toBeNull();
  });

  it("does not retry a note skipped as open elsewhere when the same path closes here", async () => {
    const conversion = await afterRun([skippedAs("b", "open-elsewhere")]);
    const { convert, done, remote } = closing(conversion, "b.md", { converted: 1 });
    await expect(done).resolves.toBeNull();
    expect(convert).not.toHaveBeenCalled();
    expect(remote.drainRecorded).not.toHaveBeenCalled();
  });

  it("does nothing for a closed note the last run did not skip", async () => {
    const conversion = await afterRun([{ converted: 1 }]);
    const { convert, done } = closing(conversion, "a.md", { converted: 1 });
    await expect(done).resolves.toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it("keeps a note that is open here again and retries it on its next close", async () => {
    const conversion = await afterRun([skippedAs("a", "open-here")]);
    await expect(closing(conversion, "a.md", skippedAs("a", "open-here")).done).resolves.toBeNull();
    const again = closing(conversion, "a.md", { converted: 1 });
    await expect(again.done).resolves.toMatchObject({ converted: 1 });
    expect(again.convert).toHaveBeenCalledOnce();
  });

  it("moves a note that does not fit, and stops retrying it", async () => {
    const conversion = await afterRun([skippedAs("a", "open-here")]);
    const overweight = { doesNotFit: [{ objectId: "a", path: "a.md" }] };
    await expect(closing(conversion, "a.md", overweight).done).resolves.toMatchObject({
      converted: 0,
      doesNotFit: [{ path: "a.md" }],
    });
    const later = closing(conversion, "a.md", { converted: 1 });
    await expect(later.done).resolves.toBeNull();
    expect(later.convert).not.toHaveBeenCalled();
  });

  it("moves a note whose retry fails into the failed group with the reason, and retries it later", async () => {
    const conversion = await afterRun([skippedAs("a", "open-here")]);
    const failed = closing(conversion, "a.md", new Error("engine stopped"));
    await expect(failed.done).resolves.toEqual({
      converted: 0,
      unchanged: 0,
      skipped: [],
      doesNotFit: [],
      failed: [{ path: "a.md", reason: "engine stopped" }],
      sent: true,
    });
    await expect(closing(conversion, "a.md", { converted: 1 }).done).resolves.toMatchObject({
      converted: 1,
    });
  });

  it("waits for a running Convert notes pass and retries a note it skipped as open here", async () => {
    const conversion = createNoteConversion();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = conversion("ws", {
      relay: relay(),
      convert: vi.fn(async () => {
        await gate;
        return pass(skippedAs("a", "open-here"));
      }),
      assertCurrent: () => undefined,
    });
    const { convert, done } = closing(conversion, "a.md", { converted: 1 });
    release();
    await running;
    await expect(done).resolves.toMatchObject({ converted: 1 });
    expect(convert).toHaveBeenCalledOnce();
  });
});

describe("who converts a workspace's notes", () => {
  const signedOut =
    "dohc could not convert notes. Sign in to the account that synced this workspace, then try again.";
  const remote = { serverUrl: "https://relay.example", ownerUserId: "owner" };
  const owner: CloudCredentials = {
    serverUrl: "https://relay.example",
    userId: "owner",
    email: "owner@example.com",
    token: "token",
  };
  const member: CloudCredentials = { ...owner, userId: "member" };
  const elsewhere: CloudCredentials = { ...owner, serverUrl: "https://other.example" };
  const shareView = {
    shareId: "share-1",
    granterEmail: owner.email,
    genericChatWritable: false,
    grantedSelector: { paths: [], versionId: "main", access: "view" as const },
  };

  it("runs a local-only workspace without the relay and an owner's synced one through it", () => {
    expect(noteConversionReach({}, null)).toBe("local");
    expect(noteConversionReach({}, member)).toBe("local");
    expect(noteConversionReach({ remote }, owner)).toBe("relay");
  });

  it("refuses a member's copy, another server, a shared view, and paused sync, and asks a signed-out owner to sign in", () => {
    for (const credentials of [member, elsewhere])
      expect(() => noteConversionReach({ remote }, credentials)).toThrow(NOTE_CONVERSION_NOT_OWNER);
    expect(() => noteConversionReach({ remote }, null)).toThrow(signedOut);
    expect(() => noteConversionReach({ pausedRemote: remote }, null)).toThrow(signedOut);
    expect(() => noteConversionReach({ remote, shareView }, owner)).toThrow(
      NOTE_CONVERSION_SHARED_VIEW,
    );
    expect(() => noteConversionReach({ pausedRemote: remote }, owner)).toThrow(
      NOTE_CONVERSION_PAUSED,
    );
    expect(() => noteConversionReach({ pausedRemote: remote }, member)).toThrow(
      NOTE_CONVERSION_NOT_OWNER,
    );
  });

  it("reads the new format unless the setting turns it off", () => {
    expect(engineNoteBodySequence({})).toBe("1");
    expect(engineNoteBodySequence({ DOHC_ENGINE_NOTE_BODY_SEQUENCE: "0" })).toBe("0");
    expect(engineNoteBodySequence({ DOHC_ENGINE_NOTE_BODY_SEQUENCE: "" })).toBe("");
  });

  it("offers conversion only to the owner, and only while the engine reads the new format", () => {
    const on = { DOHC_ENGINE_NOTE_BODY_SEQUENCE: "1" };
    expect(noteConversionOffered(on, {}, null)).toBe(true);
    expect(noteConversionOffered(on, { remote }, owner)).toBe(true);
    expect(noteConversionOffered(on, { pausedRemote: remote }, owner)).toBe(true);

    for (const credentials of [member, null, elsewhere]) {
      expect(noteConversionOffered(on, { remote }, credentials)).toBe(false);
      expect(noteConversionOffered(on, { pausedRemote: remote }, credentials)).toBe(false);
    }
    expect(noteConversionOffered(on, { remote, shareView }, owner)).toBe(false);

    expect(
      noteConversionOffered({ ...on, DOHC_ENGINE_NEW_NOTE_BODY_SEQUENCE: "0" }, {}, null),
    ).toBe(true);
    expect(noteConversionOffered({ DOHC_ENGINE_NOTE_BODY_SEQUENCE: "0" }, {}, null)).toBe(false);
    expect(noteConversionOffered({ DOHC_ENGINE_NOTE_BODY_SEQUENCE: "" }, {}, null)).toBe(false);
    expect(noteConversionOffered({}, {}, null)).toBe(true);
  });
});

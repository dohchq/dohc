import { describe, expect, it } from "vitest";
import { createKeyedSerializer } from "./keyedSerializer";
import { deferred } from "./testing/deferred";

describe("createKeyedSerializer", () => {
  it("serializes runs for the same key (a second call waits for the first) and keeps keys independent", async () => {
    const serialize = createKeyedSerializer();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serialize("ws-a", async () => {
      events.push("a1:start");
      await firstGate;
      events.push("a1:end");
    });
    const second = serialize("ws-a", async () => {
      events.push("a2:start");
      events.push("a2:end");
    });
    const other = serialize("ws-b", async () => {
      events.push("b1:start");
      events.push("b1:end");
    });

    // A different key is not blocked by ws-a's in-flight pass.
    await other;
    expect(events).toEqual(["a1:start", "b1:start", "b1:end"]);

    releaseFirst();
    await first;
    await second;
    // The second ws-a pass ran only after the first finished — it queued (so
    // ops journaled after the first pass started still get their own pass),
    // never overlapped.
    expect(events).toEqual(["a1:start", "b1:start", "b1:end", "a1:end", "a2:start", "a2:end"]);
  });

  it("keeps serving a key after a run rejects (a failed pass never wedges the queue)", async () => {
    const serialize = createKeyedSerializer();
    await expect(
      serialize("ws-a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(serialize("ws-a", async () => "recovered")).resolves.toBe("recovered");
  });

  it("keeps a queued successor current when an earlier run finishes", async () => {
    const serialize = createKeyedSerializer();
    const finishFirst = deferred();
    const secondStarted = deferred();
    const finishSecond = deferred();
    const events: string[] = [];
    const first = serialize("workspace", () => finishFirst.promise);
    const second = serialize("workspace", async () => {
      events.push("second:start");
      secondStarted.resolve();
      await finishSecond.promise;
      events.push("second:end");
    });

    finishFirst.resolve();
    await first;
    await secondStarted.promise;
    const third = serialize("workspace", async () => {
      events.push("third");
      return "third result";
    });
    await serialize("other workspace", async () => undefined);
    expect(events).toEqual(["second:start"]);

    finishSecond.resolve();
    await second;
    await expect(third).resolves.toBe("third result");
    expect(events).toEqual(["second:start", "second:end", "third"]);
    await expect(serialize("workspace", async () => "next pass")).resolves.toBe("next pass");
  });

  it("keeps attachment symbols distinct from each other and from workspace strings", async () => {
    const serialize = createKeyedSerializer<string | symbol>();
    const firstAttachment = Symbol("workspace");
    const secondAttachment = Symbol("workspace");
    const finishFirst = deferred();
    const events: string[] = [];
    const first = serialize(firstAttachment, async () => {
      events.push("first attachment");
      await finishFirst.promise;
    });
    const nextOnFirst = serialize(firstAttachment, async () => {
      events.push("next on first");
    });
    await Promise.all([
      serialize(secondAttachment, async () => {
        events.push("second attachment");
      }),
      serialize("workspace", async () => {
        events.push("workspace string");
      }),
    ]);
    expect(events).toEqual(["first attachment", "second attachment", "workspace string"]);

    finishFirst.resolve();
    await Promise.all([first, nextOnFirst]);
    expect(events).toEqual([
      "first attachment",
      "second attachment",
      "workspace string",
      "next on first",
    ]);
  });

  it("delivers a synchronous throw while continuing work already queued on the key", async () => {
    const serialize = createKeyedSerializer();
    const failure = new Error("failed before returning a promise");
    const failed = serialize("workspace", () => {
      throw failure;
    });
    const next = serialize("workspace", async () => 42);

    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe(42);
  });
});

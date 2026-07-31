import { describe, expect, it, vi } from "vitest";
import { CredentialSessionCache } from "./credentialSessionCache";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("CredentialSessionCache", () => {
  it("reserves a generation before reading and commits only the newest refresh", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const cache = new CredentialSessionCache<string>();

    const warming = cache.warm(() => first.promise);
    expect(cache.snapshot()).toEqual({ credentials: null, generation: 1 });

    const refreshing = cache.refresh(() => second.promise);
    expect(cache.snapshot()).toEqual({ credentials: null, generation: 2 });

    first.resolve("old-session");
    await warming;
    expect(cache.snapshot()).toEqual({ credentials: null, generation: 2 });

    second.resolve("new-session");
    await refreshing;
    expect(cache.snapshot()).toEqual({
      credentials: "new-session",
      generation: 2,
    });
  });

  it("keeps clear as a signed-out tombstone even when an older read finishes", async () => {
    const pending = deferred<string | null>();
    const load = vi.fn(() => pending.promise);
    const cache = new CredentialSessionCache<string>();

    const warming = cache.warm(load);
    cache.clear();
    pending.resolve("old-session");
    await warming;

    await cache.warm(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.snapshot()).toEqual({ credentials: null, generation: 2 });
  });

  it("keeps clear as a signed-out tombstone when an older read fails", async () => {
    const pending = deferred<string | null>();
    const load = vi.fn(() => pending.promise);
    const cache = new CredentialSessionCache<string>();

    const warming = cache.warm(load);
    cache.clear();
    pending.reject(new Error("stale read failure"));
    await warming;

    await cache.warm(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.snapshot()).toEqual({ credentials: null, generation: 2 });
  });

  it("allows only an explicit refresh or set to leave the signed-out state", async () => {
    const cache = new CredentialSessionCache<string>();
    cache.set("first-session");
    cache.clear();

    await cache.refresh(async () => "second-session");
    expect(cache.snapshot()).toEqual({
      credentials: "second-session",
      generation: 3,
    });
  });

  it("retries a warm load after a transient read failure", async () => {
    const cache = new CredentialSessionCache<string>();
    let attempts = 0;
    const load = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary read failure");
      return "current-session";
    };

    await expect(cache.warm(load)).resolves.toBeUndefined();
    expect(cache.snapshot()).toEqual({ credentials: null, generation: 1 });

    await expect(cache.warm(load)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(cache.snapshot()).toEqual({
      credentials: "current-session",
      generation: 2,
    });
  });

  it("refuses to adopt a store read that crossed a clear", async () => {
    const pending = deferred<string | null>();
    const cache = new CredentialSessionCache<string>();

    const reading = cache.adoptCurrent(() => pending.promise);
    cache.clear();
    pending.resolve("old-session");

    await expect(reading).resolves.toEqual({ current: false });
    expect(cache.snapshot()).toEqual({ credentials: null, generation: 1 });
  });

  it("atomically rejects the later result of two reads from one generation", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const cache = new CredentialSessionCache<string>();

    const stale = cache.adoptCurrent(() => first.promise);
    const fresh = cache.adoptCurrent(() => second.promise);
    second.resolve("new-session");
    await expect(fresh).resolves.toEqual({
      current: true,
      credentials: "new-session",
    });
    first.resolve("old-session");

    await expect(stale).resolves.toEqual({ current: false });
    expect(cache.snapshot()).toEqual({
      credentials: "new-session",
      generation: 1,
    });
  });
});

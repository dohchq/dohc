import {expect, it, vi} from "vitest";
import {cacheLogAuthorNames} from "./logAuthorNameCache";

it("shares an in-flight lookup and expires names after five seconds", async () => {
  let now = 0;
  let finish!: (name: string) => void;
  const lookup = vi.fn(() => new Promise<string>(resolve => {finish = resolve;}));
  const cached = cacheLogAuthorNames(lookup, () => now);
  const first = cached("alice"), second = cached("alice");
  await Promise.resolve();
  expect(lookup).toHaveBeenCalledExactlyOnceWith("alice");
  finish("Alice");
  expect(await first).toBe("Alice");
  expect(await second).toBe("Alice");
  now = 4999;
  expect(await cached("alice")).toBe("Alice");
  now = 5000;
  const renamed = cached("alice");
  await Promise.resolve();
  finish("Renamed");
  expect(await renamed).toBe("Renamed");
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("bounds retained accounts and keeps their names separate", async () => {
  const lookup = vi.fn((id: string) => id);
  const cached = cacheLogAuthorNames(lookup, () => 0);
  for (let id = 0; id < 257; id++) expect(await cached(`${id}`)).toBe(`${id}`);
  expect(await cached("256")).toBe("256");
  expect(lookup).toHaveBeenCalledTimes(257);
  expect(await cached("0")).toBe("0");
  expect(lookup).toHaveBeenCalledTimes(258);
});

it("discards lookup failures without deleting a newer in-flight entry", async () => {
  let now = 0;
  let fail!: (error: Error) => void;
  const lookup = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => {fail = reject;}))
    .mockResolvedValue("Alice");
  const cached = cacheLogAuthorNames(lookup, () => now);
  const old = cached("alice");
  const rejected = expect(old).rejects.toThrow("unavailable");
  await Promise.resolve();
  now = 5000;
  expect(await cached("alice")).toBe("Alice");
  fail(new Error("unavailable"));
  await rejected;
  expect(await cached("alice")).toBe("Alice");
  expect(lookup).toHaveBeenCalledTimes(2);
});

import * as fsPromises from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { vi } from "vitest";

// An uncertain swap probe reaches the listing on either kind of disk.
export function forceStoredNameListing(...entries: string[]): void {
  const swapped = new Set(entries.map(entry => join(dirname(entry), basename(entry)
    .replace(/[A-Za-z]/gu, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()))));
  const original = vi.isMockFunction(fsPromises.lstat)
    ? vi.mocked(fsPromises.lstat).getMockImplementation()!
    : fsPromises.lstat;
  vi.spyOn(fsPromises, "lstat").mockImplementation((path, options) => {
    if (options?.bigint && swapped.has(String(path))) {
      return Promise.reject(Object.assign(new Error("swap lookup unavailable"), { code: "EIO" }));
    }
    return original(path, options);
  });
}

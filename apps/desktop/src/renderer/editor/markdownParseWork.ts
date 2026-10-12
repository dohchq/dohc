// Test-only measure of the text the Markdown parser reads while `run` runs:
// characters split on newlines, and characters scanned while searching for a
// block marker or the paragraph's end. A tokenizer that probes the rest of the
// document for every paragraph makes either count grow with its square.
import { vi } from "vitest";

const SEARCHES = new Set(["\n", "[!", "$$"]);

export async function measureParseWork(
  run: () => unknown,
): Promise<{ split: number; search: number }> {
  const work = { split: 0, search: 0 };
  const split = String.prototype.split;
  const indexOf = String.prototype.indexOf;
  const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (
    this: string,
    separator: unknown,
    limit?: number,
  ) {
    if (separator === "\n") work.split += this.length;
    return Reflect.apply(split, this, [separator, limit]) as string[];
  });
  const indexOfSpy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    const found = Reflect.apply(indexOf, this, [search, position]) as number;
    if (SEARCHES.has(search)) {
      const from = Math.min(Math.max(position ?? 0, 0), this.length);
      work.search += (found < 0 ? this.length : found + search.length) - from;
    }
    return found;
  });
  try {
    await run();
    return work;
  } finally {
    splitSpy.mockRestore();
    indexOfSpy.mockRestore();
  }
}

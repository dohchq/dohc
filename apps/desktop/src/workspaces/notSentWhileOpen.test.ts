import { describe, expect, it, vi } from "vitest";
import { createNotSentWhileOpen } from "./notSentWhileOpen";

describe("notes not sent while open", () => {
  it("answers each workspace's last read, says when it changed, and keeps it through a failed read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const notSent = createNotSentWhileOpen();
      expect(await notSent.read("a", async () => ["new.md"])).toBe(true);
      expect(await notSent.read("a", async () => ["new.md"])).toBe(false);
      expect(notSent.paths("a")).toEqual(["new.md"]);
      expect(notSent.paths("b")).toEqual([]);
      expect(await notSent.read("a", () => Promise.reject(new Error("engine closed")))).toBe(false);
      expect(notSent.paths("a")).toEqual(["new.md"]);
      expect(await notSent.read("a", async () => [])).toBe(true);
      expect(notSent.paths("a")).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

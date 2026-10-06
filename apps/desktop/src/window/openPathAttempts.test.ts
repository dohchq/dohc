import { describe, expect, it } from "vitest";
import { createOpenPathAttempts } from "./openPathAttempts";

describe("open path attempts", () => {
  it("gives the folder back once, and only to the window that was told", () => {
    const attempts = createOpenPathAttempts();
    const attemptId = attempts.issue("C:\\work\\Trips", 7);

    expect(attempts.take(attemptId, 8)).toBeNull();
    expect(attempts.take(attemptId, 7)).toBe("C:\\work\\Trips");
    expect(attempts.take(attemptId, 7)).toBeNull();
    expect(attempts.take("never-issued", 7)).toBeNull();
  });

  it("forgets the oldest attempt once it holds its limit", () => {
    const attempts = createOpenPathAttempts(2);
    const first = attempts.issue("first", 1);
    const second = attempts.issue("second", 1);
    const third = attempts.issue("third", 1);

    expect(attempts.take(first, 1)).toBeNull();
    expect(attempts.take(second, 1)).toBe("second");
    expect(attempts.take(third, 1)).toBe("third");
  });
});

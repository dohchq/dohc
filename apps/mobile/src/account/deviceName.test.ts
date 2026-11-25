import { describe, expect, it } from "vitest";
import { deviceName } from "./deviceName";

describe("deviceName", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
  ])("names %s", (agent, name) => {
    expect(deviceName(agent)).toBe(name);
  });

  it("names nothing it can't read", () => {
    expect(deviceName("node")).toBeNull();
    expect(deviceName("")).toBeNull();
  });
});

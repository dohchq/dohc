import { describe, expect, it } from "vitest";
import { canonicalCloudOrigin, INSECURE_LOOPBACK_RELAY_TEST_ENV, insecureLoopbackServersForTests } from "./cloudConfiguration";

const loopback = ["http://localhost:1786", "http://127.0.0.1:1786", "http://[::1]:1786"];

describe("server origin", () => {
  it("accepts an https origin", () => {
    expect(canonicalCloudOrigin("https://cloud.example.test/")).toBe("https://cloud.example.test");
  });
  it.each(loopback)("refuses plain http origin %s, as the release engine does", origin => {
    expect(canonicalCloudOrigin(origin)).toBeNull();
  });
  it.each(loopback)("accepts loopback origin %s under the e2e switch", origin => {
    expect(canonicalCloudOrigin(origin + "/", true)).toBe(origin);
  });
  it.each(["", "cloud.example.test", "https://", "file:///cloud", "https://user:pass@cloud.example.test", "https://cloud.example.test/api", "https://cloud.example.test?token=secret", "https://cloud.example.test#secret", "http://cloud.example.test", "http://192.168.1.10:1786"])("rejects unsupported or secret-bearing address %s", origin => {
    expect(canonicalCloudOrigin(origin, true)).toBeNull();
  });
  it("reads the e2e switch only when it is exactly 1", () => {
    expect(insecureLoopbackServersForTests({ [INSECURE_LOOPBACK_RELAY_TEST_ENV]: "1" })).toBe(true);
    expect(insecureLoopbackServersForTests({ [INSECURE_LOOPBACK_RELAY_TEST_ENV]: "true" })).toBe(false);
    expect(insecureLoopbackServersForTests({})).toBe(false);
  });
});

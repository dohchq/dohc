import { describe, expect, it } from "vitest";
import { canonicalCloudOrigin } from "./cloudConfiguration";

describe("server origin", () => {
  it.each(["https://cloud.example.test", "http://localhost:1786", "http://127.0.0.1:1786", "http://[::1]:1786"])("accepts secure or loopback origin %s", origin => {
    expect(canonicalCloudOrigin(origin + "/")).toBe(origin);
  });
  it.each(["", "cloud.example.test", "https://", "file:///cloud", "https://user:pass@cloud.example.test", "https://cloud.example.test/api", "https://cloud.example.test?token=secret", "https://cloud.example.test#secret", "http://cloud.example.test", "http://192.168.1.10:1786"])("rejects unsupported or secret-bearing address %s", origin => {
    expect(canonicalCloudOrigin(origin)).toBeNull();
  });
});

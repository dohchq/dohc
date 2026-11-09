import { describe, expect, it } from "vitest";
import { buildWorkLinkUrl, parseWorkLinkUrl, workLinkPathReference, workLinkServerOrigin } from "./workLinks";

const reference = "aB_9-".repeat(8) + "aB_";

describe("work links", () => {
  it("builds and parses a work link", () => {
    const url = `https://dohc.example/l/${reference}`;
    expect(buildWorkLinkUrl({ server: "https://dohc.example", reference })).toBe(url);
    expect(parseWorkLinkUrl(url)).toEqual({ server: "https://dohc.example", reference });
  });

  it.each([
    [`https://Dohc.Example/l/${reference}`, "https://dohc.example"],
    [`https://dohc.example:443/l/${reference}`, "https://dohc.example"],
    [`http://localhost:3000/l/${reference}`, "http://localhost:3000"],
  ])("reads the server origin from %s", (url, server) => {
    expect(parseWorkLinkUrl(url)).toEqual({ server, reference });
  });

  it.each([
    "",
    `dohc://l/${reference}`,
    `ftp://dohc.example/l/${reference}`,
    `https://user:pass@dohc.example/l/${reference}`,
    `https://dohc.example/l/${reference}?q=1`,
    `https://dohc.example/l/${reference}#x`,
    `https://dohc.example/l/${reference}/`,
    `https://dohc.example/base/l/${reference}`,
    `https://dohc.example/l/${reference.slice(1)}`,
    `https://dohc.example/l/${reference}a`,
    `https://dohc.example/s/${reference}`,
    `https://dohc.example/l/${"%41".repeat(43)}`,
    "not a url",
  ])("refuses %j", url => {
    expect(parseWorkLinkUrl(url)).toBeNull();
  });

  it.each(["https://dohc.example/", "https://dohc.example/base", "https://user@dohc.example", "file:///tmp", ""])("refuses to build from a server that is not an origin: %j", server => {
    expect(() => buildWorkLinkUrl({ server, reference })).toThrow("invalid work link server");
  });

  it("refuses to build from an invalid reference", () => {
    expect(() => buildWorkLinkUrl({ server: "https://dohc.example", reference: "short" })).toThrow("invalid work reference");
  });

  it("reduces a server URL to its origin", () => {
    expect(workLinkServerOrigin("https://Dohc.Example:443/api/")).toBe("https://dohc.example");
    expect(workLinkServerOrigin("https://user:pass@dohc.example")).toBeNull();
    expect(workLinkServerOrigin("file:///tmp")).toBeNull();
    expect(workLinkServerOrigin("nonsense")).toBeNull();
  });

  it("reads a reference only from the exact link path", () => {
    expect(workLinkPathReference(`/l/${reference}`)).toBe(reference);
    expect(workLinkPathReference(`/l/${reference}/`)).toBeNull();
    expect(workLinkPathReference("/l/")).toBeNull();
  });
});

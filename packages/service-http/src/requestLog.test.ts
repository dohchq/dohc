import { afterEach, expect, it, vi } from "vitest";
import { createRequestLog } from "./requestLog";

const SECRET = Buffer.alloc(32, 11).toString("base64url");

afterEach(() => vi.restoreAllMocks());

it("refuses at startup a pattern that could hold a secret, an id or a second line", () => {
  for (const pattern of [`/s/${SECRET}`, "/sync/WorkspaceA/log", `/a/${"b".repeat(33)}`, "/s/\n", "/s?token", "unmatched", "s/*", ""]) {
    expect(() => createRequestLog("test", [pattern]), JSON.stringify(pattern)).toThrow(TypeError);
  }
  expect(() => createRequestLog("test", ["/sync/:workspaceId/log", "/s/*", "/s/", "/", "app", "/api/view/blob/:sha256"])).not.toThrow();
});

it("writes a mark outside the service's list as unmatched", () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const log = createRequestLog("test", ["/s/*"]);
  const request = new Request(`https://share.test/s/${SECRET}`);
  // A cast past the type: the raw path must never be written.
  log.mark(request, new URL(request.url).pathname as "/s/*");
  log.write(request, "GET", 200, 0);
  expect(lines).toEqual(["[test] request 1970-01-01T00:00:00.000Z GET unmatched 200"]);
});

it("writes an unknown method as OTHER", () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
  createRequestLog("test", []).write(undefined, `PROPFIND-${SECRET}`, 405, 0);
  expect(lines).toEqual(["[test] request 1970-01-01T00:00:00.000Z OTHER unmatched 405"]);
});

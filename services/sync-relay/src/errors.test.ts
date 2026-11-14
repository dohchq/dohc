import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it, vi } from "vitest";
import fixture from "../relay-error-codes.json";
import { errorResponse, RELAY_ERRORS, RELAY_ERROR_STATUSES } from "./errors";

describe("relay error codes", () => {
  it("matches the checked-in fixture exactly", () => {
    const exported = Object.entries(RELAY_ERROR_STATUSES).map(([code, status]) => ({
      code,
      status,
    }));

    expect(exported).toEqual(fixture);
    expect(Object.isFrozen(RELAY_ERROR_STATUSES)).toBe(true);
    expect(Object.isFrozen(RELAY_ERRORS)).toBe(true);
    expect(Object.values(RELAY_ERRORS).every(Object.isFrozen)).toBe(true);
  });
});

describe("an unexpected failure", () => {
  const secret = "notes/secret plan.md";
  it.each([
    [
      "an engine refusal",
      new EngineRequestError(
        1,
        { code: "CONFLICT", message: `sync-path-occupied: ${secret}`, retry: "no" } as never,
        "sync.push",
      ),
      "EngineRequestError: sync-path-occupied (code CONFLICT, method sync.push)",
    ],
    [
      "a file system error",
      Object.assign(new Error(`ENOENT: no such file or directory, open '/srv/${secret}'`), {
        code: "ENOENT",
        path: `/srv/${secret}`,
      }),
      "Error: ENOENT",
    ],
  ])("logs %s by its class and codes only, and answers a generic 500", async (_, error, line) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = errorResponse(error);
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("secret");
      expect(log.mock.calls).toEqual([["[sync-relay] unhandled error", line]]);
    } finally {
      log.mockRestore();
    }
  });
});

import { expect, it, vi } from "vitest";
import { accessOperations } from "./accessOperations";
import { registerOperations } from "./operationTable";
import { deferred } from "../testing/deferred";

it("admits Access only in the active workspace and parses allowlisted replies", async () => {
  let active = "a";
  const listeners = new Map<string, (event: { trusted: boolean }, input: unknown) => Promise<unknown>>();
  const answer = { credentials: "secret", ref: null, rows: [], visibility: "visible", checkedAtMs: 1, freshness: "stale",
    nextCursor: null, unknownReason: null, coverage: { kind: "granted", complete: true, observation: "interval", bearerUrl: "secret" } };
  const handler = vi.fn(async () => answer);
  registerOperations({
    handle: (channel, listener) => listeners.set(channel, listener),
    assertTrustedSender: event => { if (!(event as { trusted: boolean }).trusted) throw Error("untrusted"); },
    withActiveWorkspace: async (_event, workspaceId, _message, work) => {
      if (active !== workspaceId) throw Error("inactive"); const result = await work({});
      if (active !== workspaceId) throw Error("inactive"); return result;
    },
  }, accessOperations, { getObjectAccess: handler as never, listSharingAccess: handler as never, requestAccessRefresh: async () => undefined });
  const invoke = (workspaceId: string, trusted = true) => listeners.get("desktop:list-sharing-access")!({ trusted }, { workspaceId, lane: "granted" });
  await expect(invoke("b")).rejects.toThrow("inactive"); await expect(invoke("a", false)).rejects.toThrow("untrusted");
  expect(handler).not.toHaveBeenCalled(); expect(JSON.stringify(await invoke("a"))).not.toContain("secret");
  const pending = deferred<typeof answer>(); handler.mockReturnValueOnce(pending.promise);
  const response = invoke("a"); active = "b"; pending.resolve(answer);
  await expect(response).rejects.toThrow("inactive");
});

it.each(["getObjectAccess", "listSharingAccess"] as const)("carries the reason through %s", name => {
  const answer = { ref: null, rows: [], visibility: "unknown", checkedAtMs: null, freshness: "unknown", nextCursor: null,
    coverage: { kind: "unavailable", complete: false, observation: "interval" }, unknownReason: "other-account" };
  expect(accessOperations[name].result.parse(answer)).toHaveProperty("unknownReason", "other-account");
  expect(accessOperations[name].result.safeParse({ ...answer, unknownReason: null }).success).toBe(false);
});

it.each(["getObjectAccess", "listSharingAccess"] as const)("carries withheld answers through %s", name => {
  const answer = { ref: null, rows: [], visibility: "hidden", checkedAtMs: null, freshness: "unknown", nextCursor: null,
    coverage: { kind: "unavailable", complete: false, observation: "interval" }, unknownReason: null };
  expect(accessOperations[name].result.parse(answer)).toMatchObject({ visibility: "hidden", unknownReason: null });
  expect(accessOperations[name].result.safeParse({ ...answer, unknownReason: "unreadable" }).success).toBe(false);
});

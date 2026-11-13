// @vitest-environment jsdom
import {afterEach, expect, it, vi} from "vitest";
import {LiveAuthorityUnavailableError} from "@dohc/ydoc-projection/named-live-browser-transport";
import {memberPageReady, openMemberPage} from "./memberLive";
import {jsonResponse} from "./testing";

// A member's page opens live through the workspace's host, and says why when the host will not take it.

const limits = {provider: {frames: {}, maxDeliveryAttempts: 1, maxPendingUpdateBytes: 1, maxPendingUpdates: 1}, maxHttpResponseBytes: 1,
  maxSocketBufferedBytes: 1, connectTimeoutMs: 1, sendTimeoutMs: 1, drainPollMs: 1};
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

it("opens a page live, keeps the host's refusal code, and reads a refused grant as unavailable authority", async () => {
  const answers: Response[] = [
    jsonResponse({discriminator: "abcdefghijkl", objectId: "object-1", userId: "sam", token: "ab".repeat(32), limits}),
    jsonResponse({ok: false, code: "live_host_full"}, 409),
    jsonResponse({ok: false, error: "not found"}, 404),
    jsonResponse({ready: true}), jsonResponse({ready: false}),
  ];
  const fetch = vi.fn(async () => answers.shift()!);
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(await openMemberPage("grant-1", "trip/plan.md", signal)).toEqual({kind: "open", discriminator: "abcdefghijkl", objectId: "object-1",
    userId: "sam", token: "ab".repeat(32), limits});
  const sent = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(sent[0]).toBe("/api/live/member-open");
  expect(JSON.parse(String(sent[1].body))).toEqual({grantId: "grant-1", path: "trip/plan.md"});
  expect(new Headers(sent[1].headers).get("x-dohc-share-web-api-version")).not.toBeNull();
  expect(await openMemberPage("grant-1", "trip/plan.md", signal)).toEqual({kind: "refused", code: "live_host_full"});
  await expect(openMemberPage("grant-1", "trip/plan.md", signal)).rejects.toBeInstanceOf(LiveAuthorityUnavailableError);
  expect(await memberPageReady("grant-1", "trip/plan.md", signal)).toBe(true);
  expect(await memberPageReady("grant-1", "trip/plan.md", signal)).toBe(false);
  expect((fetch.mock.calls[3] as unknown as [string])[0]).toBe("/api/live/member-ready");
});


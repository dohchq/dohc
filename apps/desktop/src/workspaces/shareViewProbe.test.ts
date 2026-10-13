import { expect, it, vi } from "vitest";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { probeShareViewLog } from "./shareViewInfo";

it.each([
  [{ ops: [], nextCursor: 42, hasMore: false }, true],
  [{ ops: [{ relaySeq: 43 }], nextCursor: 43, hasMore: false }, false],
  [{ ops: [], nextCursor: 43, hasMore: true }, false],
])("only skips a complete empty log page (%j)", async (body, unchanged) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
  await expect(probeShareViewLog({ relay: { baseUrl: "https://relay.test/", token: "account", fetch }, shareId: "share/id", since: 42 }))
    .resolves.toEqual({ unchanged });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toBe("https://relay.test/sync/shares/share%2Fid/log?since=42");
  expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer account");
});

it.each([{}, { ops: [], hasMore: false }, { ops: [], nextCursor: 1, hasMore: false },
  { ops: null, nextCursor: 42, hasMore: false }, { ops: [], nextCursor: 42.5, hasMore: false },
  { ops: [], nextCursor: 42, hasMore: "false" }])("refuses unreadable or regressed cursors (%j)", async body => {
  await expect(probeShareViewLog({ relay: { baseUrl: "https://relay.test", token: "account", fetch: async () => Response.json(body) }, shareId: "share", since: 42 })).rejects.toThrow("readable share log");
});

it.each([401, 404, 500])("preserves failure classification (%s)", async status => {
  const result = probeShareViewLog({ relay: { baseUrl: "https://relay.test", token: "account", fetch: async () => new Response("unavailable", { status }) }, shareId: "share", since: 42 });
  if (status === 401) await expect(result).rejects.toBeInstanceOf(RelayUnauthorizedError);
  else if (status === 404) await expect(result).rejects.toBeInstanceOf(ShareUnavailableError);
  else await expect(result).rejects.toThrow("500");
});

import { expect, it, vi } from "vitest";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { fetchShareViewReach, probeShareViewLog } from "./shareViewInfo";

it.each([
  [{ ops: [], nextCursor: 42, hasMore: false }, true],
  [{ ops: [{ relaySeq: 43 }], nextCursor: 43, hasMore: false }, false],
  [{ ops: [], nextCursor: 43, hasMore: true }, false],
])("only skips a complete empty log page (%j)", async (body, unchanged) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
  await expect(
    probeShareViewLog({
      relay: { baseUrl: "https://relay.test/", token: "account", fetch },
      shareId: "share/id",
      since: 42,
    }),
  ).resolves.toEqual({ unchanged });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toBe("https://relay.test/sync/shares/share%2Fid/log?since=42");
  expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer account");
});

it.each([
  {},
  { ops: [], hasMore: false },
  { ops: [], nextCursor: 1, hasMore: false },
  { ops: null, nextCursor: 42, hasMore: false },
  { ops: [], nextCursor: 42.5, hasMore: false },
  { ops: [], nextCursor: 42, hasMore: "false" },
])("refuses unreadable or regressed cursors (%j)", async (body) => {
  await expect(
    probeShareViewLog({
      relay: {
        baseUrl: "https://relay.test",
        token: "account",
        fetch: async () => Response.json(body),
      },
      shareId: "share",
      since: 42,
    }),
  ).rejects.toThrow("readable share log");
});

it.each([401, 404, 500])("preserves failure classification (%s)", async (status) => {
  const result = probeShareViewLog({
    relay: {
      baseUrl: "https://relay.test",
      token: "account",
      fetch: async () => new Response("unavailable", { status }),
    },
    shareId: "share",
    since: 42,
  });
  if (status === 401) await expect(result).rejects.toBeInstanceOf(RelayUnauthorizedError);
  else if (status === 404) await expect(result).rejects.toBeInstanceOf(ShareUnavailableError);
  else await expect(result).rejects.toThrow("500");
});

// A membership's levels can move with no new op. The held pull still answers
// an empty page, and only its signatures say the full refresh has work.
it.each([
  [{ signature: "r1", visibilitySignature: "v1" }, true],
  [{ signature: "r2", visibilitySignature: "v1" }, false],
  [{ signature: "r1", visibilitySignature: "v2" }, false],
  [{}, false],
])(
  "counts an empty page under other reach signatures as news (%j)",
  async (signatures, unchanged) => {
    const fetch = async () =>
      Response.json({ ops: [], nextCursor: 42, hasMore: false, reach: signatures });
    await expect(
      probeShareViewLog({
        relay: { baseUrl: "https://relay.test", token: "account", fetch },
        shareId: "share",
        since: 42,
        reach: { signature: "r1", visibilitySignature: "v1" },
      }),
    ).resolves.toEqual({ unchanged });
  },
);

it("reads a membership's listed reach from its smallest page, and refuses one it can't read", async () => {
  const listed = {
    signature: "r1",
    visibilitySignature: "v1",
    rootLevel: "comment",
    folders: [{ path: "Team/Plans", level: "edit" }],
  };
  const page = (reach: unknown) => ({ ok: true, ops: [], nextCursor: 0, hasMore: false, reach });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(page(listed)));
  await expect(
    fetchShareViewReach({
      relay: { baseUrl: "https://relay.test/", token: "account", fetch },
      shareId: "share/id",
    }),
  ).resolves.toEqual(listed);
  expect(fetch.mock.calls[0]![0]).toBe(
    "https://relay.test/sync/shares/share%2Fid/log?since=0&limit=1",
  );
  for (const body of [
    { ...page(undefined) },
    page({ ...listed, folders: [{ path: "/Team", level: "edit" }] }),
    page({ ...listed, rootLevel: "owner" }),
    page({ ...listed, folders: [{ path: "", level: "edit" }] }),
  ]) {
    await expect(
      fetchShareViewReach({
        relay: {
          baseUrl: "https://relay.test",
          token: "account",
          fetch: async () => Response.json(body),
        },
        shareId: "share",
      }),
    ).rejects.toThrow("readable reach");
  }
});

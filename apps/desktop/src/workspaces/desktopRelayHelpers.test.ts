import {
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
} from "@dohc/workspace-contracts/relay";
import { describe, expect, it, vi } from "vitest";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import { fetchSharedChannelInfo } from "./sharedChannelInfo";
import {
  ShareSelectorInvalidError,
  fetchShareViewInfo,
} from "./shareViewInfo";

function relay(fetch: typeof globalThis.fetch) {
  return {
    baseUrl: "https://relay.test/",
    token: "relay-token",
    fetch,
  };
}

describe("desktop relay helpers", () => {
  it("reads content presence and the authoritative relay identity together", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        ok: true,
        hasContent: true,
        replicationEpoch: "epoch-a",
        streamIdentity: "stream-a",
      }),
    );

    await expect(
      probeRelayWorkspace({
        workspaceId: "workspace/a",
        relay: relay(fetchMock),
      }),
    ).resolves.toEqual({
      hasContent: true,
      identity: {
        replicationEpoch: "epoch-a",
        streamIdentity: "stream-a",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relay.test/sync/workspace%2Fa/bootstrap",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer relay-token");
  });

  it("rejects a partial or control-character relay identity", async () => {
    for (const response of [
      {
        ok: true,
        hasContent: true,
        replicationEpoch: "epoch-a",
        streamIdentity: null,
      },
      {
        ok: true,
        hasContent: true,
        replicationEpoch: "epoch-a\u0000suffix",
        streamIdentity: "stream-a",
      },
    ]) {
      await expect(
        probeRelayWorkspace({
          workspaceId: "workspace-a",
          relay: relay(
            vi.fn<typeof globalThis.fetch>(async () => Response.json(response)),
          ),
        }),
      ).rejects.toThrow("Relay bootstrap response is invalid.");
    }
  });

  it("maps probe authorization and availability failures to contract errors", async () => {
    await expect(
      probeRelayWorkspace({
        workspaceId: "workspace-a",
        relay: relay(vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 401 }))),
      }),
    ).rejects.toBeInstanceOf(RelayUnauthorizedError);
    await expect(
      probeRelayWorkspace({
        workspaceId: "workspace-a",
        relay: relay(vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 404 }))),
      }),
    ).rejects.toBeInstanceOf(RelayWorkspaceUnavailableError);
  });

  it("composes an edit grant from shared-view metadata before open", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        shareId: "share-a",
        granterUserId: "user-a",
        granterEmail: "owner@example.test",
        selector: {
          paths: ["docs"],
          versionId: "version-a",
          ignored: true,
        },
        access: "edit",
        grantId: "grant-a",
        generation: 7,
        createdAtMs: 42,
      }),
    );

    await expect(
      fetchShareViewInfo({
        relay: relay(fetchMock),
        shareId: "share-a",
      }),
    ).resolves.toEqual({
      shareId: "share-a",
      granterUserId: "user-a",
      granterEmail: "owner@example.test",
      selector: { paths: ["docs"], versionId: "version-a", access: "edit" },
      createdAtMs: 42,
    });
  });

  // The fetched selector BECOMES the grant every later pull is enforced
  // against, so an unreadable one is refused instead of softened. Every
  // permissive reading lands on the WIDEST grant — empty paths with no
  // version is "the whole tracked workspace" to the engine — so a relay that
  // merely omits or corrupts the field would disarm the containment.
  it("refuses a share whose selector it cannot read, instead of widening the grant", async () => {
    const unreadable = [
      { shareId: "share-a" }, // selector missing entirely
      { shareId: "share-a", selector: null },
      { shareId: "share-a", selector: "docs" },
      // Each row below carries a VALID access, so it is refused for the
      // reason it names and not for a missing level.
      { shareId: "share-a", selector: { versionId: "v1" }, access: "view" }, // no paths array
      {
        shareId: "share-a",
        selector: { paths: ["docs", 7], versionId: null },
        access: "view",
      },
      {
        shareId: "share-a",
        selector: { paths: [""], versionId: null },
        access: "view",
      },
      {
        shareId: "share-a",
        selector: { paths: ["docs"], versionId: "" },
        access: "view",
      },
      // Selects nothing at all: the relay refuses to CREATE this one, so a
      // response carrying it is not a grant.
      {
        shareId: "share-a",
        selector: { paths: [], versionId: null },
        access: "view",
      },
      // The level dimension (#646). An otherwise perfect selector whose level
      // is missing or unreadable is refused too: the level is pinned with the
      // grant, and reading an unreadable one as "view" would invent a grant
      // the relay never stated.
      { shareId: "share-a", selector: { paths: ["docs"], versionId: null } },
      {
        shareId: "share-a",
        selector: { paths: ["docs"], versionId: null, access: "edit" },
      }, // retired nested access is not a compatibility input
      {
        shareId: "share-a",
        selector: { paths: ["docs"], versionId: null },
        access: "View",
      },
      {
        shareId: "share-a",
        selector: { paths: ["docs"], versionId: null },
        access: " view",
      },
      {
        shareId: "share-a",
        selector: { paths: ["docs"], versionId: null },
        access: "read-only",
      },
      {
        shareId: "share-a",
        selector: { paths: ["docs"], versionId: null },
        access: null,
      },
    ];
    for (const body of unreadable) {
      await expect(
        fetchShareViewInfo({
          relay: relay(
            vi.fn<typeof globalThis.fetch>(async () => Response.json(body)),
          ),
          shareId: "share-a",
        }),
        `MUTATION: a permissive fallback records ${JSON.stringify(body.selector)} as a whole-workspace grant`,
      ).rejects.toBeInstanceOf(ShareSelectorInvalidError);
    }
  });

  // A chat-channel grant has no file selector at all. That is a KNOWN kind,
  // not an unreadable response, so it resolves to null and the file surfaces
  // refuse it with their own guidance.
  it("reports a chat-channel grant as having no file selector", async () => {
    await expect(
      fetchShareViewInfo({
        relay: relay(
          vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({
              shareId: "share-channel",
              granterUserId: "user-a",
              granterEmail: null,
              selector: {
                kind: "chat-channel",
                channelWireId: "wire-a",
              },
              access: "read-only",
              createdAtMs: 84,
            }),
          ),
        ),
        shareId: "share-channel",
      }),
    ).resolves.toMatchObject({ selector: null });
  });

  it("maps unavailable shares and rejects invalid shared-channel selectors", async () => {
    await expect(
      fetchShareViewInfo({
        relay: relay(vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 404 }))),
        shareId: "share-ended",
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);

    await expect(
      fetchSharedChannelInfo({
        relay: relay(
          vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({
              shareId: "share-path",
              selector: { paths: ["docs"], versionId: null },
            }),
          ),
        ),
        shareId: "share-path",
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);

    await expect(
      fetchSharedChannelInfo({
        relay: relay(
          vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({
              shareId: "share-channel",
              selector: {
                kind: "chat-channel",
                channelWireId: "wire-a",
                access: "read-only",
              },
            }),
          ),
        ),
        shareId: "share-channel",
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
  });

  it("fetches shared-channel information with its access mode", async () => {
    await expect(
      fetchSharedChannelInfo({
        relay: relay(
          vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({
              shareId: "share-channel",
              granterUserId: "user-a",
              granterEmail: null,
              selector: {
                kind: "chat-channel",
                channelWireId: "wire-a",
              },
              access: "read-only",
              createdAtMs: 84,
            }),
          ),
        ),
        shareId: "share-channel",
      }),
    ).resolves.toEqual({
      shareId: "share-channel",
      granterUserId: "user-a",
      granterEmail: null,
      channelWireId: "wire-a",
      access: "read-only",
      createdAtMs: 84,
    });
  });
});

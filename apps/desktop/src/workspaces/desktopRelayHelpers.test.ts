import {
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
} from "@dohc/workspace-contracts/relay";
import { describe, expect, it, vi } from "vitest";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import { fetchSharedChannelInfo } from "./sharedChannelInfo";
import { fetchShareViewInfo } from "./shareViewInfo";

function relay(fetch: typeof globalThis.fetch) {
  return {
    baseUrl: "https://relay.test/",
    token: "relay-token",
    fetch,
  };
}

describe("desktop relay helpers", () => {
  it("probes only the first relay log item", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ops: [{ relaySeq: 1 }] }),
    );

    await expect(
      probeRelayWorkspace({
        workspaceId: "workspace/a",
        relay: relay(fetchMock),
      }),
    ).resolves.toEqual({ hasContent: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relay.test/sync/workspace%2Fa/log?since=0&limit=1",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer relay-token");
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

  it("fetches and parses shared-view information", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        shareId: "share-a",
        granterUserId: "user-a",
        granterEmail: "owner@example.test",
        selector: { paths: ["docs"], versionId: "version-a", ignored: true },
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
      selector: { paths: ["docs"], versionId: "version-a" },
      createdAtMs: 42,
    });
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
                access: "read-only",
              },
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

import { describe, expect, it, vi } from "vitest";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import type {
  EngineRelayClient,
  EngineRelayWorkspaceClient,
} from "./engineRelayClient";
import { createReceivedShareEngineAccess } from "./receivedShareEngineAccess";
import type { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";

describe("received share engine access", () => {
  it("disables generic capture for store-led and relay-led opens", () => {
    const sessions = {} as EngineWorkspaceSessions;
    const store = { kind: "store" };
    const relay = { kind: "relay" } as unknown as EngineRelayWorkspaceClient;
    const createStores = vi.fn(() => ({ store }));
    const bind = vi.fn(() => relay);
    const access = createReceivedShareEngineAccess({
      sessions: () => sessions,
      relayClient: () => ({ bind }) as Pick<EngineRelayClient, "bind">,
      createStores:
        createStores as unknown as typeof createCaptureLiveStores,
    });
    const location = {
      engineWorkspaceId: "received-share-1",
      rootPath: "C:\\received-share",
    };

    expect(access.workspaceFor(location)).toEqual({
      workspaceId: location.engineWorkspaceId,
      rootPath: location.rootPath,
      shareMount: true,
    });

    expect(access.storeFor(location)).toBe(store);
    expect(createStores).toHaveBeenCalledWith(
      {
        workspaceId: location.engineWorkspaceId,
        rootPath: location.rootPath,
        shareMount: true,
      },
      sessions,
    );

    expect(
      access.relayFor({
        ...location,
        relay: { baseUrl: "https://relay.example", token: "secret" },
      }),
    ).toBe(relay);
    expect(bind).toHaveBeenCalledWith({
      workspaceId: location.engineWorkspaceId,
      rootPath: location.rootPath,
      shareMount: true,
      relay: { baseUrl: "https://relay.example", token: "secret" },
    });
  });
});

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
    const rememberShareMount = vi.fn();
    const sessions = { rememberShareMount } as unknown as EngineWorkspaceSessions;
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
    expect(rememberShareMount).toHaveBeenCalledWith({
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

  it("classifies registered workspace markers by presence and leaves local workspaces ordinary", () => {
    const rememberShareMount = vi.fn();
    const sessions = { rememberShareMount } as unknown as EngineWorkspaceSessions;
    const bind = vi.fn(() => ({}) as EngineRelayWorkspaceClient);
    const access = createReceivedShareEngineAccess({
      sessions: () => sessions,
      relayClient: () => ({ bind }) as Pick<EngineRelayClient, "bind">,
      createStores: vi.fn() as unknown as typeof createCaptureLiveStores,
    });

    expect(
      access.workspaceForRegistered({
        workspaceId: "local-1",
        rootPath: "C:\\local",
      }),
    ).toEqual({ workspaceId: "local-1", rootPath: "C:\\local" });
    expect(rememberShareMount).not.toHaveBeenCalled();

    // A damaged marker still means received share. Treating null as absent
    // would let unreadable registry data silently restore generic capture.
    expect(
      access.workspaceForRegistered({
        workspaceId: "received-1",
        rootPath: "C:\\received",
        shareView: null,
      }),
    ).toEqual({
      workspaceId: "received-1",
      rootPath: "C:\\received",
      shareMount: true,
    });
    expect(rememberShareMount).toHaveBeenCalledWith({
      workspaceId: "received-1",
      rootPath: "C:\\received",
      shareMount: true,
    });

    access.relayForRegistered({
      workspaceId: "received-1",
      rootPath: "C:\\received",
      shareView: null,
      relay: { baseUrl: "https://relay.example", token: "secret" },
    });
    expect(bind).toHaveBeenLastCalledWith({
      workspaceId: "received-1",
      rootPath: "C:\\received",
      shareMount: true,
      relay: { baseUrl: "https://relay.example", token: "secret" },
    });
  });
});

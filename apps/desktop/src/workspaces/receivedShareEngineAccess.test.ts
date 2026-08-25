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
    const workspace = {
      workspaceId: "received-share-1",
      rootPath: "C:\\received-share",
    };

    expect(access.storeFor(workspace)).toBe(store);
    expect(createStores).toHaveBeenCalledWith(
      { ...workspace, shareMount: true },
      sessions,
    );

    expect(
      access.relayFor({
        ...workspace,
        relay: { baseUrl: "https://relay.example", token: "secret" },
      }),
    ).toBe(relay);
    expect(bind).toHaveBeenCalledWith({
      ...workspace,
      shareMount: true,
      relay: { baseUrl: "https://relay.example", token: "secret" },
    });
  });
});

import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { afterEach, describe, expect, it } from "vitest";
import {
  resealWorkspaceSecrets,
  unsealWorkspaceSecret,
  workspaceSecretKeyring,
  type WorkspaceSecretKeyring,
} from "./workspaceSecretCrypto";
import {
  closeTestStorages,
  jsonBody,
  LINK_KEY,
  request,
  testHandler,
  testStorage,
} from "./testing";
import type { StorageContext } from "./storage/context";

afterEach(async () => {
  await closeTestStorages();
});

const NEW_KEY = "n".repeat(32);
const NEWER_KEY = "m".repeat(40);

const resolveDesktopSession: ResolveAccountSession = async (req) => {
  const match = /^Bearer user:([^ ]+)$/u.exec(req.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: `desktop:${match[1]!}`,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: "desktop",
  };
};

function openSecret(storage: StorageContext, keyring: WorkspaceSecretKeyring, name: string) {
  const stored = storage.readWorkspaceSecretForExecution("ws-1", name)!;
  return {
    keyId: stored.keyId,
    value: unsealWorkspaceSecret({
      ...stored.summary,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      keyId: stored.keyId,
      sealed: stored.sealedValue,
      keyring,
    }),
  };
}

describe("workspace secret keyring", () => {
  it("reads DOHC_RELAY_SECRET_KEYS, with the first key sealing and the link key only opening", () => {
    expect(workspaceSecretKeyring({ linkKey: undefined })).toBeNull();
    expect(workspaceSecretKeyring({ linkKey: LINK_KEY, secretKeys: "  " })?.activeId).toBe(
      "relay-link-v1",
    );
    const keyring = workspaceSecretKeyring({
      linkKey: LINK_KEY,
      secretKeys: `v2:${NEWER_KEY}, v1:${NEW_KEY}`,
    })!;
    expect(keyring.activeId).toBe("v2");
    expect([...keyring.keys.keys()].sort()).toEqual(["relay-link-v1", "v1", "v2"]);
    expect(
      workspaceSecretKeyring({ linkKey: undefined, secretKeys: `k:${"a:b".repeat(11)}` })?.activeId,
    ).toBe("k");

    for (const [secretKeys, message] of [
      [`relay-link-v1:${NEW_KEY}`, 'invalid key id "relay-link-v1"'],
      [`Upper:${NEW_KEY}`, 'invalid key id "Upper"'],
      [NEW_KEY, 'invalid key id ""'],
      ["v1:short", 'key "v1" is 5 bytes; each key needs at least 32 bytes'],
      [`v1:${NEW_KEY},v1:${NEWER_KEY}`, 'names key "v1" twice'],
    ] as const) {
      expect(() => workspaceSecretKeyring({ linkKey: LINK_KEY, secretKeys })).toThrow(message);
    }
  });

  it("keeps old secrets working after a new key is added, and reseals them onto it", async () => {
    const storage = (await testStorage()) as StorageContext;
    storage.claimWorkspace({ workspaceId: "ws-1", ownerUserId: "owner", createdAtMs: 1 });
    const linkOnly = workspaceSecretKeyring({ linkKey: LINK_KEY })!;
    const rotated = workspaceSecretKeyring({ linkKey: LINK_KEY, secretKeys: `v1:${NEW_KEY}` })!;
    const put = async (keyring: WorkspaceSecretKeyring, name: string, value: string) => {
      const handler = testHandler(storage, {
        secretKeyring: keyring,
        resolvePhoneCapableAccountSession: resolveDesktopSession,
      });
      const response = await handler(
        request("owner", `/sync/ws-1/secrets/${name}`, {
          ...jsonBody({ mode: "create", usage: "http-url", value }),
          method: "PUT",
        }),
      );
      expect(response.status).toBe(200);
    };

    await put(linkOnly, "OLD_HOOK", "https://hooks.example.com/old");
    await put(rotated, "NEW_HOOK", "https://hooks.example.com/new");
    expect(openSecret(storage, rotated, "OLD_HOOK")).toEqual({
      keyId: "relay-link-v1",
      value: "https://hooks.example.com/old",
    });
    expect(openSecret(storage, rotated, "NEW_HOOK")).toEqual({
      keyId: "v1",
      value: "https://hooks.example.com/new",
    });
    expect(openSecret(storage, linkOnly, "NEW_HOOK").value).toBeNull();

    expect(resealWorkspaceSecrets(storage, rotated)).toEqual({
      resealed: 1,
      current: 1,
      unreadable: 0,
      changed: 0,
    });
    expect(openSecret(storage, rotated, "OLD_HOOK")).toEqual({
      keyId: "v1",
      value: "https://hooks.example.com/old",
    });
    const withoutLinkKey = workspaceSecretKeyring({ linkKey: null, secretKeys: `v1:${NEW_KEY}` })!;
    expect(openSecret(storage, withoutLinkKey, "OLD_HOOK").value).toBe(
      "https://hooks.example.com/old",
    );

    const lostKey = workspaceSecretKeyring({ linkKey: LINK_KEY, secretKeys: `v2:${NEWER_KEY}` })!;
    expect(resealWorkspaceSecrets(storage, lostKey)).toEqual({
      resealed: 0,
      current: 0,
      unreadable: 2,
      changed: 0,
    });
    expect(openSecret(storage, rotated, "OLD_HOOK").keyId).toBe("v1");
  });
});

import { parseAppExternalDeclaration } from "@dohc/security-contract/app-external";
import { describe, expect, it, vi } from "vitest";
import {
  APP_EXTERNAL_LIMITS,
  createAppExternalCalls,
  type ServedExternalApp,
} from "./appExternalCalls";
import type { SyncRelayStorage } from "./storage";

const external = parseAppExternalDeclaration({
  count: {
    method: "GET",
    url: "https://us.posthog.com/api/events/",
    secret: { name: "POSTHOG_KEY", header: "Authorization" },
    access: "viewers",
  },
});
const served = (caller: ServedExternalApp["caller"]): ServedExternalApp => ({
  publicationId: "p".repeat(64),
  workspaceId: "w",
  authorityRevision: 1,
  external,
  caller,
});
const link = served({ kind: "link", grantId: "g", principalId: "dataset_x" });
const owner = served({ kind: "owner" } as ServedExternalApp["caller"]);
const body = { authorityRevision: 1, operation: "count", input: {} };
const failed = { refusal: { code: "transport_failed" } };
const unavailable = {
  refusal: {
    code: "external_unavailable",
    message: "This app's outside service isn't available right now.",
  },
};

function calls(options: { hold?: Promise<void> } = {}) {
  const storage = {
    workspaceOwner: () => "owner",
    readWorkspaceSecretForExecution: () => null,
  } as unknown as SyncRelayStorage;
  return createAppExternalCalls({
    storage,
    keyring: null,
    nowMs: () => 0,
    transport: {
      resolve: async (url) => {
        await options.hold;
        throw new Error(url);
      },
      read: async () => {
        throw new Error("unreachable");
      },
    },
  });
}
const run = (call: ReturnType<typeof calls>, app: ServedExternalApp) =>
  call(app, body, async () => {}, new AbortController().signal);

describe("createAppExternalCalls", () => {
  it("refuses a share link past its burst, naming the limit, and tells visitors only that the service is unavailable", async () => {
    const call = calls();
    for (let i = 0; i < APP_EXTERNAL_LIMITS.link.burst; i++)
      await expect(run(call, link)).rejects.toMatchObject(unavailable);
    await expect(run(call, link)).rejects.toMatchObject({
      refusal: {
        code: "external_rate_limited",
        message: expect.stringContaining(`${APP_EXTERNAL_LIMITS.link.burst} outside calls`),
      },
    });
    await expect(run(call, owner)).rejects.toMatchObject(failed);
  });

  it("keeps calls free for the owner, and a busy refusal spends no rate", async () => {
    let release!: () => void;
    const call = calls({ hold: new Promise<void>((resolve) => (release = resolve)) });
    const visitors = APP_EXTERNAL_LIMITS.inFlight - APP_EXTERNAL_LIMITS.ownerReserved;
    const running = [owner, owner, ...Array.from({ length: visitors }, () => link)].map((app) =>
      run(call, app).catch((error) => error),
    );
    for (let i = 0; i < APP_EXTERNAL_LIMITS.link.burst; i++)
      await expect(run(call, link)).rejects.toMatchObject({ refusal: { code: "external_busy" } });
    await expect(run(call, owner)).rejects.toMatchObject({ refusal: { code: "external_busy" } });
    release();
    for (const result of await Promise.all(running))
      expect(result.refusal.code).not.toBe("external_busy");
    await expect(run(call, link)).rejects.toMatchObject(unavailable);
  });

  it("checks the caller can still run the app before it reads the secret", async () => {
    const read = vi.fn(() => null);
    const call = createAppExternalCalls({
      storage: {
        workspaceOwner: () => "owner",
        readWorkspaceSecretForExecution: read,
      } as unknown as SyncRelayStorage,
      keyring: {} as never,
      nowMs: () => 0,
      transport: {
        resolve: async (url) => ({
          href: url,
          url: new URL(url),
          canonicalHost: "us.posthog.com",
          address: "93.184.216.34",
          family: 4,
        }),
        read: async () => {
          throw new Error("unreachable");
        },
      },
    });
    const gone = new Error("gone");
    await expect(
      call(owner, body, () => Promise.reject(gone), new AbortController().signal),
    ).rejects.toBe(gone);
    expect(read).not.toHaveBeenCalled();
  });

  it("tells the owner when the server can't read secrets, and visitors only that the service is unavailable", async () => {
    const call = createAppExternalCalls({
      storage: { workspaceOwner: () => "owner" } as unknown as SyncRelayStorage,
      keyring: null,
      nowMs: () => 0,
      transport: {
        resolve: async (url) => ({
          href: url,
          url: new URL(url),
          canonicalHost: "us.posthog.com",
          address: "93.184.216.34",
          family: 4,
        }),
        read: async () => {
          throw new Error("unreachable");
        },
      },
    });
    await expect(run(call, owner)).rejects.toMatchObject({
      refusal: {
        code: "external_unavailable",
        message: "This server can't read workspace secrets.",
      },
    });
    await expect(run(call, link)).rejects.toMatchObject(unavailable);
  });
});

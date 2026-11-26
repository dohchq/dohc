import { parseAppExternalDeclaration } from "@dohc/security-contract/app-external";
import { describe, expect, it } from "vitest";
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
const served = (caller: ServedExternalApp["authority"]["caller"]): ServedExternalApp => ({
  publicationId: "p".repeat(64),
  workspaceId: "w",
  authorityRevision: 1,
  external,
  authority: { caller, principalKey: "k", authorityToken: "t" } as ServedExternalApp["authority"],
});
const link = served({ kind: "link", grantId: "g", principalId: "dataset_x" });
const owner = served({ kind: "owner" } as ServedExternalApp["authority"]["caller"]);
const body = { authorityRevision: 1, operation: "count", input: {} };

function calls(options: { keyring?: null; hold?: Promise<void> } = {}) {
  const storage = {
    workspaceOwner: () => "owner",
    readWorkspaceSecretForExecution: () => null,
  } as unknown as SyncRelayStorage;
  return createAppExternalCalls({
    storage,
    keyring: options.keyring ?? null,
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
  it("refuses a share link past its burst, naming the limit", async () => {
    const call = calls();
    for (let i = 0; i < APP_EXTERNAL_LIMITS.link.burst; i++)
      await expect(run(call, link)).rejects.toMatchObject({
        refusal: { code: "transport_failed" },
      });
    await expect(run(call, link)).rejects.toMatchObject({
      refusal: {
        code: "external_rate_limited",
        message: expect.stringContaining(`${APP_EXTERNAL_LIMITS.link.burst} outside calls`),
      },
    });
    await expect(run(call, owner)).rejects.toMatchObject({ refusal: { code: "transport_failed" } });
  });

  it("keeps calls free for the owner while visitors fill the rest", async () => {
    let release!: () => void;
    const call = calls({ hold: new Promise<void>((resolve) => (release = resolve)) });
    const visitors = APP_EXTERNAL_LIMITS.inFlight - APP_EXTERNAL_LIMITS.ownerReserved;
    const running = Array.from({ length: visitors }, () => run(call, link).catch(() => {}));
    await expect(run(call, link)).rejects.toMatchObject({ refusal: { code: "external_busy" } });
    const mine = run(call, owner).catch((error) => error);
    release();
    await Promise.all(running);
    expect(await mine).toMatchObject({ refusal: { code: "transport_failed" } });
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
    await expect(run(call, link)).rejects.toMatchObject({
      refusal: { message: "This app's outside service isn't available right now." },
    });
  });
});

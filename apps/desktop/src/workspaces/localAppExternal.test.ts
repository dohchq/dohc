import { parseAppExternalDeclaration } from "@dohc/security-contract/app-external";
import type { DeclaredHttpsTransport, SafeOutboundRequest } from "@dohc/service-http";
import { describe, expect, it, vi } from "vitest";
import { createLocalAppExternal, LOCAL_APP_EXTERNAL_IN_FLIGHT } from "./localAppExternal";
import type { LocalWorkspaceSecretStore } from "./localWorkspaceSecretStore";

const KEY = "phx_live_secret";
const [operation] = parseAppExternalDeclaration({
  insights: {
    method: "GET",
    url: "https://us.posthog.com/api/projects/{{project}}/insights/",
    params: { project: { type: "integer", min: 1, max: 999 } },
    secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
  },
});

function secrets(
  summary: { usage?: "http-header" | "http-url"; allowedHosts?: string[] } | null,
  canKeep = true,
) {
  const read = vi.fn(async () =>
    summary === null
      ? null
      : {
          summary: {
            name: "POSTHOG_KEY",
            usage: summary.usage ?? "http-header",
            allowedHosts: summary.allowedHosts ?? ["us.posthog.com"],
            generation: 1,
            createdAtMs: 0,
            updatedAtMs: 0,
          },
          value: KEY,
        },
  );
  return {
    store: {
      canKeep: () => canKeep,
      readSecretForExecution: read,
    } as unknown as LocalWorkspaceSecretStore,
    read,
  };
}

function transport(gate?: Promise<void>) {
  const sent: SafeOutboundRequest[] = [];
  const value: DeclaredHttpsTransport = {
    resolve: async (url) => ({
      href: url,
      url: new URL(url),
      canonicalHost: "us.posthog.com",
      address: "1.1.1.1",
      family: 4,
    }),
    read: async (request) => {
      sent.push(request);
      await gate;
      return { status: 200, contentType: "application/json", body: Buffer.from('{"results":[1]}') };
    },
  };
  return { value, sent };
}

const call = (
  options: Partial<Parameters<typeof createLocalAppExternal>[0]>,
  input: unknown = { project: 7 },
) =>
  createLocalAppExternal({
    workspaceId: "ws",
    secrets: secrets({}).store,
    unavailable: () => null,
    transport: transport().value,
    ...options,
  })(operation!, input, new AbortController().signal);

describe("local app outside calls", () => {
  it("sends the declared request with the secret in its header", async () => {
    const t = transport();
    const s = secrets({});
    await expect(call({ transport: t.value, secrets: s.store })).resolves.toEqual({
      status: 200,
      data: { results: [1] },
    });
    expect(s.read).toHaveBeenCalledWith("ws", "POSTHOG_KEY");
    expect(t.sent[0]!.destination.href).toBe("https://us.posthog.com/api/projects/7/insights/");
    expect(t.sent[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    [{ secrets: secrets(null).store }, "isn't in Settings > Secrets"],
    [{ secrets: secrets({ usage: "http-url" }).store }, "is a webhook address"],
    [
      { secrets: secrets({ allowedHosts: ["api.stripe.com"] }).store },
      "isn't allowed for us.posthog.com",
    ],
    [{ secrets: secrets({}, false).store }, "keychain is unavailable"],
    [{ unavailable: () => "Apps in synced workspaces can't call outside services yet." }, "synced"],
  ])("refuses before sending when the secret can't be used: %#", async (options, message) => {
    const t = transport();
    await expect(call({ ...options, transport: t.value })).rejects.toMatchObject({
      name: "AppBackendRuntimeError",
      message: expect.stringContaining(message),
    });
    expect(t.sent).toHaveLength(0);
  });

  it("refuses input outside the declaration as the app's refusal", async () => {
    await expect(call({}, { project: "7/../admin" })).rejects.toMatchObject({
      refusal: { code: "external_input" },
    });
  });

  it(`runs at most ${LOCAL_APP_EXTERNAL_IN_FLIGHT} calls at once per workspace`, async () => {
    let open!: () => void;
    const t = transport(new Promise((resolve) => (open = resolve)));
    const run = createLocalAppExternal({
      workspaceId: "ws",
      secrets: secrets({}).store,
      unavailable: () => null,
      transport: t.value,
    });
    const signal = new AbortController().signal;
    const running = Array.from({ length: LOCAL_APP_EXTERNAL_IN_FLIGHT }, () =>
      run(operation!, { project: 1 }, signal),
    );
    await expect(run(operation!, { project: 1 }, signal)).rejects.toMatchObject({
      refusal: { code: "external_busy" },
    });
    open();
    await Promise.all(running);
    await expect(run(operation!, { project: 1 }, signal)).resolves.toMatchObject({ status: 200 });
  });
});

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createAppLaunchHandler, type AppNamedBrowserMaterial } from "./appLaunch";
import { createPhoneAppMaterialResolver } from "./namedAppMaterial";

const config = { viewerOrigin: "https://viewer.example.com", appDomain: "example.net" };
const relayUrl = "https://relay.example.org";
const publicationId = "a".repeat(64),
  workspaceId = "workspace-1",
  grant = "G".repeat(43),
  launchId = "L".repeat(43),
  exchangeKey = "x".repeat(32);
const bytes = Buffer.from("document.getElementById('root').textContent='Trip app';");
const file = {
  path: "bundle.js",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteLength: bytes.length,
  contentType: "text/javascript; charset=utf-8",
};

function fixture() {
  let now = 1_000;
  const relayed: Request[] = [],
    redeemed: unknown[] = [],
    // Each phone launch's launch-ID hash, in the order the launches were redeemed.
    launches: string[] = [];
  // The relay behind a phone launch's material: it answers until the launch is ended there.
  const material = (
    userId: string,
    phone = true,
  ): Extract<AppNamedBrowserMaterial, { ok: true }> => {
    const launchHash = String(launches.length).padStart(64, "0");
    if (phone) launches.push(launchHash);
    return {
      ok: true,
      kind: "named",
      userId,
      admissionKey: `phone-${userId}`,
      setCookie: null,
      ...(phone ? { phone: { launchHash } } : {}),
      fetchRelay: async (request) => {
        relayed.push(request);
        if (new URL(request.url).pathname.includes("/blobs/"))
          return new Response(bytes, { headers: { "content-type": file.contentType } });
        return Response.json({ publicationId, authorityRevision: 1, files: [file] });
      },
    };
  };
  const handler = createAppLaunchHandler({
    config,
    relayUrl,
    nowMs: () => now,
    fetchRelay: async () => {
      throw Error("A phone launch must use its bound transport.");
    },
    resolveMaterial: async () => {
      throw Error("A phone launch must not resolve a link session.");
    },
    resolveNamedMaterial: async (_workspace, _publication, cookie) =>
      cookie === "account=owner" ? material("browser-owner", false) : { ok: false, status: 401 },
    redeemPhoneGrant: async (workspace, publication, value, launchHost) => {
      redeemed.push({ workspace, publication, value, launchHost });
      return value === grant ? material("ana") : { ok: false, status: 404 };
    },
  });
  const post = (url: string, body: string, headers: Record<string, string>) =>
    handler.handle(
      new Request(url, { method: "POST", body, headers: { host: new URL(url).host, ...headers } }),
    );
  const issue = (headers: Record<string, string> = {}, value = grant) =>
    post(
      `${config.viewerOrigin}/api/apps/phone-launch`,
      JSON.stringify({ grant: value, workspaceId, publicationId }),
      { "content-type": "application/json", ...headers },
    );
  const bootstrap = (action: string, handoff: string, headers: Record<string, string> = {}) =>
    post(action, new URLSearchParams({ handoff }).toString(), {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    });
  const open = async () => {
    const issued = await issue();
    expect(issued.status).toBe(200);
    const { action, handoff } = (await issued.json()) as { action: string; handoff: string };
    // The phone's native code sends no Origin.
    const page = await bootstrap(action, handoff);
    expect(page.status).toBe(200);
    const html = await page.text(),
      origin = new URL(action).origin;
    const proof = /const proof="([A-Za-z0-9_-]{43})"/.exec(html)![1]!;
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const call = (path: string) =>
      post(origin + path, "", { origin, cookie, "x-dohc-app-proof": proof });
    return { action, html, call };
  };
  return {
    handler,
    issue,
    bootstrap,
    open,
    relayed,
    redeemed,
    launches,
    tick: (ms: number) => (now += ms),
  };
}

it("opens a phone launch from its grant alone, bound to the host it was redeemed for", async () => {
  const f = fixture();
  const app = await f.open();
  expect(f.redeemed).toEqual([
    {
      workspace: workspaceId,
      publication: publicationId,
      value: grant,
      launchHost: new URL(app.action).host,
    },
  ]);
  expect(app.html).not.toContain(grant);
  expect((await app.call("/document")).status).toBe(200);
  expect((await app.call("/status")).status).toBe(204);
  // A page can't spend a phone's grant: it always sends an Origin.
  for (const origin of [config.viewerOrigin, "null"])
    expect((await f.issue({ origin })).status, origin).toBe(404);
  expect((await f.issue({}, "H".repeat(43))).status).toBe(404);
});

it("keeps a browser launch's bootstrap to the viewer's Origin", async () => {
  const f = fixture();
  const issued = await f.handler.handle(
    new Request(`${config.viewerOrigin}/api/apps/launch`, {
      method: "POST",
      body: JSON.stringify({ workspaceId, publicationId }),
      headers: {
        host: new URL(config.viewerOrigin).host,
        origin: config.viewerOrigin,
        cookie: "account=owner",
        "content-type": "application/json",
      },
    }),
  );
  expect(issued.status).toBe(200);
  const { action, handoff } = (await issued.json()) as { action: string; handoff: string };
  expect((await f.bootstrap(action, handoff)).status).toBe(404);
  expect((await f.bootstrap(action, handoff, { origin: config.viewerOrigin })).status).toBe(200);
});

it("ends at once only the phone launches a purge names, so a late purge leaves a newer launch open", async () => {
  const f = fixture();
  const first = await f.open();
  const second = await f.open();
  f.handler.endPhoneLaunches(["f".repeat(64)]);
  expect((await first.call("/status")).status).toBe(204);
  const before = f.relayed.length;
  f.handler.endPhoneLaunches([f.launches[0]!]);
  // Ended without asking the relay.
  expect((await first.call("/status")).status).toBe(404);
  expect(f.relayed).toHaveLength(before);
  expect((await second.call("/status")).status).toBe(204);
  // The same purge arriving late, after the app was opened again, ends nothing new.
  const reopened = await f.open();
  f.handler.endPhoneLaunches([f.launches[0]!]);
  expect((await reopened.call("/status")).status).toBe(204);
  f.handler.endPhoneLaunches([f.launches[1]!, f.launches[2]!]);
  expect((await second.call("/status")).status).toBe(404);
  expect((await reopened.call("/status")).status).toBe(404);
});

it("ends a phone launch's session ten minutes after its bootstrap, however often it is checked", async () => {
  const f = fixture();
  const app = await f.open();
  for (let minute = 0; minute < 9; minute++) {
    f.tick(60_000);
    expect((await app.call("/status")).status).toBe(204);
  }
  f.tick(60_000);
  expect((await app.call("/status")).status).toBe(404);
});

it("holds only the relay's launch ID for a phone, never the phone's sign-in", async () => {
  const sent: Request[] = [];
  const resolve = createPhoneAppMaterialResolver({
    relayUrl,
    publicOrigin: config.viewerOrigin,
    exchangeKey,
    fetchRelay: async (request) => {
      sent.push(request);
      return new URL(request.url).pathname.endsWith("/redeem")
        ? Response.json({ launchId, userId: "ana", authorityRevision: 1 })
        : new Response(null, { status: 204 });
    },
  });
  const launchHost = `${"c".repeat(48)}.example.net`;
  const material = await resolve(
    workspaceId,
    publicationId,
    grant,
    launchHost,
    AbortSignal.timeout(1000),
  );
  if (!material.ok) throw Error("The grant was refused.");
  const redeem = sent[0]!;
  expect(new URL(redeem.url).pathname).toBe(
    `/sync/${workspaceId}/app-publications/${publicationId}/backend/redeem`,
  );
  expect(await redeem.json()).toEqual({ grant, launchHost });
  // The relay names the launches it ends by this hash.
  expect(material.phone).toEqual({
    launchHash: createHash("sha256").update(launchId).digest("hex"),
  });
  const again = await resolve(
    workspaceId,
    publicationId,
    grant,
    launchHost,
    AbortSignal.timeout(1000),
  );
  // Every launch for one person shares one rate limit.
  expect(again.ok && again.admissionKey).toBe(material.admissionKey);
  await material.fetchRelay(new Request(`${relayUrl}/sync/link/app-publications/${publicationId}`));
  const descriptor = sent.at(-1)!;
  expect(new URL(descriptor.url).pathname).toBe(
    `/sync/${workspaceId}/app-publications/${publicationId}/backend/descriptor`,
  );
  expect(descriptor.headers.get("x-dohc-app-launch")).toBe(launchId);
  expect(descriptor.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
  for (const request of sent) {
    expect(request.headers.has("cookie")).toBe(false);
    expect(request.headers.has("authorization")).toBe(false);
  }
  // A phone launch has no share summary to read.
  const count = sent.length;
  const summary = await material.fetchRelay(
    new Request(`${relayUrl}/sync/link/app-publications/${publicationId}/summary`),
  );
  expect(summary.status).toBe(404);
  expect(sent).toHaveLength(count);
});

it("answers a phone grant the relay can't be reached for as unavailable, not refused", async () => {
  const resolve = createPhoneAppMaterialResolver({
    relayUrl,
    publicOrigin: config.viewerOrigin,
    exchangeKey,
    fetchRelay: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const material = await resolve(
    workspaceId,
    publicationId,
    grant,
    `${"d".repeat(48)}.example.net`,
    AbortSignal.timeout(1000),
  );
  expect(material).toEqual({ ok: false, status: 503 });
});

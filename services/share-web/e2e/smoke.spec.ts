import { randomBytes } from "node:crypto";
import { type Browser } from "@playwright/test";
import {
  expect,
  ownerHeaders,
  seedShare,
  type SeededShare,
  test,
} from "./harness";

async function refusalCopy(browser: Browser, stackUrl: string, secret: string): Promise<string> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${stackUrl}/s/#${secret}`);
    const refusal = page.locator("main.state");
    await expect(refusal).toBeVisible();
    return (await refusal.innerText()).trim();
  } finally {
    await context.close();
  }
}

async function revokeLink(relayUrl: string, seeded: SeededShare): Promise<void> {
  const response = await fetch(
    `${relayUrl}/sync/shares/${encodeURIComponent(seeded.shareId)}/revoke`,
    {
      method: "POST",
      headers: ownerHeaders(seeded.ownerUserId, true),
      body: JSON.stringify({ grantId: seeded.grantId }),
    },
  );
  expect(response.status, await response.text()).toBe(200);
}

test("opens a real accountless share without exposing its bearer secret", async ({
  browser,
  page,
  stack,
}) => {
  const markdown = "# Browser isolation smoke\n\nRendered by the real viewer.\n";
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/readme.md", content: markdown }],
    paths: ["docs"],
  });
  const exchangeResponses: Array<import("@playwright/test").Response> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/exchange") {
      exchangeResponses.push(response);
    }
  });

  await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
  const article = page.locator("article.markdown");
  await expect(article).toContainText("Browser isolation smoke");
  await expect(article).toContainText("Rendered by the real viewer.");

  const finalUrl = new URL(page.url());
  expect(finalUrl.origin).toBe(stack.shareWebUrl);
  expect(finalUrl.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{12}$/u);
  expect(finalUrl.hash).toBe("");
  expect(finalUrl.search).toBe("");
  expect(page.url()).not.toContain(seeded.secret);

  expect(exchangeResponses).toHaveLength(1);
  const exchangeResponse = exchangeResponses[0]!;
  const session = finalUrl.pathname.slice("/s/".length);
  expect(await exchangeResponse.json()).toEqual({ ok: true, session });
  const setCookie = await exchangeResponse.headerValue("set-cookie");
  expect(setCookie).not.toBeNull();
  expect(setCookie).toMatch(
    new RegExp(`^dohc_share_${session}=[A-Za-z0-9_-]+;`, "u"),
  );
  expect(setCookie).toMatch(/;\s*Path=\/(?:;|$)/iu);
  expect(setCookie).toMatch(/;\s*Secure(?:;|$)/iu);
  expect(setCookie).toMatch(/;\s*HttpOnly(?:;|$)/iu);
  expect(setCookie).toMatch(/;\s*SameSite=Strict(?:;|$)/iu);
  expect(setCookie).not.toMatch(/;\s*Domain=/iu);

  const contextCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === `dohc_share_${session}`,
  );
  expect(contextCookie).toBeDefined();
  expect(contextCookie).toMatchObject({
    domain: "127.0.0.1",
    httpOnly: true,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
  expect(await page.evaluate(() => document.cookie)).not.toContain("dohc_share_");

  const wrongSecret = randomBytes(32).toString("base64url");
  expect(wrongSecret).toHaveLength(43);
  const wrongSecretCopy = await refusalCopy(browser, stack.shareWebUrl, wrongSecret);
  await revokeLink(stack.relayUrl, seeded);
  const revokedLinkCopy = await refusalCopy(browser, stack.shareWebUrl, seeded.secret);
  expect(wrongSecretCopy).toBe("This link isn't available.");
  expect(revokedLinkCopy).toBe(wrongSecretCopy);
});

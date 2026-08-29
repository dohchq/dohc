import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type CDPSession, type Page } from "@playwright/test";
import {
  expect,
  seedShare,
  test,
} from "./harness";

interface ObservedNetworkResponse {
  body: Buffer;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  status: number;
}

interface PausedResponse {
  request: {
    headers: Record<string, string>;
    url: string;
  };
  requestId: string;
  responseHeaders?: Array<{ name: string; value: string }>;
  responseStatusCode?: number;
}

async function fetchFromProbe(
  cdp: CDPSession,
  page: Page,
  probeUrl: string,
  blobUrl: string,
): Promise<ObservedNetworkResponse> {
  const probeResponse = await page.goto(probeUrl);
  if (!probeResponse) throw new Error(`probe navigation returned no response for ${probeUrl}`);
  expect(new URL(page.url()).origin).toBe(new URL(probeUrl).origin);

  let pausedListener: ((event: PausedResponse) => void) | undefined;
  const networkResponsePromise = new Promise<ObservedNetworkResponse>((resolve, reject) => {
    pausedListener = (event) => {
      if (event.request.url !== blobUrl) {
        void cdp.send("Fetch.continueResponse", { requestId: event.requestId }).catch(() => {});
        return;
      }
      void (async () => {
        try {
          if (event.responseStatusCode === undefined || !event.responseHeaders) {
            throw new Error("CDP paused the blob request before its response was available");
          }
          const encodedBody = await cdp.send("Fetch.getResponseBody", {
            requestId: event.requestId,
          });
          await cdp.send("Fetch.continueResponse", { requestId: event.requestId });
          resolve({
            body: Buffer.from(
              encodedBody.body,
              encodedBody.base64Encoded ? "base64" : "utf8",
            ),
            requestHeaders: lowerCaseHeaders(event.request.headers),
            responseHeaders: lowerCaseHeaders(
              Object.fromEntries(
                event.responseHeaders.map(({ name, value }) => [name, value]),
              ),
            ),
            status: event.responseStatusCode,
          });
        } catch (error) {
          await cdp.send("Fetch.continueResponse", { requestId: event.requestId }).catch(() => {});
          reject(error);
        }
      })();
    };
    cdp.on("Fetch.requestPaused", pausedListener);
  });
  const scriptResult = await page.evaluate(async (targetUrl) => {
    try {
      const response = await fetch(targetUrl, { credentials: "include" });
      return {
        body: await response.text(),
        rejected: false as const,
        status: response.status,
      };
    } catch (error) {
      return {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
        rejected: true as const,
      };
    }
  }, blobUrl);
  const networkResponse = await networkResponsePromise.finally(() => {
    if (pausedListener) cdp.off("Fetch.requestPaused", pausedListener);
  });
  expect(scriptResult).toMatchObject({
    errorName: "TypeError",
    rejected: true,
  });
  return networkResponse;
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function expectNoCorsPermission(response: ObservedNetworkResponse): void {
  expect(response.responseHeaders["access-control-allow-origin"]).toBeUndefined();
  expect(response.responseHeaders["access-control-allow-credentials"]).toBeUndefined();
}

function handoffCodeCount(relayDbPath: string): number {
  const database = new DatabaseSync(relayDbPath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM sync_relay_link_handoff_codes")
      .get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

test("separates cross-site Strict-cookie withholding from same-site CORS protection", async ({
  browser,
  probe,
  stack,
}) => {
  const targetBytes = Buffer.from(
    `iso8crossorigin-${randomBytes(24).toString("hex")}`,
    "utf8",
  );
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [{ path: "docs/cors-target.txt", content: targetBytes }],
  });
  const targetFile = seeded.files.find((file) => file.path === "docs/cors-target.txt");
  if (!targetFile) throw new Error("cross-origin fixture was not seeded");

  const context = await browser.newContext();
  let cdp: CDPSession | undefined;
  try {
    const page = await context.newPage();
    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
    await expect(
      page
        .getByRole("navigation", { name: "Shared files" })
        .getByRole("button", { name: "cors-target.txt", exact: true }),
    ).toBeVisible();

    const finalViewerUrl = new URL(page.url());
    expect(finalViewerUrl.origin).toBe(stack.shareWebUrl);
    expect(finalViewerUrl.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{12}$/u);
    expect(finalViewerUrl.hash).toBe("");
    expect(finalViewerUrl.search).toBe("");
    const session = finalViewerUrl.pathname.slice("/s/".length);
    const blobUrl = new URL(
      `/api/view/blob/${targetFile.blobSha256}?session=${session}`,
      finalViewerUrl.origin,
    ).href;
    cdp = await context.newCDPSession(page);
    await cdp.send("Fetch.enable", {
      patterns: [{ requestStage: "Response", urlPattern: blobUrl }],
    });

    const crossSite = await fetchFromProbe(cdp, page, probe.url, blobUrl);
    expect(crossSite.status).toBe(404);
    expectNoCorsPermission(crossSite);
    expect(crossSite.requestHeaders["x-dohc-link-session"])
      .toBeUndefined();

    const sameSite = await fetchFromProbe(cdp, page, probe.sameHostnameUrl, blobUrl);
    expect(sameSite.status).toBe(200);
    expectNoCorsPermission(sameSite);
    expect(sameSite.requestHeaders["x-dohc-link-session"])
      .toBeUndefined();
    expect(sameSite.body).toEqual(targetBytes);
  } finally {
    await cdp?.send("Fetch.disable").catch(() => {});
    await cdp?.detach().catch(() => {});
    await context.close();
  }
});

test("blocks a cross-origin handoff mint without disturbing the viewer", async ({
  browser,
  probe,
  stack,
}) => {
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [{ path: "docs/handoff-target.md", content: "# Handoff target\n" }],
  });
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    await viewer.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
    const fileButton = viewer
      .getByRole("navigation", { name: "Shared files" })
      .getByRole("button", { name: "handoff-target.md", exact: true });
    await expect(fileButton).toBeVisible();
    const session = new URL(viewer.url()).pathname.slice("/s/".length);
    expect(session).toMatch(/^[A-Za-z0-9_-]{12}$/u);
    expect(handoffCodeCount(stack.relayDbPath)).toBe(0);

    const hostile = await context.newPage();
    await hostile.goto(probe.sameHostnameUrl);
    const attempt = await hostile.evaluate(
      async ({ handoffUrl, session }) => {
        try {
          const response = await fetch(handoffUrl, {
            method: "POST",
            credentials: "include",
            headers: { "x-dohc-link-session": session },
          });
          return { rejected: false as const, status: response.status };
        } catch (error) {
          return {
            errorName: error instanceof Error ? error.name : typeof error,
            rejected: true as const,
          };
        }
      },
      { handoffUrl: `${stack.shareWebUrl}/api/handoff`, session },
    );

    expect(handoffCodeCount(stack.relayDbPath)).toBe(0);
    expect(attempt).toMatchObject({ errorName: "TypeError", rejected: true });
    await expect(fileButton).toBeVisible();
    await fileButton.click();
    await expect(viewer.getByRole("heading", { name: "Handoff target" })).toBeVisible();
  } finally {
    await context.close();
  }
});

import { randomBytes } from "node:crypto";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import {
  seedShare,
  startProbe,
  startStack,
  type RunningProbe,
  type RunningStack,
} from "./harness";

interface BlockedFetch {
  errorMessage: string;
  errorName: string;
  rejected: true;
}

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

let probe: RunningProbe | undefined;
let stack: RunningStack | undefined;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  stack = await startStack();
  try {
    probe = await startProbe();
  } catch (error) {
    await stack.stop();
    stack = undefined;
    throw error;
  }
});

test.afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    await probe?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await stack?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "cross-origin browser test cleanup failed");
  }
});

async function fetchFromProbe(
  cdp: CDPSession,
  page: Page,
  probeUrl: string,
  blobUrl: string,
): Promise<{ networkResponse: ObservedNetworkResponse; scriptResult: BlockedFetch }> {
  const probeResponse = await page.goto(probeUrl);
  if (!probeResponse) throw new Error(`probe navigation returned no response for ${probeUrl}`);
  expect(new URL(page.url()).origin).toBe(new URL(probeUrl).origin);

  let pausedListener: ((event: PausedResponse) => void) | undefined;
  const networkResponsePromise = new Promise<ObservedNetworkResponse>((resolve, reject) => {
    pausedListener = (event) => {
      if (event.request.url !== blobUrl) {
        void cdp.send("Fetch.continueResponse", { requestId: event.requestId });
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
  expect(scriptResult).toEqual({
    errorMessage: "Failed to fetch",
    errorName: "TypeError",
    rejected: true,
  });
  if (!scriptResult.rejected) {
    throw new Error(`probe script unexpectedly read HTTP ${String(scriptResult.status)}`);
  }
  return { networkResponse, scriptResult };
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

test("separates cross-site Strict-cookie withholding from same-site CORS protection", async ({
  browser,
}) => {
  if (!stack || !probe) throw new Error("cross-origin browser test services did not start");

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
    expect(crossSite.networkResponse.status).toBe(404);
    expectNoCorsPermission(crossSite.networkResponse);
    expect(crossSite.networkResponse.requestHeaders["x-dohc-link-session"])
      .toBeUndefined();

    const sameSite = await fetchFromProbe(cdp, page, probe.sameHostnameUrl, blobUrl);
    expect(sameSite.networkResponse.status).toBe(200);
    expectNoCorsPermission(sameSite.networkResponse);
    expect(sameSite.networkResponse.requestHeaders["x-dohc-link-session"])
      .toBeUndefined();
    expect(sameSite.networkResponse.body).toEqual(targetBytes);
  } finally {
    await cdp?.send("Fetch.disable").catch(() => {});
    await cdp?.detach().catch(() => {});
    await context.close();
  }
});

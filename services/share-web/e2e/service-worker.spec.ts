import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import {
  seedShare,
  startProbe,
  startStack,
  type RunningProbe,
  type RunningStack,
} from "./harness";

const EXECUTION_MARKER = "ISO5WORKER_EXECUTED_76b91e4a";
const EXECUTION_SENTINEL = "__dohcIso5WorkerExecutionSentinel_76b91e4a";
const SENTINEL_BASELINE = "iso5worker-unmodified-76b91e4a";
const FETCH_PROBE_PATH = "/api/view/blob/iso5worker-fetch-probe-76b91e4a/";

interface RegistrationSnapshot {
  installingScriptUrl: string | null;
  scope: string;
  waitingScriptUrl: string | null;
  activeScriptUrl: string | null;
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
    throw new AggregateError(cleanupErrors, "service-worker browser test cleanup failed");
  }
});

function hostileWorker(probeUrl: string): Uint8Array {
  const installProbeUrl = `${probeUrl}/iso5worker-install?marker=76b91e4a`;
  return new TextEncoder().encode([
    `const EXECUTION_MARKER = ${JSON.stringify(EXECUTION_MARKER)};`,
    `const INSTALL_PROBE_URL = ${JSON.stringify(installProbeUrl)};`,
    `const FETCH_PROBE_PATH = ${JSON.stringify(FETCH_PROBE_PATH)};`,
    "async function notifyClients(phase) {",
    '  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });',
    "  for (const client of windows) client.postMessage({ marker: EXECUTION_MARKER, phase });",
    "}",
    'self.addEventListener("install", (event) => {',
    "  void fetch(INSTALL_PROBE_URL).catch(() => undefined);",
    '  event.waitUntil(Promise.all([self.skipWaiting(), notifyClients("install")]));',
    "});",
    'self.addEventListener("activate", (event) => {',
    '  event.waitUntil(Promise.all([self.clients.claim(), notifyClients("activate")]));',
    "});",
    'self.addEventListener("fetch", (event) => {',
    "  if (new URL(event.request.url).pathname === FETCH_PROBE_PATH) {",
    '    event.respondWith(new Response(EXECUTION_MARKER, { headers: { "content-type": "text/plain" } }));',
    "  }",
    "});",
  ].join("\n"));
}

function registrationSnapshots(page: Page): Promise<RegistrationSnapshot[]> {
  return page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.map((registration) => ({
      activeScriptUrl: registration.active?.scriptURL ?? null,
      installingScriptUrl: registration.installing?.scriptURL ?? null,
      scope: registration.scope,
      waitingScriptUrl: registration.waiting?.scriptURL ?? null,
    }));
  });
}

function matchesWorker(
  registration: RegistrationSnapshot,
  workerScriptUrl: string,
  workerScopeUrl: string,
): boolean {
  return registration.scope === workerScopeUrl ||
    registration.activeScriptUrl === workerScriptUrl ||
    registration.installingScriptUrl === workerScriptUrl ||
    registration.waitingScriptUrl === workerScriptUrl;
}

test("keeps a shared JavaScript file from becoming a service worker", async ({ browser }) => {
  if (!stack || !probe) throw new Error("service-worker browser test services did not start");

  const workerBytes = hostileWorker(probe.url);
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [
      { path: "docs/readme.md", content: "# Service-worker browser conformance\n" },
      { path: "docs/worker.js", content: workerBytes, contentKind: "binary" },
    ],
  });
  const workerFile = seeded.files.find((file) => file.path === "docs/worker.js");
  if (!workerFile) throw new Error("service-worker fixture was not seeded");

  const context = await browser.newContext();
  let page: Page | undefined;
  let workerScriptUrl: string | undefined;
  let workerScopeUrl: string | undefined;
  try {
    await context.addInitScript(
      ({ baseline, executionMarker, sentinel }) => {
        Reflect.set(window, sentinel, baseline);
        navigator.serviceWorker.addEventListener("message", (event) => {
          const data = event.data as { marker?: unknown } | null;
          if (data?.marker === executionMarker) Reflect.set(window, sentinel, executionMarker);
        });
      },
      {
        baseline: SENTINEL_BASELINE,
        executionMarker: EXECUTION_MARKER,
        sentinel: EXECUTION_SENTINEL,
      },
    );
    page = await context.newPage();
    const observedWorkerRequests: Request[] = [];
    const observedWorkerResponses: Response[] = [];
    context.on("request", (request) => {
      if (request.url() === workerScriptUrl) observedWorkerRequests.push(request);
    });
    context.on("response", (response) => {
      if (response.url() === workerScriptUrl) observedWorkerResponses.push(response);
    });

    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
    await expect(page.locator("article.markdown")).toContainText(
      "Service-worker browser conformance",
    );

    const finalViewerUrl = new URL(page.url());
    expect(finalViewerUrl.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{12}$/u);
    expect(finalViewerUrl.hash).toBe("");
    expect(finalViewerUrl.search).toBe("");
    const session = finalViewerUrl.pathname.slice("/s/".length);
    workerScriptUrl = new URL(
      `/api/view/blob/${workerFile.blobSha256}?session=${session}`,
      finalViewerUrl.origin,
    ).href;
    workerScopeUrl = new URL(
      `/api/view/blob/iso5worker-scope-76b91e4a-${session}/`,
      finalViewerUrl.origin,
    ).href;

    const navigation = page.getByRole("navigation", { name: "Shared files" });
    await navigation.getByRole("button", { name: "worker.js", exact: true }).click();
    const downloadCard = page.locator(".download-card");
    await expect(downloadCard).toBeVisible();
    await expect(downloadCard).toContainText("This file opens as a download.");
    await expect(downloadCard.getByRole("link", { name: "Download file" })).toHaveAttribute(
      "href",
      `/api/view/blob/${workerFile.blobSha256}?session=${session}`,
    );
    await expect(page.locator("article.markdown, img.preview-image")).toHaveCount(0);
    await expect(
      page.locator(`script[src*="${workerFile.blobSha256}"], link[href*="${workerFile.blobSha256}"]`),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain(EXECUTION_MARKER);
    expect(observedWorkerRequests).toEqual([]);
    expect(observedWorkerResponses).toEqual([]);
    expect(probe.requests).toEqual([]);

    const workerResponsePromise = context.waitForEvent("response", {
      predicate: (response) => response.url() === workerScriptUrl,
    });
    const registrationAttempt = await page.evaluate(
      async ({ scriptUrl, scopeUrl }) => {
        try {
          const registration = await navigator.serviceWorker.register(scriptUrl, {
            scope: scopeUrl,
          });
          return { accepted: true, scope: registration.scope };
        } catch (error) {
          return {
            accepted: false,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : typeof error,
          };
        }
      },
      { scriptUrl: workerScriptUrl, scopeUrl: workerScopeUrl },
    );
    const workerResponse = await workerResponsePromise;

    expect.soft(registrationAttempt.accepted).toBe(false);
    if (!registrationAttempt.accepted) {
      expect(registrationAttempt.errorName).toBeTruthy();
      expect(registrationAttempt.errorMessage).toBeTruthy();
    }
    expect(observedWorkerRequests).toHaveLength(1);
    expect(observedWorkerResponses).toHaveLength(1);
    expect(workerResponse.request().url()).toBe(workerScriptUrl);
    expect(workerResponse.request().method()).toBe("GET");
    expect(workerResponse.url()).toBe(workerScriptUrl);
    expect(workerResponse.status()).toBe(200);

    const registrations = await registrationSnapshots(page);
    const matchingRegistrations = registrations.filter((registration) =>
      matchesWorker(registration, workerScriptUrl!, workerScopeUrl!)
    );
    expect(matchingRegistrations).toHaveLength(0);
    expect(await page.evaluate((sentinel) => Reflect.get(window, sentinel), EXECUTION_SENTINEL))
      .toBe(SENTINEL_BASELINE);
    expect(probe.requests).toEqual([]);
    expect(workerResponse.headers()["content-type"]).toBe("application/octet-stream");
    expect(workerResponse.headers()["content-disposition"]).toBe("attachment");
    expect(workerResponse.headers()["x-content-type-options"]).toBe("nosniff");
  } finally {
    const cleanupErrors: unknown[] = [];
    if (page && !page.isClosed()) {
      try {
        await page.evaluate(async () => {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await context.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "service-worker browser resource cleanup failed");
    }
  }
});

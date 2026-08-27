import { expect, test, type Page, type Request } from "@playwright/test";
import {
  seedShare,
  startProbe,
  startStack,
  type RunningProbe,
  type RunningStack,
} from "./harness";

const MARKER = "iso7remotefetch-31c8e4a7";
const SENTINEL_BASELINE = `${MARKER}-unmodified`;
const DATA_SVG_SENTINEL = "__dohcIso7RemoteFetchDataSvg_31c8e4a7";
const RAW_SCRIPT_SENTINEL = "__dohcIso7RemoteFetchRawScript_31c8e4a7";
const PROBE_PATHS = {
  dataSvgFetch: `/iso7remotefetch-data-svg-fetch?marker=${MARKER}-data-svg-fetch`,
  dataSvgImage: `/iso7remotefetch-data-svg-image?marker=${MARKER}-data-svg-image`,
  directFetch: `/iso7remotefetch-direct-fetch?marker=${MARKER}-direct-fetch`,
  markdownImageOne: `/iso7remotefetch-markdown-image-one?marker=${MARKER}-markdown-image-one`,
  markdownImageTwo: `/iso7remotefetch-markdown-image-two?marker=${MARKER}-markdown-image-two`,
  rawFrame: `/iso7remotefetch-raw-frame?marker=${MARKER}-raw-frame`,
  rawScriptFetch: `/iso7remotefetch-raw-script-fetch?marker=${MARKER}-raw-script-fetch`,
  rawStyleBackground: `/iso7remotefetch-raw-style-background?marker=${MARKER}-raw-style-background`,
  rawStyleImport: `/iso7remotefetch-raw-style-import?marker=${MARKER}-raw-style-import`,
  rawStylesheet: `/iso7remotefetch-raw-stylesheet?marker=${MARKER}-raw-stylesheet`,
} as const;

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
    throw new AggregateError(cleanupErrors, "remote-fetch browser test cleanup failed");
  }
});

function remoteFixture(probeUrl: string): string {
  const dataSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ` onload='window[${JSON.stringify(DATA_SVG_SENTINEL)}]="executed";fetch(${JSON.stringify(`${probeUrl}${PROBE_PATHS.dataSvgFetch}`)})'>`,
    `<image href=${JSON.stringify(`${probeUrl}${PROBE_PATHS.dataSvgImage}`)} />`,
    `<text>${MARKER}-data-svg</text>`,
    "</svg>",
  ].join("");
  const dataSvgUrl = `data:image/svg+xml,${encodeURIComponent(dataSvg)}`;

  return [
    "# Remote fetch browser conformance",
    "",
    `![Remote image one](${probeUrl}${PROBE_PATHS.markdownImageOne})`,
    "",
    `![Remote image two](${probeUrl}${PROBE_PATHS.markdownImageTwo})`,
    "",
    `![Data SVG image](${dataSvgUrl})`,
    "",
    `<script>window[${JSON.stringify(RAW_SCRIPT_SENTINEL)}] = "executed"; fetch(${JSON.stringify(`${probeUrl}${PROBE_PATHS.rawScriptFetch}`)});</script>`,
    `<link rel="stylesheet" href=${JSON.stringify(`${probeUrl}${PROBE_PATHS.rawStylesheet}`)}>`,
    `<style>@import url(${JSON.stringify(`${probeUrl}${PROBE_PATHS.rawStyleImport}`)}); .remote-background { background-image: url(${JSON.stringify(`${probeUrl}${PROBE_PATHS.rawStyleBackground}`)}); }</style>`,
    `<iframe src=${JSON.stringify(`${probeUrl}${PROBE_PATHS.rawFrame}`)}></iframe>`,
  ].join("\n");
}

async function expectSentinelsUnchanged(page: Page): Promise<void> {
  const values = await page.evaluate(
    (names) => names.map((name) => Reflect.get(window, name)),
    [DATA_SVG_SENTINEL, RAW_SCRIPT_SENTINEL],
  );
  expect(values).toEqual([SENTINEL_BASELINE, SENTINEL_BASELINE]);
}

test("blocks remote media and cross-origin connection egress", async ({ browser }) => {
  if (!stack || !probe) throw new Error("remote-fetch browser test services did not start");

  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [{ path: "docs/remote.md", content: remoteFixture(probe.url) }],
  });
  const authoredProbeUrls = new Set(
    Object.entries(PROBE_PATHS)
      .filter(([name]) => name !== "directFetch")
      .map(([, path]) => `${probe!.url}${path}`),
  );
  const browserAuthoredRequests: Request[] = [];

  const context = await browser.newContext();
  try {
    await context.addInitScript(
      ({ baseline, names }) => {
        for (const name of names) Reflect.set(window, name, baseline);
      },
      {
        baseline: SENTINEL_BASELINE,
        names: [DATA_SVG_SENTINEL, RAW_SCRIPT_SENTINEL],
      },
    );
    context.on("request", (request) => {
      if (authoredProbeUrls.has(request.url())) browserAuthoredRequests.push(request);
    });

    const page = await context.newPage();
    const viewerResponse = await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
    if (!viewerResponse) throw new Error("viewer navigation returned no response");
    expect(viewerResponse.headers()["content-security-policy"]).toContain(
      "connect-src 'self'",
    );

    const article = page.locator("article.markdown");
    await expect(article).toContainText("Remote fetch browser conformance");
    await page.waitForLoadState("networkidle");
    await expect(
      article.locator(
        'img[src^="http:" i], img[src^="https:" i], img[src^="data:" i]',
      ),
    ).toHaveCount(0);
    await expect(article.locator("img, link[rel~='stylesheet' i], script, style"))
      .toHaveCount(0);
    await expect(
      article.locator(
        "base, button, embed, form, iframe, input, meta, object, select, svg, template, textarea",
      ),
    ).toHaveCount(0);
    await expect(
      article.locator("[onerror], [onload], [onclick], [onfocus], [onsubmit], [style]"),
    ).toHaveCount(0);
    await expectSentinelsUnchanged(page);
    expect(browserAuthoredRequests).toEqual([]);
    expect(probe.requests).toEqual([]);

    const directProbeUrl = `${probe.url}${PROBE_PATHS.directFetch}`;
    const directFetchConsoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error" || !message.text().includes(directProbeUrl)) return;
      directFetchConsoleErrors.push(message.text());
    });
    const directFetchResult = await page.evaluate(async (probeUrl) => {
      try {
        const response = await fetch(probeUrl);
        return {
          rejected: false,
          responseBody: await response.text(),
          status: response.status,
        };
      } catch (error) {
        return {
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : typeof error,
          rejected: true,
        };
      }
    }, directProbeUrl);

    expect(directFetchResult).toMatchObject({
      errorName: "TypeError",
      rejected: true,
    });
    expect(directFetchConsoleErrors.length).toBeGreaterThan(0);
    expect(probe.requests).toEqual([]);
    expect(
      directFetchConsoleErrors.some((message) => message.includes("Content Security Policy")),
    ).toBe(true);

    const viewerUrl = page.url();
    expect(new URL(viewerUrl).pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{12}$/u);
    const remoteFileButton = page
      .getByRole("navigation", { name: "Shared files" })
      .getByRole("button", { name: "remote.md", exact: true });
    await expect(remoteFileButton).toBeVisible();
    await remoteFileButton.click();
    await expect(page.locator("article.markdown")).toContainText(
      "Remote fetch browser conformance",
    );
    expect(page.url()).toBe(viewerUrl);
    await expectSentinelsUnchanged(page);
    expect(probe.requests).toEqual([]);
  } finally {
    await context.close();
  }
});

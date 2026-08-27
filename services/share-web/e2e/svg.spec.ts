import { expect, test, type Download, type Page } from "@playwright/test";
import {
  seedShare,
  startProbe,
  startStack,
  type RunningProbe,
  type RunningStack,
} from "./harness";

const SVG_ATTACK_SENTINEL = "__dohcIso3SvgAttackSentinel_8f91cbe2";
const SENTINEL_BASELINE = "iso3svg-unmodified-8f91cbe2";

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
    throw new AggregateError(cleanupErrors, "SVG browser test cleanup failed");
  }
});

function hostileSvg(probeUrl: string): string {
  const onloadProbe = `${probeUrl}/iso3svg-onload?sentinel=8f91cbe2`;
  const scriptProbe = `${probeUrl}/iso3svg-script?sentinel=8f91cbe2`;
  const imageProbe = `${probeUrl}/iso3svg-image?sentinel=8f91cbe2`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg"',
    '  width="120" height="40"',
    `  onload='window[${JSON.stringify(SVG_ATTACK_SENTINEL)}]="onload-executed";fetch(${JSON.stringify(onloadProbe)})'>`,
    "  <script><![CDATA[",
    `    window[${JSON.stringify(SVG_ATTACK_SENTINEL)}] = "script-executed";`,
    `    fetch(${JSON.stringify(scriptProbe)});`,
    "  ]]></script>",
    `  <image href=${JSON.stringify(imageProbe)} width="120" height="40" />`,
    "</svg>",
  ].join("\n");
}

async function expectSentinelUnchanged(page: Page): Promise<void> {
  const value = await page.evaluate((name) => Reflect.get(window, name), SVG_ATTACK_SENTINEL);
  expect(value).toBe(SENTINEL_BASELINE);
}

test("keeps a shared SVG inert and downloads it as an attachment", async ({ browser }) => {
  if (!stack || !probe) throw new Error("SVG browser test services did not start");

  const svg = hostileSvg(probe.url);
  const svgBytes = new TextEncoder().encode(svg);
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [
      { path: "docs/attack.svg", content: svgBytes, contentKind: "binary" },
    ],
  });
  const svgFile = seeded.files.find((file) => file.path === "docs/attack.svg");
  if (!svgFile) throw new Error("SVG fixture was not seeded");

  const context = await browser.newContext({ acceptDownloads: true });
  let download: Download | undefined;
  try {
    const page = await context.newPage();
    await page.addInitScript(
      ({ name, value }) => {
        Reflect.set(window, name, value);
      },
      { name: SVG_ATTACK_SENTINEL, value: SENTINEL_BASELINE },
    );
    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);

    const navigation = page.getByRole("navigation", { name: "Shared files" });
    await navigation.getByRole("button", { name: "attack.svg", exact: true }).click();
    await expect(page.locator(".preview-image")).toHaveCount(0);
    await expect(page.locator("svg")).toHaveCount(0);
    const downloadCard = page.locator(".download-card");
    await expect(downloadCard).toBeVisible();
    await expect(downloadCard).toContainText("SVG files open as downloads.");
    const downloadLink = downloadCard.getByRole("link", { name: "Download file" });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute("download", "attack.svg");
    await expectSentinelUnchanged(page);
    expect(probe.requests).toEqual([]);

    const [downloadResponse, startedDownload] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/view/blob/${svgFile.blobSha256}`
      ),
      page.waitForEvent("download"),
      downloadLink.click(),
    ]);
    download = startedDownload;

    expect(downloadResponse.status()).toBe(200);
    expect(downloadResponse.headers()["content-type"]).toBe("application/octet-stream");
    expect(downloadResponse.headers()["content-disposition"]).toBe("attachment");
    expect(downloadResponse.headers()["x-content-type-options"]).toBe("nosniff");
    expect(download.suggestedFilename()).toBe("attack.svg");
    const downloadStream = await download.createReadStream();
    const downloadedChunks: Buffer[] = [];
    for await (const chunk of downloadStream) downloadedChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(downloadedChunks)).toEqual(Buffer.from(svgBytes));

    await expect(page.locator(".preview-image")).toHaveCount(0);
    await expect(page.locator("svg")).toHaveCount(0);
    await expectSentinelUnchanged(page);
    expect(probe.requests).toEqual([]);
  } finally {
    await download?.delete();
    await context.close();
  }
});

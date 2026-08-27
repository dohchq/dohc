import { type Page } from "@playwright/test";
import {
  expect,
  seedShare,
  test,
} from "./harness";

const SVG_ATTACK_SENTINEL = "__dohcIso3SvgAttackSentinel_8f91cbe2";
const SENTINEL_BASELINE = "iso3svg-unmodified-8f91cbe2";

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

test("keeps a shared SVG inert and downloads it as an attachment", async ({
  browser,
  probe,
  stack,
}) => {
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
    const viewerContent = page.locator("main.content");
    await expect(page.locator(".preview-image")).toHaveCount(0);
    await expect(viewerContent.locator("svg")).toHaveCount(0);
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
    const download = startedDownload;

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
    await expect(viewerContent.locator("svg")).toHaveCount(0);
    await expectSentinelUnchanged(page);
    expect(probe.requests).toEqual([]);
  } finally {
    await context.close();
  }
});

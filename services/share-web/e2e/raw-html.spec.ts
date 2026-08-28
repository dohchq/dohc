import { type Page } from "@playwright/test";
import {
  expect,
  seedShare,
  test,
} from "./harness";

const HTML_DOM_MARKER = "RAW_HTML_BYTES_MUST_NOT_ENTER_VIEWER_DOM";
const ATTACK_SENTINELS = [
  "__dohcAttackRawScript",
  "__dohcAttackEventHandler",
  "__dohcAttackIframe",
  "__dohcAttackObject",
  "__dohcAttackForm",
  "__dohcAttackSvg",
  "__dohcAttackJavascriptUrl",
] as const;

function hostileMarkup(probeUrl: string, marker: string): string {
  return `
<script>
window.__dohcAttackRawScript = true;
fetch(${JSON.stringify(`${probeUrl}/raw-script`)});
</script>
<img src=${JSON.stringify(`${probeUrl}/event-handler`)} onerror="window.__dohcAttackEventHandler = true">
<iframe src=${JSON.stringify(`${probeUrl}/iframe`)} onload="window.__dohcAttackIframe = true"></iframe>
<object data=${JSON.stringify(`${probeUrl}/object`)} onload="window.__dohcAttackObject = true"></object>
<form action=${JSON.stringify(`${probeUrl}/form`)} onsubmit="window.__dohcAttackForm = true">
  <button type="submit">Send probe</button>
</form>
<svg xmlns="http://www.w3.org/2000/svg" onload="window.__dohcAttackSvg = true">
  <image href=${JSON.stringify(`${probeUrl}/inline-svg`)} />
</svg>
<a href="javascript:window.__dohcAttackJavascriptUrl = true">Run JavaScript URL</a>
<p>${marker}</p>
`.trim();
}

async function expectNoAttackSentinel(page: Page): Promise<void> {
  const sentinelExists = await page.evaluate(
    (names) => names.map((name) => name in window),
    ATTACK_SENTINELS,
  );
  expect(sentinelExists).toEqual(ATTACK_SENTINELS.map(() => false));
}

test("keeps shared raw HTML inert in Markdown and downloadable HTML", async ({
  browser,
  probe,
  stack,
}) => {
  const markdownText = "Raw HTML conformance ordinary Markdown text.";
  const rawMarkdown = [
    "# Raw HTML browser conformance",
    "",
    markdownText,
    "",
    hostileMarkup(probe.url, "RAW_MARKDOWN_ACTIVE_MARKUP"),
  ].join("\n");
  const rawHtml = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Raw HTML attack document</title>",
    "</head>",
    "<body>",
    hostileMarkup(probe.url, HTML_DOM_MARKER),
    "</body>",
    "</html>",
  ].join("\n");
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [
      { path: "docs/raw-html.md", content: rawMarkdown },
      { path: "docs/raw.html", content: rawHtml },
    ],
  });
  const htmlFile = seeded.files.find((file) => file.path === "docs/raw.html");
  if (!htmlFile) throw new Error("raw HTML fixture was not seeded");

  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);

    const navigation = page.getByRole("navigation", { name: "Shared files" });
    await navigation.getByRole("button", { name: "raw-html.md", exact: true }).click();
    const article = page.locator("article.markdown");
    await expect(article).toContainText(markdownText);
    await expect(article.locator("script, iframe, object, form, svg, embed, link, meta, img"))
      .toHaveCount(0);
    await expect(article.locator("[onerror], [onload], [onclick], [onfocus], [onsubmit]"))
      .toHaveCount(0);
    await expect(
      article.locator(
        '[href^="javascript:" i], [src^="javascript:" i], [action^="javascript:" i], [data^="javascript:" i]',
      ),
    ).toHaveCount(0);
    await expectNoAttackSentinel(page);
    expect(probe.requests).toEqual([]);

    await navigation.getByRole("button", { name: "raw.html", exact: true }).click();
    const downloadCard = page.locator(".download-card");
    await expect(downloadCard).toBeVisible();
    await expect(downloadCard).toContainText("This file opens as a download.");
    await expect(page.locator("article.markdown")).toHaveCount(0);
    expect(await page.content()).not.toContain(HTML_DOM_MARKER);
    await expectNoAttackSentinel(page);
    expect(probe.requests).toEqual([]);

    const [downloadResponse, startedDownload] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/view/blob/${htmlFile.blobSha256}`
      ),
      page.waitForEvent("download"),
      downloadCard.getByRole("link", { name: "Download file" }).click(),
    ]);
    const download = startedDownload;

    expect(downloadResponse.status()).toBe(200);
    expect(downloadResponse.headers()["content-type"]).toBe("application/octet-stream");
    expect(downloadResponse.headers()["content-disposition"]).toBe("attachment");
    expect(downloadResponse.headers()["x-content-type-options"]).toBe("nosniff");
    expect(download.suggestedFilename()).toBe("raw.html");
    const downloadStream = await download.createReadStream();
    const downloadedChunks: Buffer[] = [];
    for await (const chunk of downloadStream) downloadedChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(downloadedChunks).toString("utf8")).toBe(rawHtml);

    expect(await page.content()).not.toContain(HTML_DOM_MARKER);
    await expectNoAttackSentinel(page);
    expect(probe.requests).toEqual([]);
  } finally {
    await context.close();
  }
});

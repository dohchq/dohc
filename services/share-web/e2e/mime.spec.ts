import { type Page, type Response } from "@playwright/test";
import {
  expect,
  seedShare,
  test,
} from "./harness";

const MIME_ATTACK_SENTINEL = "__dohcIso4MimeAttackSentinel_3de752bf";
const SENTINEL_BASELINE = "iso4mime-unmodified-3de752bf";
const HTML_DOM_MARKER = "ISO4MIME_HTML_BYTES_MUST_NOT_ENTER_THE_DOM_3de752bf";
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SIGNATURE_ONLY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not-a-decodable-png", "utf8"),
]);

function activeHtml(probeUrl: string): Uint8Array {
  const scriptProbe = `${probeUrl}/iso4mime-script?sentinel=3de752bf`;
  const imageProbe = `${probeUrl}/iso4mime-image?sentinel=3de752bf`;
  return new TextEncoder().encode([
    "<!doctype html>",
    '<html lang="en">',
    "<head><meta charset=\"utf-8\"><title>MIME attack fixture</title></head>",
    "<body>",
    `<script>window[${JSON.stringify(MIME_ATTACK_SENTINEL)}] = "executed"; fetch(${JSON.stringify(scriptProbe)});</script>`,
    `<img id="iso4mime-active-image" src=${JSON.stringify(imageProbe)} onload="window[${JSON.stringify(MIME_ATTACK_SENTINEL)}] = 'event-executed'">`,
    `<p id="iso4mime-dom-marker">${HTML_DOM_MARKER}</p>`,
    "</body>",
    "</html>",
  ].join("\n"));
}

function blobResponse(page: Page, sha256: string): Promise<Response> {
  return page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === `/api/view/blob/${sha256}`
  );
}

async function expectSentinelUnchanged(page: Page): Promise<void> {
  const value = await page.evaluate((name) => Reflect.get(window, name), MIME_ATTACK_SENTINEL);
  expect(value).toBe(SENTINEL_BASELINE);
}

async function expectImageDecodeFailure(image: import("@playwright/test").Locator): Promise<void> {
  const decoded = await image.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) throw new Error("preview is not an image");
    try {
      await element.decode();
      return true;
    } catch {
      return false;
    }
  });
  expect(decoded).toBe(false);
}

test("separates viewer extensions from service byte-sniffed mime types", async ({
  browser,
  probe,
  stack,
}) => {
  const htmlBytes = activeHtml(probe.url);
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [
      { path: "docs/html-as.png", content: htmlBytes, contentKind: "binary" },
      { path: "docs/png-as.html", content: VALID_PNG, contentKind: "binary" },
      { path: "docs/signature-only.png", content: SIGNATURE_ONLY_PNG, contentKind: "binary" },
    ],
  });
  const htmlAsPng = seeded.files.find((file) => file.path === "docs/html-as.png");
  const pngAsHtml = seeded.files.find((file) => file.path === "docs/png-as.html");
  const signatureOnly = seeded.files.find((file) => file.path === "docs/signature-only.png");
  if (!htmlAsPng || !pngAsHtml || !signatureOnly) {
    throw new Error("MIME fixtures were not seeded");
  }

  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    await page.addInitScript(
      ({ name, value }) => {
        Reflect.set(window, name, value);
      },
      { name: MIME_ATTACK_SENTINEL, value: SENTINEL_BASELINE },
    );

    const htmlResponsePromise = blobResponse(page, htmlAsPng.blobSha256);
    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
    const htmlResponse = await htmlResponsePromise;
    const navigation = page.getByRole("navigation", { name: "Shared files" });
    const htmlImage = page.locator("img.preview-image");

    await expect(htmlImage).toHaveCount(1);
    await expect(htmlImage).toHaveAttribute(
      "src",
      `/api/view/blob/${htmlAsPng.blobSha256}?session=${new URL(page.url()).pathname.slice("/s/".length)}`,
    );
    await expect(page.locator(".download-card")).toHaveCount(0);
    expect(htmlResponse.status()).toBe(200);
    expect(htmlResponse.headers()["content-type"]).toBe("application/octet-stream");
    expect(htmlResponse.headers()["content-disposition"]).toBe("attachment");
    expect(htmlResponse.headers()["x-content-type-options"]).toBe("nosniff");
    await expectImageDecodeFailure(htmlImage);
    await expect(page.locator("#iso4mime-active-image, #iso4mime-dom-marker")).toHaveCount(0);
    expect(await page.content()).not.toContain(HTML_DOM_MARKER);
    await expectSentinelUnchanged(page);
    expect(probe.requests).toEqual([]);

    await navigation.getByRole("button", { name: "png-as.html", exact: true }).click();
    const downloadCard = page.locator(".download-card");
    await expect(downloadCard).toBeVisible();
    await expect(downloadCard).toContainText("This file opens as a download.");
    await expect(page.locator("img.preview-image")).toHaveCount(0);
    const pngResponsePromise = blobResponse(page, pngAsHtml.blobSha256);
    const downloadPromise = page.waitForEvent("download");
    await downloadCard.getByRole("link", { name: "Download file" }).click();
    const [pngResponse, pngDownload] = await Promise.all([pngResponsePromise, downloadPromise]);

    expect(pngResponse.status()).toBe(200);
    expect(pngResponse.headers()["content-type"]).toBe("image/png");
    expect(pngResponse.headers()["content-disposition"]).toBeUndefined();
    expect(pngResponse.headers()["x-content-type-options"]).toBe("nosniff");
    expect(pngDownload.suggestedFilename()).toBe("png-as.html");
    const pngDownloadStream = await pngDownload.createReadStream();
    const pngDownloadChunks: Buffer[] = [];
    for await (const chunk of pngDownloadStream) pngDownloadChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(pngDownloadChunks)).toEqual(VALID_PNG);
    await expectSentinelUnchanged(page);
    expect(probe.requests).toEqual([]);

    const signatureResponsePromise = blobResponse(page, signatureOnly.blobSha256);
    await navigation.getByRole("button", { name: "signature-only.png", exact: true }).click();
    const signatureResponse = await signatureResponsePromise;
    const signatureImage = page.locator("img.preview-image");

    await expect(signatureImage).toHaveCount(1);
    await expect(page.locator(".download-card")).toHaveCount(0);
    expect(signatureResponse.status()).toBe(200);
    expect(signatureResponse.headers()["content-type"]).toBe("image/png");
    expect(signatureResponse.headers()["content-disposition"]).toBeUndefined();
    expect(signatureResponse.headers()["x-content-type-options"]).toBe("nosniff");
    await expectImageDecodeFailure(signatureImage);
    await expectSentinelUnchanged(page);
    expect(probe.requests).toEqual([]);
  } finally {
    await context.close();
  }
});

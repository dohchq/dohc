import { expect, seedShare, test } from "./harness";

const RECTANGLE_FILL = { red: 255, green: 201, blue: 201 };
const TEXT_STROKE = { red: 103, green: 65, blue: 217 };

const scene = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [
    {
      id: "roadmap-card",
      type: "rectangle",
      x: 40,
      y: 40,
      width: 320,
      height: 180,
      angle: 0,
      strokeColor: "#e03131",
      backgroundColor: "#ffc9c9",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a0",
      roundness: { type: 3 },
      seed: 12345,
      version: 1,
      versionNonce: 54321,
      isDeleted: false,
      boundElements: null,
      updated: 1_720_000_000_000,
      link: "https://example.invalid/private-roadmap",
      locked: false,
    },
    {
      id: "roadmap-label",
      type: "text",
      x: 86,
      y: 108,
      width: 228,
      height: 35,
      angle: 0,
      strokeColor: "#6741d9",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a1",
      roundness: null,
      seed: 23456,
      version: 1,
      versionNonce: 65432,
      isDeleted: false,
      boundElements: null,
      updated: 1_720_000_000_001,
      link: null,
      locked: false,
      fontSize: 28,
      fontFamily: 1,
      text: "Public roadmap",
      textAlign: "center",
      verticalAlign: "middle",
      containerId: null,
      originalText: "Public roadmap",
      autoResize: true,
      lineHeight: 1.25,
    },
  ],
  appState: {
    gridSize: null,
    viewBackgroundColor: "#ffffff",
  },
  files: {},
});

interface PixelCounts {
  rectangle: number;
  text: number;
}

interface FontResponse {
  contentType: string;
  status: number;
  url: string;
}

test("renders a representative Excalidraw scene without leaving the viewer origin", async ({
  page,
  stack,
}) => {
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/public-roadmap.excalidraw", content: scene }],
    paths: ["docs"],
  });
  const externalRequests = new Set<string>();
  const failedExternalRequests = new Set<string>();
  const externalResponses: string[] = [];
  const localFontResponses: FontResponse[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== stack.shareWebUrl) {
      externalRequests.add(request.url());
    }
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin !== stack.shareWebUrl) {
      failedExternalRequests.add(request.url());
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== stack.shareWebUrl) {
      externalResponses.push(response.url());
    } else if (url.pathname.includes("/s/assets/fonts/")) {
      localFontResponses.push({
        contentType: response.headers()["content-type"] ?? "",
        status: response.status(),
        url: response.url(),
      });
    }
  });

  const navigation = await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);
  expect(navigation?.headers()["content-security-policy"]).toContain(
    "font-src 'self'",
  );

  const drawing = page.locator(".excalidraw-view");
  await expect(drawing).toBeVisible();
  await expect(drawing.locator("canvas").first()).toBeVisible();
  await expect(page.locator(".download-card")).toHaveCount(0);

  const readPixelCounts = async (): Promise<PixelCounts> =>
    drawing.locator("canvas").evaluateAll((canvases, colors) => {
      const near = (
        value: number,
        expected: number,
      ): boolean => Math.abs(value - expected) <= 8;
      const counts = { rectangle: 0, text: 0 };
      for (const canvas of canvases as HTMLCanvasElement[]) {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) continue;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (
            near(pixels[offset]!, colors.rectangle.red) &&
            near(pixels[offset + 1]!, colors.rectangle.green) &&
            near(pixels[offset + 2]!, colors.rectangle.blue)
          ) {
            counts.rectangle += 1;
          }
          if (
            near(pixels[offset]!, colors.text.red) &&
            near(pixels[offset + 1]!, colors.text.green) &&
            near(pixels[offset + 2]!, colors.text.blue)
          ) {
            counts.text += 1;
          }
        }
      }
      return counts;
    }, { rectangle: RECTANGLE_FILL, text: TEXT_STROKE });

  await expect.poll(async () => (await readPixelCounts()).rectangle)
    .toBeGreaterThan(10_000);
  await expect.poll(async () => (await readPixelCounts()).text)
    .toBeGreaterThan(100);

  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => failedExternalRequests.size)
    .toBe(externalRequests.size);
  expect(externalResponses).toEqual([]);
  expect([...failedExternalRequests].sort()).toEqual([...externalRequests].sort());
  expect(localFontResponses).toEqual(expect.arrayContaining([
    expect.objectContaining({
      contentType: "font/woff2",
      status: 200,
    }),
  ]));
});

test("keeps a malformed Excalidraw scene inside the file fallback", async ({
  page,
  stack,
}) => {
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{
      path: "docs/malformed.excalidraw",
      content: JSON.stringify({
        type: "excalidraw",
        elements: [{ type: "line", width: 10, height: 10 }],
      }),
    }],
    paths: ["docs"],
  });

  await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);

  await expect(page.locator(".download-card")).toBeVisible();
  await expect(page.locator(".excalidraw-view")).toHaveCount(0);
  await expect(page.locator("nav[aria-label='Shared files']")).toBeVisible();
});

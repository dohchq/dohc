import { type Page } from "@playwright/test";
import {
  expect,
  seedShare,
  test,
} from "./harness";

const JAVASCRIPT_SENTINEL = "__dohcIso6NavigationJavascriptAttack_4f72a18c";
const DATA_SENTINEL = "__dohcIso6NavigationDataAttack_4f72a18c";
const SENTINEL_BASELINE = "iso6navigation-unmodified-4f72a18c";
const NEXT_FILE_MARKER = "ISO6NAVIGATION_NEXT_FILE_CONTENT_4f72a18c";
const EXTERNAL_PROBE_PATH = "/iso6navigation-external?sentinel=4f72a18c";

function navigationFixture(probeUrl: string): string {
  return [
    "# Navigation browser conformance",
    "",
    `<meta http-equiv="refresh" content="0;url=${probeUrl}/iso6navigation-meta">`,
    `<base href="${probeUrl}/iso6navigation-base/">`,
    `<form action="${probeUrl}/iso6navigation-form" method="get"><button type="submit">Submit attack form</button></form>`,
    "",
    `[Run JavaScript attack](javascript:window.${JAVASCRIPT_SENTINEL}="executed")`,
    "",
    `[Open data attack](data:text/html,<script>window.opener.${DATA_SENTINEL}="executed"</script>)`,
    "",
    `[Open external probe](${probeUrl}${EXTERNAL_PROBE_PATH})`,
    "",
    "[Open next shared file](next.md)",
  ].join("\n");
}

async function expectAttackSentinelsUnchanged(page: Page): Promise<void> {
  const sentinels = await page.evaluate(
    (names) => names.map((name) => Reflect.get(window, name)),
    [JAVASCRIPT_SENTINEL, DATA_SENTINEL],
  );
  expect(sentinels).toEqual([SENTINEL_BASELINE, SENTINEL_BASELINE]);
}

test("keeps authored navigation inert until the user follows an allowed link", async ({
  browser,
  probe,
  stack,
}) => {
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [
      { path: "docs/navigation.md", content: navigationFixture(probe.url) },
      {
        path: "docs/next.md",
        content: `# Next shared file\n\n${NEXT_FILE_MARKER}\n`,
      },
    ],
  });

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(
      ({ baseline, names }) => {
        for (const name of names) Reflect.set(window, name, baseline);
      },
      {
        baseline: SENTINEL_BASELINE,
        names: [JAVASCRIPT_SENTINEL, DATA_SENTINEL],
      },
    );
    await page.goto(`${stack.shareWebUrl}/s/#${seeded.secret}`);

    const navigation = page.getByRole("navigation", { name: "Shared files" });
    const article = page.locator("article.markdown");
    await expect(article).toContainText("Navigation browser conformance");

    const viewerUrl = page.url();
    const viewerLocation = new URL(viewerUrl);
    expect(viewerLocation.origin).toBe(stack.shareWebUrl);
    expect(viewerLocation.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{12}$/u);
    expect(viewerLocation.search).toBe("");
    expect(viewerLocation.hash).toBe("");
    expect(probe.requests).toEqual([]);
    await expect(article.locator("meta, base, form")).toHaveCount(0);

    const javascriptText = article.getByText("Run JavaScript attack", { exact: true });
    const dataText = article.getByText("Open data attack", { exact: true });
    await expect(javascriptText).toBeVisible();
    await expect(dataText).toBeVisible();
    await expect(article.getByRole("link", { name: "Run JavaScript attack" })).toHaveCount(0);
    await expect(article.getByRole("link", { name: "Open data attack" })).toHaveCount(0);
    await expect(
      article.locator('[href^="javascript:" i], [href^="data:" i]'),
    ).toHaveCount(0);
    await javascriptText.click();
    await dataText.click();
    expect(page.url()).toBe(viewerUrl);
    await expectAttackSentinelsUnchanged(page);
    expect(probe.requests).toEqual([]);

    const internalLink = article.getByRole("link", { name: "Open next shared file" });
    await expect(internalLink).toHaveAttribute("href", "/docs/next.md");
    await internalLink.click();
    expect(page.url()).toBe(viewerUrl);
    await expect(page.getByRole("heading", { level: 1, name: "docs/next.md" })).toBeVisible();
    await expect(page.locator("article.markdown")).toContainText(NEXT_FILE_MARKER);
    await expect(
      navigation.getByRole("button", { name: "next.md", exact: true }),
    ).toHaveClass(/\bselected\b/u);
    await expectAttackSentinelsUnchanged(page);
    expect(probe.requests).toEqual([]);

    await navigation.getByRole("button", { name: "navigation.md", exact: true }).click();
    const externalLink = page
      .locator("article.markdown")
      .getByRole("link", { name: "Open external probe" });
    const externalUrl = `${probe.url}${EXTERNAL_PROBE_PATH}`;
    await expect(externalLink).toHaveAttribute("href", externalUrl);
    expect(probe.requests).toEqual([]);

    await externalLink.click();
    await expect(page).toHaveURL(externalUrl);
    await expect.poll(
      () => probe.requests.filter((request) => request.path === EXTERNAL_PROBE_PATH).length,
    ).toBe(1);
    expect(probe.requests.filter((request) => request.path === EXTERNAL_PROBE_PATH)).toEqual([
      expect.objectContaining({
        method: "GET",
        origin: "cross-site",
        path: EXTERNAL_PROBE_PATH,
      }),
    ]);
  } finally {
    await context.close();
  }
});

import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

// The states page (@states-page): every shared part in every state, light
// beside dark. One baseline per theme lives in states-page.spec.ts-snapshots;
// a change to a shared part shows up here as a pixel difference. Update the
// baselines with `--update-snapshots` when the change is the point of the PR.
//
// The captures are made deterministic by construction: a fixed viewport,
// reduced motion and disabled animations, forced states instead of pointer
// events, and a check that Inter and IBM Plex Mono are in before comparing.
// The baselines were taken on Windows; Playwright names them per platform.

const STATES_PAGE_HASH = "#/dev/states";

async function withDesktop(
  env: NodeJS.ProcessEnv,
  flow: (page: Awaited<ReturnType<typeof launchDesktopApp>>["page"]) => Promise<void>,
): Promise<void> {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp, env });
    await flow(desktop.page);
  } finally {
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
}

test("@states-page every shared part matches its baseline in both themes", async () => {
  test.setTimeout(120_000);
  await withDesktop({ DOHC_DEV_TOOLS: "1" }, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();

    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, STATES_PAGE_HASH);
    await expect(page.getByTestId("states-page")).toBeVisible();
    // The page holds the document light so its light pane reads light tokens.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // `fonts.check` answers true for a family no font declares, so ask the
    // loaded faces themselves.
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.evaluate(() =>
      [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => face.family.replaceAll('"', "")),
    );
    expect(loaded, "the UI fonts must be loaded before pixels are compared").toEqual(
      expect.arrayContaining(["Inter Variable", "IBM Plex Mono"]),
    );

    await expect(page.getByTestId("states-light")).toHaveScreenshot("states-light.png");
    await expect(page.getByTestId("states-dark")).toHaveScreenshot("states-dark.png");
  });
});

test("@states-page the page stays closed without the dev-tools grant", async () => {
  test.setTimeout(120_000);
  await withDesktop({}, async (page) => {
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, STATES_PAGE_HASH);
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await expect(page.getByTestId("states-page")).toHaveCount(0);
  });
});

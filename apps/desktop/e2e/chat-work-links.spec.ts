import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityPin } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import { waitForVisibleAnimations } from "./helpers/animations";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
} from "./helpers/workspace";

// Set UI_AUDIT_SHOT_DIR to also save each frame in both themes.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";

async function shoot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR === "") return;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (value) => {
      document.documentElement.setAttribute("data-theme", value);
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, theme);
    await waitForVisibleAnimations(page);
    await page.screenshot({ path: join(SHOT_DIR, `work-links-${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

test("an agent links a Group, a thread, and a file in a message, and each chip opens what it names", async () => {
  test.setTimeout(180_000);
  if (SHOT_DIR !== "") await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "work-links");
    await mkdir(join(temp.rootPath, "plans"), { recursive: true });
    await writeFile(join(temp.rootPath, "plans", "trip.md"), "# Trip\n\nFlights on Friday.\n");
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const main = page.locator("main");
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await waitForCliEndpoint(temp.homeDir);

    // An agent works through the CLI, as it would from a terminal.
    const cli = async (...args: string[]) => JSON.parse((await runDohcCli(temp, [...args, "--as-agent", "--json"])).stdout);
    await cli("chat", "create-group", "Trip", "--type", "posts");
    await cli("chat", "create-group", "Notes", "--type", "posts");
    const flights = await cli("chat", "post", "Trip", "--agent", "Nova", "--title", "Flights", "Book", "by", "Friday");
    const group = await cli("chat", "link", "--group", "Trip");
    const thread = await cli("chat", "link", "--thread", flights.threadId);
    const file = await cli("chat", "link", "--path", "plans/trip.md");
    expect([group.kind, thread.kind, file.kind]).toEqual(["chat", "thread", "file"]);
    expect(group.link).toMatch(/^@\[work:[A-Za-z0-9_-]{43}\]$/u);
    await cli("chat", "post", "Notes", "--agent", "Nova", `Plans live in ${group.link}. See ${thread.link} and ${file.link}.`);

    await page.getByTestId(activityPin("chats")).click();
    await page.getByTestId("chats-channel").filter({ hasText: "Notes" }).click();
    await expect(main.getByTestId("chats-channel-title")).toHaveText("Notes");
    const card = main.getByTestId("chats-post-card").filter({ hasText: "Plans live in" });
    const openGroup = card.getByRole("button", { name: "Open Trip" });
    await expect(openGroup).toBeVisible();
    await expect(card.getByRole("button", { name: "Open Flights" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Open trip.md" })).toBeVisible();
    await shoot(page, "a-post");

    // The Group chip opens the Group.
    await openGroup.click();
    await expect(main.getByTestId("chats-channel-title")).toHaveText("Trip");
    await shoot(page, "b-group");

    // The thread chip opens the thread.
    await page.getByTestId("chats-channel").filter({ hasText: "Notes" }).click();
    await card.getByRole("button", { name: "Open Flights" }).click();
    await expect(main.getByTestId("chats-thread-view")).toBeVisible();
    await expect(main.getByTestId("chats-thread-view")).toContainText("Book by Friday");
    await shoot(page, "c-thread");

    // The file chip opens the file.
    await page.getByTestId("chats-channel").filter({ hasText: "Notes" }).click();
    await card.getByRole("button", { name: "Open trip.md" }).click();
    await expect(page.getByText("Flights on Friday.")).toBeVisible();
    await shoot(page, "d-file");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

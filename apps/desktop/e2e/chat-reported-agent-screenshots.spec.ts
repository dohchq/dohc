import { expect, test, type Locator, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { activityPin } from "../src/testPins";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools } from "./helpers/agentTools";
import { waitForVisibleAnimations } from "./helpers/animations";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
  type TempWorkspace,
} from "./helpers/workspace";

// Copy this spec to main with UI_AUDIT_BEFORE=1 for the two no-report frames.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
const BEFORE = process.env.UI_AUDIT_BEFORE === "1";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture reported agent screenshots");

type Report = { product?: string; version?: string; model?: string };
const REPORT: Report = { product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" };
const LONG_REPORT: Report = {
  product: "A product with spaces ".repeat(3).slice(0, 64),
  model: "model-".padEnd(64, "x"),
};
const GROUP = "Agent reports";

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, theme);
  await waitForVisibleAnimations(page);
}

async function expectTooltipUnclipped(page: Page): Promise<void> {
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect.poll(() => tooltip.evaluate((card) => {
    const box = card.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 4);
    return {
      fitsViewport: box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 &&
        box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      bottomVisible: hit !== null && card.contains(hit),
    };
  })).toEqual({ fitsViewport: true, bottomVisible: true });
}

async function shoot(page: Page, name: string, hover = false): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    if (hover) await expectTooltipUnclipped(page);
    await page.screenshot({ path: join(SHOT_DIR, `${name}${BEFORE ? "-before" : ""}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

// Like fakeChatRunner.mjs, this process consumes the real dispatch prompt and
// replies through the CLI socket, with the thread and run dohc gave it.
async function writeRunner(temp: TempWorkspace): Promise<string> {
  const cliRoot = resolve(desktopRoot, "../../packages/cli");
  const loader = createRequire(join(cliRoot, "package.json")).resolve("tsx");
  const runner = join(temp.baseDir, "reported-agent-runner.mjs");
  await writeFile(runner, `
import { sendCliRequest } from ${JSON.stringify(pathToFileURL(join(cliRoot, "src/client.ts")).href)};
import { CLI_PROTOCOL_VERSION } from ${JSON.stringify(pathToFileURL(join(cliRoot, "src/protocol.ts")).href)};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
if (!prompt.trim() || !process.env.DOHC_CHAT_THREAD || !process.env.DOHC_RUN_ID) {
  throw new Error("Expected a dispatch prompt, thread, and run.");
}
const without = prompt.includes("audit-without-report");
const long = prompt.includes("audit-long-values");
const reported = without ? undefined : long ? ${JSON.stringify(LONG_REPORT)} : ${JSON.stringify(REPORT)};
const body = without ? "Checked the exports without a report." : long ? "Checked the long reported values." : "Checked the exports with a report.";
const reply = (body) => sendCliRequest({
  protocolVersion: CLI_PROTOCOL_VERSION,
  verb: "reply",
  args: {
    cwd: process.cwd(), actor: "agent", thread: process.env.DOHC_CHAT_THREAD,
    runId: process.env.DOHC_RUN_ID, attachments: [], needsDecision: false, body,
    ...(reported ? { reported } : {}),
  },
});
await reply(body);
if (prompt.includes("audit-continued-report")) await reply("The second part of the same report.");
`);
  return `"${process.execPath}" --import "${pathToFileURL(loader).href}" "${runner}"`;
}

async function post(temp: TempWorkspace, body: string, reported?: Report) {
  return sendCliRequest<"post">({
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb: "post",
    args: {
      cwd: temp.rootPath, actor: "agent", group: GROUP, body,
      attachments: [], needsDecision: false,
      ...(reported ? { reported } : {}),
    },
  }, { stateDir: temp.homeDir });
}

async function showHover(page: Page, badge: Locator, reported?: Report): Promise<void> {
  await badge.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  if (reported) {
    await expect(tooltip).toContainText("(as reported)");
    if (reported.product) await expect(tooltip).toContainText(reported.product);
    if (reported.version) await expect(tooltip).toContainText(reported.version);
    if (reported.model) await expect(tooltip).toContainText(reported.model);
  } else {
    await expect(tooltip).not.toContainText("(as reported)");
  }
}

async function closeHover(page: Page, badge: Locator): Promise<void> {
  await badge.press("Escape");
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

async function backToFeed(page: Page): Promise<void> {
  await page.locator("main").getByTestId("chats-thread-back").click();
  await expect(page.locator("main").getByTestId("chats-channel-view")).toBeVisible();
}

async function startRun(page: Page, trigger: string, body: string): Promise<Locator> {
  const main = page.locator("main");
  await main.getByTestId("chats-new-thread-composer").fill(`@Nova ${trigger}`);
  await main.getByTestId("chats-new-thread-composer").press("Enter");
  await expect(main.getByTestId("chats-thread-view")).toBeVisible();
  const reply = main.getByTestId("chats-message").filter({ hasText: body });
  await expect(reply).toBeVisible();
  await expect(reply.getByTestId("chats-run-chip")).toBeVisible();
  return reply;
}

async function openRun(page: Page, reply: Locator, reported?: Report): Promise<Locator> {
  await reply.getByTestId("chats-run-chip").click();
  const popover = page.getByTestId("chats-run-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId("chats-run-exit-code")).toHaveText("0");
  if (reported) {
    await expect(popover.getByTestId("chats-run-product")).toContainText(reported.product!);
    await expect(popover.getByTestId("chats-run-model")).toContainText(reported.model!);
  } else {
    await expect(popover.getByTestId("chats-run-product")).toHaveCount(0);
    await expect(popover.getByTestId("chats-run-model")).toHaveCount(0);
  }
  return popover;
}

test("@ui-audit reported agents in feeds, replies, and run details", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "reported-agent-screens");
    const command = await writeRunner(temp);
    desktop = await launchDesktopApp({ workspace: temp, env: await installFakeAgentTools(temp) });
    const page = desktop.page;
    const main = page.locator("main");
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.getByTestId(activityPin("chats")).click();
    await expect(page.getByTestId("chats-view")).toBeVisible();
    await page.getByTestId("chats-add-agent-open").click();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByTestId("chats-add-agent-command").fill(command);
    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill(GROUP);
    await page.getByTestId("chats-new-channel-type-posts").click();
    await page.getByTestId("chats-new-channel-name").press("Enter");
    await expect(main.getByTestId("chats-channel-title")).toHaveText(GROUP);
    await waitForCliEndpoint(temp.homeDir);

    await post(temp, "An agent with no report\nThe exports are ready to review.");
    const plainCard = main.getByTestId("chats-post-card").filter({ hasText: "An agent with no report" });
    const plainBadge = plainCard.getByTestId("chats-post-agent-badge");
    await showHover(page, plainBadge);
    await shoot(page, "reported-agent-c-no-report", true);
    await closeHover(page, plainBadge);

    const plainRun = await startRun(page, "audit-without-report", "Checked the exports without a report.");
    await openRun(page, plainRun);
    await shoot(page, "reported-agent-e-run-no-report");
    await page.keyboard.press("Escape");
    // Main supports both frames above without the reported-agent contract.
    if (BEFORE) return;
    await backToFeed(page);

    for (const [name, reported] of [
      ["a-product-version-model", REPORT],
      ["b-product-version", { product: "Claude Code", version: "2.1" }],
      ["b-model-only", { model: "Claude Opus 5.5" }],
    ] as const) {
      await post(temp, `Report summary: ${name}\nThe exports are ready to review.`, reported);
      const card = main.getByTestId("chats-post-card").filter({ hasText: `Report summary: ${name}` });
      const badge = card.getByTestId("chats-post-agent-badge");
      await showHover(page, badge, reported);
      if (!("model" in reported)) await expect(page.getByRole("tooltip")).not.toContainText(REPORT.model!);
      if (!("product" in reported)) await expect(page.getByRole("tooltip")).not.toContainText(REPORT.product!);
      await shoot(page, `reported-agent-${name}`, true);
      await closeHover(page, badge);
    }

    const reportedRun = await startRun(page, "audit-continued-report", "Checked the exports with a report.");
    await openRun(page, reportedRun, REPORT);
    await shoot(page, "reported-agent-e-run-product-model");
    await page.keyboard.press("Escape");

    const second = main.getByTestId("chats-message").filter({ hasText: "The second part of the same report." });
    await expect(second).toHaveAttribute("data-continues", "true");
    await expect(second.getByTestId("chats-comment-agent-badge")).toHaveCount(0);
    await expect(second.getByTestId("chats-run-chip")).toBeVisible();
    await openRun(page, second, REPORT);
    await shoot(page, "reported-agent-h-continued-run-chip");
    await page.keyboard.press("Escape");

    const threads = await sendCliRequest<"threads">({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "threads",
      args: { cwd: temp.rootPath, actor: "agent", group: GROUP },
    }, { stateDir: temp.homeDir });
    const thread = threads.threads.find((item) => item.title.includes("audit-continued-report"));
    if (!thread) throw new Error("Expected the reported run's thread.");
    const plainReply = await sendCliRequest<"reply">({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "reply",
      args: {
        cwd: temp.rootPath, actor: "agent", thread: thread.id,
        attachments: [], needsDecision: false,
        body: "Checked the plan without reporting a product or model.",
      },
    }, { stateDir: temp.homeDir });
    expect(plainReply.threadId).toBe(thread.id);
    const unreportedReply = main.getByTestId("chats-message").filter({ hasText: "Checked the plan without reporting a product or model." });
    await expect(unreportedReply).toBeVisible();
    const firstBadge = reportedRun.getByTestId("chats-comment-agent-badge");
    // Enter by Tab, after moving to the preceding stop, to show native focus.
    await page.mouse.move(0, 0);
    await firstBadge.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(firstBadge).toBeFocused();
    await expect.poll(() => firstBadge.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard-nav", "");
    await expect(page.getByRole("tooltip")).toContainText("(as reported)");
    await shoot(page, "reported-agent-d-reply-keyboard", true);
    await closeHover(page, firstBadge);
    await backToFeed(page);

    const longRun = await startRun(page, "audit-long-values", "Checked the long reported values.");
    const longBadge = longRun.getByTestId("chats-comment-agent-badge");
    await showHover(page, longBadge, LONG_REPORT);
    await expect.poll(() => page.getByRole("tooltip").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await shoot(page, "reported-agent-g-long-hover", true);
    await closeHover(page, longBadge);
    const longDetails = await openRun(page, longRun, LONG_REPORT);
    await expect.poll(() => longDetails.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await shoot(page, "reported-agent-g-long-run-details");
    await page.keyboard.press("Escape");

    // The agent conversation uses ThreadedChat's inline Run details panel.
    await page.locator('[data-testid="chats-my-agent"][data-agent-id="default"]').click();
    await expect(main.getByTestId("chats-channel-title")).toHaveText("Nova");
    await main.getByTestId("chats-lane-composer").fill("audit-panel-report");
    await main.getByTestId("chats-lane-composer").press("Enter");
    const laneReply = main.getByTestId("chats-lane-message").filter({ hasText: "Checked the exports with a report." });
    await expect(laneReply).toBeVisible();
    await laneReply.hover();
    await laneReply.getByTestId("chats-lane-reply-in-thread").click();
    const panel = main.getByTestId("chats-lane-thread-panel");
    await expect(panel).toBeVisible();
    const panelReply = panel.getByTestId("chats-lane-thread-message").filter({ hasText: "Checked the exports with a report." });
    await panelReply.hover();
    await panelReply.getByTestId("chats-lane-thread-more").click();
    await page.getByTestId("chats-lane-thread-more-run-details").click();
    const details = panel.getByTestId("chats-lane-run-details");
    await expect(details.getByTestId("chats-run-product")).toHaveText("Claude Code 2.1 (as reported)");
    await expect(details.getByTestId("chats-run-model")).toHaveText("Claude Opus 5.5 (as reported)");
    await expect(details.getByTestId("chats-run-exit-code")).toHaveText("0");
    await shoot(page, "reported-agent-f-thread-run-details");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

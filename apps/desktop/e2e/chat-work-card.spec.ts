import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { activityPin } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
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

// Set UI_AUDIT_SHOT_DIR to also save each frame in both themes.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
const GROUP = "Agent work";
const LINK = "https://example.com/threads/7";

async function shoot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR === "") return;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (value) => {
      document.documentElement.setAttribute("data-theme", value);
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, theme);
    await waitForVisibleAnimations(page);
    await page.screenshot({ path: join(SHOT_DIR, `work-card-${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

type Work = { status: "working" | "waiting" | "done" | "failed" | "stopped"; url?: string };

function post(temp: TempWorkspace, body: string, work?: Work) {
  return sendCliRequest<"post">({
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb: "post",
    args: {
      cwd: temp.rootPath, actor: "agent", agent: "Nova", group: GROUP, body,
      attachments: [], needsDecision: false, ...(work ? { work } : {}),
    },
  }, { stateDir: temp.homeDir });
}

function reply(temp: TempWorkspace, thread: string, body: string, work: Work, actor: "agent" | "human" = "agent") {
  return sendCliRequest<"reply">({
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb: "reply",
    args: {
      cwd: temp.rootPath, actor, ...(actor === "agent" ? { agent: "Nova" } : {}), thread, body,
      attachments: [], needsDecision: false, work,
    },
  }, { stateDir: temp.homeDir });
}

test("an agent's work report shows as the thread's Work card, which is its newest report", async () => {
  test.setTimeout(180_000);
  if (SHOT_DIR !== "") await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "work-card");
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const main = page.locator("main");
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.getByTestId(activityPin("chats")).click();
    await expect(page.getByTestId("chats-view")).toBeVisible();
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill(GROUP);
    await page.getByTestId("chats-new-channel-type-posts").click();
    await page.getByTestId("chats-new-channel-name").press("Enter");
    await expect(main.getByTestId("chats-channel-title")).toHaveText(GROUP);
    await waitForCliEndpoint(temp.homeDir);

    // An agent working elsewhere posts where its work is and how it stands.
    const started = await post(temp, "Fix the login redirect\nReproducing it in a thread.", { status: "working", url: LINK });
    await post(temp, "Notes from the review\nNothing is running for this one.");
    const card = main.getByTestId("chats-post-card").filter({ hasText: "Fix the login redirect" });
    const status = card.getByTestId("chats-post-work");
    await expect(status).toHaveAttribute("data-status", "working");
    await expect(status).toContainText("Working");
    const open = card.getByRole("button", { name: "Open example.com, as reported" });
    await expect(open).toHaveAttribute("title", LINK);
    await expect(card.getByTestId("chats-post-work-reporter")).toHaveCount(0);
    const plain = main.getByTestId("chats-post-card").filter({ hasText: "Notes from the review" });
    await expect(plain.getByTestId("chats-post-work")).toHaveCount(0);
    await shoot(page, "a-post-working");

    // A person's message reports no work.
    await expect(reply(temp, started.threadId, "Mine", { status: "done" }, "human"))
      .rejects.toThrow("Only an agent reports work");

    // The agent reports again without a link. The card becomes that report,
    // with no reload: its status, and no link, because it gave none.
    await reply(temp, started.threadId, "Waiting for a review on the pull request.", { status: "waiting" });
    await expect(status).toHaveAttribute("data-status", "waiting");
    await expect(card.getByTestId("chats-post-work-open")).toHaveCount(0);
    await expect(card.getByTestId("chats-post-work-reporter")).toHaveText("Nova");
    await shoot(page, "b-post-waiting");
    await reply(temp, started.threadId, "Merged.", { status: "done", url: "https://example.com/pull/12" });
    await expect(status).toHaveAttribute("data-status", "done");
    await expect(card.getByTestId("chats-post-work-open")).toHaveAttribute("title", "https://example.com/pull/12");
    await shoot(page, "c-post-done");

    // Inside the thread, each report shows on its own message, the opening
    // post's included.
    await card.click();
    await expect(main.getByTestId("chats-thread-view")).toBeVisible();
    await expect(main.getByTestId("chats-message-work")).toHaveAttribute("data-status", "working");
    await expect(main.getByTestId("chats-message-work-open")).toHaveAttribute("title", LINK);
    await expect.poll(() => main.getByTestId("chats-comment-work").evaluateAll(
      (reports) => reports.map((report) => report.getAttribute("data-status")),
    )).toEqual(["waiting", "done"]);
    await expect(main.getByTestId("chats-comment-work-open")).toHaveCount(1);
    await shoot(page, "d-thread-done");

    // An agent reading the chat gets the same card.
    const shown = await sendCliRequest<"show">({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "show",
      args: { cwd: temp.rootPath, actor: "agent", target: GROUP, peek: true },
    }, { stateDir: temp.homeDir });
    if (!("stream" in shown)) throw new Error("Expected the group's stream.");
    const posted = shown.stream.items.find((item) => item.threadId === started.threadId);
    expect(posted?.post?.work).toMatchObject({ status: "done", url: "https://example.com/pull/12" });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

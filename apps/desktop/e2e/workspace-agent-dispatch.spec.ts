import { holdSystemClipboard } from "./helpers/systemClipboard";
import { desktopPins, activityPin, settingsNavPin } from "../src/testPins";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools, openMyAgent } from "./helpers/agentTools";
import { waitForVisibleAnimations } from "./helpers/animations";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  trustOpenWorkspace,
  seedWorkspaceManifest,
  type TempWorkspace,
} from "./helpers/workspace";

const REPORT = "done: checked the exports";
const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");

test("installed tool cards save profiles, Check replies through PATH, and a group mention dispatches", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-profile-e2e");
    const env = await installFakeAgentTools(temp);
    desktop = await launchDesktopApp({ workspace: temp, env });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    // No runner is set up yet, so there is no agent channel: adding the
    // agent is the opt-in that creates it.
    await page.getByTestId(activityPin("chats")).click();
    await expect(page.getByTestId("chats-view")).toBeVisible();
    await page.getByTestId(desktopPins.sidePanel).getByTestId("chats-add-agent-open").click();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    for (const name of ["Claude Code", "Codex"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByTestId("chats-add-agent-check").click();
      await expect(page.getByTestId("chats-add-agent-check-result")).toHaveAttribute("data-state", "ok");
    }
    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await page.getByTestId(desktopPins.sidePanel).getByTestId("chats-channel").filter({ hasText: "general" }).click();
    await page.getByTestId("chats-new-thread-composer").fill("@Nova check the exports");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-message").filter({ hasText: REPORT })).toHaveCount(1);

    // The Codex run's log starts with the thread's id, not with its prompt,
    // which holds the whole chat.
    await page.getByTestId("chats-message").filter({ hasText: REPORT }).getByTestId("chats-run-chip").click();
    const log = await readFile((await page.getByTestId("chats-run-log-path").textContent())!, "utf8");
    expect(log).toContain('"type":"thread.started"');
    expect(log).not.toContain("check the exports");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

function runnerCommand(mode: "report" | "silent-fail" | "ask"): string {
  return `node "${fakeRunner.replaceAll('"', '\\"')}" ${mode}`;
}

async function seedRunnerSettings(
  temp: Pick<TempWorkspace, "homeDir">,
  mode: "report" | "silent-fail" | "ask",
): Promise<string> {
  const command = runnerCommand(mode);
  const settings: DesktopUserSettings = {
    ...DEFAULT_USER_SETTINGS,
    profile: { preferredName: "Sam" },
    agents: {
      default: { name: "Nova", hue: "olive", launch: { command }, changesFiles: true, enabled: true, timeoutMinutes: 1 },
    },
  };
  await writeFile(
    join(temp.homeDir, USER_SETTINGS_FILE),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  return command;
}

test("picking the agent in a group's post says it runs when you send, and the offer leaves after the send", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-dispatch-offer-e2e");
    const command = await seedRunnerSettings(temp, "report");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);
    await page.getByTestId(desktopPins.sidePanel).getByTestId("chats-channel").filter({ hasText: "general" }).click();

    const composer = page.getByTestId("chats-new-thread-composer");
    await composer.pressSequentially("@Nova");
    await page.locator('[data-testid="chats-new-thread-mention-option"][data-candidate-id="agent:default"]').click();
    const offer = page.getByTestId("composer-agent-offer");
    await expect(offer).toHaveAttribute("data-state", "runs");
    await expect(offer.getByTestId("composer-agent-offer-words")).toHaveText("Runs when you send");

    await composer.pressSequentially("check the exports");
    await composer.press("Enter");
    await expect(page.getByTestId("chats-message").filter({ hasText: REPORT })).toHaveCount(1);
    await expect(page.getByTestId("composer-agent-offer")).toHaveCount(0);

    const runChip = page.getByTestId("chats-message").filter({ hasText: REPORT }).getByTestId("chats-run-chip");
    await expect(runChip).toHaveText("Details");
    await runChip.click();
    await expect(page.getByTestId("chats-run-popover")).toBeVisible();
    await expect(page.getByTestId("chats-run-command")).toHaveText(command);
    await expect(page.getByTestId("chats-run-id")).not.toBeEmpty();
    await expect(page.getByTestId("chats-run-exit-code")).toHaveText("0");
    // The command and log path wrap inside the popover, Copy included.
    expect(await page.getByTestId("chats-run-popover").evaluate((popover) => popover.scrollWidth <= popover.clientWidth)).toBe(true);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("the agent dispatches a fresh successful run for each human message", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-report-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "report");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);

    // An agent DM opens on its conversation.
    const composer = page.getByTestId("chats-lane-composer");
    await composer.fill("audit the projections");
    await composer.press("Enter");

    const agentReplies = page
      .getByTestId("chats-lane-message")
      .filter({ hasText: REPORT });
    await expect(agentReplies).toHaveCount(1);
    await expect(
      agentReplies.first().getByTestId("chats-lane-agent-badge"),
    ).toHaveText("agent");

    // A second committed human message is a second ledger trigger. The same
    // report arriving again, in the same conversation, proves the first
    // trigger was durably acked rather than accidentally replayed.
    await composer.fill("also audit the export totals");
    await composer.press("Enter");
    await expect(agentReplies).toHaveCount(2);
    await expect(page.getByTestId("chats-lane-message")).toHaveCount(4);
    await expect(
      agentReplies.nth(1).getByTestId("chats-lane-agent-badge"),
    ).toHaveText("agent");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("an agent's reply in Notices opens its conversation at the reply, washed and focused", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-notice-open-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "report");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);

    // The first reply lands while its chat is on screen. Its run's notice
    // comes later, once the run has ended. This reads the list on each change,
    // as Notices does, so it sees the notice arrive before Notices dismisses it.
    const runNotices = await page.evaluateHandle(() => {
      const api = (window as unknown as {
        dohcDesktop: {
          listNotices(payload: Record<string, never>): Promise<{ notices: Array<{ kind: string }> }>;
          onNoticesChanged(listener: () => void): () => void;
        };
      }).dohcDesktop;
      const listed = async () => (await api.listNotices({})).notices.filter((notice) => notice.kind === "agent-run").length;
      const state = { arrived: false, listed, stop: () => {} };
      state.stop = api.onNoticesChanged(() => {
        void listed().then((count) => { if (count > 0) state.arrived = true; });
      });
      return state;
    });
    const composer = page.getByTestId("chats-lane-composer");
    await composer.fill("audit the projections");
    await composer.press("Enter");
    const agentReplies = page.getByTestId("chats-lane-message").filter({ hasText: REPORT });
    await expect(agentReplies).toHaveCount(1);
    // Its notice arrived and left the list while the chat was still open.
    await expect.poll(() => runNotices.evaluate(async (state) => state.arrived && await state.listed() === 0), { timeout: 30_000 }).toBe(true);
    await runNotices.evaluate((state) => state.stop());

    // Ask again with the chat closed, so the reply arrives as a notice. The
    // conversation is an editor tab: another sidebar view leaves it on screen.
    await page.getByRole("button", { name: "Close Nova", exact: true }).click();
    await expect(page.getByTestId("chats-lane-message")).toHaveCount(0);
    // The agent's conversation is its channel's chat lane, not its posts.
    await page.evaluate(async (workspaceId) => {
      const api = (window as unknown as {
        dohcDesktop: {
          listChatChannels(payload: { workspaceId: string }): Promise<{ channels: Array<{ id: string; kind: string }> }>;
          listChannelThreads(payload: { workspaceId: string; channelId: string; lane: "chat" }): Promise<{ threads: Array<{ id: string }> }>;
          sendChatMessage(payload: { workspaceId: string; threadId: string; body: string }): Promise<unknown>;
        };
      }).dohcDesktop;
      const { channels } = await api.listChatChannels({ workspaceId });
      const agent = channels.find((channel) => channel.kind === "agent");
      if (!agent) throw new Error(`no agent channel in ${workspaceId}`);
      const { threads: [conversation] } = await api.listChannelThreads({ workspaceId, channelId: agent.id, lane: "chat" });
      if (!conversation) throw new Error("the agent channel has no conversation");
      await api.sendChatMessage({ workspaceId, threadId: conversation.id, body: "also audit the export totals" });
    }, workspaceId);

    // With UI_AUDIT_SHOT_DIR set, saves the window in both themes.
    const shots = async (name: string) => {
      const dir = process.env.UI_AUDIT_SHOT_DIR;
      if (!dir) return;
      await mkdir(dir, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await waitForVisibleAnimations(page);
        await page.screenshot({ path: join(dir, `${name}-${theme}.png`) });
      }
    };

    // The reply arrives as a toast with its Open, before it fades.
    const toastOpen = page.getByTestId("sent-notice-toast").filter({ hasText: "Nova" }).getByTestId("sent-notice-toast-open");
    await expect(toastOpen).toBeVisible();
    await toastOpen.hover();
    await shots("notice-toast-open-hover");
    // The toast fades on its own; still here means the frames caught it.
    await expect(toastOpen).toBeVisible();

    await page.getByTestId("notice-center-toggle").click();
    const center = page.getByTestId("notice-center");
    const row = center.locator('li[data-testid^="sent-notice-"]').filter({ hasText: "Nova" }).first();
    await expect(row).toBeVisible();
    await row.hover();
    await shots("notice-row-hover");
    // The whole row is the target, with the pointer.
    expect(await row.evaluate((node) => getComputedStyle(node).cursor === "pointer"
      || getComputedStyle(node.querySelector("[data-notice-open]")!, "::after").cursor === "pointer")).toBe(true);
    // The row's own Open is the toast's button.
    await row.getByRole("button", { name: "Open", exact: true }).hover();
    await shots("notice-row-open-hover");
    // The keyboard reaches the row through its one stop, and rings the row.
    await page.mouse.move(0, 0);
    await page.keyboard.press("ArrowDown");
    await expect(row.locator("[data-notice-open]")).toBeFocused();
    await shots("notice-row-focus");

    // A press anywhere on the row, not only its Open, lands on the reply.
    await row.click();
    await expect(center).toHaveCount(0);
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Nova");
    const landed = page.locator('[data-testid="chats-lane-message"].dohc-target-flash');
    await expect(landed).toHaveCount(1);
    await expect(landed).toContainText(REPORT);
    await expect(landed).toBeFocused();
    await expect(landed).toHaveAttribute("data-message-id", await agentReplies.nth(1).getAttribute("data-message-id") ?? "");
    if (process.env.UI_AUDIT_SHOT_DIR) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `notice-landed-reply-${theme}.png`) });
      }
    }
    // The wash clears on its own.
    await expect(landed).toHaveCount(0);

    // Both replies exist now. The only Nova row is the one just opened at the
    // second reply.
    await page.getByTestId("notice-center-toggle").click();
    await expect(center.locator('li[data-testid^="sent-notice-"]').filter({ hasText: "Nova" })).toHaveCount(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("an agent's question with choices is a poll; picking one answers it and the answer reaches the next run", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-ask-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "ask");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);

    await page.getByTestId("chats-lane-composer").fill("plan the release");
    await page.getByTestId("chats-lane-composer").press("Enter");

    // The agent asks with choices. The question is a poll: its choices are
    // on screen and there is no bare Answer button.
    const question = page.getByTestId("chats-lane-message").filter({ hasText: "Which day do we ship?" });
    await expect(question).toHaveCount(1);
    await expect(question.getByTestId("chats-lane-agent-badge")).toHaveText("agent");
    await expect(question.getByTestId("chats-lane-decision-open")).toHaveText("Unanswered");
    const options = question.getByTestId("chats-lane-poll-option");
    await expect(options).toHaveText(["Friday", "Monday"]);
    await expect(question.getByTestId("chats-lane-decision-resolve")).toHaveCount(0);

    // Picking a choice answers the poll with that choice.
    await options.nth(1).click();
    await expect(question.getByTestId("chats-lane-decision-resolved")).toHaveText("Answered");
    await expect(options.nth(1)).toHaveAttribute("data-chosen", "true");

    // The answer is a human message, so it triggers a run. That run reads
    // the taken choice out of the conversation and reports it back.
    await expect(
      page.getByTestId("chats-lane-message").filter({ hasText: "going with Monday" }),
    ).toHaveCount(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("an agent's open question shows Answer, which starts the reply that answers it", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-open-question-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "ask");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);
    const shoot = async (name: string) => {
      if (!process.env.UI_AUDIT_SHOT_DIR) return;
      await mkdir(process.env.UI_AUDIT_SHOT_DIR, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await waitForVisibleAnimations(page);
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `${name}-${theme}.png`) });
      }
    };

    await page.getByTestId("chats-lane-composer").fill("name the file");
    await page.getByTestId("chats-lane-composer").press("Enter");

    // An open question without choices says so in words, with Answer beside it.
    const question = page.getByTestId("chats-lane-message").filter({ hasText: "What should I call the file?" });
    await expect(question.getByTestId("chats-lane-decision-open")).toBeVisible();
    await shoot("open-question");
    await expect(question.getByTestId("chats-lane-decision-open")).toHaveText("Unanswered");
    await expect(question.getByTestId("chats-lane-poll-option")).toHaveCount(0);

    // Answer opens the question's thread with the reply box focused.
    await question.getByTestId("chats-lane-decision-resolve").click();
    const reply = page.getByTestId("chats-lane-thread-composer");
    await expect(reply).toBeFocused();
    await shoot("open-question-answering");

    await reply.fill("Call it notes.md");
    await reply.press("Enter");
    await expect(question.getByTestId("chats-lane-decision-resolved")).toHaveText("Answered");
    await expect(question.getByTestId("chats-lane-decision-resolve")).toHaveCount(0);

    // The answer reaches the agent's next run, which replies in the thread.
    const thread = page.getByTestId("chats-lane-thread-panel");
    await expect(thread.getByText("calling it notes.md")).toHaveCount(1);
    await shoot("open-question-answered");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a runner that exits silently says why under the message and posts a notice", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-failure-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "silent-fail");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);

    await page.getByTestId("chats-lane-composer").fill("audit the projections");
    await page.getByTestId("chats-lane-composer").press("Enter");

    // The words sit under the message that asked. Running it again would
    // repeat what it did, so the line offers no Try again. In its own chat
    // a message asks it, so its button readies the box. The thread panel,
    // away from that box, says it in words.
    const words = "Nova didn't reply. Its run ended with an error.";
    const nextStep = "Message Nova to ask again.";
    const line = page.getByTestId("chats-lane-run-failed");
    await expect(line.getByRole("status")).toHaveText([words]);
    await expect(line.getByRole("button", { name: "Message Nova" })).toBeVisible();
    await expect(page.getByTestId("chats-lane-run-try-again")).toHaveCount(0);

    // The failure is a row in Notices. Its chat was on screen, so it posts no
    // toast in a focused window; focus differs between test hosts, so the
    // unit tests check that part. The conversation keeps only what people
    // and the agent wrote, so once the notice is there it still holds one
    // message.
    await page.getByTestId("notice-center-toggle").click();
    // An agent DM's conversation has no title, so the title names no thread.
    const center = page.getByTestId("notice-center");
    await expect(center.getByText("Nova didn't reply", { exact: true })).toBeVisible();
    await expect(center.getByText("Its run ended with an error.", { exact: true })).toBeVisible();
    await expect(center).not.toContainText(nextStep);
    const messages = page.getByTestId("chats-lane-message");
    await expect(messages).toHaveCount(1);
    await expect(messages.getByTestId("chats-lane-message-author")).toHaveAttribute("data-author-kind", "human");
    await expect(messages).toContainText("audit the projections");

    // The message's thread repeats the line under it.
    await page.keyboard.press("Escape");
    await messages.hover();
    await page.getByTestId("chats-lane-reply-in-thread").click();
    const panel = page.getByTestId("chats-lane-thread-panel");
    const panelLine = panel.getByTestId("chats-lane-run-failed");
    await expect(panelLine.getByRole("status")).toHaveText([words, nextStep]);
    if (process.env.UI_AUDIT_SHOT_DIR) {
      await mkdir(process.env.UI_AUDIT_SHOT_DIR, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await waitForVisibleAnimations(page);
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `thread-run-failed-${theme}.png`) });
      }
    }

    // A run that fails while the person is in another chat posts a toast.
    // Agent replies wait while paused, so the post's run starts only once
    // the person is back in Nova's DM.
    await setDispatchPaused(page, true);
    await page.getByTestId(desktopPins.sidePanel).getByTestId("chats-channel").filter({ hasText: "general" }).click();
    await page.getByTestId("chats-new-thread-composer").fill("@Nova check the exports");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();
    await page.locator('[data-testid="chats-my-agent"][data-agent-id="default"]').click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Nova");
    await setDispatchPaused(page, false);

    // The toast sits above the message box, so Send stays in reach.
    const toasts = page.getByTestId("notice-toasts");
    await expect(toasts).toContainText("Nova didn't reply in \"");
    await waitForVisibleAnimations(page);
    if (process.env.UI_AUDIT_SHOT_DIR) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await waitForVisibleAnimations(page);
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `toast-above-composer-${theme}.png`) });
      }
    }
    const box = page.getByTestId("chats-lane-composer").locator("xpath=ancestor::form[1]");
    const boxTop = await box.evaluate((node) => node.getBoundingClientRect().top);
    const toastsBottom = await toasts.evaluate((node) => node.getBoundingClientRect().bottom);
    expect(toastsBottom).toBeLessThanOrEqual(boxTop);

    // Its Open goes to the post, which says the same under its opening
    // message, with a button that readies a comment to @Nova and sends
    // nothing.
    await toasts.getByTestId("sent-notice-toast-open").click();
    const postLine = page.getByTestId("chats-run-failed");
    await expect(postLine.getByRole("status")).toHaveText([words]);
    await expect(page.getByTestId("chats-run-try-again")).toHaveCount(0);
    const mention = postLine.getByRole("button", { name: "Mention @Nova" });
    await expect(mention).toBeVisible();
    if (process.env.UI_AUDIT_SHOT_DIR) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await waitForVisibleAnimations(page);
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `post-run-failed-${theme}.png`) });
      }
    }
    await mention.click();
    const comment = page.getByTestId("chats-composer");
    await expect(comment).toBeFocused();
    await expect(comment).toHaveValue("@Nova ");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// Pauses or resumes agent replies on this computer, as Settings does.
async function setDispatchPaused(page: Page, paused: boolean): Promise<void> {
  await page.evaluate(
    (value) => (window as unknown as {
      dohcDesktop: { setChatDispatchPaused(payload: { paused: boolean }): Promise<void> };
    }).dohcDesktop.setChatDispatchPaused({ paused: value }),
    paused,
  );
}

// What the pointer reaches at a toast's center: the toast, a workbench
// modal (`data-dohc-modal` on its backdrop), something else, or nothing.
function hitAtCenter(toast: Locator): Promise<string> {
  return toast.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    if (hit === null) return "none";
    if (element.contains(hit)) return "toast";
    if (hit.closest("[data-dohc-modal]")) return "modal";
    return `other:${hit.tagName.toLowerCase()}`;
  });
}

// Toasts sit above every dialog and its scrim (NoticeCenter), so a failed
// check says so inside Settings and its reason is reachable in the toast while
// Settings stays open. Copy and Dismiss leave Settings in place. The row stays
// in Notices after the toast is gone.
test("failed agent checks stay readable above Settings and remain in Notices", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-settings-failure-e2e");
    await seedRunnerSettings(temp, "silent-fail");
    desktop = await launchDesktopApp({ workspace: temp, env: await installFakeAgentTools(temp) });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    await page.getByTestId("agent-check").click();
    await expect(page.getByTestId("agent-row")).toContainText("Didn't reply.");
    // The toast names the agent; Copy details carries why.
    const message = "Nova didn't reply to the check.";
    const reason = "Runner exited before reporting self-test success.";
    const toast = page.getByTestId("workspace-shell-error");
    await expect(toast).toContainText(message);
    const settings = page.getByTestId(desktopPins.settingsDialog);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await expect.poll(() => hitAtCenter(toast)).toBe("toast");
      await expect(settings).toBeVisible();
      if (process.env.UI_AUDIT_SHOT_DIR) {
        await mkdir(process.env.UI_AUDIT_SHOT_DIR, { recursive: true });
        await waitForVisibleAnimations(page);
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `runner-test-error-${theme}.png`) });
      }
    }
    // Keep both clears inside the copy/read span.
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await desktop!.app.evaluate(({ clipboard }) => clipboard.clear());
      try {
        await page.getByTestId("workspace-shell-error-details").click({ timeout: remainingMs() });
        await page.getByTestId("workspace-shell-error-details-copy").click({ timeout: remainingMs() });
        await expect.poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: remainingMs() }).toContain(reason);
      } finally {
        await desktop!.app.evaluate(({ clipboard }) => clipboard.clear()).catch(() => undefined);
      }
    });
    await expect(settings).toBeVisible();
    await page.getByRole("button", { name: "Dismiss workspace error" }).click();
    await expect(toast).toHaveCount(0);
    await expect(settings).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(settings).toHaveCount(0);
    await page.getByTestId("notice-center-toggle").click();
    await expect(page.getByTestId("notice-center")).toContainText(message);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

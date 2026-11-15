import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { expect, test, type Page } from "@playwright/test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { startFakeT3Code } from "../src/testing/fakeT3Code";
import { openAgentChat } from "./helpers/agentTools";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
} from "./helpers/workspace";

// A person connects a thread they have in T3 Code as an agent, then sends it
// a chat message. T3 Code here is a stand-in for its server, named by the
// file T3 Code keeps in the home folder the app runs with, so the app never
// reaches a T3 Code the person running the test has. With UI_AUDIT_SHOT_DIR
// set, each screen is also captured in both themes.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
const WORKSPACE_ID = "agent-thread-t3-code";
const SETTINGS: DesktopUserSettings = {
  ...DEFAULT_USER_SETTINGS,
  profile: { preferredName: "Sam" },
};

const THREADS = [
  { threadId: "t-chief", projectId: "p-dohc", title: "Chief of Staff: dohc", status: "running" },
  { threadId: "t-issues", projectId: "p-dohc", title: "Issue owner: triage", status: "completed" },
  {
    threadId: "t-release",
    projectId: "p-dohc",
    title: "Release owner: alpha",
    status: "completed",
  },
  { threadId: "t-mobile", projectId: "p-dohc", title: "Mobile: dohc phone app", status: null },
  { threadId: "t-site", projectId: "p-site", title: "Landing page copy", status: "completed" },
].map((thread, index) => ({
  ...thread,
  updatedAt: new Date(Date.UTC(2026, 10, 13, 20 - index, 5)).toISOString(),
}));

// A stand-in for T3 Code's own program, where its desktop app writes it. It
// prints the file beside it, as the real one prints the sign-in code it made,
// and fails while that file is not there. The test puts a code from the
// stand-in server in that file, so each code approves one sign-in.
async function writeT3CodeProgram(home: string): Promise<{ make(code: string): Promise<void> }> {
  const bin = join(home, ".t3", "bin");
  await mkdir(bin, { recursive: true });
  if (process.platform === "win32")
    await writeFile(join(bin, "t3.cmd"), '@type "%~dp0made.json" 2>nul\r\n');
  else {
    await writeFile(
      join(bin, "t3"),
      '#!/bin/sh\nexec cat "$(dirname "$0")/made.json" 2>/dev/null\n',
    );
    await chmod(join(bin, "t3"), 0o755);
  }
  return {
    make: (code) => writeFile(join(bin, "made.json"), JSON.stringify({ credential: code })),
  };
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(
  page: Page,
  target: { screenshot(options: { path: string }): Promise<Buffer> },
  name: string,
): Promise<void> {
  if (SHOT_DIR === "") return;
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

test("connects a T3 Code thread as an agent and forwards a chat message to it", async () => {
  test.setTimeout(240_000);
  if (SHOT_DIR !== "") await mkdir(SHOT_DIR, { recursive: true });
  const t3 = await startFakeT3Code();
  t3.tools.t3_project_list = () => ({
    projects: [
      { id: "p-dohc", title: "dohc", archivedAt: null, deletedAt: null },
      { id: "p-site", title: "Marketing site", archivedAt: null, deletedAt: null },
    ],
    nextCursor: null,
  });
  t3.tools.t3_thread_list = (args) => ({
    threads: THREADS.filter(
      (thread) =>
        thread.projectId === args.projectId &&
        (typeof args.titleContains !== "string" ||
          thread.title.toLowerCase().includes(args.titleContains.toLowerCase())),
    ),
    nextCursor: null,
  });
  const sends = () => t3.calls.filter((call) => call.tool === "t3_thread_send");
  t3.tools.t3_thread_send = (args) => ({ threadId: args.threadId, runId: `run-${sends().length}` });
  // How many requests wait on the person in the thread, and the question among them.
  let waiting = 0;
  let question: { requestId: string; questions: unknown[] } | null = null;
  t3.tools.t3_pending_request = (args) => {
    if (args.action === "list") return { requestIds: question ? [question.requestId] : [] };
    if (args.action === "read") return question;
    // An answer ends the wait, and the thread works on.
    question = null;
    waiting = 0;
    return { sequence: 1 };
  };
  // What the thread's runs are doing, newest first, as the test sets them.
  let runs: Array<{ runId: string; status: string; completedAt: string | null }> = [];
  t3.tools.t3_thread_read = (args) => ({
    thread: {
      title: THREADS.find((thread) => thread.threadId === args.threadId)?.title ?? "",
      activeRunId: runs.find((run) => run.status === "running")?.runId ?? null,
      pendingRequestCount: waiting,
      archived: false,
      settled: false,
    },
    recentRuns: runs.map((run) => ({
      ...run,
      requestedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    })),
  });
  t3.tools.t3_thread_wait = (args) => {
    const run = runs.find((entry) => entry.runId === args.runId);
    return {
      runId: args.runId,
      status: run?.status ?? "queued",
      timedOut: !run || run.completedAt === null,
    };
  };

  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeFile(
      join(temp.homeDir, USER_SETTINGS_FILE),
      `${JSON.stringify(SETTINGS, null, 2)}\n`,
    );
    await mkdir(join(temp.homeDir, ".t3", "userdata"), { recursive: true });
    await writeFile(
      join(temp.homeDir, ".t3", "userdata", "server-runtime.json"),
      JSON.stringify({ origin: t3.origin }),
    );
    const program = await writeT3CodeProgram(temp.homeDir);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    // The person's browser: it follows T3 Code's page to where T3 Code sends
    // it, and goes nowhere but the stand-in.
    await desktop.app.evaluate(({ shell }, origin) => {
      const opened: string[] = [];
      (globalThis as unknown as { openedInT3Code: string[] }).openedInT3Code = opened;
      shell.openExternal = async (url: string) => {
        if (url.startsWith("t3code://")) {
          opened.push(url);
          return;
        }
        if (!url.startsWith(`${origin}/`)) throw new Error(`The test opened ${url}.`);
        await fetch(url);
      };
    }, t3.origin);
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);

    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    const dialog = page.getByTestId(desktopPins.settingsDialog);
    const section = page.getByTestId(settingsSectionPin("agents"));
    await section.getByTestId("agent-add").click();
    const sheet = page.getByTestId("agent-add-sheet");
    await expect(sheet.getByLabel(/^Looking for /)).toHaveCount(0);
    await sheet.getByTestId("agent-runs-with-t3-code").click();
    await expect(sheet.getByTestId("t3-code-allow")).toBeVisible();
    await expect(sheet.getByTestId("agent-add-confirm")).toHaveCount(0);
    // The person picks the mode. dohc picks none for them.
    const modes = sheet.getByTestId("t3-code-allow-modes");
    await expect(modes.getByRole("radio")).toHaveCount(4);
    await expect(modes.getByRole("radio", { checked: true })).toHaveCount(0);
    await shoot(page, page, "t3-code-a-allow");

    // T3 Code's program makes no code, as when a policy on the computer
    // forbids such codes. dohc says so, and offers T3 Code's page.
    await sheet.getByTestId("t3-code-allow-mode-full-access").click();
    await sheet.getByTestId("t3-code-allow-start").click();
    await expect(sheet.getByTestId("t3-code-allow-error")).toHaveText(
      "dohc could not make its own sign-in code in T3 Code.",
    );
    await expect(sheet.getByTestId("t3-code-allow-on-page")).toBeVisible();
    expect(t3.decisions).toEqual([]);
    await shoot(page, page, "t3-code-a-could-not");

    // With a code from the program, the same button allows dohc. No page
    // opens, and T3 Code is asked for the mode the person picked.
    const code = t3.issueCode();
    await program.make(code);
    await sheet.getByTestId("t3-code-allow-start").click();
    await expect(sheet.getByTestId("t3-code-thread")).toHaveCount(4);
    expect(t3.authorizations).toEqual([]);
    expect(t3.decisions.map((sent) => sent.decision)).toEqual([
      { _tag: "pairing-code", access: "full-access", code },
    ]);
    await shoot(page, page, "t3-code-b-threads");

    await sheet.getByTestId("t3-code-thread-search").fill("owner");
    await expect(sheet.getByTestId("t3-code-thread")).toHaveCount(2);
    await sheet.getByTestId("t3-code-thread-search").fill("");
    await expect(sheet.getByTestId("t3-code-thread")).toHaveCount(4);

    await sheet.locator('[data-testid="t3-code-thread"][data-thread-id="t-chief"]').click();
    const name = sheet.getByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue("Chief of Staff: dohc");
    await name.fill("Chief");
    await shoot(page, page, "t3-code-c-picked");

    await sheet.getByTestId("agent-add-confirm").click();
    await expect(sheet).toHaveCount(0);
    const row = section.locator('[data-testid="agent-row"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("T3 Code");
    await shoot(page, section, "t3-code-d-list");

    expect(sends().map((call) => call.args.threadId)).toEqual(["t-chief"]);
    expect(String(sends()[0]!.args.message)).toContain('as their agent "Chief"');

    await row.click();
    const agentPage = section.getByTestId("agent-page");
    const access = agentPage.getByTestId("agent-thread-access");
    await expect(access).toContainText("Allowed with Full access until");
    await agentPage.getByTestId("agent-note").fill("Post decisions and a daily status here.");
    await agentPage.getByTestId("agent-note").blur();
    await shoot(page, dialog, "t3-code-e-page");

    // Allowing again starts from the mode dohc has. T3 Code takes a code
    // once, so the program's old one is refused, and the person goes to T3
    // Code's page. dohc does not learn the mode they pick there.
    await agentPage.getByTestId("t3-code-allow-again-start").click();
    await expect(
      agentPage.getByTestId("t3-code-allow-modes").getByRole("radio", { checked: true }),
    ).toHaveText(/^Full access/);
    await agentPage.getByTestId("t3-code-allow-mode-auto").click();
    await agentPage.getByTestId("t3-code-allow-start").click();
    await expect(agentPage.getByTestId("t3-code-allow-error")).toHaveText(
      "T3 Code did not take dohc's own sign-in code.",
    );
    await expect(access).toContainText("Allowed with Full access until");
    await shoot(page, dialog, "t3-code-e-again");
    await agentPage.getByTestId("t3-code-allow-on-page").click();
    await expect(access).toHaveText(/^Allowed until /);
    await expect(agentPage.getByTestId("t3-code-allow-modes")).toHaveCount(0);
    expect(t3.authorizations).toHaveLength(1);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).toHaveCount(0);
    const agentId = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          dohcDesktop: { getUserSettings(): Promise<{ settings: { agents: object } }> };
        }
      ).dohcDesktop;
      return Object.keys((await api.getUserSettings()).settings.agents)[0]!;
    });
    await openAgentChat(page, agentId, "Chief");
    runs = [{ runId: "run-2", status: "running", completedAt: null }];
    await page.getByTestId("chats-lane-composer").fill("Can you check the Mac build?");
    await page.getByTestId("chats-lane-composer").press("Enter");

    await expect.poll(() => sends().length, { timeout: 30_000 }).toBe(2);
    const forwarded = String(sends()[1]!.args.message);
    expect(sends()[1]!.args).toMatchObject({ threadId: "t-chief", mode: "queue" });
    expect(forwarded).toContain('From "Sam" in dohc.');
    expect(forwarded).toContain("Can you check the Mac build?");
    expect(forwarded).toContain('Note from "Sam": Post decisions and a daily status here.');
    expect(forwarded).toContain(`--workspace ${WORKSPACE_ID} --agent-id ${agentId} -`);

    const line = page.getByTestId("agent-thread-line");
    await expect(line).toHaveAttribute("data-state", "working", { timeout: 30_000 });
    await expect(line).toContainText("Chief");
    await expect(line).toContainText("Working");
    await shoot(page, page, "t3-code-f-chat");

    await line.getByTestId("agent-thread-open").click();
    await expect
      .poll(() =>
        desktop!.app.evaluate(
          () => (globalThis as unknown as { openedInT3Code: string[] }).openedInT3Code,
        ),
      )
      .toEqual(["t3code://threads/env-fake/t-chief"]);

    // An approval waits in T3 Code: the chat says so, and offers no answer here.
    waiting = 1;
    await expect(line).toHaveAttribute("data-state", "waiting-in-tool", { timeout: 30_000 });
    await expect(line).toContainText("Waiting for you in T3 Code");
    await expect(line.getByTestId("agent-thread-answer")).toHaveCount(0);

    // The thread asks a question in its own box: the person answers it here.
    question = {
      requestId: "q-1",
      questions: [
        {
          id: "which",
          header: "Build",
          question: "Which Mac build should I check?",
          options: [
            { label: "Signed", description: "The build from the release branch", value: "signed" },
            { label: "Nightly", description: "Last night's build" },
          ],
        },
        {
          id: "note",
          header: "",
          question: "Anything else I should know?",
          options: [],
          required: false,
        },
      ],
    };
    await line.getByTestId("agent-thread-answer").click({ timeout: 30_000 });
    const answer = page.getByTestId("agent-thread-answer-dialog");
    await expect(answer).toHaveAttribute("data-view", "form");
    await expect(answer).toContainText("Which Mac build should I check?");
    await expect(answer).toContainText("The build from the release branch");
    await shoot(page, page, "t3-code-h-question");
    // A required question with no answer is not sent.
    await answer.getByTestId("agent-thread-answer-submit").click();
    await expect(answer.getByTestId("agent-thread-answer-missing")).toHaveCount(1);
    await answer.getByRole("radio", { name: "Nightly" }).check();
    await shoot(page, page, "t3-code-i-answer");
    await answer.getByTestId("agent-thread-answer-submit").click();
    await expect(answer).toHaveCount(0);
    const responded = t3.calls.filter(
      (call) => call.tool === "t3_pending_request" && call.args.action === "respond",
    );
    // An option with no value of its own is answered with its label. The optional question is left out.
    expect(responded.map((call) => call.args)).toEqual([
      { action: "respond", threadId: "t-chief", requestId: "q-1", answers: { which: "Nightly" } },
    ]);
    await expect(line).toHaveAttribute("data-state", "working", { timeout: 30_000 });
    await expect(line.getByTestId("agent-thread-answer")).toHaveCount(0);

    runs = [{ runId: "run-2", status: "completed", completedAt: new Date().toISOString() }];
    await expect.poll(() => sends().length, { timeout: 30_000 }).toBe(3);
    expect(String(sends()[2]!.args.message)).toContain("you finished without replying");
    runs = [
      { runId: "run-3", status: "completed", completedAt: new Date().toISOString() },
      ...runs,
    ];
    await expect(line).toHaveAttribute("data-state", "silent", { timeout: 30_000 });
    await expect(line).toContainText("Finished without replying here");
    await shoot(page, page, "t3-code-g-silent");
    expect(sends()).toHaveLength(3);

    // The person points the agent at another thread, from the agent's page.
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    await expect(section).toBeVisible();
    if ((await agentPage.count()) === 0) await row.click();
    await expect(agentPage.getByTestId("agent-page-thread-title")).toContainText(
      "Chief of Staff: dohc",
    );
    await agentPage.getByTestId("agent-page-thread-change").click();
    const change = page.getByTestId("agent-thread-change-dialog");
    // The thread the agent has is no change.
    await change.locator('[data-testid="t3-code-thread"][data-thread-id="t-chief"]').click();
    await expect(change.getByTestId("agent-thread-change-confirm")).toBeDisabled();
    await change.locator('[data-testid="t3-code-thread"][data-thread-id="t-issues"]').click();
    await shoot(page, page, "t3-code-j-change");
    await change.getByTestId("agent-thread-change-confirm").click();
    await expect(change).toHaveCount(0);
    // The new thread got dohc's introduction, and the page names it.
    expect(sends()).toHaveLength(4);
    expect(sends()[3]!.args.threadId).toBe("t-issues");
    expect(String(sends()[3]!.args.message)).toContain('as their agent "Chief"');
    await expect(agentPage.getByTestId("agent-page-thread-title")).toContainText(
      "Issue owner: triage",
    );
    await shoot(page, dialog, "t3-code-k-changed");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).toHaveCount(0);
    // The line of the thread the agent left is gone, and the next message goes to the new one.
    await expect(line).toHaveCount(0);
    await page.getByTestId("chats-lane-composer").fill("And the Windows build?");
    await page.getByTestId("chats-lane-composer").press("Enter");
    await expect.poll(() => sends().length, { timeout: 30_000 }).toBe(5);
    expect(sends()[4]!.args.threadId).toBe("t-issues");
    expect(String(sends()[4]!.args.message)).toContain("And the Windows build?");

    // The person turns this workspace off for the agent. Its thread is not
    // offered there, and a message written then is not forwarded.
    const openAgentPage = async () => {
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("agents")).click();
      await expect(section).toBeVisible();
      if ((await agentPage.count()) === 0) await row.click();
    };
    const closeSettings = async () => {
      await page.getByRole("button", { name: "Close settings" }).click();
      await expect(dialog).toHaveCount(0);
    };
    await openAgentPage();
    const here = agentPage.getByTestId("agent-thread-workspace");
    await here.getByRole("switch").click();
    await expect(here).toContainText("Its thread gets no messages from this workspace.");
    await expect(agentPage.getByTestId("agent-page-thread-title")).toHaveCount(0);
    await expect(agentPage.getByTestId("agent-page-thread-change")).toHaveCount(0);
    await shoot(page, dialog, "t3-code-l-workspace-off");
    await closeSettings();
    await page.getByTestId("chats-lane-composer").fill("Written while it was off.");
    await page.getByTestId("chats-lane-composer").press("Enter");
    await expect(page.getByText("Written while it was off.").first()).toBeVisible();

    // Turning it on again asks first, and says what the thread then holds.
    // dohc tells the thread, and forwards what comes after, not what came before.
    await openAgentPage();
    await here.getByRole("switch").click();
    const ask = page.getByTestId("agent-workspace-dialog");
    await expect(ask).toContainText("can appear in what it posts in another");
    expect(sends()).toHaveLength(5);
    await shoot(page, page, "t3-code-m-workspace-ask");
    await page.getByTestId("agent-workspace-confirm").click();
    await expect(ask).toHaveCount(0);
    await expect(agentPage.getByTestId("agent-page-thread-title")).toContainText(
      "Issue owner: triage",
    );
    expect(sends()).toHaveLength(6);
    expect(sends()[5]!.args.threadId).toBe("t-issues");
    expect(String(sends()[5]!.args.message)).toContain(
      "now forwards their messages from the workspace named",
    );
    await closeSettings();
    await page.getByTestId("chats-lane-composer").fill("After it was on again.");
    await page.getByTestId("chats-lane-composer").press("Enter");
    await expect.poll(() => sends().length, { timeout: 30_000 }).toBe(7);
    expect(String(sends()[6]!.args.message)).toContain("After it was on again.");
    expect(
      sends().some((call) => String(call.args.message).includes("Written while it was off.")),
    ).toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
    await t3.close();
  }
});

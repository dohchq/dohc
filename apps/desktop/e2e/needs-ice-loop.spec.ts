import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopPins } from "../src/testPins";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { openMyAgent } from "./helpers/agentTools";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
  type TempWorkspace,
} from "./helpers/workspace";

// The loop Ice runs with agents dohc starts: the agent works a card on the
// board, asks in #needs-ice when it is blocked, and Ice's reply in that
// thread reaches the agent, which sets the card and resolves the question.
// The agent (fixtures/fakeNeedsIceAgent.mjs) uses only dohc's MCP server or
// CLI, and Ice only the window.

const agent = resolve(desktopRoot, "e2e/fixtures/fakeNeedsIceAgent.mjs");
const TITLE = "Launch: pick a ship date";
const QUESTION = "Which day do we ship the launch?";
const BOARD_YAML = [
  "name: board",
  "fields:",
  "  Name:",
  "    type: text",
  "  Status:",
  "    type: select",
  "    options: [Backlog, Ready, In progress, Review, Done, Blocked]",
  "  Decision:",
  "    type: text",
  "views:",
  "  - name: Board",
  "    kind: board",
  "    groupBy: Status",
  "",
].join("\n");

interface RunLine { runId: string; door: string; phase: "ask" | "answer"; threadId: string; sameRun?: boolean; promptHasAnswer?: boolean; promptHasCard?: boolean; promptHasQuestion?: boolean }

async function seed(temp: TempWorkspace, door: "mcp" | "cli", when: "mid-run" | "after-run"): Promise<void> {
  const settings: DesktopUserSettings = {
    ...DEFAULT_USER_SETTINGS,
    profile: { preferredName: "Ice" },
    agents: {
      default: {
        name: "Nova", hue: "olive", changesFiles: true, enabled: true, timeoutMinutes: 2,
        launch: { command: `node "${agent.replaceAll('"', '\\"')}" ${door} ${when}` },
      },
    },
  };
  await writeFile(join(temp.homeDir, USER_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
  await mkdir(join(temp.rootPath, "board"), { recursive: true });
  await writeFile(join(temp.rootPath, "board", "collection.yaml"), BOARD_YAML);
  await writeFile(join(temp.rootPath, "board", "launch.md"), "---\nid: rec_launche2e234567abcdefgh234\nName: Launch\nStatus: In progress\n---\n");
}

async function runLines(file: string): Promise<RunLine[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as RunLine);
}

async function card(temp: TempWorkspace): Promise<string> {
  return await readFile(join(temp.rootPath, "board", "launch.md"), "utf8").catch(() => "");
}

// What dispatch holds for a thread: its live run and the requests waiting
// for one.
async function dispatchState(page: Page, threadId: string): Promise<{ liveRunId: string | null; pendingCount: number }> {
  return await page.evaluate(async (thread) => {
    const api = (window as unknown as { dohcDesktop: {
      getWorkspaceRegistry(): Promise<{ workspaces: Array<{ workspaceId: string }> }>;
      chatDispatchStateForThread(payload: { workspaceId: string; threadId: string }): Promise<{ liveRunId: string | null; pendingCount: number }>;
    } }).dohcDesktop;
    const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
    const { liveRunId, pendingCount } = await api.chatDispatchStateForThread({ workspaceId, threadId: thread });
    return { liveRunId, pendingCount };
  }, threadId);
}

function postCard(view: Locator, title: string): Locator {
  return view.getByTestId("chats-post-card").filter({ has: view.page().getByTestId("chats-post-title").filter({ hasText: title }) });
}

for (const door of ["mcp", "cli"] as const) {
  for (const when of ["mid-run", "after-run"] as const) {
    test(`an agent dohc starts asks in #needs-ice and acts on Ice's reply ${when}, through ${door === "mcp" ? "MCP" : "the CLI"}`, async () => {
      test.setTimeout(240_000);
      const temp = await createTempWorkspace();
      const runs = join(temp.homeDir, "needs-ice-runs.jsonl");
      let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
      try {
        await seedWorkspaceManifest(temp, `needs-ice-${door}-${when}-e2e`);
        await seed(temp, door, when);
        desktop = await launchDesktopApp({ workspace: temp, env: { NEEDS_ICE_RUNS: runs } });
        await openWorkspaceFromFirstRun(desktop.page, temp);
        await trustOpenWorkspace(desktop);
        const page = desktop.page;
        // The board is a Collection before the agent writes to its card.
        await expect(page.locator('[data-testid="tree-row"][data-path="board"]')).toHaveAttribute("data-collection", "true", { timeout: 60_000 });
        await openMyAgent(page);
        await page.getByTestId("chats-lane-composer").fill("Work the launch card on the board.");
        await page.getByTestId("chats-lane-composer").press("Enter");

        // The agent blocks its card, makes #needs-ice, and asks there with
        // the card attached.
        const group = page.getByTestId(desktopPins.sidePanel).getByTestId("chats-channel").filter({ hasText: "needs-ice" });
        await expect(group).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => card(temp), { timeout: 30_000 }).toContain("Status: Blocked");
        await group.click();
        const view = page.locator("main");
        const post = postCard(view, TITLE);
        await expect(post.getByTestId("chats-post-decision-open")).toBeVisible({ timeout: 30_000 });
        const threadId = await post.getAttribute("data-thread-id");
        if (!threadId) throw new Error("The question's post has no thread id.");
        await post.click();
        const opening = view.locator('article[data-testid="chats-message"]');
        await expect(opening.getByTestId("chats-message-body")).toHaveText(QUESTION);
        await expect(opening.getByTestId("chats-attachment-chip")).toContainText("launch.md");
        await expect(opening.getByTestId("chats-message-decision-open")).toBeVisible();
        if (when === "after-run") {
          // The asking run has ended before Ice answers.
          await expect.poll(async () => (await runLines(runs)).length).toBe(1);
          const [asked] = await runLines(runs);
          await expect.poll(async () => (await dispatchState(page, asked!.threadId)).liveRunId, { timeout: 30_000 }).toBeNull();
        }

        // Ice replies in the thread like anyone would: no mention, no Answer.
        await view.getByTestId("chats-composer").fill("Friday");
        await view.getByTestId("chats-composer").press("Enter");

        // The agent sets the card from the answer and resolves the question.
        await expect(view.getByText("Going with Friday. The card is back In progress.")).toBeVisible({ timeout: 60_000 });
        await expect(opening.getByTestId("chats-message-decision-resolved")).toBeVisible();
        await expect.poll(() => card(temp), { timeout: 30_000 }).toMatch(/Status: In progress[\s\S]*Decision: Friday|Decision: Friday[\s\S]*Status: In progress/u);

        // Once no run is live and nothing waits in the thread, the runs are
        // settled: the reply started a run only when no run was there to
        // take it.
        const askedIn = (await runLines(runs))[0]!.threadId;
        await expect.poll(async () => [await dispatchState(page, askedIn), await dispatchState(page, threadId)], { timeout: 30_000 })
          .toEqual([{ liveRunId: null, pendingCount: 0 }, { liveRunId: null, pendingCount: 0 }]);
        const lines = await runLines(runs);
        expect(lines.map(line => line.phase)).toEqual(["ask", "answer"]);
        expect(lines.every(line => line.door === door)).toBe(true);
        if (when === "mid-run") {
          expect(lines[1]).toMatchObject({ runId: lines[0]!.runId, sameRun: true });
        } else {
          expect(lines[1]!.runId).not.toBe(lines[0]!.runId);
          expect(lines[1]).toMatchObject({ promptHasAnswer: true, promptHasCard: true, promptHasQuestion: true });
        }
      } finally {
        await cleanupDesktopWorkspace(desktop, temp);
      }
    });
  }
}

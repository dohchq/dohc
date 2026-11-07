import { activityPin } from "../src/testPins";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mintLocalhostCa } from "../../../services/share-web/src/testing/localhostCa";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools } from "./helpers/agentTools";
import { waitForVisibleAnimations } from "./helpers/animations";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { relayJson } from "./helpers/relayPeer";
import { startServerProxy } from "./helpers/selfHostOnboarding";
import { sharedDatasetViewerOrigin } from "./helpers/sharedDatasetBrowser";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openChatsView,
  openWorkspaceFromFirstRun,
  trustOpenWorkspace,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for the agent moments of the chat overhaul:
// adding an agent, the agent's screen, an agent's question answered as a
// poll, and the marks of authors who joined with a share link. Light and dark. Not a regression test; it runs only when a shot
// directory is set, the way ui-audit-screenshots.spec.ts does.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture agent screenshots");

const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

test("@ui-audit adding an agent, its screen, and an answered question", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "agent-screens");
    const env = await installFakeAgentTools(temp);
    desktop = await launchDesktopApp({ workspace: temp, env });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;

    await page.getByTestId(activityPin("chats")).click();
    await expect(page.getByTestId("chats-view")).toBeVisible();

    // No runner yet: Agents has no agent of yours and offers Add an agent,
    // which creates its channel.
    await expect(page.getByTestId("chats-add-agent-open")).toBeVisible();
    await expect(page.getByTestId("chats-channel").filter({ hasText: "general" })).toBeVisible();
    await expect(page.getByTestId("chats-my-agent")).toHaveCount(0);
    await shoot(page, "agents-not-set-up");

    await page.getByTestId("chats-add-agent-open").click();
    await expect(page.getByTestId("chats-add-agent")).toBeVisible();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await shoot(page, "agent-tool-cards");
    // The dialog keeps its top, and its fields their left edge, when a pick
    // adds the profile under the cards.
    const dialogTop = async () => (await page.getByTestId("chats-add-agent").boundingBox())?.y;
    const nameLeft = async () => (await page.getByTestId("chats-add-agent-agent-name").boundingBox())?.x;
    const topBeforePick = await dialogTop();
    const leftBeforePick = await nameLeft();
    for (const tool of ["Claude Code", "Codex"]) {
      const card = page.getByRole("button", { name: tool, exact: true });
      await expect(card).toBeEnabled();
      await card.click();
      await expect(page.getByText("Conversation through stdin")).toBeVisible();
      await expect(card).toBeFocused();
      expect(await dialogTop()).toBe(topBeforePick);
      expect(await nameLeft()).toBe(leftBeforePick);
      await shoot(page, `agent-profile-${tool.toLowerCase().replaceAll(" ", "-")}`);
    }
    await page.getByText("Advanced", { exact: true }).click();
    await page
      .getByTestId("chats-add-agent-command")
      .fill(`node "${fakeRunner.replaceAll('"', '\\"')}" ask`);
    await expect(page.getByTestId("chats-add-agent-preview")).toContainText("Nova");
    await expect(page.getByTestId("agent-tool-using-command")).toHaveText("Using your runner command.");
    // The tallest state, shot with its body scrolling between the title and
    // actions bands. A window tall enough to hold it all is shortened for
    // this shot only.
    const body = page.getByTestId("chats-add-agent-body");
    const overflows = () => body.evaluate((node) => node.scrollHeight > node.clientHeight);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    try {
      if (!(await overflows())) {
        const form = await page.getByTestId("chats-add-agent").boundingBox();
        if (!form) throw new Error("Expected the Add agent dialog to be laid out.");
        await page.setViewportSize({ width: viewport.width, height: Math.floor(form.y + form.height) - 160 });
      }
      await expect.poll(overflows).toBe(true);
      await expect(page.getByTestId("chats-add-agent")).toHaveAttribute("data-scrolls", "");
      for (const [band, edge] of [["chats-add-agent-header", "bottom"], ["chats-add-agent-footer", "top"]] as const) {
        await expect(page.getByTestId(band)).toBeVisible();
        const rule = await page.getByTestId(band).evaluate((node, side) => {
          const style = getComputedStyle(node);
          return { width: style.getPropertyValue(`border-${side}-width`), style: style.getPropertyValue(`border-${side}-style`) };
        }, edge);
        expect(rule).toEqual({ width: "1px", style: "solid" });
      }
      expect(await dialogTop()).toBe(topBeforePick);
      expect(await nameLeft()).toBe(leftBeforePick);
      await shoot(page, "add-agent-form");
    } finally {
      await page.setViewportSize(viewport);
    }

    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await expect(page.getByTestId("chats-manage-agent")).toBeVisible();

    // A ready agent's chat opens on its conversation, with its settings in the header.
    await page.locator('[data-testid="chats-my-agent"][data-agent-id="default"]').click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Nova");
    await expect(page.getByTestId("chats-agent-settings")).toBeVisible();
    await expect(page.getByTestId("chats-agent-problem")).toHaveCount(0);
    await shoot(page, "agent-screen");

    // A question with choices is a poll; picking one answers it.
    await page.getByTestId("chats-lane-composer").fill("plan the release");
    await page.getByTestId("chats-lane-composer").press("Enter");
    const question = page.getByTestId("chats-lane-message").filter({ hasText: "Which day do we ship?" });
    await expect(question).toHaveCount(1);
    await expect(question.getByTestId("chats-lane-decision-open")).toHaveText("Unanswered");
    await shoot(page, "agent-question-open");

    await question.getByTestId("chats-lane-poll-option").nth(1).click();
    await expect(question.getByTestId("chats-lane-decision-resolved")).toHaveText("Answered");
    await expect(
      page.getByTestId("chats-lane-message").filter({ hasText: "going with Monday" }),
    ).toHaveCount(1);
    await shoot(page, "agent-question-answered");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// --- Link agent and link holder marks ----------------------------------------
// A Group shared by a read-write link, where three authors write in a row: the
// owner's agent at the default color, an agent that signed in with the link,
// and a person holding the link. Both link authors reach the relay through the
// routes a real one uses: share-web's MCP sign-in for the agent, a browser's
// link session for the person.

type Api = DohcDesktopBridge;
type RelayOp = { opKind: string; payload: Record<string, unknown> };
const LINK_WORKSPACE_ID = "link-marks";
const LINK_OWNER = "e2e-link-marks-owner";
const LINK_TOKEN = `test:${LINK_OWNER}`;
const LINK_REDIRECT = "http://127.0.0.1:43110/callback";
const LINK_VERIFIER = "link-marks-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const SAID = {
  kickoff: "Kickoff: where do we stay?",
  memberAgent: "I can hold the lake cabin until Friday.",
  linkAgent: "Booked the lake cabin for the first week.",
  linkHolder: "Can we add a night?",
  post: "Shortlist: three cabins near the lake.",
  linkAgentComment: "The second cabin has a dock.",
  linkHolderComment: "A dock wins it for me.",
} as const;

// What a screen reader hears of the author marks in one row, in order.
async function spokenMarks(row: Locator): Promise<string[]> {
  return row.evaluate((node) => [...node.querySelectorAll(".sr-only")]
    .map((word) => word.textContent?.trim().toLowerCase() ?? "")
    .filter((word) => word === "agent" || word === "link holder"));
}

async function relayPost(baseUrl: string, path: string, body: unknown, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as Record<string, unknown>;
}

// The Group as the relay holds it, once the owner's chat and the agent's post have synced.
function groupOnRelay(ops: readonly RelayOp[], postThreadId: string) {
  const channel = ops.find((op) => op.opKind === "chat.channel.create" && op.payload.name === "Trip plan")?.payload;
  const thread = (match: (payload: Record<string, unknown>) => boolean) =>
    ops.find((op) => op.opKind === "chat.thread.create" && match(op.payload))?.payload;
  const lane = thread((payload) => payload.channelWireId === channel?.wireId && payload.lane === "chat");
  if (!channel || !lane || !thread((payload) => payload.threadId === postThreadId)) return null;
  return { channelWireId: String(channel.wireId), folderPath: String(channel.folderPath), laneThreadId: String(lane.threadId) };
}

test("@ui-audit link agent and link holder marks", async () => {
  test.setTimeout(480_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | undefined;
  let primaryFailure: unknown;
  try {
    // A read-write Group link edits the Group's folder, so it needs a relay
    // that releases Edit links, deployed the self-hosted way.
    const ca = await mintLocalhostCa(temp.baseDir);
    const env = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
      DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
    proxy = await startServerProxy(ca);
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      editLinks: { engineExecutable: resolveEngineBinary(), publicOrigin: proxy.origin, trustEnv: env },
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey: exchangeKey,
        publicViewerOrigin: sharedDatasetViewerOrigin } });
    proxy.routeRelayTo(relay.baseUrl);
    const relayOps = async (): Promise<RelayOp[]> => {
      const identity = relayAdoptedIdentity(relay!.dbPath, LINK_WORKSPACE_ID);
      if (!identity) return [];
      const query = new URLSearchParams({ since: "0", limit: "1000", ...identity });
      const result = await relayJson(relay!.baseUrl, LINK_TOKEN, `/sync/${LINK_WORKSPACE_ID}/log?${query}`);
      expect(result.status, result.body).toBe(200);
      return (JSON.parse(result.body) as { ops: RelayOp[] }).ops;
    };

    // --- The owner syncs a Group with a chat and posts --------------------
    await seedWorkspaceManifest(temp, LINK_WORKSPACE_ID);
    await seedWorkspaceRegistry(temp, [{ workspaceId: LINK_WORKSPACE_ID, rootPath: temp.rootPath }]);
    await seedCloudCredentials(temp, { serverUrl: proxy.origin, relayUrl: proxy.origin,
      userId: LINK_OWNER, email: `${LINK_OWNER}@dohc.test`, token: LINK_TOKEN });
    owner = await launchDesktopApp({ workspace: temp, env });
    const page = owner.page;
    await openWorkspaceFromFirstRun(page, temp);
    await page.evaluate(async (workspaceId) => {
      await (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudEnableSync({ workspaceId });
    }, LINK_WORKSPACE_ID);

    await openChatsView(page);
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Trip plan");
    await page.getByTestId("chats-new-channel-type-both").click();
    await page.getByTestId("chats-new-channel-submit").click();
    const channelView = page.locator('[data-testid="chats-channel-view"][data-variant="page"]');
    const threadView = page.locator('[data-testid="chats-thread-view"][data-variant="page"]');
    await expect(channelView.getByTestId("chats-channel-title")).toHaveText("Trip plan");
    await waitForWorkspaceFile(page, LINK_WORKSPACE_ID, "trip-plan");

    // The owner's first chat message starts the Group's chat.
    await channelView.getByTestId("chats-group-lane-chat").click();
    await channelView.getByTestId("chats-lane-composer").fill(SAID.kickoff);
    await channelView.getByTestId("chats-lane-composer").press("Enter");
    await expect(channelView.getByTestId("chats-lane-message-body").filter({ hasText: SAID.kickoff })).toBeVisible();

    // The owner's agent, at the default color, posts, then answers in the chat.
    await waitForCliEndpoint(temp.homeDir);
    const posted = await runDohcCli(temp, ["chat", "post", "trip-plan", "--as-agent", SAID.post]);
    const handle = posted.stdout.match(/^posted\s+(\S+)\s/mu)?.[1];
    if (!handle) throw new Error(`The agent's post printed no thread: ${posted.stdout}`);
    // The CLI prints a short `th_` handle; the relay and the bridge use the engine's `thread-` id.
    const postThreadId = handle.startsWith("th_") ? `thread-${handle.slice(3)}` : handle;
    await expect.poll(async () => groupOnRelay(await relayOps(), postThreadId) !== null,
      { timeout: 120_000, intervals: [1000] }).toBe(true);
    const group = groupOnRelay(await relayOps(), postThreadId)!;
    const replied = await runDohcCli(temp, ["chat", "reply", group.laneThreadId, "--as-agent", SAID.memberAgent]);
    expect(replied.stdout).toContain("replied");

    // --- The owner shares the Group and makes a read-write link -----------
    const shared = await relayJson(relay.baseUrl, LINK_TOKEN, `/sync/${LINK_WORKSPACE_ID}/shares`, {
      method: "POST", body: JSON.stringify({ recipientUserId: "e2e-link-marks-member", channelWireId: group.channelWireId,
        paths: [group.folderPath], access: "read-write", subjectName: "Trip plan" }),
    });
    expect(shared.status, shared.body).toBe(200);
    const shareId = String((JSON.parse(shared.body) as { shareId: string }).shareId);
    const created = await relayJson(relay.baseUrl, LINK_TOKEN, `/sync/${LINK_WORKSPACE_ID}/shares/${shareId}/links`, {
      method: "POST", body: JSON.stringify({ access: "read-write" }),
    });
    expect(created.status, created.body).toBe(200);
    const secret = new URL((JSON.parse(created.body) as { url: string }).url).hash.slice(1);
    const exchange = { "x-dohc-relay-exchange-key": exchangeKey };

    // --- An agent signs in with the link, as share-web's MCP sign-in does --
    const resource = `${sharedDatasetViewerOrigin}/mcp/s/${secret}`;
    const { clientId } = await relayPost(relay.baseUrl, "/sync/link/agent-clients",
      { registration: "registered", redirectUris: [LINK_REDIRECT], clientName: "Claude Code" }, exchange);
    const { requestId } = await relayPost(relay.baseUrl, "/sync/link/agent-authorizations", {
      clientId, resource, redirectUri: LINK_REDIRECT, state: "link-marks", codeChallengeMethod: "S256",
      codeChallenge: createHash("sha256").update(LINK_VERIFIER).digest("base64url"),
    }, exchange);
    const { code } = await relayPost(relay.baseUrl, "/sync/link/agent-authorizations/decision", { requestId, decision: "allow" }, exchange);
    const { accessToken } = await relayPost(relay.baseUrl, "/sync/link/agent-token", {
      grantType: "authorization_code", clientId, code, redirectUri: LINK_REDIRECT, codeVerifier: LINK_VERIFIER, resource,
    }, exchange);
    const agentPost = (body: string, threadId: string, idempotencyKey: string) =>
      relayPost(relay!.baseUrl, "/sync/link/agent-chat/post", { accessToken, body, threadId, idempotencyKey }, exchange);

    // --- A person opens the link in a browser -----------------------------
    const { capabilityToken } = await relayPost(relay.baseUrl, "/sync/link-exchange", { secret }, exchange);
    const browser = {
      authorization: `LinkCapability ${String(capabilityToken)}`,
      "x-dohc-link-profile-secret": randomBytes(32).toString("base64url"),
    };
    const holderPost = (body: string, threadId: string, idempotencyKey: string) =>
      relayPost(relay!.baseUrl, "/sync/link/chat/messages",
        { channelWireId: group.channelWireId, threadId, body, claimedName: "Wren", idempotencyKey }, browser);

    // Both write in the Group's chat after the owner's agent, then comment on its post.
    await agentPost(SAID.linkAgent, group.laneThreadId, "chat-1");
    await holderPost(SAID.linkHolder, group.laneThreadId, "chat-1");
    await agentPost(SAID.linkAgentComment, postThreadId, "comment-1");
    await holderPost(SAID.linkHolderComment, postThreadId, "comment-1");

    // --- The Group: three authors in a row --------------------------------
    // An idle owner pulls on its own sync cadence; a throwaway write wakes it.
    const lane = channelView.getByTestId("chats-lane");
    const laneRow = (body: string) => lane.getByTestId("chats-lane-message").filter({ hasText: body });
    let nudge = 0;
    await expect.poll(async () => {
      nudge += 1;
      await writeFile(join(temp.rootPath, `sync-nudge-${nudge}.md`), `nudge ${nudge}\n`);
      await channelView.getByTestId("chats-group-lane-posts").click();
      await channelView.getByTestId("chats-group-lane-chat").click();
      await expect(channelView.getByTestId("chats-lane-composer")).toBeEnabled({ timeout: 10_000 });
      return laneRow("Can we add a night?").count();
    }, { timeout: 120_000, intervals: [2000] }).toBe(1);
    await expect(laneRow(SAID.memberAgent).getByTestId("chats-lane-message-author")).toHaveAttribute("data-author-kind", "agent");
    await expect(laneRow("Booked").getByTestId("chats-lane-message-author")).toHaveAttribute("data-author-kind", "link");
    expect(await spokenMarks(laneRow(SAID.memberAgent))).toEqual(["agent"]);
    expect(await spokenMarks(laneRow("Booked"))).toEqual(["agent", "link holder"]);
    expect(await spokenMarks(laneRow("Can we add a night?"))).toEqual(["link holder"]);
    await expect(laneRow("Booked").getByTestId("chats-lane-message-author")).toHaveText("Claude Code");
    await expect(laneRow("Booked").locator("[data-link-agent]")).toHaveAttribute("title", "Claude Code");
    await page.mouse.move(0, 0);
    await shoot(page, "link-marks-group");

    // --- The post card, its thread, and the link agent's comment ----------
    await channelView.getByTestId("chats-group-lane-posts").click();
    const card = channelView.getByTestId("chats-post-card").filter({ hasText: SAID.post });
    await expect(card).toBeVisible();
    // A link author writes in the Group's chat or comments on a post; it
    // cannot start a post. The card's author is the owner's agent.
    expect(await spokenMarks(card)).toEqual(["agent"]);
    await page.mouse.move(0, 0);
    await shoot(page, "link-marks-post-card");

    await card.click();
    await expect(threadView).toBeVisible();
    const comment = (body: string) => threadView
      .locator('li[data-testid="chats-message"] > [data-testid="chats-comment-bubble"]').filter({ hasText: body });
    await expect(comment(SAID.linkHolderComment)).toBeVisible({ timeout: 30_000 });
    expect(await spokenMarks(threadView.locator('article[data-testid="chats-message"]'))).toEqual(["agent"]);
    expect(await spokenMarks(comment(SAID.linkAgentComment))).toEqual(["agent", "link holder"]);
    expect(await spokenMarks(comment(SAID.linkHolderComment))).toEqual(["link holder"]);
    await expect(comment(SAID.linkAgentComment).getByTestId("chats-comment-link-holder")).toHaveText("Link holder");
    await page.mouse.move(0, 0);
    await shoot(page, "link-marks-thread");

    // The agent's badge names it, with no owner: nobody in the workspace owns it.
    const badge = comment(SAID.linkAgentComment).getByTestId("chats-comment-agent-badge");
    await expect(badge).toHaveAccessibleName("agent");
    await badge.focus();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("Claude Code");
    await expect(tooltip).not.toContainText("Owned by");
    await expect(tooltip).not.toContainText("Owner name unavailable");
    await shoot(page, "link-marks-comment");
    await page.keyboard.press("Escape");

    // --- Home ---------------------------------------------------------------
    // A Group follow lists opening posts only. Comments reach Home once the
    // owner follows the post's thread, which their agent's post does not do.
    await page.evaluate(async ({ workspaceId, threadId }) => {
      await (window as unknown as { dohcDesktop: Api }).dohcDesktop.setChatFollow({
        workspaceId, target: { kind: "thread", threadId }, state: "following" });
    }, { workspaceId: LINK_WORKSPACE_ID, threadId: postThreadId });
    await page.getByTestId("chats-feed-link").click();
    const home = page.locator('[data-testid="chats-personal-feed"][data-variant="page"]');
    const feedRow = (body: string) => home.getByTestId("chats-feed-item").filter({ hasText: body });
    await expect(feedRow(SAID.linkAgentComment)).toBeVisible();
    expect(await spokenMarks(feedRow(SAID.linkAgentComment))).toEqual(["agent", "link holder"]);
    expect(await spokenMarks(feedRow(SAID.linkHolderComment))).toEqual(["link holder"]);
    await page.mouse.move(0, 0);
    await shoot(page, "link-marks-feed");

    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([owner?.close()]);
    cleanup.push(...await Promise.allSettled([relay?.stop(), proxy?.close()]));
    cleanup.push(...await Promise.allSettled([temp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      await test.info().attach("cleanup failures", { contentType: "text/plain",
        body: failures.map((result) => String(result.reason)).join("\n") });
      if (primaryFailure === undefined) throw new AggregateError(failures.map((result) => result.reason), "Link marks test cleanup failed.");
    }
  }
});

// About this conversation lists a file by its latest mention, and a link
// author's message carries no attachment the index reads. So About's link
// marks are shot from the states page's specimen of the real part.
test("@ui-audit link agent and link holder marks in About", async () => {
  test.setTimeout(120_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp, env: { DOHC_DEV_TOOLS: "1" } });
    const page = desktop.page;
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await page.evaluate(() => { window.location.hash = "#/dev/states"; });
    await expect(page.getByTestId("states-page")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      const specimen = page.getByTestId(`states-${theme}`)
        .locator('section[data-part="about-conversation-links"] > div > div')
        .filter({ hasText: "files mentioned last by a link agent and by a link holder" });
      const authors = (path: string) => specimen
        .locator(`[data-testid="about-conversation-link"][data-path="${path}"]`)
        .getByTestId("about-conversation-link-authors");
      await expect(authors("trip-plan/cabin.md")).toHaveText("Mentioned by agent link holder Claude Code");
      await expect(authors("trip-plan/dates.md")).toHaveText("Mentioned by link holder Wren");
      await expect(specimen.locator("[data-link-agent]")).toHaveCount(1);
      await specimen.scrollIntoViewIfNeeded();
      await waitForVisibleAnimations(page);
      await specimen.screenshot({ path: join(SHOT_DIR, `link-marks-about-${theme}.png`) });
    }
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

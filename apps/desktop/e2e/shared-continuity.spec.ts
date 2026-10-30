import { holdSystemClipboard } from "./helpers/systemClipboard";
import { activityPin, editorTabTestId, settingsNavPin } from "../src/testPins";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { test, expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { DohcDesktopBridge, EngineMomentRecord } from "../src/ipc/bridgeContract";
import { assertDesktopEngineHealthy, launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { readHistoryMoments } from "./helpers/history";
import { appliedServiceHostSeqs, liveDocumentFold, noticedRefusals, ownerAuditRecord, ownerEnrollment, ownerOutboxDeclarations, ownerSettlementState, ydocUpdateAuthors, type LiveAuditRecord } from "./helpers/engineDb";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa } from "./helpers/selfHostOnboarding";
import {
  activeWorkspace, createTempWorkspace, explorerRow, openHistoryView, openWorkspaceFromFirstRun,
  revealExplorerPath, waitForWorkspaceFile, writeWorkspaceFiles, type TempWorkspace,
} from "./helpers/workspace";

// One live document, start to finish, on a self-hosted server: real accounts,
// HTTPS from a test CA that every process verifies, and the native live host.
// The owner types, an agent edits through the dohc CLI, and the owner
// restarts. Once the server hosts the document, another agent edits through
// the CLI, and every desktop's history names that agent through a close, a
// restart and the restore. A second account opens the shared document on its own desktop and
// types. The owner and the agent see that edit. The owner stops that access and
// restores the document to before it, and the result survives a restart. The
// owner and the agent then continue the restored document, and a third account
// opens a new share, sees all of it, and edits. The stopped access stays ended.
// The owner then ends the new share while that recipient's last typing is
// still on its way, and the typing stays copyable on the recipient's desktop.
//
// The recipient's Markdown file is a snapshot. The owner's live document is the
// authority, so the recipient's disk is not asserted.

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

type Api = DohcDesktopBridge;

const PATH = "notes/plan.md";
const HIDDEN = "private/hidden.md";
const HIDDEN_TEXT = "Only the owner reads this.";
const HIDDEN_EDIT = "The owner changed this privately.";
const SEED = "# Trip plan\n\nThe agent drafts this line.\n\nThe person writes here.\n";
const H1 = "Human first edit.";
const A1 = "Agent revised this line.";
const R1 = "Recipient continued.";
const H2 = "Human continued after restore.";
const A2 = "Agent continued after restore.";
const R2 = "New recipient continued.";
const RP = "New recipient typed as access ended.";
const HA = "Agent edited while hosted.";
const AGENT = "trip-agent";
const HOSTED_AGENT = "trip-agent-hosted";
const NEXT_AGENT = "trip-agent-after-restore";
// The document is shared, so the pending warning goes on to say someone may change the same blocks.
const PENDING_EDIT_WARNING = "Saved locally. The shared file update is pending. Do not repeat this edit. " +
  "The edit is saved. Someone may be changing this document at the same moment, and a change they make to the " +
  "same blocks before your edit reaches them can still remove its text. Read the document to check it is there.";

const editor = (page: Page) => page.getByTestId("markdown-editor");
const saveState = (page: Page) => page.getByTestId("markdown-save-state");

/** A desktop window as the person sees it, for layout review. It stays in the local report. */
async function attachScreen(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  await testInfo.attach(name, { contentType: "image/png", body: await page.screenshot() });
}

/** A document workflow sends no Collection changes, so no notice in this window speaks of them. */
async function expectNoCollectionNotice(page: Page): Promise<void> {
  await expect(page.getByText(/Collection changes/)).toHaveCount(0);
}

async function cliRead(temp: TempWorkspace): Promise<string> {
  return (await runDohcCli(temp, ["document", "read", PATH])).stdout;
}

/** One agent edit through the CLI while the server hosts the document. An applied edit is never retried. */
async function hostedAgentEdit(temp: TempWorkspace, find: string, text: string, agent: string): Promise<"saved" | "saved locally, pending"> {
  const edited = await runDohcCli(temp, ["--json", "document", "edit", PATH, "--find", find, "--text", text, "--agent", agent]);
  expect(edited.stderr).toBe("");
  const result = JSON.parse(edited.stdout) as { warning?: string };
  expect(result).toMatchObject({ ok: true, path: PATH, changed: true });
  if (result.warning?.startsWith("Saved locally.")) {
    expect(result.warning).toBe(PENDING_EDIT_WARNING);
    return "saved locally, pending";
  }
  return "saved";
}

async function momentIds(page: Page, workspaceId: string, path: string): Promise<string[]> {
  const moments = await readHistoryMoments(page, workspaceId, path);
  if (moments === null) throw new Error("History is unavailable.");
  return moments.map(moment => moment.id);
}

// The last views ownerSettled compared, attached when the test fails so a
// failure says whether the agent's read or the settled file missed an edit.
// They hold only the fixture document and the fixed sentences.
let lastOwnerViews: unknown;

function describeView(view: PromiseSettledResult<string>, sentences: string[]) {
  return view.status === "fulfilled"
    ? { text: view.value, contains: Object.fromEntries(sentences.map(sentence => [sentence, view.value.includes(sentence)])) }
    : { error: view.reason instanceof Error ? view.reason.message : String(view.reason) };
}

/** The agent's read equals the settled file, which holds `present` and none of `absent`. */
async function ownerSettled(temp: TempWorkspace, present: string[], absent: string[] = []): Promise<boolean> {
  const [cli, disk] = await Promise.allSettled([cliRead(temp), readFile(join(temp.rootPath, PATH), "utf8")]);
  const sentences = [...present, ...absent];
  const settled = cli.status === "fulfilled" && disk.status === "fulfilled" && cli.value === disk.value &&
    present.every(text => disk.value.includes(text)) && absent.every(text => !disk.value.includes(text));
  lastOwnerViews = {
    checkedAt: new Date().toISOString(), present, absent,
    cli: describeView(cli, sentences), disk: describeView(disk, sentences),
    equal: cli.status === "fulfilled" && disk.status === "fulfilled" && cli.value === disk.value,
    // Whether the host's settlement never arrived, waits for the accepted
    // cursor, or waits for a retry. Counts only.
    ...(settled ? {} : { ownerSettlements: settlementState(temp) }),
  };
  if (cli.status === "rejected") throw cli.reason;
  if (disk.status === "rejected") throw disk.reason;
  return settled;
}

function settlementState(temp: TempWorkspace) {
  try { return ownerSettlementState(temp.rootPath); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function openDocument(page: Page, path = PATH): Promise<void> {
  const explorer = page.getByTestId(activityPin("explorer"));
  if ((await explorer.getAttribute("aria-current")) !== "page") await explorer.click();
  await revealExplorerPath(page, path);
  await explorerRow(page, path).click();
  // The engine session is live once the local editor's Edit toggle is gone.
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
  await expect(editor(page)).toBeVisible();
}

async function typeAfter(page: Page, anchor: string, text: string): Promise<void> {
  await editor(page).getByText(anchor).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

/**
 * A recipient's ended share: the banner says so without a Refresh, and the
 * document stays readable and nothing in it is editable. With no edit set
 * aside it shows the last live document; with one, it shows the saved file.
 * `text` must show, so a missing or empty document cannot pass.
 */
async function expectEndedShare(page: Page, text: string[]) {
  const banner = page.getByTestId("shared-view-banner");
  await expect(banner).toHaveAttribute("data-ended", "true", { timeout: 60_000 });
  await expect(banner).toContainText(/This share was ended/);
  await expect(page.getByTestId("shared-view-refresh")).toHaveCount(0);
  const document = page.getByTestId("view-markdown");
  await expect(document).toBeVisible();
  await expect(document.getByTestId("page-title")).toHaveAttribute("readonly", "");
  for (const line of text) await expect(document).toContainText(line);
  await expect(page.getByTestId("file-inspector").locator('[contenteditable="true"]')).toHaveCount(0);
  return document;
}

async function openSharedRestore(page: Page) {
  await openHistoryView(page);
  const moment = page.locator(`[data-testid="engine-moment-open"][data-moment-path="${PATH}"]`).first();
  await expect(moment).toBeVisible({ timeout: 60_000 });
  await moment.click();
  await expect(page.getByTestId("engine-moment-diff-page")).toBeVisible();
  await page.getByTestId("engine-diff-more").click();
  await page.getByTestId("engine-diff-shared-restore").click();
  const dialog = page.getByTestId("owner-restore-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The owner's restore review lists exactly these recipients as holding edit access. */
async function expectActiveAccess(page: Page, recipients: string[]): Promise<void> {
  const dialog = await openSharedRestore(page);
  if (recipients.length) {
    await expect(dialog.getByLabel("Access to stop").locator('option:not([value=""])')).toHaveText(recipients, { timeout: 60_000 });
  } else {
    await expect(dialog.getByText("No active edit access is available for this file.")).toBeVisible({ timeout: 60_000 });
  }
  await dialog.getByRole("button", { name: "Close" }).click();
}

/** Shares `paths` with Edit and waits until the server hosts `path` live. */
async function shareForEdit(page: Page, workspaceId: string, recipientEmail: string, paths = [PATH], path = PATH) {
  const created = await page.evaluate(({ workspaceId, recipientEmail, paths }) =>
    (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({ workspaceId, recipientEmail, paths, access: "edit" }),
  { workspaceId, recipientEmail, paths });
  await expect.poll(async () => {
    const live = await page.evaluate(workspaceId =>
      (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), workspaceId);
    return live.documents.find(document => document.path === path)?.status;
  }, { timeout: 120_000, intervals: [1_000] }).toBe("ready");
  return created;
}

/** The owner opens their workspace, connects a new account to the server, and turns on sync. */
async function connectAndSync(owner: LaunchedDesktopApp, temp: TempWorkspace, approvalPage: Page, origin: string,
  server: Awaited<ReturnType<typeof startSelfHostOnboardingStack>>["account"], account: { email: string; password: string; name: string }) {
  const opened = await openWorkspaceFromFirstRun(owner.page, temp);
  await owner.page.getByTestId(activityPin("settings")).click();
  await owner.page.getByTestId(settingsNavPin("cloud")).click();
  await owner.page.getByTestId("settings-cloud-connect").click();
  await expect(owner.page.getByTestId("cloud-sync-panel")).toBeVisible();
  const approval = await openDesktopApproval(owner, approvalPage, origin);
  await createVerifiedAccount(approvalPage, server, account, approval);
  await approveDesktop(approvalPage, account);
  await expect(owner.page.getByTestId("settings-row-account")).toContainText(account.email);
  const syncSwitch = owner.page.getByRole("switch", { name: "Sync this workspace" });
  await syncSwitch.click();
  // The switch shows on from the click. The workspace code shows only once
  // main has enabled sync.
  await expect(owner.page.getByTestId("cloud-sync-code")).toBeVisible();
  await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
  await owner.page.keyboard.press("Escape");
  return opened;
}

/** A recipient opens the share on their own desktop, connecting their account first, and opens the document. */
async function openShare(recipient: LaunchedDesktopApp, temp: TempWorkspace, approvalPage: Page, origin: string,
  account: { email: string; password: string }, shareCode: string, path = PATH): Promise<string> {
  const page = recipient.page;
  await page.getByTestId("first-run-open-share").click();
  await page.getByTestId("open-share-code").fill(shareCode);
  await page.getByTestId("open-share-choose-folder").click();
  // Opening without an account asks the person to connect one first.
  await page.getByTestId("open-share-start").click();
  await openDesktopApproval(recipient, approvalPage, origin);
  await approveDesktop(approvalPage, account);
  // The sign-in panel leaves only once the desktop holds the session.
  // Before that, the button reads Open share too, and pressing it only
  // reopens the panel.
  await expect(page.locator("#open-share-sign-in-description")).toHaveCount(0, { timeout: 60_000 });
  const open = page.getByTestId("open-share-start");
  await expect(open).toHaveText("Open share");
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 60_000 });
  const shared = await activeWorkspace(page, temp.rootPath);
  await waitForWorkspaceFile(page, shared.workspaceId, path);
  const listed = await page.evaluate(workspaceId =>
    (window as unknown as { dohcDesktop: Api }).dohcDesktop.listWorkspaceFiles({ workspaceId }), shared.workspaceId);
  expect(listed.files.map(file => file.path).filter(path => path.startsWith("private/"))).toEqual([]);
  expect(existsSync(join(temp.rootPath, HIDDEN))).toBe(false);
  await openDocument(page, path);
  await expect(explorerRow(page, "private")).toHaveCount(0);
  return shared.workspaceId;
}

// Holds main's handler for one desktop's editor updates behind a gate, as in
// workspace-agent-documents.spec.ts. Electron 43 looks the handler up in
// ipcMain._invokeHandlers on each invoke (lib/browser/ipc-dispatch.ts), so the
// swap holds every update the editor sends. Release puts the original back
// and lets the held calls through it. The state counts the calls and keeps
// their outcomes, not their bytes.
type InvokeHandler = (...args: unknown[]) => unknown;
type HeldOutcome = { accepted: boolean | null; reason: string | null } | { error: string };
interface HeldUpdates { entered: number; settled: number; outcomes: HeldOutcome[]; released: boolean }
type HeldGate = { state: HeldUpdates; release(): void };

async function holdEditorUpdates(desktop: LaunchedDesktopApp): Promise<void> {
  await desktop.app.evaluate(({ ipcMain }) => {
    const scope = globalThis as { __dohcHeldEditorUpdates?: HeldGate };
    if (scope.__dohcHeldEditorUpdates && !scope.__dohcHeldEditorUpdates.state.released) throw new Error("editor updates are already held");
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })._invokeHandlers;
    const channel = "desktop:engine-ydoc-apply-update";
    const original = handlers.get(channel);
    if (!original) throw new Error("main has no editor update handler");
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const state: HeldUpdates = { entered: 0, settled: 0, outcomes: [], released: false };
    const held: InvokeHandler = async (...args) => {
      state.entered += 1;
      await gate;
      try {
        const result = await original(...args) as { accepted?: boolean; reason?: string } | undefined;
        state.outcomes.push({ accepted: result?.accepted ?? null, reason: result?.reason ?? null });
        return result;
      } catch (error) {
        state.outcomes.push({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        state.settled += 1;
      }
    };
    handlers.set(channel, held);
    scope.__dohcHeldEditorUpdates = { state, release() {
      if (state.released) return;
      state.released = true;
      // Put back only this gate's wrapper, and open the gate either way.
      const ours = handlers.get(channel) === held;
      if (ours) handlers.set(channel, original);
      open();
      if (!ours) throw new Error("the editor update handler changed while held");
    } };
  });
}

async function heldEditorUpdates(desktop: LaunchedDesktopApp): Promise<HeldUpdates | null> {
  return desktop.app.evaluate(() => (globalThis as { __dohcHeldEditorUpdates?: HeldGate }).__dohcHeldEditorUpdates?.state ?? null);
}

async function releaseEditorUpdates(desktop: LaunchedDesktopApp): Promise<void> {
  await desktop.app.evaluate(() => {
    const gate = (globalThis as { __dohcHeldEditorUpdates?: HeldGate }).__dohcHeldEditorUpdates;
    if (!gate) throw new Error("editor updates are not held");
    gate.release();
  });
}

/**
 * The set-aside drafts this window stored for the document, read from the
 * renderer's store (orphanedDraftStorage.ts). A draft still carries the
 * recovery marker until the projection refines it to Markdown.
 */
async function storedDrafts(page: Page, workspaceId: string): Promise<{ id: number; text: string; refined: boolean }[]> {
  return page.evaluate(({ workspaceId, path }) => {
    const drafts: { id: number; text: string; refined: boolean }[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("dohc-set-aside-drafts:")) continue;
      const row = JSON.parse(localStorage.getItem(key) ?? "null") as { id: number; workspaceId: string; path: string; text: string } | null;
      if (row?.workspaceId === workspaceId && row.path === path) {
        drafts.push({ id: row.id, text: row.text, refined: !row.text.includes("dohc-ydoc-recovery-v1") });
      }
    }
    return drafts;
  }, { workspaceId, path: PATH });
}

type Authors = EngineMomentRecord["authors"];
interface IntroducingMoment { id: string; momentOrder: number; origin: string; listed: Authors; authors: Authors }

/** The earliest moment of the document whose change wrote `text`, with the authors its list row and its detail report. Null until history records it. */
async function momentIntroducing(page: Page, workspaceId: string, text: string): Promise<IntroducingMoment | null> {
  const rows = await readHistoryMoments(page, workspaceId, PATH);
  if (rows === null) return null;
  return page.evaluate(async ({ workspaceId, rows, text }) => {
    const bridge = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
    for (const row of rows.sort((a, b) => a.momentOrder - b.momentOrder)) {
      const { moment } = await bridge.readEngineMoment({ workspaceId, momentId: row.id });
      if (moment?.afterText?.includes(text) && !moment.beforeText?.includes(text)) {
        return { id: row.id, momentOrder: row.momentOrder, origin: moment.origin, listed: row.authors, authors: moment.authors };
      }
    }
    return null;
  }, { workspaceId, rows, text });
}

type HostedEvidence = ReturnType<Awaited<ReturnType<typeof startSelfHostOnboardingStack>>["hostedAgentEvidence"]>;
interface AcceptedDeclaration { change: HostedEvidence["relay"][number]; audit: LiveAuditRecord }

type Declaration = { agentId: string; agentName?: string; onBehalfOf: string | null; depth: number };
const admittedAgent = (snapshot: LiveAuthorSnapshot): Declaration => {
  const agent = snapshot.find(author => author.kind === "agent");
  if (!agent || agent.kind !== "agent") throw new Error("Accepted snapshot has no agent.");
  return {...agent, onBehalfOf: agent.onBehalfOf ?? null, depth: agent.depth ?? 0};
};
// How history names the agent a change declared. Depth 0 and no principal are
// the defaults history leaves out.
const declaredAuthor = (declaration: Declaration) => expect.objectContaining({
  kind: "agent", agentId: declaration.agentId,
  ...(declaration.agentName === undefined ? {} : {agentName: declaration.agentName}),
  ...(declaration.onBehalfOf === null ? {} : { onBehalfOf: declaration.onBehalfOf }),
  ...(declaration.depth > 0 ? { depth: declaration.depth } : {}),
});

/** The moment that wrote `text` names the declared agent, in its list row and its detail alike. */
async function expectDeclaredMoment(page: Page, workspaceId: string, text: string, declaration: Declaration): Promise<IntroducingMoment> {
  let moment: IntroducingMoment | null | undefined;
  try {
    await expect.poll(async () => (moment = await momentIntroducing(page, workspaceId, text))?.authors ?? [], { timeout: 60_000, intervals: [1_000] })
      .toContainEqual(declaredAuthor(declaration));
  } catch (error) {
    const evidence = await readHistoryMoments(page, workspaceId, PATH).then(rows => page.evaluate(async ({ workspaceId, path, text, rows }) => {
      const bridge = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
      if (rows === null) return { workspaceId, path, historyReady: false };
      const details = [];
      for (const row of rows.slice(0, 8)) {
        const { moment } = await bridge.readEngineMoment({ workspaceId, momentId: row.id });
        details.push({ id: row.id, momentOrder: row.momentOrder, detailExists: moment !== null,
          afterContains: moment?.afterText?.includes(text) ?? false,
          beforeContains: moment?.beforeText?.includes(text) ?? false,
          listed: row.authors, authors: moment?.authors ?? null });
      }
      return { workspaceId, path, historyReady: true, pathRowCount: rows.length, details };
    }, { workspaceId, path: PATH, text, rows })).catch(cause => ({ error: cause instanceof Error ? cause.message : String(cause) }));
    await test.info().attach(`declared agent history ${declaration.agentId}`, {
      contentType: "application/json", body: JSON.stringify(evidence, null, 2),
    }).catch(() => undefined);
    throw error;
  }
  expect(moment!.listed).toEqual(moment!.authors);
  return moment!;
}

/**
 * The earliest moment of the document whose change wrote `text`, with the
 * authors its list row and its detail report, and the History label of the
 * person `humanId` among them. A moment with one author labels it in
 * `liveAuthorName`; a moment with several labels each author at its own
 * position in `authorLabels`. Null until history records the moment.
 */
async function recipientCredit(page: Page, workspaceId: string, text: string, humanId: string) {
  const rows = await readHistoryMoments(page, workspaceId, PATH);
  if (rows === null) return null;
  return page.evaluate(async ({ workspaceId, rows, text, humanId }) => {
    const bridge = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
    for (const row of rows.sort((a, b) => a.momentOrder - b.momentOrder)) {
      const { moment } = await bridge.readEngineMoment({ workspaceId, momentId: row.id });
      if (!moment?.afterText?.includes(text) || moment.beforeText?.includes(text)) continue;
      const index = (row.authors ?? []).findIndex(author => author.kind === "human" && author.humanId === humanId);
      const label = index < 0 ? null : (row.authors!.length === 1 ? row.liveAuthorName : row.authorLabels?.[index]) ?? null;
      return { id: row.id, momentOrder: row.momentOrder, listed: row.authors, authors: moment.authors, label };
    }
    return null;
  }, { workspaceId, rows, text, humanId });
}

test("@shared-continuity a live document keeps its person's and agent's work through restart, a recipient continues it, the owner restores it, and the work continues with a new recipient", async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const newRecipientTemp = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let owner: LaunchedDesktopApp | undefined;
  let recipient: LaunchedDesktopApp | undefined;
  let newRecipient: LaunchedDesktopApp | undefined;
  let ownerBrowser: BrowserContext | undefined;
  let recipientBrowser: BrowserContext | undefined;
  let newRecipientBrowser: BrowserContext | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const launches: LaunchedDesktopApp[] = [];
  const launch = async (temp: TempWorkspace) => {
    const app = await launchDesktopApp({ workspace: temp, env: stack!.trustEnv });
    launches.push(app);
    return app;
  };
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-proof-${randomUUID()}`, name: "Owner proof" };
  const recipientAccount = { email: `recipient-${randomUUID()}@example.test`, password: `Recipient-proof-${randomUUID()}`, name: "Recipient proof" };
  const newRecipientAccount = { email: `new-recipient-${randomUUID()}@example.test`, password: `New-recipient-proof-${randomUUID()}`, name: "New recipient proof" };
  const accountId = async (email: string) =>
    (await stack!.account.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]!.id;
  // The hosted agent edits' accepted changes and the moments that show them,
  // kept for the report.
  let ownerWorkspaceId: string | undefined;
  let hosted: AcceptedDeclaration | undefined;
  let next: AcceptedDeclaration | undefined;
  const provenance: Record<string, IntroducingMoment> = {};
  // The owner document's compaction marker before and after its tab closed.
  let foldEvidence: unknown;
  // Counts from the last check of a declared change's acceptance.
  let lastAcceptance: unknown;
  let lastEnrollment: unknown;
  const enrollments: unknown[] = [];
  const waitForOwnerEnrollment = async (page: Page, temp: TempWorkspace, workspaceId: string, afterFence?: number) => {
    const phase = afterFence === undefined ? "initial" : "post-restore";
    await expect.poll(async () => {
      const live = await page.evaluate(workspaceId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), workspaceId);
      const status = live.documents.find(document => document.path === PATH)?.status ?? null;
      const check = {
        phase, checkedAt: new Date().toISOString(), status, afterFence,
        expected: null as ReturnType<NonNullable<typeof stack>["ownerLiveBinding"]>,
        actual: null as ReturnType<typeof ownerEnrollment>,
      };
      lastEnrollment = check;
      // The bridge keeps binding coordinates in main. The fixture relay read
      // supplies those coordinates; bridge readiness remains required.
      check.expected = stack!.ownerLiveBinding(workspaceId, PATH);
      check.actual = check.expected && ownerEnrollment(temp.rootPath, check.expected.binding);
      const { expected, actual } = check;
      return status === "ready" && expected !== null && actual !== null &&
        (afterFence === undefined || expected.binding.restoreFenceGeneration > afterFence) &&
        isDeepStrictEqual(actual.binding, expected.binding) &&
        actual.relayDatabaseNamespace === expected.relayDatabaseNamespace;
    }, { message: `The owner's ${phase} session enrolled in the exact ready host binding.`, timeout: 120_000, intervals: [1_000] }).toBe(true);
    enrollments.push(lastEnrollment);
    await testInfo.attach(`owner enrollment ${phase}`, { contentType: "application/json", body: JSON.stringify(lastEnrollment, null, 2) });
  };
  const ownerAudit = (deliveryId: string) => ownerAuditRecord(ownerTemp.rootPath, deliveryId);
  /** The one accepted change that declared `agentId`, as the relay journaled it, the service host accepted and audited it, and the owner imported that audit. */
  const acceptedDeclaration = async (workspaceId: string, agentId: string): Promise<AcceptedDeclaration> => {
    const read = () => stack!.hostedAgentEvidence(workspaceId, PATH, agentId);
    await expect.poll(() => {
      const { relay, host, journal } = read();
      const imported = relay.length === 1 && ownerAudit(relay[0]!.deliveryId) !== null;
      // Where the change stopped: the owner's queue, the relay journal, the host audit or the owner's import.
      lastAcceptance = { agentId, checkedAt: new Date().toISOString(), ownerOutbox: ownerOutboxDeclarations(ownerTemp.rootPath),
        journal, declaredChanges: relay.length, hostAudits: host.filter(copy => copy.audit).length, ownerImported: imported };
      return imported && host.some(copy => copy.audit);
    }, { message: `The server accepted, audited and returned one change that declared ${agentId}.`, timeout: 60_000, intervals: [1_000] }).toBe(true);
    const { relay: [change], host } = read();
    const ownerId = await accountId(ownerAccount.email);
    // The authority is the authenticated owner; the agent is only declared.
    expect(change).toMatchObject({ principalKind: "owner", principalId: ownerId });
    expect(change!.authorSnapshot).toContainEqual({kind: "human", humanId: ownerId, humanName: ownerAccount.name});
    expect(change!.authorSnapshot).toContainEqual(expect.objectContaining({kind: "agent", agentId}));
    const accepted = {
      receipt: { deliveryId: change!.deliveryId, updateDigest: change!.updateDigest, journalCursor: change!.journalCursor },
      binding: { currentPath: PATH, restoreFenceGeneration: change!.restoreFenceGeneration },
      authority: { principalKind: "owner", principalId: ownerId },
    };
    const copies = host.filter(copy => copy.audit);
    expect(copies).toHaveLength(1);
    const { journalCursor, eventCount, evidenceDigest } = change!;
    expect(copies[0]!.accepted).toMatchObject([{ journalCursor, eventCount, evidenceDigest, accepted, authorSnapshot: change!.authorSnapshot }]);
    const audit = copies[0]!.audit!;
    expect(audit).toMatchObject({ deliveryId: change!.deliveryId, journalCursor, eventCount, evidenceDigest, accepted, authorSnapshot: change!.authorSnapshot });
    expect(ownerAudit(change!.deliveryId)).toEqual(audit);
    return { change: change!, audit };
  };
  // Accepted history folds into checkpoints; the owner's imported audit record must not change.
  const expectAuditKept = ({ change, audit }: AcceptedDeclaration) => expect(ownerAudit(change.deliveryId)).toEqual(audit);
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true, signal });
    const origin = stack.relayUrl;
    expect(new URL(origin).protocol).toBe("https:");
    trust = trustFixtureCa(stack.ca!.ca);
    ownerBrowser = await browser.newContext();
    await trust.route(ownerBrowser, origin);
    recipientBrowser = await browser.newContext();
    await trust.route(recipientBrowser, origin);
    newRecipientBrowser = await browser.newContext();
    await trust.route(newRecipientBrowser, origin);
    const recipientPage = await recipientBrowser.newPage();
    const newRecipientPage = await newRecipientBrowser.newPage();
    // The owner can share only with an account the server knows.
    await createVerifiedAccount(recipientPage, stack.account, recipientAccount);
    await createVerifiedAccount(newRecipientPage, stack.account, newRecipientAccount);

    const workspace = await test.step("the owner connects a workspace to the server", async () => {
      await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: SEED }, { path: HIDDEN, contents: `${HIDDEN_TEXT}\n` }]);
      owner = await launch(ownerTemp);
      const opened = await connectAndSync(owner, ownerTemp, await ownerBrowser!.newPage(), origin, stack!.account, ownerAccount);
      await waitForWorkspaceFile(owner.page, opened.workspaceId, PATH);
      ownerWorkspaceId = opened.workspaceId;
      return opened;
    });

    await test.step("the owner types and the agent edits through the CLI", async () => {
      const page = owner!.page;
      await openDocument(page);
      await typeAfter(page, "The person writes here.", ` ${H1}`);
      await expect(saveState(page)).toHaveAttribute("data-state", "saved");
      await waitForCliEndpoint(ownerTemp.homeDir);
      await expect.poll(() => cliRead(ownerTemp), { timeout: 30_000 }).toContain(H1);
      const edited = await runDohcCli(ownerTemp, ["--json", "document", "edit", PATH, "--find", "The agent drafts this line.", "--text", A1, "--agent", AGENT]);
      expect(JSON.parse(edited.stdout)).toMatchObject({ ok: true, path: PATH, changed: true });
      await expect(editor(page)).toContainText(A1);
      await expect(saveState(page)).toHaveAttribute("data-state", "saved");
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1]), { timeout: 30_000 }).toBe(true);
      const authors = ydocUpdateAuthors(ownerTemp.rootPath);
      expect(authors).toContainEqual({ actorOriginId: AGENT, actorKind: "agent" });
      expect(authors.some(author => author.actorKind === "human")).toBe(true);
    });

    // The share will leave this file out. Its history must hold a moment, so a
    // recipient has a real moment ID to guess.
    await test.step("the owner changes the private file and history records it", async () => {
      const edited = await runDohcCli(ownerTemp, ["--json", "document", "edit", HIDDEN, "--find", HIDDEN_TEXT, "--text", `${HIDDEN_TEXT} ${HIDDEN_EDIT}`]);
      expect(JSON.parse(edited.stdout)).toMatchObject({ ok: true, path: HIDDEN, changed: true });
      await expect(async () => {
        expect(await momentIds(owner!.page, workspace.workspaceId, HIDDEN)).not.toEqual([]);
      }).toPass({ timeout: 30_000 });
    });

    await test.step("both edits survive the owner's restart", async () => {
      await owner!.close();
      owner = undefined;
      owner = await launch(ownerTemp);
      expect((await openWorkspaceFromFirstRun(owner.page, ownerTemp)).workspaceId).toBe(workspace.workspaceId);
      await waitForWorkspaceFile(owner.page, workspace.workspaceId, PATH);
      await waitForCliEndpoint(ownerTemp.homeDir);
      await openDocument(owner.page);
      await expect(editor(owner.page)).toContainText(H1);
      await expect(editor(owner.page)).toContainText(A1);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1]), { timeout: 30_000 }).toBe(true);
      const status = await owner.page.evaluate(workspaceId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudStatus({ workspaceId }), workspace.workspaceId);
      expect(status).toMatchObject({ connected: true, email: ownerAccount.email, relayUrl: origin, workspaceSynced: true });
    });

    const share = await test.step("the owner shares the document with Edit and the server hosts it live", () =>
      shareForEdit(owner!.page, workspace.workspaceId, recipientAccount.email));

    await test.step("an agent edits through the CLI while the server hosts the document, and history names it", async () => {
      const page = owner!.page;
      await waitForOwnerEnrollment(page, ownerTemp, workspace.workspaceId);
      testInfo.annotations.push({ type: "hosted agent edit", description: await hostedAgentEdit(ownerTemp, A1, `${A1} ${HA}`, HOSTED_AGENT) });
      await expect.poll(() => cliRead(ownerTemp), { timeout: 30_000 }).toContain(HA);
      await expect(editor(page)).toContainText(HA);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA]), { timeout: 60_000 }).toBe(true);
      hosted = await acceptedDeclaration(workspace.workspaceId, HOSTED_AGENT);
      provenance.hostedOwner = await expectDeclaredMoment(page, workspace.workspaceId, HA, admittedAgent(hosted.change.authorSnapshot));
    });

    await test.step("closing the owner's document keeps the hosted agent as the author of its change", async () => {
      const page = owner!.page;
      const before = liveDocumentFold(ownerTemp.rootPath, PATH);
      foldEvidence = { before };
      // A replicated document with updates its snapshot does not cover yet, so
      // the close has something to fold.
      expect(before).toMatchObject({ regime: "replicated" });
      expect(before!.head).toBeGreaterThan(before!.snapshot);
      const tab = page.getByTestId(editorTabTestId(PATH));
      await tab.hover();
      await tab.getByRole("button", { name: /^Close / }).click();
      await expect(tab).toHaveCount(0);
      // Closing the last session of a replicated document compacts it: a
      // snapshot row covers the head it had, and the updates it folded are gone.
      await expect.poll(() => {
        const after = liveDocumentFold(ownerTemp.rootPath, PATH);
        foldEvidence = { before, after };
        return after !== null && after.snapshot >= before!.head && after.snapshotRow === after.snapshot && after.updatesAtOrBelowSnapshot === 0;
      }, { message: "The owner's tab close compacted the document.", timeout: 30_000, intervals: [500] }).toBe(true);
      await openDocument(page);
      await expect(editor(page)).toContainText(HA);
      provenance.hostedClosed = await expectDeclaredMoment(page, workspace.workspaceId, HA, admittedAgent(hosted!.change.authorSnapshot));
      expect(provenance.hostedClosed).toEqual(provenance.hostedOwner);
      expectAuditKept(hosted!);
    });

    await test.step("the hosted agent's attribution survives the owner's restart", async () => {
      await owner!.close();
      owner = undefined;
      owner = await launch(ownerTemp);
      await openWorkspaceFromFirstRun(owner.page, ownerTemp);
      await waitForCliEndpoint(ownerTemp.homeDir);
      await openDocument(owner.page);
      await expect(editor(owner.page)).toContainText(HA);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA]), { timeout: 30_000 }).toBe(true);
      provenance.hostedRestarted = await expectDeclaredMoment(owner.page, workspace.workspaceId, HA, admittedAgent(hosted!.change.authorSnapshot));
      expect(provenance.hostedRestarted).toEqual(provenance.hostedOwner);
      expectAuditKept(hosted!);
    });

    await test.step("the recipient opens the share on their own desktop, sees who wrote it, and continues the document", async () => {
      recipient = await launch(recipientTemp);
      const recipientWorkspaceId = await openShare(recipient, recipientTemp, recipientPage, origin, recipientAccount, share.shareCode);
      const page = recipient.page;
      await expect(editor(page)).toContainText(H1);
      await expect(editor(page)).toContainText(A1);
      await expect(editor(page)).toContainText(HA);
      provenance.hostedRecipient = await expectDeclaredMoment(page, recipientWorkspaceId, HA, admittedAgent(hosted!.change.authorSnapshot));
      // The share holds one file: no history of the hidden one, even by the owner's moment IDs.
      await expect(async () => {
        expect(await momentIds(page, recipientWorkspaceId, HIDDEN)).toEqual([]);
      }).toPass({ timeout: 30_000 });
      let guessed: string[] = [];
      await expect(async () => {
        guessed = await momentIds(owner!.page, workspace.workspaceId, HIDDEN);
        expect(guessed.length).toBeGreaterThan(0);
      }).toPass({ timeout: 30_000 });
      for (const momentId of guessed) {
        expect(await page.evaluate(payload =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.readEngineMoment(payload), { workspaceId: recipientWorkspaceId, momentId })).toEqual({ moment: null });
      }
      await typeAfter(page, H1, ` ${R1}`);
      // The recipient session reports host acceptance without a local artifact.
      await expect(saveState(page)).toHaveAttribute("data-state", "saved-to-host", { timeout: 60_000 });
      await expectNoCollectionNotice(page);
    });

    await test.step("the idle owner's editor and the agent see the recipient's edit", async () => {
      await expect(editor(owner!.page)).toContainText(R1, { timeout: 60_000 });
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, R1]), { timeout: 60_000 }).toBe(true);
      // The owner's History credits the recipient's change to the account and
      // name the server admitted for their desktop's edit.
      const page = owner!.page;
      const recipientUserId = await accountId(recipientAccount.email);
      const admitted = { kind: "human", humanId: recipientUserId, humanName: recipientAccount.name, relayConfirmed: true };
      let credit: Awaited<ReturnType<typeof recipientCredit>> | undefined;
      try {
        await expect.poll(async () => (credit = await recipientCredit(page, workspace.workspaceId, R1, recipientUserId))?.authors ?? [],
          { timeout: 60_000, intervals: [1_000] }).toContainEqual(admitted);
      } finally {
        await testInfo.attach("owner History recipient credit", { contentType: "application/json",
          body: JSON.stringify({ admitted, credit }, null, 2) }).catch(() => undefined);
      }
      expect(credit!.listed).toEqual(credit!.authors);
      expect(credit!.label).toBe(recipientAccount.name);
      // The recipient's credit leaves the hosted agent's credit in place.
      expect(await expectDeclaredMoment(page, workspace.workspaceId, HA, admittedAgent(hosted!.change.authorSnapshot))).toEqual(provenance.hostedOwner);
      await openHistoryView(page);
      await expect(page.locator(`[data-testid="engine-moment-open"][data-moment-id="${credit!.id}"]`))
        .toContainText(recipientAccount.name, { timeout: 60_000 });
      await attachScreen(testInfo, page, "owner History names the recipient");
    });

    await test.step("the owner stops the recipient's access and restores the document to before their edit", async () => {
      const page = owner!.page;
      const recipientUserId = await accountId(recipientAccount.email);
      const dialog = await openSharedRestore(page);
      // Restore names the recipient by their account email.
      const recipientLabel = recipientAccount.email;
      const access = dialog.getByLabel("Access to stop");
      await expect(access.locator("option", { hasText: recipientLabel })).toHaveCount(1, { timeout: 60_000 });
      await access.selectOption({ label: recipientLabel });
      // Restore to the accepted change just before the recipient's first edit,
      // which keeps the owner's and agent's work.
      const point = stack!.acceptedCursorBefore(workspace.workspaceId, PATH, recipientUserId);
      const pointSelect = dialog.getByLabel("Shared restore point");
      // A choice says when and who made the change, never an internal change
      // number. Its value stays the exact accepted cursor.
      await expect(pointSelect.locator(`option[value="${point}"]`)).toHaveText(/ · Owner( \(\d+ of \d+\))?$/);
      await expect(pointSelect.locator("option", { hasText: /Change \d+/ })).toHaveCount(0);
      await pointSelect.selectOption({ value: String(point) });
      await attachScreen(testInfo, page, "restore choices");
      await dialog.getByRole("button", { name: "Review affected access" }).click();
      await expect(dialog.getByRole("heading", { name: "Stop access before restoring?" })).toBeVisible();
      await expect(dialog.getByRole("listitem").filter({ hasText: recipientLabel })).toHaveCount(1);
      await attachScreen(testInfo, page, "restore stop access");
      // The recipient can still edit, so read-only afterwards proves the stop.
      await expect(saveState(recipient!.page)).toHaveAttribute("data-state", "saved-to-host");
      await expect(editor(recipient!.page)).toHaveAttribute("contenteditable", "true");
      await dialog.getByRole("button", { name: "Stop access" }).click();
      const current = dialog.getByLabel("Current file before restore");
      await expect(current).toBeVisible({ timeout: 60_000 });
      expect(await current.inputValue()).toContain(R1);
      const restored = await dialog.getByLabel("File after restore").inputValue();
      expect(restored).toContain(H1);
      expect(restored).toContain(A1);
      expect(restored).toContain(HA);
      expect(restored).not.toContain(R1);
      const restorePoint = dialog.getByText(/^Restore point:/);
      await expect(restorePoint).toHaveAttribute("data-journal-cursor", String(point));
      await expect(restorePoint).toHaveText(/ · Owner$/);
      await attachScreen(testInfo, page, "restore review before and after");
      // The review names the recipient by the same email, not an account ID.
      const removed = dialog.locator("details", { has: page.locator("summary", { hasText: /^Removed by this restore/ }) });
      await removed.locator("summary").first().click();
      await expect(removed).toContainText(recipientAccount.email);
      await expect(removed).not.toContainText(`Account ${recipientUserId}`);
      await attachScreen(testInfo, page, "restore review removed changes");
      await testInfo.attach("attribution", {
        contentType: "application/json",
        body: JSON.stringify({
          recipientUserId,
          ydocUpdateAuthors: ydocUpdateAuthors(ownerTemp.rootPath),
          sharedRestoreRemoved: await removed.innerText(),
          ownerHistory: await page.evaluate(async ({ workspaceId, path }) => {
            const history = await (window as unknown as { dohcDesktop: Api }).dohcDesktop.listEngineMoments({ workspaceId, limit: 50 });
            return "moments" in history ? { firstPage: history.moments.filter(moment => moment.path === path), more: history.nextCursor !== null } : history;
          }, { workspaceId: workspace.workspaceId, path: PATH }),
        }, null, 2),
      });
      await dialog.getByRole("button", { name: "Restore file" }).click();
      await expect(dialog.getByRole("heading", { name: "File restored" })).toBeVisible({ timeout: 60_000 });
      await dialog.getByRole("button", { name: "Close" }).click();
    });

    await test.step("the restore reaches the owner and the agent, and the recipient can no longer edit", async () => {
      await openDocument(owner!.page);
      await expect(editor(owner!.page)).not.toContainText(R1, { timeout: 60_000 });
      await expect(editor(owner!.page)).toContainText(H1);
      await expect(editor(owner!.page)).toContainText(A1);
      await expect(editor(owner!.page)).toContainText(HA);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA], [R1]), { timeout: 60_000 }).toBe(true);
      const page = recipient!.page;
      // The relay, the read-only document and the owner's access list prove
      // the stop. The save chip does not: the read-only view may show none.
      await expect.poll(() => page.evaluate(shareId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.getRelayReceivedShare({ shareId }), share.shareId), { timeout: 60_000 })
        .toMatchObject({ found: false });
      const document = await expectEndedShare(page, [H1, A1, HA]);
      await document.getByText(H1).click();
      await page.keyboard.type(" Typed after access stopped.");
      await expect(document).not.toContainText("Typed after access stopped.");
      await expectActiveAccess(owner!.page, []);
      // The recipient's edit saved before the stop, so nothing is set aside.
      await expect(page.getByTestId("orphaned-draft-notice")).toHaveCount(0);
    });

    await test.step("the restored document and the stopped access survive the owner's restart", async () => {
      await owner!.close();
      owner = undefined;
      owner = await launch(ownerTemp);
      await openWorkspaceFromFirstRun(owner.page, ownerTemp);
      await waitForCliEndpoint(ownerTemp.homeDir);
      await openDocument(owner.page);
      await expect(editor(owner.page)).toContainText(A1);
      await expect(editor(owner.page)).not.toContainText(R1);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA], [R1]), { timeout: 30_000 }).toBe(true);
      await expectActiveAccess(owner.page, []);
      expect(await expectDeclaredMoment(owner.page, workspace.workspaceId, HA, admittedAgent(hosted!.change.authorSnapshot))).toEqual(provenance.hostedOwner);
      expectAuditKept(hosted!);
    });

    await test.step("the owner types and the agent edits through the CLI after the restore", async () => {
      const page = owner!.page;
      await openDocument(page);
      await waitForOwnerEnrollment(page, ownerTemp, workspace.workspaceId, hosted!.change.restoreFenceGeneration);
      await typeAfter(page, H1, ` ${H2}`);
      // The server still hosts the document, so the owner's edit may finish as
      // saved locally or saved to the host. The settled-file check covers the disk.
      await expect(saveState(page)).toHaveAttribute("data-state", /^(saved|saved-to-host)$/, { timeout: 60_000 });
      await expect.poll(() => cliRead(ownerTemp), { timeout: 30_000 }).toContain(H2);
      testInfo.annotations.push({ type: "post-restore agent edit", description: await hostedAgentEdit(ownerTemp, A1, `${A1} ${A2}`, NEXT_AGENT) });
      await expect.poll(() => cliRead(ownerTemp), { timeout: 30_000 }).toContain(A2);
      await expect(editor(page)).toContainText(A2);
      await expect(saveState(page)).toHaveAttribute("data-state", /^(saved|saved-to-host)$/, { timeout: 60_000 });
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, H2, A2], [R1]), { timeout: 60_000 }).toBe(true);
      await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 60_000 });
      // The restore moved the document to a new binding, so the agent's
      // accepted change carries the higher restore fence.
      next = await acceptedDeclaration(workspace.workspaceId, NEXT_AGENT);
      expect(next.change.restoreFenceGeneration).toBeGreaterThan(hosted!.change.restoreFenceGeneration);
      provenance.nextOwner = await expectDeclaredMoment(page, workspace.workspaceId, A2, admittedAgent(next.change.authorSnapshot));
      expect(await expectDeclaredMoment(page, workspace.workspaceId, HA, admittedAgent(hosted!.change.authorSnapshot))).toEqual(provenance.hostedOwner);
      expectAuditKept(hosted!);
    });

    const newShare = await test.step("the owner shares the continued document with a new recipient", () =>
      shareForEdit(owner!.page, workspace.workspaceId, newRecipientAccount.email));

    const newRecipientWorkspaceId = await test.step("the new recipient sees the restored and continued document and edits it", async () => {
      newRecipient = await launch(newRecipientTemp);
      const sharedWorkspaceId = await openShare(newRecipient, newRecipientTemp, newRecipientPage, origin, newRecipientAccount, newShare.shareCode);
      const page = newRecipient.page;
      for (const text of [H1, A1, HA, H2, A2]) await expect(editor(page)).toContainText(text);
      await expect(editor(page)).not.toContainText(R1);
      // Both agents' changes reach the new recipient's history, before and after the restore.
      provenance.hostedNewRecipient = await expectDeclaredMoment(page, sharedWorkspaceId, HA, admittedAgent(hosted!.change.authorSnapshot));
      provenance.nextNewRecipient = await expectDeclaredMoment(page, sharedWorkspaceId, A2, admittedAgent(next!.change.authorSnapshot));
      await typeAfter(page, H2, ` ${R2}`);
      await expect(saveState(page)).toHaveAttribute("data-state", "saved-to-host", { timeout: 60_000 });
      await expect(editor(owner!.page)).toContainText(R2, { timeout: 60_000 });
      await expect.poll(() => cliRead(ownerTemp), { timeout: 60_000 }).toContain(R2);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, H2, A2, R2], [R1]), { timeout: 60_000 }).toBe(true);
      await expect(owner!.page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 60_000 });
      await expectNoCollectionNotice(page);
      return sharedWorkspaceId;
    });

    await test.step("the stopped recipient's access stays ended", async () => {
      const page = recipient!.page;
      expect(await page.evaluate(shareId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.getRelayReceivedShare({ shareId }), share.shareId)).toMatchObject({ found: false });
      // The window says the share ended without the person asking: the
      // document turning read-only made it ask the relay, and the relay said so.
      const document = await expectEndedShare(page, [H1, A1, HA]);
      await expect(document).not.toContainText(R2);
      // The saved edit stays in the owner's History, not in a set-aside draft.
      await expect(page.getByTestId("orphaned-draft-notice")).toHaveCount(0);
      await expectNoCollectionNotice(page);
      await attachScreen(testInfo, page, "stopped recipient");
      await expectActiveAccess(owner!.page, [newRecipientAccount.email]);
    });

    await test.step("the new recipient's unsaved typing stays copyable when the owner ends their share", async () => {
      await openDocument(owner!.page);
      const desktop = newRecipient!;
      const page = desktop.page;
      let drafts: Awaited<ReturnType<typeof storedDrafts>> = [];
      let copied: string | null = null;
      let failed = false;
      await holdEditorUpdates(desktop);
      try {
        // Main holds the editor's updates, so this typing is in the
        // recipient's editor and nowhere else when the share ends.
        await typeAfter(page, R2, ` ${RP}`);
        await expect(editor(page)).toContainText(`${R2} ${RP}`);
        await expect.poll(async () => (await heldEditorUpdates(desktop))?.entered ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
        expect(await heldEditorUpdates(desktop)).toMatchObject({ settled: 0, released: false });
        expect(await cliRead(ownerTemp)).not.toContain(RP);
        // The owner ends the share through the same call as Shared by me.
        await owner!.page.evaluate(shareId =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.revokeRelayShare({ shareId }), newShare.shareId);
        await expect.poll(async () => (await page.evaluate(shareId =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.getRelayReceivedShare({ shareId }), newShare.shareId)).found, { timeout: 60_000 })
          .toBe(false);
        const document = await expectEndedShare(page, [H1, A1, HA]);
        // Access ended while main still held the typing.
        expect(await heldEditorUpdates(desktop)).toMatchObject({ settled: 0, released: false });
        await document.getByText(H1).click();
        await page.keyboard.type(" Typed after the share ended.");
        await expect(document).not.toContainText("Typed after the share ended.");
        const notice = page.getByTestId("orphaned-draft-notice");
        await expect(notice).toHaveCount(1);
        await expect(notice).toContainText("This document became read-only. Copy your text to keep it.");
        await expect.poll(async () => {
          drafts = await storedDrafts(page, newRecipientWorkspaceId);
          return drafts.length === 1 && drafts[0]!.refined;
        }, { message: "The recipient's window stored one refined draft.", timeout: 30_000 }).toBe(true);
        const draft = drafts[0]!.text;
        for (const text of [H1, A1, HA, H2, A2, `${R2} ${RP}`]) expect(draft).toContain(text);
        expect(draft).not.toContain(R1);
        expect(draft).not.toContain("Typed after the share ended.");
        await holdSystemClipboard(testInfo, async (remainingMs) => {
          await desktop!.app.evaluate(({ clipboard }) => clipboard.writeText(""));
          await page.getByTestId("orphaned-draft-copy").click({ timeout: remainingMs() });
          // Chromium writes plain text with CRLF line endings on Windows.
          await expect.poll(async () => (copied = await desktop!.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, "\n"), { timeout: remainingMs() })
            .toBe(draft);
        });
        await attachScreen(testInfo, page, "new recipient's set-aside typing");
        await expect(editor(owner!.page)).not.toContainText(RP);
        await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, H2, A2, R2], [R1, RP]), { timeout: 60_000 }).toBe(true);
        await expectActiveAccess(owner!.page, []);
      } catch (error) {
        failed = true;
        const read = <T>(value: Promise<T>) => value.catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
        await testInfo.attach("new recipient held typing", { contentType: "application/json", body: JSON.stringify({
          gate: await read(heldEditorUpdates(desktop)),
          drafts: await read(storedDrafts(page, newRecipientWorkspaceId)),
          copied,
          shareFound: await read(page.evaluate(shareId =>
            (window as unknown as { dohcDesktop: Api }).dohcDesktop.getRelayReceivedShare({ shareId }).then(share => share.found), newShare.shareId)),
          // An ended share has no live editor, so these two can be empty while
          // the read-only document below still shows.
          editable: await read(editor(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("contenteditable")))),
          saveState: await read(saveState(page).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-state")))),
          ended: await read(page.getByTestId("shared-view-banner").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-ended")))),
          editDisabled: await read(page.getByTestId("markdown-edit-toggle").evaluateAll(nodes => nodes.map(node => (node as HTMLButtonElement).disabled))),
          documents: await read(page.getByTestId("view-markdown").count()),
          notices: await read(page.getByTestId("orphaned-draft-notice").allInnerTexts()),
          copyLabels: await read(page.getByTestId("orphaned-draft-copy").allInnerTexts()),
        }, null, 2) }).catch(() => undefined);
        throw error;
      } finally {
        // The gate opens before the step ends, so no close waits on it.
        await releaseEditorUpdates(desktop).catch(async (error: unknown) => {
          if (!failed) throw error;
          await testInfo.attach("held typing release failure", { contentType: "text/plain",
            body: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        });
      }
      // Main takes the held typing only now, after access ended, and refuses it.
      await expect.poll(async () => {
        const state = await heldEditorUpdates(desktop);
        return state !== null && state.released && state.settled === state.entered;
      }, { timeout: 30_000 }).toBe(true);
      const { outcomes } = (await heldEditorUpdates(desktop))!;
      expect(outcomes.length).toBeGreaterThan(0);
      for (const outcome of outcomes) expect(outcome).toMatchObject({ accepted: false });
      await expect(page.getByTestId("orphaned-draft-notice")).toHaveCount(1);
      expect(await storedDrafts(page, newRecipientWorkspaceId)).toEqual(drafts);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, H2, A2, R2], [R1, RP]), { timeout: 30_000 }).toBe(true);
    });

    await test.step("both hosted agents' attribution survives the owner's last restart", async () => {
      await owner!.close();
      owner = undefined;
      owner = await launch(ownerTemp);
      await openWorkspaceFromFirstRun(owner.page, ownerTemp);
      await waitForCliEndpoint(ownerTemp.homeDir);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, H2, A2, R2], [R1, RP]), { timeout: 30_000 }).toBe(true);
      expect(await expectDeclaredMoment(owner.page, workspace.workspaceId, HA, admittedAgent(hosted!.change.authorSnapshot))).toEqual(provenance.hostedOwner);
      expect(await expectDeclaredMoment(owner.page, workspace.workspaceId, A2, admittedAgent(next!.change.authorSnapshot))).toEqual(provenance.nextOwner);
      expectAuditKept(hosted!);
      expectAuditKept(next!);
    });
    await testInfo.attach("hosted agent provenance", { contentType: "application/json", body: JSON.stringify({ hosted, next, provenance, foldEvidence, enrollments }, null, 2) });

    for (const app of launches) {
      expect(app.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
      assertDesktopEngineHealthy(app.logs);
    }
  } catch (error) {
    bodyFailure = { error };
    // Attached before cleanup removes the workspace; the report keeps a copy.
    if (lastOwnerViews) {
      await testInfo.attach("last owner CLI and disk views", {
        contentType: "application/json", body: JSON.stringify(lastOwnerViews, null, 2),
      }).catch(() => undefined);
    }
    if (stack) {
      const relay = stack;
      const settlements = (() => {
        try { return relay.settlementEvidence(); }
        catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; }
      })();
      await testInfo.attach("server settlements", { contentType: "application/json", body: JSON.stringify(settlements, null, 2) })
        .catch(() => undefined);
      await testInfo.attach("relay output", { contentType: "text/plain", body: relay.relayOutput() })
        .catch(() => undefined);
      // Where each declared agent's change stopped, against the moments found so far.
      const declared = ownerWorkspaceId && [HOSTED_AGENT, NEXT_AGENT].map(agentId => {
        try { return { agentId, evidence: relay.hostedAgentEvidence(ownerWorkspaceId!, PATH, agentId) }; }
        catch (cause) { return { agentId, error: cause instanceof Error ? cause.message : String(cause) }; }
      });
      await testInfo.attach("hosted agent provenance", { contentType: "application/json", body: JSON.stringify({ lastAcceptance, declared, hosted, next, provenance, foldEvidence, enrollments, lastEnrollment }, null, 2) })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      newRecipientBrowser?.close(), recipientBrowser?.close(), ownerBrowser?.close(),
      newRecipient?.close(), recipient?.close(), owner?.close(),
    ]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([newRecipientTemp.cleanup(), recipientTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      const errors = [...new Set([...(bodyFailure ? [bodyFailure.error] : []), ...failures.map(result => result.reason)])];
      if (bodyFailure && errors.length === 1) throw bodyFailure.error;
      throw new AggregateError(errors, "Shared continuity cleanup failed.");
    }
  }
});

const NOTE = "docs/notes.md";
const NOTE_TEXT = "Nobody edits this note.";

/** Each settlement the relay logged as refused, as "<stage> <check>". */
const refusedSettlementChecks = (output: string) =>
  [...output.matchAll(/live settlement refused at (\w+): workspace [^,]+, settlement [^,]+, check ([a-z-]+)\./gu)]
    .map(([, stage, check]) => `${stage} ${check}`);

type LiveDelivery = Awaited<ReturnType<Api["getSyncStatus"]>>["ownerLiveDelivery"];
// One read of the owner's live editing, and when it was asked for.
type LiveEditingRead = { requestedAt: number; state: LiveDelivery | null | "unread"; reason: string | null };

// Each stretch in which the owner's live editing was not active, from the
// read that saw it leave to the read that saw it back, in ms from `from`.
function departureWindows(reads: LiveEditingRead[], from: number) {
  const windows: { from: number; to: number | null; states: LiveEditingRead["state"][]; reasons: string[] }[] = [];
  for (const read of reads) {
    const last = windows.at(-1);
    const open = last?.to === null ? last : undefined;
    if (read.state === "active") {
      if (open) open.to = read.requestedAt - from;
      continue;
    }
    const stretch = open ?? { from: read.requestedAt - from, to: null, states: [], reasons: [] };
    if (!open) windows.push(stretch);
    if (!stretch.states.includes(read.state)) stretch.states.push(read.state);
    if (read.reason !== null && !stretch.reasons.includes(read.reason)) stretch.reasons.push(read.reason);
  }
  return windows;
}

async function observeOwnerLiveEditing(page: Page, workspaceId: string): Promise<() => Promise<LiveEditingRead[]>> {
  await page.evaluate((workspaceId) => {
    const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
    const reads: LiveEditingRead[] = [];
    const pending = new Set<Promise<void>>();
    // Each read takes its place in the log when it is asked for, and its
    // state when it answers.
    const read = () => {
      const entry: LiveEditingRead = { requestedAt: Date.now(), state: "unread", reason: null };
      reads.push(entry);
      const done: Promise<void> = api.getSyncStatus({ workspaceId }).then((status) => {
        entry.state = status.ownerLiveDelivery ?? null;
        entry.reason = status.ownerLiveDeliveryReason ?? null;
      }, () => undefined).finally(() => pending.delete(done));
      pending.add(done);
    };
    api.onWorkspaceActivity((event) => {
      if (event.workspaceId === undefined || event.workspaceId === workspaceId) read();
    });
    read();
    Reflect.set(window, "ownerLiveEditing", { reads, pending });
  }, workspaceId);
  // Every read asked for so far, once each has answered, in the order asked.
  return () => page.evaluate(async () => {
    const { reads, pending } = Reflect.get(window, "ownerLiveEditing") as { reads: LiveEditingRead[]; pending: Set<Promise<void>> };
    while (pending.size) await Promise.all(pending);
    return reads;
  });
}

// The service activates at cursor 0. Runtime owner_publication tests cover
// changed nonzero cuts with a new owner's durable pending edits.
test("@self-host-activation-typing typing continues through self-host activation and reaches both people", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let owner: LaunchedDesktopApp | undefined;
  let liveEditingReads: (() => Promise<LiveEditingRead[]>) | undefined;
  let activationStartedAt: number | undefined;
  let updatesHeld = false;
  let lastSettled: unknown;
  let bodyFailure: { error: unknown } | undefined;
  const contexts: BrowserContext[] = [];
  const desktops: LaunchedDesktopApp[] = [];
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-proof-${randomUUID()}`, name: "Owner proof" };
  const recipientAccount = { email: `recipient-${randomUUID()}@example.test`, password: `Recipient-proof-${randomUUID()}`, name: "Recipient proof" };
  const during = "Typing while the server starts.";
  const continued = "Still typing after activation.";
  const reply = "The other person continues.";
  const attachJson = (name: string, value: unknown) =>
    testInfo.attach(name, { contentType: "application/json", body: JSON.stringify(value, null, 2) });
  const ownerNotices = async () => (await owner!.page.evaluate(() =>
    (window as unknown as { dohcDesktop: Api }).dohcDesktop.listNotices({}))).notices;
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true, signal });
    const origin = stack.relayUrl;
    trust = trustFixtureCa(stack.ca!.ca);
    const approvalPage = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      await trust!.route(context, origin);
      return context.newPage();
    };
    const recipientPage = await approvalPage();
    await createVerifiedAccount(recipientPage, stack.account, recipientAccount);
    await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: SEED }]);
    owner = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    desktops.push(owner);
    const { workspaceId } = await connectAndSync(owner, ownerTemp, await approvalPage(), origin, stack.account, ownerAccount);
    await waitForWorkspaceFile(owner.page, workspaceId, PATH);
    await openDocument(owner.page);
    liveEditingReads = await observeOwnerLiveEditing(owner.page, workspaceId);

    // Keep an editor update in flight across activation. This is a renderer
    // draft, not the durable native outbox covered by the runtime tests.
    await holdEditorUpdates(owner);
    updatesHeld = true;
    await typeAfter(owner.page, "The person writes here.", ` ${during}`);
    await expect.poll(async () => (await heldEditorUpdates(owner!))?.entered ?? 0).toBeGreaterThan(0);
    activationStartedAt = Date.now();
    const [share] = await Promise.all([
      shareForEdit(owner.page, workspaceId, recipientAccount.email),
      typeAfter(owner.page, during, ` ${continued}`),
    ]);
    const binding = stack.ownerLiveBinding(workspaceId, PATH);
    expect(binding).not.toBeNull();
    await expect.poll(() => binding && ownerEnrollment(ownerTemp.rootPath, binding.binding)?.acceptedCursor,
      { timeout: 60_000 }).toBe(0);
    expect(stack.livePublication(workspaceId, PATH).acceptedHead).toBe(0);
    const held = await heldEditorUpdates(owner);
    expect(held).toMatchObject({ settled: 0, released: false });
    await attachJson("typing held across cursor-zero activation", { checkedAt: new Date().toISOString(), binding, held });
    await expect(editor(owner.page)).toContainText(during);
    await expect(editor(owner.page)).toContainText(continued);
    await attachScreen(testInfo, owner.page, "owner keeps typing through activation");
    await releaseEditorUpdates(owner);
    updatesHeld = false;
    await expect.poll(async () => {
      const state = await heldEditorUpdates(owner!);
      return state !== null && state.settled === state.entered;
    }, { timeout: 60_000 }).toBe(true);

    const recipient = await launchDesktopApp({ workspace: recipientTemp, env: stack.trustEnv });
    desktops.push(recipient);
    await openShare(recipient, recipientTemp, recipientPage, origin, recipientAccount, share.shareCode);
    await expect(editor(recipient.page)).toContainText(during);
    await expect(editor(recipient.page)).toContainText(continued);
    await typeAfter(recipient.page, continued, ` ${reply}`);
    await expect(editor(owner.page)).toContainText(reply);
    await expect.poll(() => ownerSettled(ownerTemp, [during, continued, reply]), { timeout: 120_000 }).toBe(true);
    await expect(saveState(owner.page)).toHaveAttribute("data-state", "saved-to-host");
    await expect.poll(() => {
      const server = stack!.livePublication(workspaceId, PATH);
      const applied = appliedServiceHostSeqs(ownerTemp.rootPath, workspaceId);
      lastSettled = { checkedAt: new Date().toISOString(), server, applied };
      return server.acceptedHead > 0 && Object.keys(server.hostOrigins).length > 0 &&
        server.hosts.every(host => host.unpushed === 0) &&
        Math.max(...server.hosts.map(host => host.settledThrough)) >= server.acceptedHead &&
        isDeepStrictEqual(applied, server.hostOrigins);
    }, { timeout: 120_000, intervals: [1_000] }).toBe(true);
    // #2789: the owner refuses some of the service host's activation updates
    // with this reason. Every other refusal still fails the test.
    const refused = noticedRefusals(ownerTemp.rootPath, workspaceId);
    expect(refused.filter(row => row.reason !== "ordinary update has no native live admission")).toEqual([]);
    expect((await ownerNotices()).filter(notice => notice.kind === "sync-refusal" && !notice.refusalCoordinates?.every(coordinate =>
      "originId" in coordinate && refused.some(row => row.originId === coordinate.originId && row.originSeq === coordinate.originSeq)))).toEqual([]);
    expect(refusedSettlementChecks(stack.relayOutput())).toEqual([]);
    await attachScreen(testInfo, recipient.page, "both people's typing reached the shared note");
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    if (updatesHeld && owner) await releaseEditorUpdates(owner).catch(() => undefined);
    await attachJson("live settlement state", lastSettled ?? null).catch(() => undefined);
    const reads = await liveEditingReads?.().catch(() => undefined);
    await attachJson("owner live editing reads", reads ?? null).catch(() => undefined);
    await attachJson("owner live editing departures", reads && activationStartedAt !== undefined
      ? { from: "the owner starts sharing", unit: "ms", windows: departureWindows(reads, activationStartedAt) } : null).catch(() => undefined);
    if (owner) await ownerNotices().then(notices => attachJson("owner Notices at the end", notices)).catch(() => undefined);
    if (stack) await testInfo.attach("relay output", { contentType: "text/plain", body: stack.relayOutput() }).catch(() => undefined);
    const cleanup = await Promise.allSettled([...contexts.map(context => context.close()), ...desktops.map(desktop => desktop.close())]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([recipientTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length && !bodyFailure) throw new AggregateError(failures.map(result => result.reason), "Self-host activation cleanup failed.");
  }
});

// Two people open a shared note live on a self-hosted server, and nobody edits
// it. The server publishes its settlement of the note with its authors, so the
// owner's Notices holds no review row.
test("@self-host-live-review two people open a shared note live and its owner gets no review notice", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let owner: LaunchedDesktopApp | undefined;
  let lastSettled: unknown;
  let liveEditingReads: (() => Promise<LiveEditingRead[]>) | undefined;
  let openedShareAt: number | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const contexts: BrowserContext[] = [];
  const desktops: LaunchedDesktopApp[] = [];
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-proof-${randomUUID()}`, name: "Owner proof" };
  const recipientAccount = { email: `recipient-${randomUUID()}@example.test`, password: `Recipient-proof-${randomUUID()}`, name: "Recipient proof" };
  const ownerNotices = async () => (await owner!.page.evaluate(() =>
    (window as unknown as { dohcDesktop: Api }).dohcDesktop.listNotices({}))).notices;
  const attachJson = (name: string, value: unknown) =>
    testInfo.attach(name, { contentType: "application/json", body: JSON.stringify(value, null, 2) });
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true, signal });
    const origin = stack.relayUrl;
    trust = trustFixtureCa(stack.ca!.ca);
    const approvalPage = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      await trust!.route(context, origin);
      return context.newPage();
    };
    const recipientPage = await approvalPage();
    await createVerifiedAccount(recipientPage, stack.account, recipientAccount);

    await writeWorkspaceFiles(ownerTemp, [{ path: NOTE, contents: `# Notes\n\n${NOTE_TEXT}\n` }]);
    owner = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    desktops.push(owner);
    const { workspaceId } = await connectAndSync(owner, ownerTemp, await approvalPage(), origin, stack.account, ownerAccount);
    await waitForWorkspaceFile(owner.page, workspaceId, NOTE);
    await openDocument(owner.page, NOTE);

    const share = await shareForEdit(owner.page, workspaceId, recipientAccount.email, ["docs"], NOTE);
    const hosted = await ownerNotices();
    await attachJson("owner Notices once the server hosts the note", hosted);
    testInfo.annotations.push({ type: "owner review rows before the recipient opens the share",
      description: String(hosted.filter(notice => notice.kind === "sync-refusal").length) });
    testInfo.annotations.push({ type: "refused settlement checks before the recipient opens the share",
      description: refusedSettlementChecks(stack.relayOutput()).join(", ") || "none" });

    liveEditingReads = await observeOwnerLiveEditing(owner.page, workspaceId);

    const recipient = await launchDesktopApp({ workspace: recipientTemp, env: stack.trustEnv });
    desktops.push(recipient);
    openedShareAt = Date.now();
    await openShare(recipient, recipientTemp, recipientPage, origin, recipientAccount, share.shareCode, NOTE);
    await expect(editor(recipient.page)).toContainText(NOTE_TEXT);

    // Settled: the host settled everything the relay accepted for the note and
    // pushed it, and the owner applied every operation the host published.
    await expect.poll(() => {
      const server = stack!.livePublication(workspaceId, NOTE);
      const applied = appliedServiceHostSeqs(ownerTemp.rootPath, workspaceId);
      lastSettled = { checkedAt: new Date().toISOString(), server, applied };
      return Object.keys(server.hostOrigins).length > 0 &&
        server.hosts.every(host => host.unpushed === 0) &&
        Math.max(...server.hosts.map(host => host.settledThrough)) >= server.acceptedHead &&
        isDeepStrictEqual(applied, server.hostOrigins);
    }, { message: "The host settled and published the note, and its owner applied it.", timeout: 120_000, intervals: [1_000] }).toBe(true);
    expect((await ownerNotices()).filter(notice => notice.kind === "sync-refusal")).toEqual([]);
    expect(refusedSettlementChecks(stack.relayOutput())).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    // Every run keeps its evidence, attached before cleanup removes the stack.
    if (lastSettled) await attachJson("live settlement state", lastSettled).catch(() => undefined);
    const reads = await liveEditingReads?.().catch(() => undefined);
    await attachJson("owner live editing reads", reads ?? null).catch(() => undefined);
    await attachJson("owner live editing departures", reads && openedShareAt !== undefined
      ? { from: "the recipient opens the share", unit: "ms", windows: departureWindows(reads, openedShareAt) } : null).catch(() => undefined);
    if (owner) {
      await ownerNotices().then(notices => attachJson("owner Notices at the end", notices),
        (error: unknown) => attachJson("owner Notices at the end", { error: error instanceof Error ? error.message : String(error) }))
        .catch(() => undefined);
    }
    if (stack) {
      const output = stack.relayOutput();
      testInfo.annotations.push({ type: "refused settlement checks", description: refusedSettlementChecks(output).join(", ") || "none" });
      await testInfo.attach("relay output", { contentType: "text/plain", body: output }).catch(() => undefined);
    }
    const cleanup = await Promise.allSettled([...contexts.map(context => context.close()), ...desktops.map(desktop => desktop.close())]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([recipientTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    // A body failure stays the reported error.
    if (failures.length && !bodyFailure) throw new AggregateError(failures.map(result => result.reason), "Self-host live review cleanup failed.");
  }
});

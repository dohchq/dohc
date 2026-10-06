import { activityPin, editorTabTestId } from "../src/testPins";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { DohcDesktopBridge, EngineMomentRecord } from "../src/ipc/bridgeContract";
import { assertDesktopEngineHealthy, launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { DohcCliFailure, runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { liveDocumentFold, ownerAuditRecord, ownerEnrollment, ownerOutboxDeclarations, ownerSettlementState, ydocUpdateAuthors, type LiveAuditRecord } from "./helpers/engineDb";
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
const HA = "Agent edited while hosted.";
const AGENT = "trip-agent";
const HOSTED_AGENT = "trip-agent-hosted";
const NEXT_AGENT = "trip-agent-after-restore";
// While the server hosts the document, an agent's edit can reach the live
// document before the file is saved. The CLI then fails with this line, and
// the agent reads the document instead of retrying.
const EDIT_NOT_YET_SAVED = `dohc: The edit is in ${PATH}, but dohc has not saved it to the file yet (Saved locally. The shared file update is pending.). Read the document before you retry.\n`;

const editor = (page: Page) => page.getByTestId("markdown-editor");
const saveState = (page: Page) => page.getByTestId("markdown-save-state");

async function cliRead(temp: TempWorkspace): Promise<string> {
  return (await runDohcCli(temp, ["document", "read", PATH])).stdout;
}

/** One agent edit through the CLI while the server hosts the document. An applied edit is never retried. */
async function hostedAgentEdit(temp: TempWorkspace, find: string, text: string, agent: string): Promise<"saved" | "applied, not yet saved"> {
  const edited = await runDohcCli(temp, ["--json", "document", "edit", PATH, "--find", find, "--text", text, "--agent", agent])
    .catch((error: unknown) => {
      if (error instanceof DohcCliFailure && error.exitCode === 1 && error.stdout === "" && error.stderr === EDIT_NOT_YET_SAVED) return null;
      throw error;
    });
  if (!edited) return "applied, not yet saved";
  expect(JSON.parse(edited.stdout)).toMatchObject({ ok: true, path: PATH, changed: true });
  return "saved";
}

async function momentIds(page: Page, workspaceId: string, path: string): Promise<string[]> {
  return page.evaluate(async ({ workspaceId, path }) => {
    const history = await (window as unknown as { dohcDesktop: Api }).dohcDesktop.listEngineMoments({ workspaceId, limit: 100 });
    if (!("moments" in history)) throw new Error("History is still updating.");
    return history.moments.filter(moment => moment.path === path).map(moment => moment.id);
  }, { workspaceId, path });
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

async function openDocument(page: Page): Promise<void> {
  const explorer = page.getByTestId(activityPin("explorer"));
  if ((await explorer.getAttribute("aria-current")) !== "page") await explorer.click();
  await revealExplorerPath(page, PATH);
  await explorerRow(page, PATH).click();
  // The engine session is live once the local editor's Edit toggle is gone.
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
  await expect(editor(page)).toBeVisible();
}

async function typeAfter(page: Page, anchor: string, text: string): Promise<void> {
  await editor(page).getByText(anchor).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function openSharedRestore(page: Page) {
  await openHistoryView(page);
  const moment = page.locator(`[data-testid="engine-moment-open"][data-moment-path="${PATH}"]`).first();
  await expect(moment).toBeVisible({ timeout: 60_000 });
  await moment.click();
  await expect(page.getByTestId("engine-moment-diff-page")).toBeVisible();
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

async function shareForEdit(page: Page, workspaceId: string, recipientEmail: string) {
  const created = await page.evaluate(({ workspaceId, recipientEmail, path }) =>
    (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({ workspaceId, recipientEmail, paths: [path], access: "edit" }),
  { workspaceId, recipientEmail, path: PATH });
  await expect.poll(async () => {
    const live = await page.evaluate(workspaceId =>
      (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), workspaceId);
    return live.documents.find(document => document.path === PATH)?.status;
  }, { timeout: 120_000, intervals: [1_000] }).toBe("ready");
  return created;
}

/** A recipient opens the share on their own desktop, connecting their account first, and opens the document. */
async function openShare(recipient: LaunchedDesktopApp, temp: TempWorkspace, approvalPage: Page, origin: string,
  account: { email: string; password: string }, shareCode: string): Promise<string> {
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
  await waitForWorkspaceFile(page, shared.workspaceId, PATH);
  const listed = await page.evaluate(workspaceId =>
    (window as unknown as { dohcDesktop: Api }).dohcDesktop.listWorkspaceFiles({ workspaceId }), shared.workspaceId);
  expect(listed.files.map(file => file.path).filter(path => path.startsWith("private/"))).toEqual([]);
  expect(existsSync(join(temp.rootPath, HIDDEN))).toBe(false);
  await openDocument(page);
  await expect(explorerRow(page, "private")).toHaveCount(0);
  return shared.workspaceId;
}

type Authors = EngineMomentRecord["authors"];
interface IntroducingMoment { id: string; momentOrder: number; origin: string; listed: Authors; authors: Authors }

/** The earliest moment of the document whose change wrote `text`, with the authors its list row and its detail report. Null until history records it. */
async function momentIntroducing(page: Page, workspaceId: string, text: string): Promise<IntroducingMoment | null> {
  return page.evaluate(async ({ workspaceId, path, text }) => {
    const bridge = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
    const history = await bridge.listEngineMoments({ workspaceId, limit: 100 });
    if (!("moments" in history)) return null;
    for (const row of history.moments.filter(moment => moment.path === path).sort((a, b) => a.momentOrder - b.momentOrder)) {
      const { moment } = await bridge.readEngineMoment({ workspaceId, momentId: row.id });
      if (moment?.afterText?.includes(text) && !moment.beforeText?.includes(text)) {
        return { id: row.id, momentOrder: row.momentOrder, origin: moment.origin, listed: row.authors, authors: moment.authors };
      }
    }
    return null;
  }, { workspaceId, path: PATH, text });
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
  try {
    await expect.poll(async () => (await momentIntroducing(page, workspaceId, text))?.authors ?? [], { timeout: 60_000, intervals: [1_000] })
      .toContainEqual(declaredAuthor(declaration));
  } catch (error) {
    const evidence = await page.evaluate(async ({ workspaceId, path, text }) => {
      const bridge = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
      const history = await bridge.listEngineMoments({ workspaceId, limit: 100 });
      if (!("moments" in history)) return { workspaceId, path, historyReady: false };
      const rows = history.moments.filter(moment => moment.path === path);
      const details = [];
      for (const row of rows.slice(0, 8)) {
        const { moment } = await bridge.readEngineMoment({ workspaceId, momentId: row.id });
        details.push({ id: row.id, momentOrder: row.momentOrder, detailExists: moment !== null,
          afterContains: moment?.afterText?.includes(text) ?? false,
          beforeContains: moment?.beforeText?.includes(text) ?? false,
          listed: row.authors, authors: moment?.authors ?? null });
      }
      return { workspaceId, path, historyReady: true, pathRowCount: rows.length, details };
    }, { workspaceId, path: PATH, text }).catch(cause => ({ error: cause instanceof Error ? cause.message : String(cause) }));
    await test.info().attach(`declared agent history ${declaration.agentId}`, {
      contentType: "application/json", body: JSON.stringify(evidence, null, 2),
    }).catch(() => undefined);
    throw error;
  }
  const moment = (await momentIntroducing(page, workspaceId, text))!;
  expect(moment.listed).toEqual(moment.authors);
  return moment;
}

test("@shared-continuity a live document keeps its person's and agent's work through restart, a recipient continues it, the owner restores it, and the work continues with a new recipient", async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
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
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true });
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
      const opened = await openWorkspaceFromFirstRun(owner.page, ownerTemp);
      await owner.page.getByTestId(activityPin("cloud")).click();
      await expect(owner.page.getByTestId("cloud-sync-panel")).toBeVisible();
      const ownerPage = await ownerBrowser!.newPage();
      const approval = await openDesktopApproval(owner, ownerPage, origin);
      await createVerifiedAccount(ownerPage, stack!.account, ownerAccount, approval);
      await approveDesktop(ownerPage, ownerAccount);
      await expect(owner.page.getByTestId("cloud-connected-email")).toHaveText(ownerAccount.email);
      await owner.page.getByTestId("cloud-enable-sync").click();
      await expect(owner.page.getByTestId("cloud-workspace-synced")).toBeVisible();
      await owner.page.keyboard.press("Escape");
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
      await expect.poll(() => momentIds(owner!.page, workspace.workspaceId, HIDDEN), { timeout: 30_000 }).not.toEqual([]);
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
      expect(await momentIds(page, recipientWorkspaceId, HIDDEN)).toEqual([]);
      const guessed = await momentIds(owner!.page, workspace.workspaceId, HIDDEN);
      expect(guessed.length).toBeGreaterThan(0);
      for (const momentId of guessed) {
        expect(await page.evaluate(payload =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.readEngineMoment(payload), { workspaceId: recipientWorkspaceId, momentId })).toEqual({ moment: null });
      }
      await typeAfter(page, H1, ` ${R1}`);
      // A shared session reports saved once the server's host accepted the edit.
      await expect(saveState(page)).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
    });

    await test.step("the idle owner's editor and the agent see the recipient's edit", async () => {
      await expect(editor(owner!.page)).toContainText(R1, { timeout: 60_000 });
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, R1]), { timeout: 60_000 }).toBe(true);
    });

    await test.step("the owner stops the recipient's access and restores the document to before their edit", async () => {
      const page = owner!.page;
      const recipientUserId = await accountId(recipientAccount.email);
      const dialog = await openSharedRestore(page);
      // Restore lists an account recipient by account ID, not email.
      const recipientLabel = `Account ${recipientUserId}`;
      const access = dialog.getByLabel("Access to stop");
      await expect(access.locator("option", { hasText: recipientLabel })).toHaveCount(1, { timeout: 60_000 });
      await access.selectOption({ label: recipientLabel });
      // Restore to the accepted change just before the recipient's first edit,
      // which keeps the owner's and agent's work.
      const point = stack!.acceptedCursorBefore(workspace.workspaceId, PATH, recipientUserId);
      const pointSelect = dialog.getByLabel("Shared restore point");
      await expect(pointSelect.locator(`option[value="${point}"]`)).toHaveText(new RegExp(` · Change ${point}$`));
      await pointSelect.selectOption({ value: String(point) });
      await dialog.getByRole("button", { name: "Review affected access" }).click();
      await expect(dialog.getByRole("heading", { name: "Stop access before restoring?" })).toBeVisible();
      await expect(dialog.getByRole("listitem").filter({ hasText: recipientLabel })).toHaveCount(1);
      // The recipient can still edit, so read-only afterwards proves the stop.
      await expect(saveState(recipient!.page)).toHaveAttribute("data-state", "saved");
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
      // The review names the recipient by account ID, not by name or email.
      const removed = dialog.locator("details", { has: page.locator("summary", { hasText: /^Removed by this restore/ }) });
      await removed.locator("summary").first().click();
      await expect(removed).toContainText(`Account ${recipientUserId}`);
      await testInfo.attach("attribution", {
        contentType: "application/json",
        body: JSON.stringify({
          recipientUserId,
          ydocUpdateAuthors: ydocUpdateAuthors(ownerTemp.rootPath),
          sharedRestoreRemoved: await removed.innerText(),
          ownerHistory: await page.evaluate(async ({ workspaceId, path }) => {
            const history = await (window as unknown as { dohcDesktop: Api }).dohcDesktop.listEngineMoments({ workspaceId, limit: 100 });
            return "moments" in history ? history.moments.filter(moment => moment.path === path) : history;
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
      await expect(saveState(page)).toHaveAttribute("data-state", "read-only", { timeout: 60_000 });
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
      await editor(page).getByText(H1).click();
      await page.keyboard.type(" Typed after access stopped.");
      await expect(editor(page)).not.toContainText("Typed after access stopped.");
      await expectActiveAccess(owner!.page, []);
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

    await test.step("the new recipient sees the restored and continued document and edits it", async () => {
      newRecipient = await launch(newRecipientTemp);
      const newRecipientWorkspaceId = await openShare(newRecipient, newRecipientTemp, newRecipientPage, origin, newRecipientAccount, newShare.shareCode);
      const page = newRecipient.page;
      for (const text of [H1, A1, HA, H2, A2]) await expect(editor(page)).toContainText(text);
      await expect(editor(page)).not.toContainText(R1);
      // Both agents' changes reach the new recipient's history, before and after the restore.
      provenance.hostedNewRecipient = await expectDeclaredMoment(page, newRecipientWorkspaceId, HA, admittedAgent(hosted!.change.authorSnapshot));
      provenance.nextNewRecipient = await expectDeclaredMoment(page, newRecipientWorkspaceId, A2, admittedAgent(next!.change.authorSnapshot));
      await typeAfter(page, H2, ` ${R2}`);
      await expect(saveState(page)).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
      await expect(editor(owner!.page)).toContainText(R2, { timeout: 60_000 });
      await expect.poll(() => cliRead(ownerTemp), { timeout: 60_000 }).toContain(R2);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, H2, A2, R2], [R1]), { timeout: 60_000 }).toBe(true);
      await expect(owner!.page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 60_000 });
    });

    await test.step("the stopped recipient's access stays ended", async () => {
      const page = recipient!.page;
      expect(await page.evaluate(shareId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.getRelayReceivedShare({ shareId }), share.shareId)).toMatchObject({ found: false });
      await expect(saveState(page)).toHaveAttribute("data-state", "read-only");
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
      await expect(editor(page)).not.toContainText(R2);
      await expectActiveAccess(owner!.page, [`Account ${await accountId(newRecipientAccount.email)}`]);
    });

    await test.step("both hosted agents' attribution survives the owner's last restart", async () => {
      await owner!.close();
      owner = undefined;
      owner = await launch(ownerTemp);
      await openWorkspaceFromFirstRun(owner.page, ownerTemp);
      await waitForCliEndpoint(ownerTemp.homeDir);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, HA, H2, A2, R2], [R1]), { timeout: 30_000 }).toBe(true);
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

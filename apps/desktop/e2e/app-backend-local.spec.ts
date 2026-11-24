import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import type { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openExplorerHome,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
} from "./helpers/workspace";

const publish = (page: Page, request: OwnerAppPublicationRequest) =>
  page.evaluate((input) => window.dohcDesktop!.publishOwnerApp(input), request);
async function dataset(page: Page, request: DatasetRequest): Promise<DatasetResult> {
  const result = await page.evaluate(
    async (input) => JSON.stringify(await window.dohcDesktop!.dataset(JSON.parse(input))),
    JSON.stringify(request),
  );
  return JSON.parse(result) as DatasetResult;
}

test("@app-backend-local fundraiser compiles and persists through the real desktop without an account", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext();
  try {
    await cp(
      resolve(desktopRoot, "../../examples/fundraiser"),
      join(workspace.rootPath, "fundraiser"),
      { recursive: true },
    );
    desktop = await launchDesktopApp({ workspace });
    const { workspaceId } = await openWorkspaceFromFirstRun(desktop.page, workspace);
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/app.publish.json");
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/dataset.json");
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/backend.ts");
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/schema.sql");
    const dataPrepared = await dataset(desktop.page, {
      action: "prepare",
      workspaceId,
      descriptorPath: "fundraiser/dataset.json",
    });
    if (dataPrepared.kind !== "prepared") throw new Error("Expected captured dataset source.");
    const dataApproved = await dataset(desktop.page, {
      action: "approve",
      workspaceId,
      preparationId: dataPrepared.preparationId,
      revisionSha256: dataPrepared.revision.revisionSha256,
    });
    if (dataApproved.kind !== "approved") throw new Error("Expected an approved dataset.");
    const revision = dataApproved.revision;
    const dataSelection = {
      workspaceId,
      datasetPath: "fundraiser/dataset.json",
      revision: revision.revision,
      revisionSha256: revision.revisionSha256,
    };
    const operationId = (name: string) =>
      revision.definition.operations.find((operation) => operation.name === name)!.operationId;
    const fields = revision.definition.tables.find(
      (table) => table.sqlName === "registrations",
    )!.fields;
    const nameField = fields.find(
      (field) => field.type !== "button" && field.sqlColumn === "full_name",
    )!.fieldId;
    const prepared = await publish(desktop.page, {
      action: "prepareLocal",
      workspaceId,
      appRoot: "fundraiser",
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Expected a local approval candidate.");
    expect(prepared.local).toBe(true);
    expect(prepared.sourcePaths).not.toContain("fundraiser/backend.ts");
    expect(prepared.sourcePaths).not.toContain("fundraiser/schema.sql");
    expect(prepared.capabilities).toMatchObject([
      { kind: "dataset", datasetId: revision.datasetId, revisionSha256: revision.revisionSha256 },
    ]);
    const approved = await publish(desktop.page, {
      action: "approve",
      workspaceId,
      approvalId: prepared.approvalId,
      candidateDigest: prepared.candidateDigest,
    });
    expect(approved.kind).toBe("published");
    if (approved.kind !== "published") throw new Error("Expected a local publication.");
    expect(approved.local).toBe(true);
    const selection = { workspaceId, publicationId: approved.publicationId };
    const description = await dataset(desktop.page, {
      workspaceId,
      datasetPath: "fundraiser/dataset.json",
      action: "describe",
    });
    expect(description).toMatchObject({
      kind: "description",
      dataset: { datasetId: revision.datasetId, name: "Pickleball fundraiser" },
    });

    const entry = {
      ...dataSelection,
      action: "invoke" as const,
      operationId: operationId("manualEntry"),
      idempotencyKey: "electron-fundraiser-entry",
      input: {
        fullName: "Synthetic Electron Player",
        mobile: "09170000000",
        paymentMethod: "cash",
        source: "manual",
        status: "pay_at_venue",
        role: "player",
        session: "s1",
      },
    };
    const saved = await dataset(desktop.page, entry);
    expect(saved).toMatchObject({ replayed: false, result: { status: "pay_at_venue" } });
    const list = {
      ...dataSelection,
      action: "invoke" as const,
      operationId: operationId("tableRegistrations"),
      idempotencyKey: "electron-table-read",
      input: {},
    };
    const rows = await dataset(desktop.page, list);
    expect(rows).toMatchObject({
      result: { rows: [{ values: { [nameField]: "Synthetic Electron Player" } }] },
    });

    const launched = await publish(desktop.page, { ...selection, action: "launchLocal" });
    if (launched.kind !== "localLaunched") throw new Error("Expected an approved loopback launch.");
    const browserPage = await context.newPage();
    await browserPage.goto(launched.url);
    const app = browserPage.frameLocator("iframe");
    await expect(app.getByRole("heading", { name: "Pickleball fundraiser" })).toBeVisible();
    await app.getByRole("button", { name: "Organizer", exact: true }).click();
    await app
      .getByRole("tabpanel", { name: "Registrations" })
      .getByLabel("Status", { exact: true })
      .selectOption("all");
    await expect(
      app.getByRole("button", { name: "Synthetic Electron Player", exact: true }),
    ).toBeVisible();
    await browserPage.close();

    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const publications = await publish(desktop.page, {
      action: "listLocal",
      workspaceId,
      appRoot: "fundraiser",
    });
    expect(publications).toMatchObject({
      kind: "localListed",
      publications: [{ publicationId: approved.publicationId, active: true }],
    });
    expect(await dataset(desktop.page, list)).toEqual(rows);
    expect(await dataset(desktop.page, entry)).toEqual({ ...saved, replayed: true });
    const cliRows = await sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "dataset",
        args: { cwd: workspace.rootPath, actor: "agent", request: list },
      },
      { stateDir: workspace.homeDir },
    );
    expect(cliRows).toEqual(rows);
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

test("@app-backend-local personal control tower stages via CLI, approves from one review card, runs two Collections live, and persists across restart", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext();
  const shotDir = process.env.DOHC_PROOF_SCREENSHOT_DIR;
  try {
    await cp(
      resolve(desktopRoot, "../../examples/personal-control-tower"),
      join(workspace.rootPath, "personal-control-tower"),
      { recursive: true },
    );
    if (shotDir) await mkdir(shotDir, { recursive: true });
    desktop = await launchDesktopApp({ workspace });
    const { workspaceId } = await openWorkspaceFromFirstRun(desktop.page, workspace);
    for (const rel of [
      "personal-control-tower/app.publish.json",
      "personal-control-tower/index.tsx",
      "personal-control-tower/expenses/dataset.json",
      "personal-control-tower/expenses/schema.sql",
      "personal-control-tower/expenses/operations.js",
      "personal-control-tower/workouts/dataset.json",
      "personal-control-tower/workouts/schema.sql",
      "personal-control-tower/workouts/operations.js",
    ]) {
      await waitForWorkspaceFile(desktop.page, workspaceId, rel);
    }

    const stagedReply = (await sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "appPublication",
        args: {
          cwd: workspace.rootPath,
          actor: "agent",
          request: {
            action: "stage",
            workspaceId,
            appRoot: "personal-control-tower",
          },
        },
      },
      { stateDir: workspace.homeDir },
    )) as {
      kind: string;
      stage: {
        stageId: string;
        collections: Array<{ alias?: string; name: string; action: string }>;
      };
    };
    expect(stagedReply.kind).toBe("staged");
    expect(stagedReply.stage.collections.map((c) => `${c.alias}:${c.action}`).sort()).toEqual([
      "expenses:create",
      "workouts:create",
    ]);
    expect((await readdir(workspace.rootPath)).sort()).toEqual([".dohc", "personal-control-tower"]);
    expect(await readdir(join(workspace.rootPath, ".dohc", "local", "staged-apps"))).toEqual([
      stagedReply.stage.stageId,
    ]);

    await openExplorerHome(desktop.page);
    const row = desktop.page.locator(
      '[data-testid="sites-row"][data-root="personal-control-tower"]',
    );
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(desktop.page.getByTestId("app-view-unapproved")).toBeVisible({ timeout: 20_000 });
    await desktop.page.getByTestId("app-view-review").click();

    const dialog = desktop.page.getByTestId("app-publication-dialog");
    const card = dialog.getByTestId("staged-app-review-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("2 new Collections");
    await expect(card).toContainText("Expenses");
    await expect(card).toContainText("Workouts");
    await expect(card).toContainText("Date, Merchant, Category, Amount, Note");
    await expect(card).toContainText("Date, Activity, Minutes, Effort, Notes");

    if (shotDir) {
      for (const theme of ["light", "dark"] as const) {
        await desktop.page.evaluate((value) => {
          document.documentElement.setAttribute("data-theme", value);
          void getComputedStyle(document.body).backgroundColor;
        }, theme);
        await dialog.screenshot({ path: join(shotDir, `staged-review-card-${theme}.png`) });
      }
      await desktop.page.evaluate(() => {
        document.documentElement.setAttribute("data-theme", "light");
      });
    }

    await desktop.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await desktop.page.getByTestId("app-view-review").click();
    await expect(card).toBeVisible({ timeout: 20_000 });

    await dialog.getByTestId("staged-app-approve").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await expect(desktop.page.getByRole("button", { name: "Expenses" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(desktop.page.getByRole("button", { name: "Workouts" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(desktop.page.getByTestId("app-view-webview")).toBeVisible({ timeout: 20_000 });
    await expect(desktop.page.getByTestId("app-view-loading")).toHaveCount(0, { timeout: 20_000 });
    await expect(desktop.page.getByTestId("app-view-unapproved")).toHaveCount(0);
    const embeddedDesktop = desktop;
    await expect
      .poll(
        async () =>
          embeddedDesktop.app.evaluate(async ({ webContents }) => {
            const guest = webContents
              .getAllWebContents()
              .find(
                (contents) =>
                  contents.getType() === "webview" &&
                  /^http:\/\/127\.0\.0\.1:\d+\/bootstrap(?:#|$)/.test(contents.getURL()),
              );
            const frame = guest?.mainFrame.framesInSubtree.find(
              (entry) => entry.url === "about:srcdoc",
            );
            if (!frame) return "";
            return (await frame.executeJavaScript(
              "document.body?.innerText ?? ''",
              true,
            )) as string;
          }),
        { timeout: 20_000 },
      )
      .toContain("Control Tower");
    if (shotDir) {
      await desktop.page.screenshot({
        path: join(shotDir, "desktop-approved-sidebar-light.png"),
      });
    }

    const stagedAfter = await publish(desktop.page, {
      action: "listStaged",
      workspaceId,
      appRoot: "personal-control-tower",
    });
    expect(stagedAfter).toEqual({ kind: "stagedListed", stages: [] });

    const listed = await publish(desktop.page, {
      action: "listLocal",
      workspaceId,
      appRoot: "personal-control-tower",
    });
    if (listed.kind !== "localListed" || listed.publications.length !== 1) {
      throw new Error("Expected one active local publication.");
    }
    const publicationId = listed.publications[0]!.publicationId;
    expect(listed.publications[0]!.active).toBe(true);

    const launched = await publish(desktop.page, {
      action: "launchLocal",
      workspaceId,
      publicationId,
    });
    if (launched.kind !== "localLaunched") throw new Error("Expected local launch URL.");

    const browserPage = await context.newPage();
    await browserPage.setViewportSize({ width: 1200, height: 860 });
    await browserPage.goto(launched.url);
    const app = browserPage.frameLocator("iframe");
    await expect(app.getByRole("heading", { name: "Control Tower" })).toBeVisible({
      timeout: 20_000,
    });

    await app.getByRole("button", { name: "Add expense", exact: true }).first().click();
    await app.getByLabel("Merchant").fill("Blue Bottle");
    await app.getByLabel("Amount").fill("6.50");
    await app.getByLabel("Note").fill("Cortado");
    await app.getByRole("button", { name: "Save expense", exact: true }).click();
    await expect(app.getByText("Blue Bottle")).toBeVisible({ timeout: 15_000 });
    await expect(app.getByText("$6.50").first()).toBeVisible();

    await app.getByRole("button", { name: "Log workout", exact: true }).first().click();
    await app.getByLabel("Activity").fill("Morning 5K");
    await app.getByLabel("Minutes").fill("28");
    await app.getByLabel("Notes").fill("Tempo run");
    await app.getByRole("button", { name: "Save workout", exact: true }).click();
    await expect(app.getByText("28 min").first()).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const text = (await embeddedDesktop.app.evaluate(async ({ webContents }) => {
            const guest = webContents
              .getAllWebContents()
              .find(
                (contents) =>
                  contents.getType() === "webview" &&
                  /^http:\/\/127\.0\.0\.1:\d+\/bootstrap(?:#|$)/.test(contents.getURL()),
              );
            const frame = guest?.mainFrame.framesInSubtree.find(
              (entry) => entry.url === "about:srcdoc",
            );
            if (!frame) return "";
            return (await frame.executeJavaScript(
              "document.body?.innerText ?? ''",
              true,
            )) as string;
          })) as string;
          return text.includes("Blue Bottle") && text.includes("$6.50") && text.includes("28 min");
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    if (shotDir) {
      for (const theme of ["light", "dark"] as const) {
        await browserPage.emulateMedia({ colorScheme: theme });
        await browserPage.screenshot({
          path: join(shotDir, `personal-control-tower-expenses-${theme}.png`),
        });
      }
      await app.getByRole("tab", { name: /Workouts/ }).click();
      await expect(app.getByText("Morning 5K")).toBeVisible({ timeout: 15_000 });
      for (const theme of ["light", "dark"] as const) {
        await browserPage.emulateMedia({ colorScheme: theme });
        await browserPage.screenshot({
          path: join(shotDir, `personal-control-tower-workouts-${theme}.png`),
        });
      }
      await browserPage.emulateMedia({ colorScheme: "light" });
    } else {
      await app.getByRole("tab", { name: /Workouts/ }).click();
      await expect(app.getByText("Morning 5K")).toBeVisible({ timeout: 15_000 });
    }
    await browserPage.close();

    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const relaunched = await publish(desktop.page, {
      action: "launchLocal",
      workspaceId,
      publicationId,
    });
    if (relaunched.kind !== "localLaunched")
      throw new Error("Expected local launch URL after restart.");
    const afterRestart = await context.newPage();
    await afterRestart.goto(relaunched.url);
    const restartedApp = afterRestart.frameLocator("iframe");
    await expect(restartedApp.getByText("Blue Bottle")).toBeVisible({ timeout: 20_000 });
    await expect(restartedApp.getByText("$6.50").first()).toBeVisible();
    await restartedApp.getByRole("tab", { name: /Workouts/ }).click();
    await expect(restartedApp.getByText("Morning 5K")).toBeVisible({ timeout: 15_000 });
    await expect(restartedApp.getByText("28 min").first()).toBeVisible();
    await afterRestart.close();

    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

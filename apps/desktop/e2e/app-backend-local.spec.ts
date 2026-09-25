import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import type { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceFile } from "./helpers/workspace";

const publish = (page: Page, request: OwnerAppPublicationRequest) =>
  page.evaluate(input => window.dohcDesktop!.publishOwnerApp(input), request);
async function dataset(page: Page, request: DatasetRequest): Promise<DatasetResult> {
  const result = await page.evaluate(async input => JSON.stringify(await window.dohcDesktop!.dataset(JSON.parse(input))), JSON.stringify(request));
  return JSON.parse(result) as DatasetResult;
}

test("@app-backend-local fundraiser compiles and persists through the real desktop without an account", async ({ browser }) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext();
  try {
    await cp(resolve(desktopRoot, "../../examples/fundraiser"), join(workspace.rootPath, "fundraiser"), { recursive: true });
    desktop = await launchDesktopApp({ workspace });
    const { workspaceId } = await openWorkspaceFromFirstRun(desktop.page, workspace);
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/app.publish.json");
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/dataset.json");
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/backend.ts");
    await waitForWorkspaceFile(desktop.page, workspaceId, "fundraiser/schema.sql");
    const dataPrepared = await dataset(desktop.page, { action: "prepare", workspaceId, descriptorPath: "fundraiser/dataset.json" });
    if (dataPrepared.kind !== "prepared") throw new Error("Expected captured dataset source.");
    const dataApproved = await dataset(desktop.page, { action: "approve", workspaceId, preparationId: dataPrepared.preparationId, revisionSha256: dataPrepared.revision.revisionSha256 });
    if (dataApproved.kind !== "approved") throw new Error("Expected an approved dataset.");
    const revision = dataApproved.revision;
    const dataSelection = { workspaceId, datasetId: revision.datasetId, revision: revision.revision, revisionSha256: revision.revisionSha256 };
    const operationId = (name: string) => revision.definition.operations.find(operation => operation.name === name)!.operationId;
    const fields = revision.definition.tables.find(table => table.sqlName === "registrations")!.fields;
    const nameField = fields.find(field => field.type !== "button" && field.sqlColumn === "full_name")!.fieldId;
    const prepared = await publish(desktop.page, { action: "prepareLocal", workspaceId, appRoot: "fundraiser" });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Expected a local approval candidate.");
    expect(prepared.local).toBe(true);
    expect(prepared.sourcePaths).not.toContain("fundraiser/backend.ts");
    expect(prepared.sourcePaths).not.toContain("fundraiser/schema.sql");
    expect(prepared.capabilities).toMatchObject([{ kind: "dataset", datasetId: revision.datasetId, revisionSha256: revision.revisionSha256 }]);
    const approved = await publish(desktop.page, { action: "approve", workspaceId, approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
    expect(approved.kind).toBe("published");
    if (approved.kind !== "published") throw new Error("Expected a local publication.");
    expect(approved.local).toBe(true);
    const selection = { workspaceId, publicationId: approved.publicationId };
    const description = await dataset(desktop.page, { workspaceId, datasetId: revision.datasetId, action: "describe" });
    expect(description).toMatchObject({ kind: "description", dataset: { datasetId: revision.datasetId, name: "Pickleball fundraiser" } });

    const entry = { ...dataSelection, action: "invoke" as const, operationId: operationId("manualEntry"), idempotencyKey: "electron-fundraiser-entry",
      input: { fullName: "Synthetic Electron Player", mobile: "09170000000", paymentMethod: "cash", source: "manual", status: "pay_at_venue", role: "player", session: "s1" } };
    const saved = await dataset(desktop.page, entry);
    expect(saved).toMatchObject({ replayed: false, result: { status: "pay_at_venue" } });
    const list = { ...dataSelection, action: "invoke" as const, operationId: operationId("tableRegistrations"), idempotencyKey: "electron-table-read", input: {} };
    const rows = await dataset(desktop.page, list);
    expect(rows).toMatchObject({ result: { rows: [{ values: { [nameField]: "Synthetic Electron Player" } }] } });

    const launched = await publish(desktop.page, { ...selection, action: "launchLocal" });
    if (launched.kind !== "localLaunched") throw new Error("Expected an approved loopback launch.");
    const browserPage = await context.newPage();
    await browserPage.goto(launched.url);
    const app = browserPage.frameLocator("iframe");
    await expect(app.getByRole("heading", { name: "Pickleball fundraiser" })).toBeVisible();
    await app.getByRole("button", { name: "Organizer", exact: true }).click();
    await app.getByRole("tabpanel", { name: "Registrations" }).getByLabel("Status", { exact: true }).selectOption("all");
    await expect(app.getByRole("button", { name: "Synthetic Electron Player", exact: true })).toBeVisible();
    await browserPage.close();

    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const publications = await publish(desktop.page, { action: "listLocal", workspaceId, appRoot: "fundraiser" });
    expect(publications).toMatchObject({ kind: "localListed", publications: [{ publicationId: approved.publicationId, active: true }] });
    expect(await dataset(desktop.page, list)).toEqual(rows);
    expect(await dataset(desktop.page, entry)).toEqual({ ...saved, replayed: true });
    const cliRows = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset",
      args: { cwd: workspace.rootPath, actor: "agent", request: list } }, { stateDir: workspace.homeDir });
    expect(cliRows).toEqual(rows);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import type { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import type { OwnerAppBackendRequest, OwnerAppBackendResult } from "@dohc/cli/app-backend";
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceFile } from "./helpers/workspace";

const publish = (page: Page, request: OwnerAppPublicationRequest) =>
  page.evaluate(input => window.dohcDesktop!.publishOwnerApp(input), request);
async function backend(page: Page, request: OwnerAppBackendRequest): Promise<OwnerAppBackendResult> {
  const result = await page.evaluate(async input => JSON.stringify(await window.dohcDesktop!.appBackend(JSON.parse(input))), JSON.stringify(request));
  return JSON.parse(result) as OwnerAppBackendResult;
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
    const prepared = await publish(desktop.page, { action: "prepareLocal", workspaceId, appRoot: "fundraiser" });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Expected a local approval candidate.");
    expect(prepared.local).toBe(true);
    expect(prepared.sourcePaths).toContain("fundraiser/backend.ts");
    const approved = await publish(desktop.page, { action: "approve", workspaceId, approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
    expect(approved.kind).toBe("published");
    if (approved.kind !== "published") throw new Error("Expected a local publication.");
    expect(approved.local).toBe(true);
    const selection = { workspaceId, publicationId: approved.publicationId };
    const description = await backend(desktop.page, { ...selection, action: "describe" });
    expect(description).toMatchObject({ online: true, capability: { kind: "app-backend", dataPath: "fundraiser/data.sqlite" } });

    const entry = { ...selection, action: "invoke" as const, operation: "manualEntry", idempotencyKey: "electron-fundraiser-entry",
      input: { fullName: "Synthetic Electron Player", mobile: "09170000000", paymentMethod: "cash", source: "manual", status: "pay_at_venue", role: "player", session: "s1" } };
    const saved = await backend(desktop.page, entry);
    expect(saved).toMatchObject({ replayed: false, result: { status: "pay_at_venue" } });
    const list = { ...selection, action: "invoke" as const, operation: "tableRegistrations", idempotencyKey: "electron-table-read", input: {} };
    const rows = await backend(desktop.page, list);
    expect(rows).toMatchObject({ result: { rows: [{ fullName: "Synthetic Electron Player" }] } });

    const launched = await publish(desktop.page, { ...selection, action: "launchLocal" });
    if (launched.kind !== "localLaunched") throw new Error("Expected an approved loopback launch.");
    const browserPage = await context.newPage();
    await browserPage.goto(launched.url);
    const app = browserPage.frameLocator("iframe");
    await expect(app.getByRole("heading", { name: "Pickleball fundraiser" })).toBeVisible();
    await app.getByRole("button", { name: "Organizer", exact: true }).click();
    await app.getByLabel("Status", { exact: true }).selectOption("all");
    await expect(app.getByRole("button", { name: "Synthetic Electron Player", exact: true })).toBeVisible();
    await browserPage.close();

    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const publications = await publish(desktop.page, { action: "listLocal", workspaceId, appRoot: "fundraiser" });
    expect(publications).toMatchObject({ kind: "localListed", publications: [{ publicationId: approved.publicationId, active: true }] });
    expect(await backend(desktop.page, list)).toEqual(rows);
    expect(await backend(desktop.page, entry)).toEqual({ ...saved, replayed: true });
    const cliRows = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "appBackend",
      args: { cwd: workspace.rootPath, actor: "agent", request: list } }, { stateDir: workspace.homeDir });
    expect(cliRows).toEqual(rows);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import { assertDesktopEngineHealthy, launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedWorkspaceManifest } from "./helpers/workspace";

async function dataset(page: Page, request: DatasetRequest): Promise<DatasetResult> {
  return JSON.parse(await page.evaluate(async input => JSON.stringify(await window.dohcDesktop!.dataset(JSON.parse(input))), JSON.stringify(request))) as DatasetResult;
}

test("@dataset-recovery owner exports and restores records, files, history, and retry receipts on a clean desktop", async () => {
  test.setTimeout(180_000);
  const source = await createTempWorkspace(), target = await createTempWorkspace();
  let oldDesktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let restoredDesktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const receipt = Buffer.from("Synthetic private recovery receipt\nAmount: 250\n");
  const archivePath = join(source.baseDir, "private.dohc-recovery");
  try {
    oldDesktop = await launchDesktopApp({ workspace: source });
    const { page } = oldDesktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, source);
    await oldDesktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Recovery proof");
    await create.getByRole("button", { name: "Add field", exact: true }).click();
    await create.getByLabel("Field name", { exact: true }).last().fill("Receipt");
    await create.getByLabel("Field type", { exact: true }).last().selectOption("attachment");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const collection = page.getByRole("region", { name: "Recovery proof", exact: true });
    await collection.getByRole("button", { name: "New record", exact: true }).click();
    const newRecord = collection.getByRole("form", { name: "New record" });
    await newRecord.getByLabel("Name", { exact: true }).fill("Before agent edit");
    await newRecord.getByLabel("Receipt", { exact: true }).setInputFiles({ name: "receipt.txt", mimeType: "text/plain", buffer: receipt });
    await expect(newRecord.getByText(/receipt\.txt.*Save to attach/)).toBeVisible();
    await collection.getByRole("button", { name: "Create record", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Before agent edit");

    const listed = await dataset(page, { action: "list", workspaceId });
    if (listed.kind !== "list" || listed.datasets.length !== 1) throw Error("Expected one Collection.");
    const description = listed.datasets[0]!, table = description.tables[0]!;
    const nameField = table.fields.find(field => field.name === "Name")!;
    const fileField = table.fields.find(field => field.name === "Receipt")!;
    const readOperation = description.operations.find(operation => operation.kind === "read")!;
    const editOperation = description.operations.find(operation => operation.kind === "edit")!;
    const scope = { workspaceId, datasetId: description.datasetId };
    const pinned = { ...scope, revision: description.revision, revisionSha256: description.revisionSha256 };
    const readRequest = { ...pinned, action: "invoke" as const, operationId: readOperation.operationId, idempotencyKey: "recovery-read", input: { limit: 50 } };
    const initial = await dataset(page, readRequest);
    if (initial.kind !== "invoked") throw Error("Expected records.");
    const row = (initial.result as { rows: Array<{ id: string; version: number; values: Record<string, string> }> }).rows[0]!;
    const fileId = row.values[fileField.fieldId]!;
    const retryRequest = { ...pinned, action: "invoke" as const, operationId: editOperation.operationId, idempotencyKey: "retained-agent-edit",
      input: { id: row.id, expectedVersion: row.version, values: { [nameField.fieldId]: "Before owner edit" } } };
    const agentResult = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset", args: { cwd: source.rootPath, actor: "agent", request: retryRequest } }, { stateDir: source.homeDir });
    expect(agentResult).toMatchObject({ kind: "invoked", replayed: false });
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Before owner edit");
    await collection.getByRole("button", { name: /^Edit Name for record / }).click();
    await collection.getByRole("form", { name: "Edit Name" }).getByLabel("Name").fill("Saved before recovery");
    await collection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Saved before recovery");
    const before = await dataset(page, readRequest);
    const historyRequest = { ...scope, action: "history" as const, limit: 50 };
    const historyBefore = await dataset(page, historyRequest);
    if (before.kind !== "invoked" || historyBefore.kind !== "history") throw Error("Expected saved records and history.");
    expect(historyBefore.entries).toHaveLength(3);

    // Only the native picker result is supplied by the harness. Export and restore run through the visible controls and production IPC.
    await oldDesktop.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, archivePath);
    await collection.getByLabel("Manage Collection", { exact: true }).click();
    await collection.getByRole("button", { name: "Export recovery", exact: true }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export Recovery proof?", exact: true });
    await expect(exportDialog).toContainText("private records");
    await exportDialog.getByRole("button", { name: "Save recovery file", exact: true }).click();
    await expect(exportDialog).toBeHidden();
    expect((await readFile(archivePath)).byteLength).toBeGreaterThan(4096);
    assertDesktopEngineHealthy(oldDesktop.logs);
    expect(oldDesktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    await oldDesktop.close();
    oldDesktop = null;

    // A new profile and empty host store adopt only the required workspace identity. No database or tombstone is copied or removed.
    await seedWorkspaceManifest(target, workspaceId);
    restoredDesktop = await launchDesktopApp({ workspace: target });
    const restored = restoredDesktop.page;
    expect((await openWorkspaceFromFirstRun(restored, target)).workspaceId).toBe(workspaceId);
    expect(await dataset(restored, { action: "list", workspaceId, includeArchived: true })).toMatchObject({ kind: "list", datasets: [] });
    await restoredDesktop.app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, archivePath);
    await restored.getByRole("button", { name: "Restore from recovery file", exact: true }).click();
    const recovery = restored.getByRole("dialog", { name: "Restore a Collection", exact: true });
    await recovery.getByRole("button", { name: "Choose recovery file", exact: true }).click();
    await expect(recovery).toContainText("Recovery proof");
    await expect(recovery).toContainText("Sharing stays off");
    await expect(recovery.getByRole("button", { name: "Restore Collection", exact: true })).toBeDisabled();
    await recovery.getByRole("checkbox", { name: "I stopped the old host and will not restart it for this Collection." }).check();
    await recovery.getByRole("button", { name: "Restore Collection", exact: true }).click();
    await expect(recovery).toBeHidden();
    const recovered = restored.getByRole("region", { name: "Recovery proof", exact: true });
    await expect(recovered.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Saved before recovery");
    // Claiming a new host adds an authority checkpoint, not a user edit.
    const recoveredRead = { ...before, revision: before.revision + 1 };
    expect(await dataset(restored, readRequest)).toEqual(recoveredRead);
    expect(await dataset(restored, historyRequest)).toEqual({ ...historyBefore, headRevision: historyBefore.headRevision + 1 });
    expect(await dataset(restored, { action: "list", workspaceId })).toEqual(listed);
    const restoredFile = await dataset(restored, { ...pinned, action: "file", fileId });
    if (restoredFile.kind !== "file") throw Error("Expected restored receipt.");
    expect(restoredFile.file.name).toBe("receipt.txt");
    expect(Buffer.from(restoredFile.bytesBase64, "base64")).toEqual(receipt);
    const replay = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset", args: { cwd: target.rootPath, actor: "agent", request: retryRequest } }, { stateDir: target.homeDir });
    expect(replay).toEqual({ ...(agentResult as object), replayed: true });
    expect(await dataset(restored, readRequest)).toEqual(recoveredRead);

    await recovered.getByLabel("Manage Collection", { exact: true }).click();
    await recovered.getByRole("button", { name: "History", exact: true }).click();
    const history = restored.getByRole("dialog", { name: "Collection history", exact: true });
    const latest = history.locator("details").first();
    await latest.locator("summary").click();
    await expect(latest.getByText('"Before owner edit"', { exact: true })).toBeVisible();
    await restored.screenshot({ path: test.info().outputPath("restored-history.png") });
    await latest.getByRole("button", { name: "Undo edit", exact: true }).click();
    await expect(recovered.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Before owner edit");
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await expect(recovered.getByRole("button", { name: "Download Receipt", exact: true })).toBeVisible();
    assertDesktopEngineHealthy(restoredDesktop.logs);
    expect(restoredDesktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    await test.info().attach("recovery-scope", { body: JSON.stringify({ workspaceId, datasetId: description.datasetId, recordId: row.id, fileId,
      scope: "Visible export and clean-target restore; same workspace and dataset identity, exact records/history/attachment bytes, agent retry receipt, owner History Undo.",
      seams: "Native file picker returns and clean target workspace manifest identity only. Old source stays stopped; no internal database repair." }), contentType: "application/json" });
  } finally {
    await cleanupDesktopWorkspace(restoredDesktop, target);
    await cleanupDesktopWorkspace(oldDesktop, source);
  }
});

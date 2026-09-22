import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cpus, freemem, platform, totalmem } from "node:os";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { generateDatasetSources } from "../../src/workspaces/datasetGenerator";
import { launchDesktopApp } from "../helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceFile } from "../helpers/workspace";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rowCount = 100_000, samples = 30, title = "Performance participants";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: title, schemaPath: "performance/schema.sql", operationsPath: "performance/operations.js",
  tables: [{ tableId: id(2), name: title, sqlName: "participants", primaryKey: "record_id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "record_id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }], operations: [
    { operationId: id(5), name: "read", label: "Read", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "owner", readOnly: false, fieldIds: [id(4)] },
  ],
};

function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], p99: sorted[Math.ceil(sorted.length * .99) - 1], max: sorted.at(-1), samplesMs: values };
}

/** Starts at the actual click event and stops at a painted, settled 50-row table. */
async function tableSample(page: Page, initial: boolean) {
  return page.evaluate(({ initial, title }) => new Promise<number>((resolve, reject) => {
    const region = () => document.querySelector<HTMLElement>(`section[aria-label="${title}"]`);
    const previous = region();
    const container = initial ? document.querySelector('section[aria-label="Collections"]') : previous;
    const button = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => button.textContent?.trim() === (initial ? title : "Refresh"));
    if (!button || button.disabled) { reject(Error("The Collection control is unavailable.")); return; }
    let started = 0, changed = false, finishing = false;
    const timeout = setTimeout(() => { observer.disconnect(); reject(Error("The Collection did not settle.")); }, 60_000);
    const observer = new MutationObserver(() => {
      const current = region();
      changed ||= current !== previous || current?.getAttribute("aria-busy") === "true";
      if (finishing || !started || !changed || !current || current.getAttribute("aria-busy") !== "false" || current.querySelectorAll("tbody tr").length !== 50) return;
      finishing = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const latest = region();
        if (latest !== current || latest?.getAttribute("aria-busy") !== "false") { finishing = false; return; }
        observer.disconnect(); clearTimeout(timeout); resolve(performance.now() - started);
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
    button.addEventListener("click", () => { started = performance.now(); }, { once: true, capture: true });
    button.click();
  }), { initial, title });
}

/** Captures real keyboard input and waits for a paint; Playwright transport latency is outside the sample. */
async function inputSample(page: Page) {
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('form[aria-label="Edit Name"] input[aria-label="Name"]');
    if (!input || input.disabled) throw Error("The record editor is unavailable.");
    (window as Window & { collectionInputSample?: Promise<number> }).collectionInputSample = new Promise((resolve, reject) => {
      let started = 0;
      const before = input.value;
      const timeout = setTimeout(() => { input.removeEventListener("keydown", begin, true); input.removeEventListener("input", changed); reject(Error("The editor did not receive input.")); }, 10_000);
      function begin() { started = performance.now(); }
      function changed() {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timeout);
          if (!started || input!.value === before) reject(Error("The editor did not paint the changed value."));
          else resolve(performance.now() - started);
        }));
      }
      input.addEventListener("keydown", begin, { once: true, capture: true });
      input.addEventListener("input", changed, { once: true });
    });
  });
  await page.keyboard.press("x");
  return page.evaluate(() => (window as Window & { collectionInputSample?: Promise<number> }).collectionInputSample!);
}

test("@collection-performance profiles a real 100k-row owner table and editor", async () => {
  test.setTimeout(20 * 60_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const generated = generateDatasetSources(definition);
  const fullDefinition: DatasetDefinition = { ...definition, operations: [...definition.operations,
    { operationId: id(7), name: "seed", label: "Seed fixture", tableId: id(2), kind: "action", access: "owner", readOnly: false, fieldIds: [id(3), id(4)] },
    { operationId: id(8), name: "count", label: "Count fixture", tableId: id(2), kind: "action", access: "owner", readOnly: true, fieldIds: [] },
  ] };
  const seedSource = `
globalThis.operations.seed=(ctx,input)=>{
  if(ctx.caller.kind!=='owner')ctx.refuse('forbidden','Owner only.');
  if(!Number.isSafeInteger(input.start)||input.start<1||!Number.isSafeInteger(input.count)||input.count<1||input.count>128)ctx.refuse('invalid','Invalid seed batch.');
  ctx.db.execute("WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT INTO participants(record_id,name,_record_version) SELECT 'record-'||printf('%06d',n),'Participant '||printf('%06d',n),1 FROM seq",[input.start,input.start+input.count-1]);
  return {inserted:input.count};
};
globalThis.operations.count=(ctx)=>{if(ctx.caller.kind!=='owner')ctx.refuse('forbidden','Owner only.');return ctx.db.query('SELECT count(*) AS count FROM participants');};
`;
  const source = generated.files[definition.operationsPath]! + seedSource;
  const files = { ...generated.files, "performance/dataset.json": JSON.stringify(fullDefinition), [definition.operationsPath]: source, "performance/checkpoint.sql": "SELECT 1;" };
  try {
    for (const [path, contents] of Object.entries(files)) { await mkdir(dirname(join(workspace.rootPath, path)), { recursive: true }); await writeFile(join(workspace.rootPath, path), contents); }
    desktop = await launchDesktopApp({ workspace });
    let page = desktop.page;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    for (const path of Object.keys(files)) await waitForWorkspaceFile(page, workspaceId, path);
    const prepared = await page.evaluate(workspaceId => window.dohcDesktop!.dataset({ action: "prepare", workspaceId, descriptorPath: "performance/dataset.json" }), workspaceId);
    if (prepared.kind !== "prepared") throw Error("Expected prepared performance fixture.");
    const approved = await page.evaluate(input => window.dohcDesktop!.dataset({ action: "approve", ...input }), { workspaceId, preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
    if (approved.kind !== "approved") throw Error("Expected approved performance fixture.");
    const selection = { workspaceId, datasetId: definition.datasetId, revision: approved.revision.revision, revisionSha256: approved.revision.revisionSha256 };
    const seed = await page.evaluate(async ({ selection, operationId, countOperationId, rowCount }) => {
      const started = performance.now();
      let head = 0;
      for (let start = 1; start <= rowCount; start += 128) {
        const result = await window.dohcDesktop!.dataset({ action: "invoke", ...selection, operationId, input: { start, count: Math.min(128, rowCount - start + 1) }, idempotencyKey: `seed-${start}` });
        if (result.kind !== "invoked") throw Error("The fixture seed failed.");
        head = result.revision;
      }
      const count = await window.dohcDesktop!.dataset({ action: "invoke", ...selection, operationId: countOperationId, input: {}, idempotencyKey: "verify-count" });
      if (count.kind !== "invoked" || JSON.stringify(count.result) !== JSON.stringify([{ count: rowCount }])) throw Error("The fixture row count differs.");
      return { elapsedMs: performance.now() - started, head };
    }, { selection, operationId: id(7), countOperationId: id(8), rowCount });
    const checkpoint = await page.evaluate(input => window.dohcDesktop!.dataset({ ...input, action: "prepareMigration", descriptorPath: "performance/dataset.json", migrationPath: "performance/checkpoint.sql" }), { workspaceId, datasetId: definition.datasetId });
    if (checkpoint.kind !== "migration-prepared") throw Error("Expected a fixture checkpoint candidate.");
    const migrated = await page.evaluate(input => window.dohcDesktop!.dataset({ ...input, action: "approveMigration" }), { workspaceId, preparationId: checkpoint.preparationId, revisionSha256: checkpoint.revision.revisionSha256, approvalDigest: checkpoint.approvalDigest });
    if (migrated.kind !== "migrated") throw Error("Expected a fixture checkpoint.");
    await desktop.close(); desktop = await launchDesktopApp({ workspace }); page = desktop.page;
    await openWorkspaceFromFirstRun(page, workspace);
    await expect(page.getByRole("region", { name: "Collections", exact: true }).getByRole("button", { name: title, exact: true })).toBeVisible();
    const coldMs = await tableSample(page, true);
    const warm: number[] = [], input: number[] = [];
    for (let index = 0; index < samples; index++) warm.push(await tableSample(page, false));
    const collection = page.getByRole("region", { name: title, exact: true });
    await collection.getByRole("button", { name: /^Edit Name for record / }).first().click();
    await collection.getByRole("form", { name: "Edit Name" }).getByLabel("Name", { exact: true }).focus();
    for (let index = 0; index < samples; index++) input.push(await inputSample(page));
    await collection.getByRole("button", { name: "Cancel", exact: true }).click();
    const evidence = {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
      machine: { platform: platform(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
      dataset: { ...selection, rowCount, seed, checkpoint: checkpoint.expected, approvedRevision: checkpoint.revision.revision, approvedRevisionHash: checkpoint.revision.revisionSha256, schemaSha256: hash(files[definition.schemaPath]!), sourceSha256: hash(source) },
      measurements: { coldOpenMs: coldMs, warmTable: statistics(warm), inputFeedback: statistics(input) },
      targets: { warmTableP95Ms: 300, inputFeedbackP95Ms: 100 },
      boundaries: { realRenderer: true, path: "Collection refresh → owner IPC → approved read → painted 50-row table", input: "keydown → changed controlled input → two animation frames", seed: "Owner fixture action in 128-row transactions, followed by approved checkpoint", network: false, quietHost: "Not assumed; record concurrent load separately", thresholdsEnforced: false },
    };
    await writeFile(test.info().outputPath("collection-performance.json"), JSON.stringify(evidence, null, 2));
    await test.info().attach("collection-performance", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    await page.screenshot({ path: test.info().outputPath("collection-100k.png") });
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});

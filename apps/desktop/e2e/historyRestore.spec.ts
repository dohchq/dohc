import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ElectronApplication } from "playwright";
import { launchApp } from "./launch";

type HistoryRecord = {
  id: string;
  recordedAtMs: number;
  kind: string;
  summary: string;
  humanSummary?: string;
  files: Array<{
    path: string;
    operation: string;
    before?: { text?: string; unavailableReason?: string } | null;
    after?: { text?: string; unavailableReason?: string } | null;
  }>;
  provenance?: {
    source?: string;
    restoreOfChangeSetId?: string;
    restoreOfPath?: string;
    restoreDirection?: "restore" | "undo";
  };
};

const seededWorkspaces: Array<{ home: string; root: string }> = [];

test.afterEach(async () => {
  await Promise.all(
    seededWorkspaces.splice(0).flatMap(({ home, root }) => [
      rm(home, { recursive: true, force: true }),
      rm(dirname(root), { recursive: true, force: true }),
    ]),
  );
});

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-history-restore-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-history-restore-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId,
      kind: "personal",
      mode: "local-first",
    }),
  );
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  seededWorkspaces.push({ home, root });
  return { home, root };
}

async function openSeeded(home: string, root: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await expect(page.getByTestId("sync-status")).toBeVisible();
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect(page.getByTestId("history-timeline")).toBeVisible();
  return { app, page };
}

async function historyRecords(root: string): Promise<HistoryRecord[]> {
  const historyDir = join(root, ".dohc", "history");
  try {
    const files = await readdir(historyDir);
    const records = await Promise.all(
      files
        .filter((name) => name.endsWith(".json") && name !== "index.json")
        .map(async (name) =>
          JSON.parse(await readFile(join(historyDir, name), "utf8")) as HistoryRecord,
        ),
    );
    return records.sort(
      (a, b) => b.recordedAtMs - a.recordedAtMs || b.id.localeCompare(a.id),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForHistoryRecord(
  root: string,
  predicate: (record: HistoryRecord) => boolean,
): Promise<HistoryRecord> {
  let latest: HistoryRecord | null = null;
  await expect
    .poll(async () => {
      latest =
        (await historyRecords(root)).find((record) => predicate(record)) ?? null;
      return latest !== null;
    }, { timeout: 15_000 })
    .toBe(true);
  return latest!;
}

async function expectNoDohcHistoryNoise(page: Page): Promise<void> {
  await expect(page.getByTestId("history-timeline")).not.toContainText(".dohc");
}

async function openNewestHistoryDiff(page: Page, matchingText: RegExp) {
  const timeline = page.getByTestId("history-timeline");
  const item = timeline
    .getByTestId("history-change-open")
    .filter({ hasText: matchingText })
    .first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("history-diff-page")).toBeVisible();
}

async function confirmRestore(page: Page) {
  await page.getByTestId("history-diff-restore-file").click();
  await expect(page.getByTestId("history-diff-restore-confirm")).toBeVisible();
  await page.getByTestId("history-diff-confirm-restore").click();
}

test("history restore smoke: edit, restore, Ctrl+Z undo, restore again, durable restore-entry undo", async () => {
  test.setTimeout(120_000);
  const { home, root } = await seedWorkspace("history-restore-edit", {
    "notes/today.md": "before\n",
  });
  const { app, page } = await openSeeded(home, root);
  const filePath = join(root, "notes", "today.md");

  await writeFile(filePath, "after\n");
  const editRecord = await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "user-edit" &&
      record.files.some(
        (file) =>
          file.path === "notes/today.md" &&
          file.before?.text === "before\n" &&
          file.after?.text === "after\n",
      ),
  );
  await expect(page.getByTestId("history-timeline")).toContainText(/today\.md/i);
  await openNewestHistoryDiff(page, /today\.md/i);
  const diffTabTestId = `tab-dohc://history-diff/${encodeURIComponent(
    editRecord.id,
  )}?file=${encodeURIComponent("notes/today.md")}`;
  await expect(page.getByTestId(diffTabTestId)).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.getByTestId("history-diff-title-open-file")).toHaveText(
    "notes/today.md",
  );
  await page.getByTestId("history-diff-title-open-file").click();
  await expect(page.getByTestId("tab-notes/today.md")).toHaveAttribute(
    "data-active",
    "true",
  );
  await page.getByTestId(diffTabTestId).click();
  await expect(page.getByTestId("history-diff-page")).toBeVisible();
  await expect(page.getByTestId("history-diff-restore-file")).toContainText("Restore");

  await confirmRestore(page);
  await expect
    .poll(() => readFileSync(filePath, "utf8"), { timeout: 10_000 })
    .toBe("before\n");
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /restored the previous snapshot/i,
  );
  const firstRestore = await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.provenance?.restoreDirection === "restore" &&
      record.provenance.restoreOfChangeSetId === editRecord.id &&
      record.provenance.restoreOfPath === "notes/today.md",
  );
  expect(firstRestore.files[0]).toMatchObject({
    path: "notes/today.md",
    operation: "write",
    before: { text: "after\n" },
    after: { text: "before\n" },
  });
  await expectNoDohcHistoryNoise(page);

  // The immediate diff-tab undo should behave like a normal active-context
  // undo shortcut, and should also be recorded as explicit history.
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => readFileSync(filePath, "utf8"), { timeout: 10_000 })
    .toBe("after\n");
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /undid the restore/i,
  );
  await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.provenance?.restoreDirection === "undo" &&
      record.provenance.restoreOfChangeSetId === editRecord.id &&
      record.files.some(
        (file) =>
          file.path === "notes/today.md" &&
          file.before?.text === "before\n" &&
          file.after?.text === "after\n",
      ),
  );

  // Restore once more from the original edit, then open the restore-created
  // history entry. Its primary action should be durable "Undo restore" even
  // after leaving the original diff tab.
  await openNewestHistoryDiff(page, /you edited notes\/today\.md/i);
  await confirmRestore(page);
  await expect
    .poll(() => readFileSync(filePath, "utf8"), { timeout: 10_000 })
    .toBe("before\n");
  const secondRestore = await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.id !== firstRestore.id &&
      record.provenance?.restoreDirection === "restore" &&
      record.files.some(
        (file) =>
          file.path === "notes/today.md" &&
          file.before?.text === "after\n" &&
          file.after?.text === "before\n",
      ),
  );

  await expect(page.getByTestId("history-timeline")).toContainText(/restored notes\/today\.md/i, {
    timeout: 15_000,
  });
  await openNewestHistoryDiff(page, /restored notes\/today\.md/i);
  await expect(page.getByTestId("history-diff-restore-file")).toHaveText(
    "Undo restore...",
  );
  await confirmRestore(page);
  await expect
    .poll(() => readFileSync(filePath, "utf8"), { timeout: 10_000 })
    .toBe("after\n");
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /recorded in history/i,
  );
  await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.provenance?.restoreDirection === "undo" &&
      record.provenance.restoreOfChangeSetId === editRecord.id &&
      record.recordedAtMs > secondRestore.recordedAtMs,
  );

  await expectNoDohcHistoryNoise(page);
  await app.close();
});

test("history restore smoke: created file restore moves it away and undo recreates it", async () => {
  // Restore flows wait on filesystem watcher/history settle loops; the longer
  // timeout is a CI safety margin, not expected steady-state duration.
  test.setTimeout(90_000);
  const { home, root } = await seedWorkspace("history-restore-created", {
    "notes/anchor.md": "anchor\n",
  });
  const { app, page } = await openSeeded(home, root);
  const createdPath = join(root, "notes", "new.md");

  await writeFile(createdPath, "created\n");
  const createRecord = await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "user-edit" &&
      record.files.some(
        (file) =>
          file.path === "notes/new.md" &&
          file.before === null &&
          file.after?.text === "created\n",
      ),
  );
  await expect(page.getByTestId("history-timeline")).toContainText(/new\.md/i);

  await openNewestHistoryDiff(page, /new\.md/i);
  await confirmRestore(page);
  await expect.poll(() => existsSync(createdPath), { timeout: 10_000 }).toBe(false);
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /moved the created file to trash/i,
  );
  await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.provenance?.restoreDirection === "restore" &&
      record.provenance.restoreOfChangeSetId === createRecord.id &&
      record.files.some(
        (file) =>
          file.path === "notes/new.md" &&
          file.before?.text === "created\n" &&
          file.after === null,
      ),
  );

  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => (existsSync(createdPath) ? readFileSync(createdPath, "utf8") : null), {
      timeout: 10_000,
    })
    .toBe("created\n");
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /undid the restore/i,
  );
  await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.provenance?.restoreDirection === "undo" &&
      record.provenance.restoreOfChangeSetId === createRecord.id &&
      record.files.some(
        (file) =>
          file.path === "notes/new.md" &&
          file.before === null &&
          file.after?.text === "created\n",
      ),
  );

  await expectNoDohcHistoryNoise(page);
  await app.close();
});

test("history restore smoke: deleted file restore recreates it and undo removes it again", async () => {
  // Restore flows wait on filesystem watcher/history settle loops; the longer
  // timeout is a CI safety margin, not expected steady-state duration.
  test.setTimeout(90_000);
  const { home, root } = await seedWorkspace("history-restore-deleted", {
    "notes/deleted.md": "deleted body\n",
  });
  const { app, page } = await openSeeded(home, root);
  const deletedPath = join(root, "notes", "deleted.md");

  await rm(deletedPath);
  const deleteRecord = await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "user-edit" &&
      record.files.some(
        (file) =>
          file.path === "notes/deleted.md" &&
          file.before?.text === "deleted body\n" &&
          file.after === null,
      ),
  );
  await expect(page.getByTestId("history-timeline")).toContainText(/deleted\.md/i);

  await openNewestHistoryDiff(page, /deleted\.md/i);
  await confirmRestore(page);
  await expect
    .poll(() => (existsSync(deletedPath) ? readFileSync(deletedPath, "utf8") : null), {
      timeout: 10_000,
    })
    .toBe("deleted body\n");
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /restored the previous snapshot/i,
  );
  await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.provenance?.restoreDirection === "restore" &&
      record.provenance.restoreOfChangeSetId === deleteRecord.id &&
      record.files.some(
        (file) =>
          file.path === "notes/deleted.md" &&
          file.before === null &&
          file.after?.text === "deleted body\n",
      ),
  );

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => existsSync(deletedPath), { timeout: 10_000 }).toBe(false);
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /undid the restore/i,
  );
  await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "history-restore" &&
      record.provenance?.restoreDirection === "undo" &&
      record.provenance.restoreOfChangeSetId === deleteRecord.id &&
      record.files.some(
        (file) =>
          file.path === "notes/deleted.md" &&
          file.before?.text === "deleted body\n" &&
          file.after === null,
      ),
  );

  await expectNoDohcHistoryNoise(page);
  await app.close();
});

test("history restore smoke: stale live files are refused and do not create restore provenance", async () => {
  // Restore flows wait on filesystem watcher/history settle loops; the longer
  // timeout is a CI safety margin, not expected steady-state duration.
  test.setTimeout(90_000);
  const { home, root } = await seedWorkspace("history-restore-stale", {
    "notes/stale.md": "before\n",
  });
  const { app, page } = await openSeeded(home, root);
  const stalePath = join(root, "notes", "stale.md");

  await writeFile(stalePath, "after\n");
  const editRecord = await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "user-edit" &&
      record.files.some(
        (file) =>
          file.path === "notes/stale.md" &&
          file.before?.text === "before\n" &&
          file.after?.text === "after\n",
      ),
  );
  await openNewestHistoryDiff(page, /stale\.md/i);

  await writeFile(stalePath, "manual later\n");
  await waitForHistoryRecord(
    root,
    (record) =>
      record.kind === "user-edit" &&
      record.id !== editRecord.id &&
      record.files.some(
        (file) =>
          file.path === "notes/stale.md" &&
          file.before?.text === "after\n" &&
          file.after?.text === "manual later\n",
      ),
  );

  await confirmRestore(page);
  await expect(page.getByTestId("history-diff-restore-status")).toContainText(
    /live file changed/i,
  );
  expect(readFileSync(stalePath, "utf8")).toBe("manual later\n");

  const records = await historyRecords(root);
  expect(
    records.some(
      (record) =>
        record.kind === "history-restore" &&
        record.provenance?.restoreOfChangeSetId === editRecord.id,
    ),
  ).toBe(false);
  await expectNoDohcHistoryNoise(page);
  await app.close();
});

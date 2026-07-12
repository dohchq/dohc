import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openHistoryView,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// PR 08 — SECRET-BACKED FILES, THE MARQUEE CLAIM AS A TEST: dohc can version
// `.env` safely, which git cannot. A flagged workspace with a .env gets a
// PROTECTED history moment (lock, "Contents are protected", no diff), the
// secret follows a version switch on disk, search finds nothing, and the
// persisted engine.db never contains the plaintext.

const SECRET_VALUE = "E2E_SUPER_SECRET_a1b2c3d4";
const ENV_MAIN = `API_KEY=${SECRET_VALUE}\n`;
const ENV_EXPERIMENT = `API_KEY=${SECRET_VALUE}\nMODE=experiment\n`;

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

function withEngineDb<T>(
  rootPath: string,
  read: (db: InstanceType<typeof DatabaseSync>) => T,
): T | null {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
      readOnly: true,
    });
  } catch {
    return null;
  }
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function secretMomentCount(rootPath: string): number | null {
  return withEngineDb(rootPath, (db) => {
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM secret_moments").get();
      return Number(row?.count ?? 0);
    } catch {
      return null;
    }
  });
}

async function engineDbBytes(rootPath: string): Promise<Buffer> {
  const base = join(rootPath, ".dohc/engine/engine.db");
  const chunks: Buffer[] = [];
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      chunks.push(await readFile(path));
    } catch {
      // Absent WAL/SHM contribute nothing.
    }
  }
  return Buffer.concat(chunks);
}

async function readWorkspaceText(rootPath: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(rootPath, path), "utf8");
  } catch {
    return null;
  }
}

async function openVersionMenu(page: Page): Promise<void> {
  const button = page.getByTestId("version-menu-button");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId("version-menu")).toBeVisible();
}

async function expectActiveVersion(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("version-menu-active")).toHaveText(name, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("version-menu-button")).toBeEnabled();
}

async function createVersionViaMenu(page: Page, name: string): Promise<void> {
  await openVersionMenu(page);
  await page.getByTestId("version-new").click();
  await page.getByTestId("version-new-input").fill(name);
  await page.getByTestId("version-new-input").press("Enter");
  await expectActiveVersion(page, name);
}

async function switchVersionViaMenu(page: Page, name: string): Promise<void> {
  await openVersionMenu(page);
  await page
    .locator(`[data-testid="version-item"][data-version-name="${name}"]`)
    .click();
  await expectActiveVersion(page, name);
}

test("a .env is versioned protected: locked history, versions carry it, search finds nothing, no plaintext at rest", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "ordinary findable prose\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes.md");
    await expectActiveVersion(page, "Main");

    // 1. A live .env edit is captured ENCRYPTED with a protected
    //    metadata-only moment.
    await writeWorkspaceFiles(temp, [{ path: ".env", contents: ENV_MAIN }]);
    await expect
      .poll(() => secretMomentCount(temp.rootPath), { timeout: 30_000 })
      .toBe(1);
    const protectedRow = page.locator(
      '[data-testid="engine-moment-open"][data-moment-path=".env"]',
    );
    // History lives in the left History view (the right panel is Chats now).
    await openHistoryView(page);
    await expect(protectedRow.first()).toBeVisible({ timeout: 20_000 });
    await expect(protectedRow.first()).toContainText("Updated .env");
    await expect(
      protectedRow.first().getByTestId("engine-moment-lock"),
    ).toBeVisible();

    // 2. The moment's page shows the lock copy and NO contents.
    await protectedRow.first().click();
    await expect(page.getByTestId("engine-moment-diff-page")).toBeVisible();
    await expect(page.getByTestId("engine-diff-protected")).toContainText(
      "Contents are protected",
    );
    await expect(page.getByTestId("engine-diff-lines")).toHaveCount(0);
    const diffPageText = await page
      .getByTestId("engine-moment-diff-page")
      .textContent();
    expect(diffPageText ?? "").not.toContain(SECRET_VALUE);

    // 3. Secrets follow versions: edit .env in a fork, switch back — the
    //    folder's .env returns to Main's copy; forward again, it follows.
    await createVersionViaMenu(page, "Experiment");
    await writeWorkspaceFiles(temp, [{ path: ".env", contents: ENV_EXPERIMENT }]);
    await expect
      .poll(() => secretMomentCount(temp.rootPath), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    await switchVersionViaMenu(page, "Main");
    await expect
      .poll(() => readWorkspaceText(temp.rootPath, ".env"), { timeout: 20_000 })
      .toBe(ENV_MAIN);

    await switchVersionViaMenu(page, "Experiment");
    await expect
      .poll(() => readWorkspaceText(temp.rootPath, ".env"), { timeout: 20_000 })
      .toBe(ENV_EXPERIMENT);

    // 4. Compare with Main renders the protected row without contents.
    await openVersionMenu(page);
    await page.getByTestId("version-compare").click();
    await expect(page.getByTestId("version-compare-page")).toBeVisible();
    const compareRow = page.locator(
      '[data-testid="version-compare-file"][data-compare-path=".env"]',
    );
    await expect(compareRow).toBeVisible({ timeout: 20_000 });
    await expect(compareRow.getByTestId("version-compare-protected")).toContainText(
      "Protected file changed",
    );
    expect((await compareRow.textContent()) ?? "").not.toContain(SECRET_VALUE);

    // 5. Search: the secret value is unfindable; ordinary text still works.
    await page.getByTestId("activity-search").click();
    await expect(page.getByTestId("search-view")).toBeVisible();
    await page.getByTestId("search-input").fill(SECRET_VALUE);
    await expect(page.getByTestId("search-empty-state")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("search-input").fill("findable");
    await expect(
      page.locator('[data-testid="search-result-group"][data-path="notes.md"]'),
    ).toBeVisible({ timeout: 20_000 });

    // 6. ADVERSARIAL: the persisted engine.db (+wal/shm) never contains the
    //    plaintext secret.
    const bytes = await engineDbBytes(temp.rootPath);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.includes(Buffer.from(SECRET_VALUE, "utf8"))).toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

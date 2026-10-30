import { desktopPins, activityPin } from "../../src/testPins";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { normalizeAbsolutePath } from "@dohc/workspace-core";
import { DEFAULT_WORKSPACE_SETTINGS } from "../../src/workspaces/workspaceSettings";
import { canonicalWorkspaceRoot } from "../../src/workspaces/createWorkspaceFolder";
import {
  createTestScratch,
  removeTestScratch,
} from "../../src/workspaces/testTemp";

export interface TempWorkspace {
  baseDir: string;
  homeDir: string;
  rootPath: string;
  cleanup(): Promise<void>;
}

export interface CloseableDesktop {
  close(): Promise<void>;
}

export interface WorkspaceFileWrite {
  path: string;
  contents: string | Uint8Array;
}

export interface WorkspaceSummary {
  workspaceId: string;
  rootPath: string;
  kind: "personal" | "shared" | "cloud-only";
  mode: "local-first" | "cloud-first-local-copy" | "cloud-only";
}

export async function createTempWorkspace(): Promise<TempWorkspace> {
  const baseDir = await createTestScratch("dohc-desktop-e2e-");
  const homeDir = join(baseDir, "home");
  const rootPath = join(baseDir, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(rootPath, { recursive: true });
  return {
    baseDir,
    homeDir,
    rootPath,
    cleanup: () => removeTestScratch(baseDir),
  };
}

export async function cleanupDesktopWorkspace(
  desktop: CloseableDesktop | null | undefined,
  workspace: Pick<TempWorkspace, "cleanup">,
): Promise<void> {
  try {
    if (desktop) await desktop.close();
  } catch (error) {
    console.error("[desktop-e2e] desktop close failed:", error);
  }
  try {
    await workspace.cleanup();
  } catch (error) {
    console.error("[desktop-e2e] workspace cleanup failed:", error);
  }
}

/**
 * Validates workspace-relative test paths before writing fixture files.
 * Both raw and decoded forms are checked so encoded traversal cannot bypass the
 * guard. This rejects absolute paths, parent/current directory references,
 * empty segments, null bytes, and backslashes before a test can escape the
 * temporary workspace root.
 */
function assertSafeRelativePath(path: string): void {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`Unsafe workspace-relative test path: ${path}`);
  }
  if (
    !path ||
    isAbsolute(path) ||
    isAbsolute(decoded) ||
    path.includes("\0") ||
    path.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    decoded.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe workspace-relative test path: ${path}`);
  }
}

// Seeds .dohc/local/settings.local.json before launch so a spec can set
// per-workspace settings without driving the settings UI. Built FROM
// DEFAULT_WORKSPACE_SETTINGS (the strict schema's canonical default) so the
// seed can never drift from the shape the app parses.
export async function seedWorkspaceSettings(
  workspace: Pick<TempWorkspace, "rootPath">,
  overrides: {
    files?: Partial<(typeof DEFAULT_WORKSPACE_SETTINGS)["files"]>;
  } = {},
): Promise<void> {
  const settings = {
    ...DEFAULT_WORKSPACE_SETTINGS,
    files: {
      ...DEFAULT_WORKSPACE_SETTINGS.files,
      ...overrides.files,
    },
  };
  // The engine's first open takes this folder and makes it private.
  const dir = join(workspace.rootPath, ".dohc", "local");
  await mkdir(dir, { recursive: true });
  // dohc reads a settings file only if no other user can write it.
  await writeFile(
    join(dir, "settings.local.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    { mode: 0o600 },
  );
}

// Seeds.dohc/manifest.json with a known workspace id before launch so a
// spec can pre-populate per-workspace state (engine.db moments, chats) that
// the app will adopt — createWorkspaceFolder preserves an existing manifest's
// identity.
// One shape for every seeded workspace: seedWorkspaceManifest and
// seedWorkspaceRegistry must agree on kind/mode or the app would see a
// manifest/registry mismatch.
const SEEDED_WORKSPACE_SHAPE = { kind: "personal", mode: "local-first" } as const;

export async function seedWorkspaceManifest(
  workspace: Pick<TempWorkspace, "rootPath">,
  workspaceId: string,
): Promise<void> {
  const dir = join(workspace.rootPath, ".dohc");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      { version: 1, workspaceId, ...SEEDED_WORKSPACE_SHAPE },
      null,
      2,
    )}\n`,
  );
}

// A second workspace root beside the primary one (same temp sandbox, same
// hermetic DOHC_TEST_HOME).
export async function createSiblingWorkspaceDir(
  workspace: Pick<TempWorkspace, "baseDir">,
  name: string,
): Promise<{ rootPath: string }> {
  const rootPath = join(workspace.baseDir, name);
  await mkdir(rootPath, { recursive: true });
  return { rootPath };
}

// Pre-seeds the hermetic registry (dohc-workspaces.json under the test home)
// so the app launches with multiple known workspaces and the titlebar
// switcher can move between them. An entry's optional `remote` marks the
// workspace as cloud-synced (the 0P sync specs seed it so the relay engine
// attaches at open without driving the enable-sync UI, which has its own
// coverage).
export async function seedWorkspaceRegistry(
  workspace: Pick<TempWorkspace, "homeDir">,
  entries: Array<{
    workspaceId: string;
    rootPath: string;
    remote?: {
      serverUrl: string;
      ownerUserId: string;
    };
    // Mount records as the registry stores them (`ShareMountRecord`).
    shareMounts?: ReadonlyArray<Record<string, unknown>>;
  }>,
): Promise<void> {
  await mkdir(workspace.homeDir, { recursive: true });
  await writeFile(
    join(workspace.homeDir, "dohc-workspaces.json"),
    `${JSON.stringify(
      {
        version: 1,
        workspaces: entries.map((entry) => ({
          workspaceId: entry.workspaceId,
          // The forward-slash form (matters on Windows). The app moves a
          // spelling through a link to the folder's real path when it loads.
          rootPath: normalizeAbsolutePath(entry.rootPath),
          ...SEEDED_WORKSPACE_SHAPE,
          ...(entry.remote ? { remote: entry.remote } : {}),
          ...(entry.shareMounts ? { shareMounts: entry.shareMounts } : {}),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

// Seeds the desktop's cloud session file (dohc-cloud.json in the hermetic
// state dir) with a plaintext-fallback token — exactly what the credential
// store writes when no OS keychain exists — so a spec launches signed in.
// The relay's SYNC_RELAY_TEST_AUTH seam accepts `test:<user>` bearers.
export async function seedCloudCredentials(
  workspace: Pick<TempWorkspace, "homeDir">,
  input: {
    serverUrl: string;
    relayUrl: string;
    userId: string;
    email?: string;
    token?: string;
  },
): Promise<void> {
  await mkdir(workspace.homeDir, { recursive: true });
  await writeFile(
    join(workspace.homeDir, "dohc-cloud.json"),
    `${JSON.stringify(
      {
        version: 1,
        serverUrl: input.serverUrl,
        relayUrl: input.relayUrl,
        email: input.email ?? "e2e@dohc.dev",
        userId: input.userId,
        token: `plain:${input.token ?? "test:e2e-user"}`,
      },
      null,
      2,
    )}\n`,
  );
}

export async function writeWorkspaceFiles(
  workspace: Pick<TempWorkspace, "rootPath">,
  files: WorkspaceFileWrite[],
): Promise<void> {
  for (const file of files) {
    assertSafeRelativePath(file.path);
    const absolute = join(workspace.rootPath, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.contents);
  }
}

function cssString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\a ")
    .replace(/\r/g, "\\d ")
    .replace(/\t/g, "\\9 ")
    .replace(/\f/g, "\\c ")
    .replace(/"/g, '\\"')}"`;
}

export function explorerRow(page: Page, path: string) {
  return page.locator(
    `[data-testid="tree-row"][data-path=${cssString(path)}]`,
  );
}

export async function waitForWorkspaceReady(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-shell")).toHaveAttribute(
    "data-ready",
    "true",
  );
}

// An opened folder starts in Restricted Mode, where dohc starts no agent and
// runs no app code. This trusts it the way a person does: Restricted Mode in
// the title bar, then Trust workspace in main's dialog, answered here.
export async function trustOpenWorkspace(desktop: { app: ElectronApplication; page: Page }): Promise<void> {
  await desktop.app.evaluate(({ dialog }) => {
    const ask = dialog.showMessageBox;
    dialog.showMessageBox = (async () => {
      dialog.showMessageBox = ask;
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const indicator = desktop.page.getByTestId("restricted-mode-indicator");
  await indicator.click();
  await expect(indicator).toHaveCount(0);
}

// A manifest seeded on disk names no computer for the workspace's
// Collections, as a workspace from before dohc kept that record does. The
// test keeps them on this desktop, as its person would, before using them.
export async function keepCollectionsHere(page: Page, workspaceId: string): Promise<void> {
  expect(await page.evaluate(id => window.dohcDesktop!.keepCollectionsHere({ workspaceId: id }), workspaceId)).toEqual({ kept: true });
}

export async function openWorkspaceFromFirstRun(
  page: Page,
  workspace: Pick<TempWorkspace, "rootPath">,
): Promise<WorkspaceSummary> {
  const shell = page.getByTestId("workspace-shell");
  const openFolder = page.getByTestId("workspace-manager").getByRole("button", { name: "Open folder", exact: true });
  let surface: "shell" | "first-run";
  try {
    surface = await Promise.race([
      shell.waitFor({ state: "attached", timeout: 20_000 }).then(() => "shell" as const),
      openFolder.waitFor({ state: "visible", timeout: 20_000 }).then(() => "first-run" as const),
    ]);
  } catch (cause) {
    throw new Error(
      `Timed out waiting for workspace shell or first-run picker: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (surface === "first-run") {
    await openFolder.click();
  }
  await waitForWorkspaceReady(page);
  await showExplorerFiles(page);
  return activeWorkspace(page, workspace.rootPath);
}

// A workspace opens its Explorer on Home. Most specs drive the file tree, so
// once the saved layout is restored they switch a shown Explorer to Files.
// A spec that needs Home's sections calls openExplorerHome.
async function showExplorerFiles(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-workbench")).not.toHaveAttribute("inert");
  const files = page.getByTestId("explorer-mode-files");
  if ((await files.count()) === 0 || (await files.getAttribute("aria-selected")) === "true") return;
  await files.click();
  await expect(files).toHaveAttribute("aria-selected", "true");
}

/** Switches the Explorer to Home, where Pinned, Pages, Collections and Apps live. */
export async function openExplorerHome(page: Page): Promise<void> {
  await openExplorerView(page);
  await page.getByTestId("explorer-mode-home").click();
  await expect(page.getByTestId("explorer-home")).toBeVisible();
}

export async function activeWorkspace(
  page: Page,
  rootPath: string,
): Promise<WorkspaceSummary> {
  // The registry stores a workspace by its real path in the app's forward-slash
  // form. Scratch roots can lead through links (macOS /tmp, Windows 8.3 names).
  const expected = canonicalWorkspaceRoot(rootPath);
  const workspace = await page.waitForFunction(
    async (expectedRootPath) => {
      const api = (window as unknown as {
        dohcDesktop?: {
          getWorkspaceRegistry(): Promise<{ workspaces: WorkspaceSummary[] }>;
        };
      }).dohcDesktop;
      if (!api) return null;
      const registry = await api.getWorkspaceRegistry();
      return (
        registry.workspaces.find(
          (entry) => entry.rootPath === expectedRootPath,
        ) ?? null
      );
    },
    expected,
  );
  const value = await workspace.jsonValue();
  if (!value) throw new Error(`Workspace was not registered: ${rootPath}`);
  return value;
}

export async function waitForWorkspaceFile(
  page: Page,
  workspaceId: string,
  path: string,
): Promise<void> {
  assertSafeRelativePath(path);
  await page.waitForFunction(
    async ({ expectedPath, id }) => {
      const api = (window as unknown as {
        dohcDesktop?: {
          listWorkspaceFiles(payload: { workspaceId: string }): Promise<{
            files: Array<{ path: string }>;
            folders?: string[];
          }>;
        };
      }).dohcDesktop;
      if (!api) return false;
      const result = await api.listWorkspaceFiles({ workspaceId: id });
      return (
        result.files.some((file) => file.path === expectedPath) ||
        (result.folders ?? []).includes(expectedPath)
      );
    },
    { expectedPath: path, id: workspaceId },
  );
}

// Waits until the engine owns the file under a stable object id, which a
// chat needs before it can link or mention it.
export async function waitForFileObjectId(
  page: Page,
  workspaceId: string,
  path: string,
): Promise<void> {
  await page.waitForFunction(
    async ({ id, filePath }) => {
      const api = (window as unknown as {
        dohcDesktop?: {
          listFileChats(payload: { workspaceId: string; path: string }): Promise<{
            fileObjectId: string | null;
          }>;
        };
      }).dohcDesktop;
      if (!api) return false;
      const result = await api.listFileChats({ workspaceId: id, path: filePath });
      return result.fileObjectId !== null;
    },
    { id: workspaceId, filePath: path },
  );
}

function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  return segments
    .slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join("/"));
}

export async function revealExplorerPath(
  page: Page,
  path: string,
): Promise<void> {
  assertSafeRelativePath(path);
  await openExplorerView(page);
  for (const folder of ancestorsOf(path)) {
    const row = explorerRow(page, folder);
    await expect(row).toBeVisible();
    if ((await row.getAttribute("aria-expanded")) !== "true") {
      await row.click();
    }
  }
  await expect(explorerRow(page, path)).toBeVisible();
}

// Opens the left Explorer view, which shares the side panel with Chats
// (idempotent, like openHistoryView).
export async function openExplorerView(page: Page): Promise<void> {
  const button = page.getByTestId(activityPin("explorer"));
  if ((await button.getAttribute("aria-current")) !== "page") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-current", "page");
}

// Opens the left History view (idempotent: re-clicking the active activity
// entry would collapse the side panel, and a restored ui-state may bring the
// view back already open). aria-current="page" is exactly "history view
// showing" — active view and visible panel.
export async function openHistoryView(page: Page): Promise<void> {
  const button = page.getByTestId(activityPin("history"));
  if ((await button.getAttribute("aria-current")) !== "page") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-current", "page");
}

// Opens the right-hand About rail — the active file's chats, history and
// access (idempotent: the rail's visibility persists in ui-state, so a
// relaunch may restore it already open).
export async function openAboutPanel(page: Page): Promise<void> {
  const rail = page.getByTestId(desktopPins.aboutRail);
  if (!(await rail.isVisible())) {
    await page.getByTestId(desktopPins.titlebarAboutSidebar).click();
    await expect(rail).toBeVisible();
  }
}

// Opens the left Chats view (idempotent, like openHistoryView) and returns
// the side panel that holds the chat list.
export async function openChatsView(page: Page): Promise<Locator> {
  const button = page.getByTestId(activityPin("chats"));
  if ((await button.getAttribute("aria-current")) !== "page") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-current", "page");
  const panel = page.getByTestId(desktopPins.sidePanel);
  await expect(panel.getByTestId("chats-view")).toBeVisible();
  return panel;
}

export async function expectVisibleContent(
  page: Page,
  text: string | RegExp,
): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible();
}

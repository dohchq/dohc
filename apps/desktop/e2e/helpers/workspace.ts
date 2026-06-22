import { expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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
  const baseDir = await mkdtemp(join(tmpdir(), "dohc-desktop-e2e-"));
  const homeDir = join(baseDir, "home");
  const rootPath = join(baseDir, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(rootPath, { recursive: true });
  return {
    baseDir,
    homeDir,
    rootPath,
    cleanup: () => rm(baseDir, { recursive: true, force: true }),
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

export async function openWorkspaceFromFirstRun(
  page: Page,
  workspace: Pick<TempWorkspace, "rootPath">,
): Promise<WorkspaceSummary> {
  const shell = page.getByTestId("workspace-shell");
  const openFolder = page.getByRole("button", {
    name: /open an existing folder as a workspace/i,
  });
  let surface: "shell" | "first-run";
  try {
    surface = await Promise.race([
      shell.waitFor({ state: "attached", timeout: 10_000 }).then(() => "shell" as const),
      openFolder.waitFor({ state: "visible", timeout: 10_000 }).then(() => "first-run" as const),
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
  return activeWorkspace(page, workspace.rootPath);
}

export async function activeWorkspace(
  page: Page,
  rootPath: string,
): Promise<WorkspaceSummary> {
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
    rootPath,
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
  for (const folder of ancestorsOf(path)) {
    const row = explorerRow(page, folder);
    await expect(row).toBeVisible();
    if ((await row.getAttribute("aria-expanded")) !== "true") {
      await row.click();
    }
  }
  await expect(explorerRow(page, path)).toBeVisible();
}

export async function expectVisibleContent(
  page: Page,
  text: string | RegExp,
): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible();
}

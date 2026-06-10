import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Registry of known local workspaces. Lives in Electron userData; in test
// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
// formalizes attachment/duplicate rules with dedicated tests.

function testHome(): string | null {
  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
    ? (process.env.DOHC_TEST_HOME ?? null)
    : null;
}

export function effectiveHome(): string {
  return testHome() ?? homedir();
}

function registryPath(): string {
  const base = testHome() ?? app.getPath("userData");
  return join(base, "dohc-workspaces.json");
}

interface RegistryFile {
  version: 1;
  workspaces: CreatedWorkspace[];
}

function readRegistry(): RegistryFile {
  try {
    const parsed = JSON.parse(
      readFileSync(registryPath(), "utf8"),
    ) as RegistryFile;
    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
  } catch {
    return { version: 1, workspaces: [] };
  }
}

function writeRegistry(registry: RegistryFile): void {
  mkdirSync(dirname(registryPath()), { recursive: true });
  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

export function listWorkspaces(): CreatedWorkspace[] {
  return readRegistry().workspaces;
}

export function registerWorkspace(workspace: CreatedWorkspace): void {
  const registry = readRegistry();
  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
    return;
  }
  registry.workspaces.push(workspace);
  writeRegistry(registry);
}

export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
  return (
    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
    null
  );
}

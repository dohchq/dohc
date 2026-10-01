import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createDesktopAutomationControls } from "./desktopAutomationControls";
import type { RegistryEntry } from "./registryStore";
import type { WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import type { ShareViewFiles } from "./shareViewFiles";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";

const text = "version: 1\nautomations: []\n", hash = createHash("sha256").update(text).digest("hex");
it.each(["view", "comment", "edit"] as const)("reads %s definitions from the canonical named share store", async access => {
  const read = vi.fn(async () => ({ kind: "text", text, contentHash: hash, truncated: false }));
  const workspace = { workspaceId: "w", rootPath: "/projection", attachmentId: Symbol(), shareView: { shareId: "s", grantedSelector: { paths: ["Tasks"], versionId: null as string | null, access } } };
  const operation = { workspace, state: {}, assertCurrent: () => undefined } as unknown as WorkspaceAuthorityOperation<RegistryEntry, Record<string, never>>;
  const controls = createDesktopAutomationControls({ operation, files: { read } as unknown as ShareViewFiles,
    sessions: () => ({ run: async () => ({ contentHash: hash, state: "accepted" }) }) as unknown as EngineWorkspaceSessions,
    canSwitch: async () => true, edited: () => undefined });
  await expect(controls.list("Tasks")).resolves.toMatchObject({ canSwitch: access === "edit", file: { status: "read" }, sync: "accepted" });
  expect(read).toHaveBeenCalledWith({ kind: "standalone", workspaceId: "w" }, { kind: "text", path: "Tasks/automations.yaml" });
  workspace.shareView = { shareId: "s", grantedSelector: { paths: ["Tasks/one.md"], versionId: null, access } };
  read.mockClear();
  await expect(controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, file: { status: "missing" }, sync: "accepted" });
  expect(read).not.toHaveBeenCalled();
  workspace.shareView = { shareId: "s", grantedSelector: { paths: ["Tasks"], versionId: "saved", access } };
  await expect(controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, file: { status: "read" } });
});

it.each(["view", "comment", "edit"] as const)("reads a whole saved version with %s access without a direct-write query", async access => {
  const workspace = { workspaceId: "w", rootPath: "/projection", attachmentId: Symbol(),
    shareView: { shareId: "s", grantedSelector: { paths: [], versionId: "saved", access } } };
  const operation = { workspace, state: {}, assertCurrent: () => undefined } as unknown as WorkspaceAuthorityOperation<RegistryEntry, Record<string, never>>;
  const run = vi.fn(async () => { throw new Error("Saved versions have no direct writes."); });
  const controls = createDesktopAutomationControls({ operation,
    files: { read: async () => ({ kind: "text", text, contentHash: hash, truncated: false }) } as unknown as ShareViewFiles,
    sessions: () => ({ run }) as unknown as EngineWorkspaceSessions, canSwitch: async () => true, edited: () => undefined });
  await expect(controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, file: { status: "read" }, sync: "accepted" });
  expect(run).not.toHaveBeenCalled();
});

it("keeps pending saves pending after a downgrade and never pushes from a read", async () => {
  const workspace = { workspaceId: "w", rootPath: "/projection", attachmentId: Symbol(), shareView: { shareId: "s", ended: false,
    grantedSelector: { paths: ["Tasks"], versionId: null, access: "edit" as "edit" | "view" | "comment" } } };
  const operation = { workspace, state: {}, assertCurrent: () => undefined } as unknown as WorkspaceAuthorityOperation<RegistryEntry, Record<string, never>>;
  const edited = vi.fn();
  const controls = createDesktopAutomationControls({ operation,
    files: { read: async () => ({ kind: "text", text, contentHash: hash, truncated: false }) } as unknown as ShareViewFiles,
    sessions: () => ({ run: async () => ({ contentHash: hash, state: "pending" }) }) as unknown as EngineWorkspaceSessions,
    canSwitch: async () => true, edited });
  await expect(controls.list("Tasks")).resolves.toMatchObject({ sync: "pending", canSwitch: true });
  for (const access of ["view", "comment"] as const) {
    workspace.shareView.grantedSelector.access = access;
    await expect(controls.list("Tasks")).resolves.toMatchObject({ sync: "pending", canSwitch: false });
  }
  workspace.shareView.ended = true;
  await expect(controls.list("Tasks")).resolves.toMatchObject({ sync: "pending", canSwitch: false });
  expect(edited).not.toHaveBeenCalled();
});

it.each(["committed", "indeterminate", "conflict"] as const)("uses the shared file lane for a %s switch outcome", async outcome => {
  const source = "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ready\n";
  const base = createHash("sha256").update(source).digest("hex");
  const workspace = { workspaceId: "w", rootPath: process.cwd(), attachmentId: Symbol(),
    shareView: { shareId: "s", grantedSelector: { paths: ["Tasks"], versionId: null, access: "edit" } } };
  const operation = { workspace, state: {}, assertCurrent: () => undefined } as unknown as WorkspaceAuthorityOperation<RegistryEntry, Record<string, never>>;
  const edited = vi.fn(), change = vi.fn(async () => outcome === "indeterminate" ? { status: "indeterminate" }
    : { status: "committed", value: { status: outcome === "conflict" ? "conflict" : "written" } });
  const controls = createDesktopAutomationControls({ operation, files: { change,
    read: async () => ({ kind: "text", text: source, contentHash: base, truncated: false }) } as unknown as ShareViewFiles,
    sessions: () => ({ run: async () => ({ contentHash: base, state: "pending" }) }) as unknown as EngineWorkspaceSessions,
    canSwitch: async () => true, edited });
  await expect(controls.switch("Tasks", { automation: "stamp", enabled: false, expectedContentHash: base, reformat: true, submitId: "switch-1" }))
    .resolves.toMatchObject({ status: outcome === "committed" ? "written" : outcome === "indeterminate" ? "unknown" : "conflict" });
  expect(change).toHaveBeenCalledWith(expect.anything(), { kind: "standalone", workspaceId: "w" }, expect.objectContaining({
    kind: "save", path: "Tasks/automations.yaml", expectedContentHash: base,
  }));
  expect(edited).toHaveBeenCalledTimes(outcome === "conflict" ? 0 : 1);
});

it("withholds refused catalog switches and offline preflights without losing pending delivery", async () => {
  const workspace = { workspaceId: "w", rootPath: process.cwd(), attachmentId: Symbol(),
    shareView: { shareId: "s", grantedSelector: { paths: ["Tasks"], versionId: null, access: "edit" } } };
  const operation = { workspace, state: {}, assertCurrent: () => undefined } as unknown as WorkspaceAuthorityOperation<RegistryEntry, Record<string, never>>;
  const canSwitch = vi.fn(async () => false), change = vi.fn();
  const controls = createDesktopAutomationControls({ operation, files: { change,
    read: async () => ({ kind: "text", text, contentHash: hash, truncated: false }) } as unknown as ShareViewFiles,
    sessions: () => ({ run: async () => ({ contentHash: hash, state: "pending" }) }) as unknown as EngineWorkspaceSessions,
    canSwitch, edited: () => undefined });
  await expect(controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, sync: "pending", switchReason: expect.stringContaining("server does not accept") });
  expect(canSwitch).toHaveBeenCalledTimes(1);
  canSwitch.mockRejectedValue(new Error("offline"));
  await expect(controls.list("Tasks")).resolves.toMatchObject({ canSwitch: false, sync: "pending", switchReason: expect.stringContaining("when connected") });
  expect(change).not.toHaveBeenCalled();
});

it("reads mounted definitions without offering or querying a switch", async () => {
  const rootPath = await mkdtemp(join(process.cwd(), ".automation-controls-"));
  try {
    await mkdir(join(rootPath, "shared-with-me", "alex", "Tasks"), { recursive: true });
    const workspace = { workspaceId: "w", rootPath, attachmentId: Symbol(), shareMounts: [{ shareId: "s", label: "alex",
      granterEmail: "alex@example.test", relayUrl: "https://relay.example.test", grantedSelector: { paths: ["Tasks"], versionId: null, access: "edit" } }] };
    const operation = { workspace, state: {}, assertCurrent: () => undefined } as unknown as WorkspaceAuthorityOperation<RegistryEntry, Record<string, never>>;
    const canSwitch = vi.fn(), run = vi.fn(), change = vi.fn();
    const controls = createDesktopAutomationControls({ operation, files: { change,
      read: async () => ({ kind: "text", text, contentHash: hash, truncated: false }) } as unknown as ShareViewFiles,
      sessions: () => ({ run }) as unknown as EngineWorkspaceSessions, canSwitch, edited: () => undefined });
    await expect(controls.list("shared-with-me/alex/Tasks")).resolves.toMatchObject({ file: { status: "read" }, canSwitch: false,
      switchReason: expect.stringContaining("own workspace") });
    expect(canSwitch).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  } finally {
    if (dirname(resolve(rootPath)) !== resolve(process.cwd())) throw new Error("Test folder escaped its workspace.");
    await rm(rootPath, { recursive: true, force: true });
  }
});

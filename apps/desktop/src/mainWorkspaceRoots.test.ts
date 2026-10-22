import { readFileSync, realpathSync } from "node:fs";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { canonicalWorkspaceRoot } from "./workspaces/createWorkspaceFolder";
import { createTestScratch } from "./workspaces/testTemp";
import { workspaceRootsMatch } from "./workspaces/workspaceRootsMatch";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

// Exercise main's closures without booting Electron or starting a daemon.
function mainClosure<T>(start: string, end: string, result: string, dependencies: Record<string, unknown>, suffix = ""): T {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing main closure: ${start}`);
  const { code } = transformSync(`${source.slice(from, to)}${suffix}\nreturn ${result};`, { loader: "ts", target: "esnext" });
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies)) as T;
}

type Workspace = { workspaceId: string; rootPath: string };

async function roots() {
  const folder = await createTestScratch("root-spelling-");
  const other = await createTestScratch("root-spelling-other-");
  return { native: realpathSync.native(folder), registry: canonicalWorkspaceRoot(folder), other: canonicalWorkspaceRoot(other) };
}

it.each(["native", "registry", "other"] as const)("reopens the local Collection host only for its folder (%s)", async spelling => {
  const root = await roots();
  const workspace = { workspaceId: "workspace", rootPath: root[spelling] };
  const host = {};
  const operation = {
    workspace: { ...workspace, rootPath: root.native, attachmentId: Symbol("attachment") },
    state: { datasetHost: { pending: Promise.resolve(host) } },
    assertCurrent: vi.fn(),
  };
  if (process.platform === "win32") expect(root.native).not.toBe(root.registry);
  const localDatasetHostFor = mainClosure<(workspace: Workspace, signal: AbortSignal) => Promise<unknown>>(
    "const localDatasetHostFor =", "const chatWrites =", "localDatasetHostFor", {
      workspaceAuthorities: { withOperation: async (_id: string, work: (value: typeof operation) => unknown) => work(operation) },
      workspaceRootsMatch,
    });
  const result = localDatasetHostFor(workspace, new AbortController().signal);
  if (spelling === "other") await expect(result).rejects.toThrow("This workspace changed while this ran.");
  else await expect(result).resolves.toBe(host);
});

it.each(["native", "registry", "other"] as const)("opens a dataset copy only for its folder (%s)", async spelling => {
  const root = await roots();
  const workspace = { workspaceId: "workspace", rootPath: root[spelling] };
  const operation = { workspace: { ...workspace, rootPath: root.native, attachmentId: Symbol("attachment") },
    signal: new AbortController().signal, assertCurrent: vi.fn() };
  const get = vi.fn(async () => "copy");
  const openCopy = mainClosure<() => Promise<unknown>>("const openCopy =", "// Right after launch", "openCopy", {
    workspace, workspaceRootsMatch, signal: new AbortController().signal, attachmentId: undefined,
    workspaceAuthorities: { withOperation: async (_id: string, work: (value: typeof operation) => unknown) => work(operation) },
    ownerDatasetCopies: { get }, datasetId: "dataset", targetOrigin: "https://relay.example", ownerKey: "owner",
    utilityProcess: {}, createDesktopAppRuntimeLauncher: vi.fn(), datasetRuntimePath: () => root.native,
    join: (...parts: string[]) => parts.join("/"),
  });
  // openCopy captures an attachment id in its enclosing remote-dataset scope.
  const result = openCopy();
  if (spelling === "other") {
    await expect(result).rejects.toThrow("This workspace changed while this ran.");
    expect(get).not.toHaveBeenCalled();
  } else await expect(result).resolves.toBe("copy");
});

it.each(["native", "registry", "other"] as const)("reads the engine adapter only for its registered folder (%s)", async spelling => {
  const root = await roots();
  const workspace = { workspaceId: "workspace", rootPath: root[spelling] };
  const withAttachment = vi.fn(async (_workspace: Workspace, work: (lease: object) => unknown) => work({}));
  const withEngineAdapter = mainClosure<(workspace: Workspace, work: () => Promise<string>) => Promise<unknown>>(
    "async function withEngineAdapter<", "const workspaceLinks =", "withEngineAdapter", {
      workspaceRootsMatch, findWorkspace: () => ({ ...workspace, rootPath: root.registry }),
      desktopEngine: { sessions: { run: async (_workspace: Workspace, work: (binding: object) => unknown) => work({}) } },
      withWorkspaceAttachmentAsync: withAttachment, engineWorkspaceForAuthority: () => ({ ...workspace, rootPath: root.native }),
      VersionedLiveAdapter: class {},
    });
  const read = vi.fn(async () => "read");
  const result = withEngineAdapter(workspace, read);
  if (spelling === "other") {
    await expect(result).rejects.toThrow("This workspace changed while this ran.");
    expect(read).not.toHaveBeenCalled();
  } else await expect(result).resolves.toBe("read");
});

it("reconciles after an engine restart using the operation's workspace", async () => {
  const root = await roots();
  const workspace = { workspaceId: "workspace", rootPath: root.registry };
  const physical = { ...workspace, rootPath: root.native };
  const reconcile = vi.fn();
  const onOpened = mainClosure<(workspaceId: string) => void>("const desktopEngine = createDesktopEngine({", "onRefusalsChanged:", "desktopEngine.onWorkspaceOpened", {
    resourcesBasePath: "", createDesktopEngine: (options: unknown) => options,
    findWorkspace: () => workspace, activity: { engineCaptureFor: () => ({}) },
    withWorkspaceAttachment: (_workspace: object, work: (lease: object) => unknown) => work({}),
    canonicalWorkspaceFor: () => physical, recoverOutageTyping: vi.fn(), reconcileLocalCollectionApps: reconcile,
    noticeStore: () => ({ refreshRefusals: async () => undefined }),
  }, "});");
  onOpened(workspace.workspaceId);
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(physical);
});

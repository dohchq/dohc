import { chmod, link, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonRefusalError, type Request, type Response } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions, type EngineDaemonClient } from "@dohc/workspace-engine-client/daemon";
import {
  existingLocalStateDir,
  localStateDir,
  localStateFolder,
  LocalStateFolderError,
  LocalStateUnavailableError,
  ownedSqliteFiles,
  readLocalStateFrom,
  readOwnedLocalState,
  readOwnedLocalStateFolder,
} from "./workspaceLocalState";
import { readUiStateFile } from "./workspaceUiState";
import { readWorkspaceSettingsFile } from "./workspaceSettingsFile";
import { createTestScratch } from "./testTemp";

// The folder a reader is given.
const ownedLocalStateDir = (rootPath: string) => readOwnedLocalState(rootPath, async (dir) => dir);
const existingLocalStateFolder = (rootPath: string, name: string) => readOwnedLocalStateFolder(rootPath, name, async (dir) => dir);

// A daemon whose opens answer as the engine's do: it prepares the folder,
// then says whether it is ready.
class Daemon implements EngineDaemonClient {
  ready = true;
  hold: Promise<void> | null = null;
  fail = false;
  busy = 0;

  async sendRequest(request: Request): Promise<Response> {
    if (request.method === "workspace.open") {
      await this.hold;
      if (this.busy > 0) {
        this.busy -= 1;
        throw new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined);
      }
      if (this.fail) throw new Error("open refused");
      const { rootDir } = request.params as { rootDir: string };
      await mkdir(join(rootDir, ".dohc", "local"), { recursive: true });
      return { id: request.id, result: { workspace: "handle", localStateReady: this.ready } };
    }
    if (request.method === "workspace.close") return { id: request.id, result: { closed: true } };
    throw new Error(`Unexpected method: ${request.method}`);
  }

  close(): void {}
}

const opened: EngineWorkspaceSessions[] = [];
afterEach(async () => {
  for (const sessions of opened.splice(0)) await sessions.closeAll();
});

let workspaces = 0;
async function engine(sleep: (ms: number) => Promise<void> = async () => undefined) {
  const daemon = new Daemon();
  const sessions = new EngineWorkspaceSessions({ currentClient: () => daemon }, { sleep });
  opened.push(sessions);
  readLocalStateFrom(sessions);
  workspaces += 1;
  const workspace = { workspaceId: `local-state-${workspaces}`, rootPath: await createTestScratch("dohc-local-state-") };
  const open = () => sessions.run(workspace, async () => undefined);
  return { daemon, sessions, workspace, open };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(LocalStateUnavailableError);
  return (error as LocalStateUnavailableError).refusal;
}

describe("this computer's .dohc/local", () => {
  it("refuses a writer until this workspace's engine open finished, and creates nothing", async () => {
    const { workspace, open } = await engine();
    expect(await refusal(localStateDir(workspace))).toBe("not-opened");
    expect(await lstat(join(workspace.rootPath, ".dohc")).catch(() => null)).toBeNull();

    // A folder an earlier run of dohc left is not this open's.
    await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
    expect(await refusal(localStateDir(workspace))).toBe("not-opened");

    await open();
    const dir = await localStateDir(workspace);
    expect(await readdir(dir)).toEqual([]);
    // Nor does this open say anything about the same workspace at another root.
    const elsewhere = { ...workspace, rootPath: await createTestScratch("dohc-local-state-") };
    await mkdir(join(elsewhere.rootPath, ".dohc", "local"), { recursive: true });
    expect(await refusal(localStateDir(elsewhere))).toBe("not-opened");
  });

  it("refuses a writer after an open that could not keep the folder out of iCloud Drive", async () => {
    const { daemon, sessions, workspace, open } = await engine();
    daemon.ready = false;
    await open();
    const error = await localStateDir(workspace).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalStateUnavailableError);
    expect((error as Error).message).toBe(
      "dohc could not keep this workspace's .dohc/local out of iCloud Drive, so it saves nothing there. Restart dohc to try again.",
    );

    // A later open that marks it makes it ready again.
    await sessions.closeWorkspaceBinding(workspace);
    daemon.ready = true;
    await open();
    await expect(localStateDir(workspace)).resolves.toMatch(/local$/);
  });

  it("refuses a writer once the workspace closes, and until a reopen finishes", async () => {
    const { daemon, sessions, workspace, open } = await engine();
    await open();
    await expect(localStateDir(workspace)).resolves.toMatch(/local$/);
    await sessions.closeWorkspaceBinding(workspace);
    expect(await refusal(localStateDir(workspace))).toBe("not-opened");

    const held = Promise.withResolvers<void>();
    daemon.hold = held.promise;
    const reopening = open();
    expect(await refusal(localStateDir(workspace))).toBe("not-opened");
    held.resolve();
    await reopening;
    await expect(localStateDir(workspace)).resolves.toMatch(/local$/);
  });

  it("refuses a writer after a reopen fails", async () => {
    const { daemon, sessions, workspace, open } = await engine();
    await open();
    await expect(localStateDir(workspace)).resolves.toMatch(/local$/);
    await sessions.closeWorkspaceBinding(workspace);
    daemon.fail = true;
    await expect(open()).rejects.toThrow("open refused");
    expect(await refusal(localStateDir(workspace))).toBe("not-opened");
  });

  it("refuses a writer whose open closed while dohc looked at the folder", async () => {
    const { sessions, workspace, open } = await engine();
    await open();
    const looking = localStateDir(workspace);
    const closing = sessions.closeWorkspaceBinding(workspace);
    expect(await refusal(looking)).toBe("not-opened");
    await closing;
  });

  it("refuses a writer, and makes nothing, when the prepared folder is gone", async () => {
    const { workspace, open } = await engine();
    await open();
    await rm(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
    expect(await refusal(localStateDir(workspace))).toBe("not-opened");
    expect(await lstat(join(workspace.rootPath, ".dohc", "local")).catch(() => null)).toBeNull();
  });

  it("refuses a link at .dohc/local to writers and readers, and leaves its target alone", async () => {
    const { workspace, open } = await engine();
    await open();
    const outside = await createTestScratch("dohc-local-state-outside-");
    await rm(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
    await symlink(outside, join(workspace.rootPath, ".dohc", "local"), "dir");
    expect(await refusal(localStateDir(workspace))).toBe("not-opened");
    expect(await existingLocalStateDir(workspace.rootPath)).toBeNull();
    expect(await readdir(outside)).toEqual([]);
  });

  // What dohc can't look at may hold what protects a person's work, so only a
  // folder that is not there reads as missing. chmod can't hide a folder from
  // root, and Windows has no such mode.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a reader whose .dohc dohc can't look into, rather than read it as missing",
    async () => {
      const { workspace, open } = await engine();
      await open();
      await mkdir(join(workspace.rootPath, ".dohc", "local", "trash"));
      const dohc = join(workspace.rootPath, ".dohc");
      await chmod(dohc, 0o600);
      try {
        const refused = await ownedLocalStateDir(workspace.rootPath).then(() => null, (error: unknown) => error);
        expect(refused).toBeInstanceOf(LocalStateFolderError);
        expect((refused as Error).message).toBe(
          "This workspace's .dohc/local can't be read. Make sure you can open it, then try again.",
        );
        await expect(existingLocalStateFolder(workspace.rootPath, "trash")).rejects.toBeInstanceOf(LocalStateFolderError);
      } finally {
        await chmod(dohc, 0o700);
      }
      expect(await ownedLocalStateDir(workspace.rootPath)).toMatch(/local$/);
    },
  );

  it("makes each folder on the way to a nested one private, and refuses a link on the way to writers and readers", async () => {
    const { workspace, open } = await engine();
    await open();
    const guard = { path: ".dohc/local/datasets/workers", lead: "dohc could not open this Collection's records." };
    const made = await localStateFolder(workspace, "datasets/workers", guard);
    expect(made).toBe(join(workspace.rootPath, ".dohc", "local", "datasets", "workers"));
    if (process.platform !== "win32") for (const folder of [join(made, ".."), made]) expect((await lstat(folder)).mode & 0o777).toBe(0o700);
    expect(await existingLocalStateFolder(workspace.rootPath, "datasets/workers")).toBe(made);
    expect(await existingLocalStateFolder(workspace.rootPath, "datasets/exports")).toBeNull();
    const outside = await createTestScratch("dohc-local-state-outside-");
    await rm(join(workspace.rootPath, ".dohc", "local", "datasets"), { recursive: true });
    await symlink(outside, join(workspace.rootPath, ".dohc", "local", "datasets"), "dir");
    await expect(localStateFolder(workspace, "datasets/workers", guard)).rejects.toThrow(
      "dohc could not open this Collection's records. A link is at .dohc/local/datasets, which must be a real folder.");
    expect(await existingLocalStateFolder(workspace.rootPath, "datasets/workers")).toBe("unusable");
    expect(await readdir(outside)).toEqual([]);
  });

  // A SQLite database in `.dohc/local` can decide what dohc does, such as the
  // next operation number, so each of its files must be one only this user can change.
  it.skipIf(process.platform === "win32")("trusts a SQLite database only when it and each of its files is this user's alone", async () => {
    const folder = await createTestScratch("dohc-local-sqlite-");
    const elsewhere = await createTestScratch("dohc-local-sqlite-elsewhere-");
    expect(await ownedSqliteFiles(folder, "state.sqlite")).toBe(true);
    for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal"]) await writeFile(join(folder, name), "", { mode: 0o644 });
    expect(await ownedSqliteFiles(folder, "state.sqlite")).toBe(true);
    const someoneElse = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    try {
      expect(await ownedSqliteFiles(folder, "state.sqlite")).toBe(false);
    } finally { someoneElse.mockRestore(); }
    for (const [name, untrust, restore] of [
      ["state.sqlite", () => chmod(join(folder, "state.sqlite"), 0o664), () => chmod(join(folder, "state.sqlite"), 0o644)],
      ["state.sqlite-wal", () => link(join(folder, "state.sqlite-wal"), join(elsewhere, "wal")), () => rm(join(elsewhere, "wal"))],
      ["state.sqlite-shm", async () => { await rm(join(folder, "state.sqlite-shm")); await symlink(join(elsewhere, "shm"), join(folder, "state.sqlite-shm")); },
        async () => { await rm(join(folder, "state.sqlite-shm")); await writeFile(join(folder, "state.sqlite-shm"), ""); }],
      ["state.sqlite-journal", () => chmod(join(folder, "state.sqlite-journal"), 0o646), () => chmod(join(folder, "state.sqlite-journal"), 0o644)],
    ] as const) {
      await untrust();
      expect(await ownedSqliteFiles(folder, "state.sqlite"), name).toBe(false);
      await restore();
      expect(await ownedSqliteFiles(folder, "state.sqlite"), name).toBe(true);
    }
  });

  it("gives a reader the folder whatever the engine said, and null when it is missing", async () => {
    const { workspace } = await engine();
    expect(await existingLocalStateDir(workspace.rootPath)).toBeNull();
    await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
    expect(await existingLocalStateDir(workspace.rootPath)).toMatch(/local$/);
  });
});

// Node can't see who may change a folder on Windows, so there a reader trusts
// `.dohc/local` only while the engine's open holds it.
describe("this computer's .dohc/local for a reader on Windows", () => {
  const platform = process.platform;
  const runOn = (system: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: system });
  afterEach(() => runOn(platform));
  // The test scratch is made for the system the tests run on.
  async function windowsEngine(sleep?: (ms: number) => Promise<void>) {
    const made = await engine(sleep);
    runOn("win32");
    return made;
  }

  it("refuses a reader until this workspace's engine open holds the folder, and again once it closes", async () => {
    const { sessions, workspace, open } = await windowsEngine();
    await mkdir(join(workspace.rootPath, ".dohc", "local", "automations"), { recursive: true });
    expect(await refusal(ownedLocalStateDir(workspace.rootPath))).toBe("not-opened");
    expect(await refusal(existingLocalStateFolder(workspace.rootPath, "automations"))).toBe("not-opened");

    await open();
    expect(await ownedLocalStateDir(workspace.rootPath)).toMatch(/local$/);
    expect(await existingLocalStateFolder(workspace.rootPath, "automations")).toMatch(/automations$/);

    await sessions.closeWorkspace(workspace);
    expect(await refusal(ownedLocalStateDir(workspace.rootPath))).toBe("not-opened");
  });

  it("refuses a reader when the engine's open did not prepare the folder", async () => {
    const { daemon, workspace, open } = await windowsEngine();
    daemon.ready = false;
    await open();
    expect(await refusal(ownedLocalStateDir(workspace.rootPath))).toBe("not-opened");
  });

  it("waits for an open under way, then reads", async () => {
    const { daemon, sessions, workspace, open } = await windowsEngine();
    await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
    const held = Promise.withResolvers<void>();
    daemon.hold = held.promise;
    const opening = open();
    await vi.waitFor(() => expect(sessions.openInProgress(workspace)).not.toBeNull());
    const reading = ownedLocalStateDir(workspace.rootPath);
    held.resolve();
    await opening;
    expect(await reading).toMatch(/local$/);
  });

  it("reads the saved layout when it asks while the open waits for a busy store", async () => {
    const paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const { daemon, sessions, workspace, open } = await windowsEngine(async () => { paused.resolve(); await resume.promise; });
    const local = join(workspace.rootPath, ".dohc", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "ui-state.json"), JSON.stringify({ sidebarOpen: true }));
    daemon.busy = 1;
    const asked = vi.spyOn(sessions, "localStateOpenAt");
    const opening = open();
    await paused.promise;
    const reading = readUiStateFile(workspace.rootPath);
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    resume.resolve();
    await opening;
    expect(await reading).toEqual({ sidebarOpen: true });
  });

  // A read is trusted only while one open holds the folder throughout.
  it("drops what a reader found when the open closes before the read ends, even if another open follows", async () => {
    const { sessions, workspace, open } = await windowsEngine();
    const local = join(workspace.rootPath, ".dohc", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "settings.local.json"), "{}");
    const settings = (dir: string | null) => readFile(join(dir!, "settings.local.json"), "utf8");
    await open();
    expect(await refusal(readOwnedLocalState(workspace.rootPath, async (dir) => {
      await sessions.closeWorkspaceBinding(workspace);
      return settings(dir);
    }))).toBe("not-opened");

    await open();
    expect(await refusal(readOwnedLocalState(workspace.rootPath, async (dir) => {
      await sessions.closeWorkspaceBinding(workspace);
      await open();
      return settings(dir);
    }))).toBe("not-opened");
    expect(await readOwnedLocalState(workspace.rootPath, settings)).toBe("{}");
  });

  // A refused read, unlike "no saved layout", keeps the window from saving
  // its defaults over the file.
  it("refuses a saved-layout read before an open or once it closes", async () => {
    const { sessions, workspace, open } = await windowsEngine();
    const local = join(workspace.rootPath, ".dohc", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "ui-state.json"), JSON.stringify({ sidebarOpen: true }));
    expect(await refusal(readUiStateFile(workspace.rootPath))).toBe("not-opened");
    await open();
    expect(await readUiStateFile(workspace.rootPath)).toEqual({ sidebarOpen: true });
    await sessions.closeWorkspace(workspace);
    expect(await refusal(readUiStateFile(workspace.rootPath))).toBe("not-opened");
  });

  it("reads the saved layout across a close that keeps the workspace, as the sync client's rebind does", async () => {
    const { sessions, workspace, open } = await windowsEngine();
    const local = join(workspace.rootPath, ".dohc", "local");
    await mkdir(local, { recursive: true });
    const saved = JSON.stringify({ sidebarOpen: true });
    await writeFile(join(local, "ui-state.json"), saved);
    await open();
    const asked = vi.spyOn(sessions, "localStateOpenAt");
    const closing = sessions.closeWorkspaceBinding(workspace);
    const reading = readUiStateFile(workspace.rootPath);
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    await closing;
    await open();
    expect(await reading).toEqual({ sidebarOpen: true });
    expect(await readFile(join(local, "ui-state.json"), "utf8")).toBe(saved);
  });

  it("refuses a saved-layout read whose wait ends while the open is still under way", async () => {
    const { daemon, sessions, workspace, open } = await windowsEngine();
    const local = join(workspace.rootPath, ".dohc", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "ui-state.json"), JSON.stringify({ sidebarOpen: true }));
    const held = Promise.withResolvers<void>();
    daemon.hold = held.promise;
    const opening = open();
    await vi.waitFor(() => expect(sessions.openInProgress(workspace)).not.toBeNull());
    // As when the wait runs past two open deadlines.
    const waits = vi.spyOn(sessions, "openInProgress").mockReturnValue(Promise.resolve());
    expect(await refusal(readUiStateFile(workspace.rootPath))).toBe("not-opened");
    waits.mockRestore();
    held.resolve();
    await opening;
    expect(await readUiStateFile(workspace.rootPath)).toEqual({ sidebarOpen: true });
  });

  it("says a settings read before an open read no file, not that the file is unusable", async () => {
    const { workspace, open } = await windowsEngine();
    const local = join(workspace.rootPath, ".dohc", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "settings.local.json"), JSON.stringify({ privacy: { confirmExternalLinks: false } }));
    expect(await readWorkspaceSettingsFile(workspace)).toMatchObject({ source: "recovered", notOpened: true });
    await open();
    const read = await readWorkspaceSettingsFile(workspace);
    expect(read).toMatchObject({ source: "stored", settings: { privacy: { confirmExternalLinks: false } } });
    expect(read).not.toHaveProperty("notOpened");
  });

  it("reads as before on other systems, with no open", async () => {
    const { workspace } = await engine();
    const local = join(workspace.rootPath, ".dohc", "local");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "ui-state.json"), JSON.stringify({ sidebarOpen: true }));
    runOn("linux");
    expect(await ownedLocalStateDir(workspace.rootPath)).toMatch(/local$/);
    expect(await readUiStateFile(workspace.rootPath)).toEqual({ sidebarOpen: true });
  });
});

import { lstat, mkdir, readdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_UI_STATE_FILE_BYTES,
  readUiStateFile,
  writeUiStateFile,
} from "./workspaceUiState";
import { LocalStateUnavailableError } from "./workspaceLocalState";
import { fakeLocalStateOpens } from "../testing/preparedLocalState";
import type { WorkspaceUiState } from "../ipc/bridgeContract";

import { createTestScratch } from "./testTemp";

// The next `left` calls of `operation` on ui-state.json fail with `code`, as
// when another program holds the file. `onFailure` runs after each failure.
const held = vi.hoisted(() => ({
  operation: null as "lstat" | "readFile" | null,
  code: "",
  left: 0,
  calls: 0,
  onFailure: null as (() => void) | null,
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  const holdable = <A extends unknown[], R>(operation: "lstat" | "readFile", real: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (held.operation === operation && String(args[0]).endsWith("ui-state.json")) {
        held.calls += 1;
        if (held.left > 0) {
          held.left -= 1;
          held.onFailure?.();
          throw Object.assign(new Error(`${held.code}: the file is held`), { code: held.code });
        }
      }
      return real(...args);
    };
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    lstat: holdable("lstat", actual.lstat),
    readFile: holdable("readFile", actual.readFile),
  };
});

function hold(operation: "lstat" | "readFile", code: string, times: number, onFailure: (() => void) | null = null) {
  Object.assign(held, { operation, code, left: times, calls: 0, onFailure });
}

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function runOn(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platform, value });
}

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  Object.assign(held, { operation: null, left: 0, calls: 0, onFailure: null });
});

const STATE: WorkspaceUiState = {
  version: 3,
  activeView: "explorer",
  sidebarVisible: true,
  sidebarWidth: 240,
  editorGroups: [{
    id: "primary",
    tabs: ["notes/a.md", "tab://graph"],
    activeTab: "tab://graph",
    size: 1,
  }],
  activeEditorGroup: "primary",
  aboutVisible: false,
  aboutWidth: 320,
  openEditorsHeight: 126,
  expandedFolders: [],
  pinned: [],
  recentFiles: ["notes/a.md"],
  collectionViews: {},
};


const engine = fakeLocalStateOpens();
let workspaces = 0;
// A workspace whose engine open prepared .dohc/local.
async function openedWorkspace() {
  workspaces += 1;
  const workspace = { workspaceId: `ui-state-${workspaces}`, rootPath: await createTestScratch("dohc-ui-state-") };
  await engine.open(workspace);
  return workspace;
}

describe("ui-state file store", () => {
  it("round-trips state through .dohc/local/ui-state.json", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    await writeUiStateFile(workspace, STATE);
    expect(await readUiStateFile(root)).toEqual(STATE);
    // Pretty-printed JSON with a trailing newline, like every .dohc file.
    const raw = await readFile(join(root, ".dohc", "local", "ui-state.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(await readdir(join(root, ".dohc"))).toEqual(["local"]);
  });

  it("ignores the old .dohc/ui-state.json and leaves it as it was", async () => {
    const workspace = await openedWorkspace();
    const old = join(workspace.rootPath, ".dohc", "ui-state.json");
    const oldState = `${JSON.stringify({ ...STATE, sidebarWidth: 999 })}\n`;
    await writeFile(old, oldState);
    expect(await readUiStateFile(workspace.rootPath)).toBeNull();
    await writeUiStateFile(workspace, STATE);
    expect(await readUiStateFile(workspace.rootPath)).toEqual(STATE);
    expect(await readFile(old, "utf8")).toBe(oldState);
  });

  it("never creates .dohc/local, so an early write leaves nothing to sync", async () => {
    const workspace = { workspaceId: "ui-state-unopened", rootPath: await createTestScratch("dohc-ui-state-") };
    await expect(writeUiStateFile(workspace, STATE)).rejects.toBeInstanceOf(LocalStateUnavailableError);
    expect(await lstat(join(workspace.rootPath, ".dohc")).catch(() => null)).toBeNull();

    // An open that could not keep the folder out of iCloud Drive leaves it empty.
    await engine.open(workspace, false);
    await expect(writeUiStateFile(workspace, STATE)).rejects.toBeInstanceOf(LocalStateUnavailableError);
    expect(await readdir(join(workspace.rootPath, ".dohc", "local"))).toEqual([]);

    // A write after the workspace's engine open closed changes nothing.
    await engine.open(workspace);
    await writeUiStateFile(workspace, STATE);
    engine.close(workspace);
    await expect(writeUiStateFile(workspace, { ...STATE, sidebarWidth: 300 })).rejects.toBeInstanceOf(LocalStateUnavailableError);
    // On Windows nothing reads it until the next open holds the folder.
    expect(JSON.parse(await readFile(join(workspace.rootPath, ".dohc", "local", "ui-state.json"), "utf8"))).toEqual(STATE);
  });

  it("serializes a burst of writes and leaves the latest complete state", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    await Promise.all(
      Array.from({ length: 40 }, (_, sequence) =>
        writeUiStateFile(workspace, { ...STATE, sidebarWidth: 300 + sequence }),
      ),
    );

    expect(await readUiStateFile(root)).toEqual({
      ...STATE,
      sidebarWidth: 339,
    });
    expect(
      (await readdir(join(root, ".dohc", "local"))).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("retries a transient Windows rename failure and completes the write", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const transient = Object.assign(new Error("file is temporarily busy"), {
      code: "EBUSY",
    });
    const renameMock = vi.mocked(rename);
    renameMock.mockClear();
    renameMock.mockRejectedValueOnce(transient);

    runOn("win32");
    await expect(writeUiStateFile(workspace, STATE)).resolves.toBeUndefined();
    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(await readUiStateFile(root)).toEqual(STATE);
  });

  // A read that answers "no saved state" lets the renderer save its defaults
  // over the file, so a file dohc couldn't read must reject instead.
  const heldReads = (["lstat", "readFile"] as const).flatMap((operation) =>
    (["EBUSY", "EPERM", "EACCES"] as const).map((code) => ({ operation, code })));

  it.each(heldReads)("reads a file whose $operation fails with $code five times on Windows", async ({ operation, code }) => {
    const workspace = await openedWorkspace();
    await writeUiStateFile(workspace, STATE);
    hold(operation, code, 5);
    runOn("win32");
    expect(await readUiStateFile(workspace.rootPath)).toEqual(STATE);
    expect(held.calls).toBe(6);
  });

  it.each(heldReads)("rejects once $operation has failed with $code six times on Windows", async ({ operation, code }) => {
    const workspace = await openedWorkspace();
    await writeUiStateFile(workspace, STATE);
    hold(operation, code, Number.POSITIVE_INFINITY);
    runOn("win32");
    await expect(readUiStateFile(workspace.rootPath)).rejects.toMatchObject({ code });
    expect(held.calls).toBe(6);
  });

  it("asks for the engine's open again before it reads a held file again", async () => {
    const workspace = await openedWorkspace();
    await writeUiStateFile(workspace, STATE);
    hold("readFile", "EBUSY", 1, () => engine.close(workspace));
    runOn("win32");
    await expect(readUiStateFile(workspace.rootPath)).rejects.toBeInstanceOf(LocalStateUnavailableError);
    expect(held.calls).toBe(1);
  });

  it.each(["lstat", "readFile"] as const)("rejects at once when %s fails with EBUSY on other systems", async (operation) => {
    const workspace = await openedWorkspace();
    await writeUiStateFile(workspace, STATE);
    hold(operation, "EBUSY", 1);
    runOn("linux");
    await expect(readUiStateFile(workspace.rootPath)).rejects.toMatchObject({ code: "EBUSY" });
    expect(held.calls).toBe(1);
  });

  it("a missing or corrupt file reads as null, never an error", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    expect(await readUiStateFile(root)).toBeNull();
    await writeUiStateFile(workspace, STATE);
    await writeFile(join(root, ".dohc", "local", "ui-state.json"), "{not json");
    expect(await readUiStateFile(root)).toBeNull();
  });

  it("an oversized on-disk file reads as null — stat-capped before read+parse", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    await writeUiStateFile(workspace, STATE);
    // Valid JSON, hostile size: a workspace can carry any bytes it likes —
    // the cap must refuse it before JSON.parse ever sees the payload.
    const huge = JSON.stringify({
      ...STATE,
      padding: "x".repeat(MAX_UI_STATE_FILE_BYTES),
    });
    await writeFile(join(root, ".dohc", "local", "ui-state.json"), huge);
    expect(await readUiStateFile(root)).toBeNull();
  });

  // A malicious attached workspace can ship `.dohc` as a SYMLINK to a
  // user-writable directory outside the workspace. Following it would land
  // main-process metadata writes outside the boundary — both the write and
  // the read must refuse, and nothing may appear in the symlink's target.
  it.each([".dohc", ".dohc/local"])("refuses to write through a symlinked %s and never lands files outside", async (linked) => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const outside = await createTestScratch("dohc-ui-state-");
    if (linked === ".dohc") await mkdir(join(outside, "local"));
    await rename(join(root, linked), join(root, "moved-aside"));
    await symlink(outside, join(root, linked), "dir");

    await expect(writeUiStateFile(workspace, STATE)).rejects.toBeInstanceOf(LocalStateUnavailableError);
    expect(await readUiStateFile(root)).toBeNull();
    // The escape target stayed untouched: no ui-state.json, no temp files.
    expect(await readdir(outside)).toEqual(linked === ".dohc" ? ["local"] : []);
    if (linked === ".dohc") expect(await readdir(join(outside, "local"))).toEqual([]);
  });

  it("refuses to read a symlinked ui-state file", async () => {
    const workspace = await openedWorkspace();
    const root = workspace.rootPath;
    const outside = await createTestScratch("dohc-ui-state-");
    await writeUiStateFile(workspace, STATE);
    const outsideState = join(outside, "ui-state.json");
    await writeFile(outsideState, JSON.stringify({ ...STATE, sidebarWidth: 999 }));
    await unlink(join(root, ".dohc", "local", "ui-state.json"));
    await symlink(outsideState, join(root, ".dohc", "local", "ui-state.json"));

    expect(await readUiStateFile(root)).toBeNull();
  });
});

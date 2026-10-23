import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AutomationStoreFolder } from "@dohc/automation-executor/automation-run-store";
import { localAutomationStoreFolder } from "../automations/localAutomationStore";
import { readLocalStateFrom, readOwnedLocalState, type LocalStateWorkspace } from "../workspaces/workspaceLocalState";

// An open that holds `.dohc/local` for as long as the test runs.
const HELD = { current: () => true };

// Stands in for the engine sessions: each workspace's current open, by id and
// root, with what it said about `.dohc/local`.
export function fakeLocalStateOpens() {
  const opens = new Map<string, { workspace: LocalStateWorkspace; localStateReady: boolean }>();
  const underWay = new Map<string, Promise<void>>();
  const key = (workspace: LocalStateWorkspace) => `${workspace.workspaceId}\0${workspace.rootPath}`;
  let waits = 0;
  readLocalStateFrom({
    currentBinding: (workspace) => opens.get(key(workspace)) ?? null,
    openInProgress: (workspace) => {
      const opening = underWay.get(key(workspace)) ?? null;
      if (opening) waits++;
      return opening;
    },
    // An open that could not keep the folder out of iCloud Drive prepared it.
    localStateOpenAt: async (rootPath) => {
      await Promise.all([...underWay].filter(([at]) => at.endsWith(`\0${rootPath}`)).map(([, opening]) => opening.catch(() => undefined)));
      const open = [...opens.values()].find((candidate) => candidate.workspace.rootPath === rootPath);
      return open ? { current: () => opens.get(key(open.workspace)) === open } : null;
    },
  });
  const fake = {
    /** What an engine open that writes does: make the folder, then answer. */
    async open(workspace: LocalStateWorkspace, localStateReady = true) {
      await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
      opens.set(key(workspace), { workspace, localStateReady });
    },
    /** An open that is under way until `finish` answers it. */
    start(workspace: LocalStateWorkspace) {
      let finish!: () => void;
      const answered = new Promise<void>((resolve) => { finish = resolve; });
      const opening = answered.then(() => fake.open(workspace)).finally(() => underWay.delete(key(workspace)));
      underWay.set(key(workspace), opening);
      return { finish: async () => { finish(); await opening; } };
    },
    /** How many times a writer waited for an open under way. */
    waits: () => waits,
    close(workspace: LocalStateWorkspace) {
      opens.delete(key(workspace));
    },
  };
  return fake;
}

// One map for every workspace a file opens with openedLocalState, installed
// again on each call so a file that stood in its own opens meanwhile still
// finds these.
const opened = new Map<string, { localStateReady: boolean }>();
const openedKey = (workspace: LocalStateWorkspace) => `${workspace.workspaceId}\0${workspace.rootPath}`;

/**
 * For a test that is not about the open: the engine's open of this workspace
 * has prepared `.dohc/local`, so its writers, such as the workspace trash,
 * write there, and on Windows its readers read there.
 */
export async function openedLocalState(workspace: LocalStateWorkspace): Promise<void> {
  await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
  opened.set(openedKey(workspace), { localStateReady: true });
  readLocalStateFrom({
    currentBinding: (current) => opened.get(openedKey(current)) ?? null,
    localStateOpenAt: async () => HELD,
  });
}

/**
 * For a test whose readers are not about the open: every workspace's
 * `.dohc/local` reads as an engine open leaves it, as it does on a Mac and
 * Linux. No writer gets a folder.
 */
export function readersTrustLocalState(): void {
  readLocalStateFrom({ currentBinding: () => null, localStateOpenAt: async () => HELD });
}

/**
 * A workspace's run store folder as an engine open leaves it for a test that
 * is not about the open: a write finds `.dohc/local` made, and a read finds
 * it as the desktop does.
 */
export function preparedAutomationStoreFolder(rootPath: string): AutomationStoreFolder {
  return {
    async forWrite() {
      await mkdir(join(rootPath, ".dohc", "local"), { recursive: true });
      return (await readOwnedLocalState(rootPath, async (dir) => dir))!;
    },
    read: (work) => localAutomationStoreFolder({ workspaceId: "prepared", rootPath }).read(work),
  };
}

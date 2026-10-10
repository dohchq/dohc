import { discoverSites, type WatcherEvent, type WorkspaceSiteSource } from "@dohc/workspace-core";
import type { FolderAppAnswer } from "../ipc/bridgeContract";

export function detectFolderApp(workspaceId: string, folder: string, sources: readonly (string | WorkspaceSiteSource)[]): FolderAppAnswer {
  const scoped = sources.filter(source => {
    const path = typeof source === "string" ? source : source.path;
    return folder === "." || path.startsWith(folder + "/");
  });
  const site = discoverSites(scoped).find(site => (site.root || ".") === folder);
  return { workspaceId, folder, isApp: Boolean(site), run: site ? {
    path: folder,
    entryPath: site.entry ? (folder === "." ? site.entry : folder + "/" + site.entry) : null,
    previewMode: site.configuredPreviewMode ?? null,
  } : null };
}

interface Attachment { workspaceId: string; attachmentId: symbol }

// Observation has settled each batch. The queue also joins renderer reads
// and batches arriving before a folder's scan starts.
export function createFolderAppDetection<Workspace extends Attachment>(input: {
  sources(workspace: Workspace, folder: string): Promise<readonly (string | WorkspaceSiteSource)[]>;
  updated(workspace: Workspace): void;
  failed(error: unknown): void;
}) {
  interface Folder { answer?: FolderAppAnswer; dirty: boolean; pending?: Promise<FolderAppAnswer> }
  const attachments = new Map<symbol, Map<string, Folder>>();
  function foldersFor(workspace: Workspace) {
    let folders = attachments.get(workspace.attachmentId);
    if (!folders) { folders = new Map(); attachments.set(workspace.attachmentId, folders); }
    return folders;
  }
  function read(workspace: Workspace, folder: string): Promise<FolderAppAnswer> {
    const folders = foldersFor(workspace);
    let state = folders.get(folder);
    if (!state) { state = { dirty: true }; folders.set(folder, state); }
    if (state.pending) return state.pending;
    if (!state.dirty && state.answer) return Promise.resolve(state.answer);
    const current = state;
    current.pending = Promise.resolve().then(async () => {
      let answer: FolderAppAnswer;
      do {
        current.dirty = false;
        answer = detectFolderApp(workspace.workspaceId, folder, await input.sources(workspace, folder));
      } while (current.dirty);
      current.answer = answer;
      input.updated(workspace);
      return answer;
    }).catch(error => { current.dirty = true; throw error; }).finally(() => { current.pending = undefined; });
    return current.pending;
  }
  function settledEvents(workspace: Workspace, events: readonly WatcherEvent[]) {
    const folders = foldersFor(workspace);
    const affected = new Set<string>();
    for (const event of events) {
      const slash = event.path.lastIndexOf("/");
      affected.add(slash < 0 ? "." : event.path.slice(0, slash));
      const segments = event.path.split("/");
      const output = segments.findIndex(segment => ["dist", "build", "out"].includes(segment));
      if (output >= 0) affected.add(segments.slice(0, output).join("/") || ".");
      for (const folder of folders.keys()) {
        if (folder === "." ? slash < 0 || folders.get(folder)?.answer?.isApp === true : event.path === folder || event.path.startsWith(folder + "/") || folder.startsWith(event.path + "/")) affected.add(folder);
      }
    }
    for (const folder of affected) {
      const state = folders.get(folder);
      if (state) state.dirty = true;
      void read(workspace, folder).catch(input.failed);
    }
  }
  async function retire(attachmentId: symbol) {
    const folders = attachments.get(attachmentId);
    if (!folders) return;
    await Promise.allSettled([...folders.values()].map(state => state.pending));
    attachments.delete(attachmentId);
  }
  function invalidate(attachmentId: symbol) {
    for (const state of attachments.get(attachmentId)?.values() ?? []) state.dirty = true;
  }
  return { read, settledEvents, retire, invalidate };
}

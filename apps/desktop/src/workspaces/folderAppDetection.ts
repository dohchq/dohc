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

export const MAX_REQUESTED_APP_FOLDERS = 128;

// Settled observation batches share one background queue per attachment.
// Renderer reads join existing folder work or start independently.
export function createFolderAppDetection<Workspace extends Attachment>(input: {
  sources(workspace: Workspace, folder: string): Promise<readonly (string | WorkspaceSiteSource)[]>;
  updated(workspace: Workspace, answer: FolderAppAnswer): void;
  failed(error: unknown): void;
}) {
  interface Folder { answer?: FolderAppAnswer; dirty: boolean; readFailed?: boolean; pending?: Promise<FolderAppAnswer>; queued?: Promise<FolderAppAnswer> }
  interface Tracking { folders: Map<string, Folder>; pending: Set<Promise<FolderAppAnswer>>; queue: Promise<void> }
  const attachments = new Map<symbol, Tracking>();
  function read(workspace: Workspace, folder: string): Promise<FolderAppAnswer> {
    let tracking = attachments.get(workspace.attachmentId);
    if (!tracking) {
      tracking = { folders: new Map(), pending: new Set(), queue: Promise.resolve() };
      attachments.set(workspace.attachmentId, tracking);
    }
    const { folders } = tracking;
    const state = folders.get(folder) ?? { dirty: true };
    // Map order records renderer requests, never background scans.
    folders.delete(folder);
    folders.set(folder, state);
    if (folders.size > MAX_REQUESTED_APP_FOLDERS) folders.delete(folders.keys().next().value!);
    // A pending refresh broadcasts its eventual answer through updated.
    if ((state.pending || state.queued) && state.answer) return Promise.resolve(state.answer);
    return scan(workspace, folder, tracking, state);
  }
  function scan(workspace: Workspace, folder: string, tracking: Tracking, current: Folder): Promise<FolderAppAnswer> {
    if (current.pending) return current.pending;
    if (!current.dirty && current.answer) return Promise.resolve(current.answer);
    const pending = Promise.resolve().then(async () => {
      let answer: FolderAppAnswer;
      do {
        current.dirty = false;
        answer = detectFolderApp(workspace.workspaceId, folder, await input.sources(workspace, folder));
      } while (current.dirty && tracking.folders.get(folder) === current);
      const previous = current.answer;
      const changed = current.readFailed || !previous || JSON.stringify(previous) !== JSON.stringify(answer);
      current.answer = answer;
      current.readFailed = false;
      if (tracking.folders.get(folder) === current && changed) input.updated(workspace, answer);
      return answer;
    }).catch(error => {
      current.readFailed = true;
      current.dirty = true;
      throw error;
    }).finally(() => {
      current.pending = undefined;
      tracking.pending.delete(pending);
    });
    current.pending = pending;
    tracking.pending.add(pending);
    return pending;
  }
  function queueScan(workspace: Workspace, folder: string, tracking: Tracking, current: Folder): Promise<FolderAppAnswer> {
    if (current.pending) return current.pending;
    if (current.queued) return current.queued;
    const queued = tracking.queue.then(() => scan(workspace, folder, tracking, current)).finally(() => {
      current.queued = undefined;
      tracking.pending.delete(queued);
    });
    current.queued = queued;
    tracking.pending.add(queued);
    tracking.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }
  function settledEvents(workspace: Workspace, events: readonly WatcherEvent[]) {
    const tracking = attachments.get(workspace.attachmentId);
    if (!tracking) return;
    const { folders } = tracking;
    const affected = new Set<string>();
    for (const event of events) {
      const slash = event.path.lastIndexOf("/");
      for (const folder of folders.keys()) {
        if (folder === "." ? slash < 0 || ["dist", "build", "out"].includes(event.path.split("/")[0]!) || folders.get(folder)?.answer?.isApp === true : event.path === folder || event.path.startsWith(folder + "/") || folder.startsWith(event.path + "/")) affected.add(folder);
      }
    }
    for (const folder of affected) {
      const state = folders.get(folder);
      if (state) {
        state.dirty = true;
        void queueScan(workspace, folder, tracking, state).catch(input.failed);
      }
    }
  }
  async function retire(attachmentId: symbol) {
    const tracking = attachments.get(attachmentId);
    if (!tracking) return;
    await Promise.allSettled(tracking.pending);
    attachments.delete(attachmentId);
  }
  function invalidate(workspace: Workspace) {
    const tracking = attachments.get(workspace.attachmentId);
    if (!tracking) return;
    for (const [folder, state] of tracking.folders) {
      state.dirty = true;
      void queueScan(workspace, folder, tracking, state).catch(input.failed);
    }
  }
  return { read, settledEvents, retire, invalidate };
}

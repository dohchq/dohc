// Bookkeeping for the main process's running guest views. This module makes
// the decisions — which record a request may touch, which records an event
// tears down — and returns the records; main.ts applies the Electron effects
// (attach, position, destroy) to what it gets back. That split is what keeps
// the async-guard rules here testable without Electron.

export interface PluginWebAppViewIdentity {
  workspaceId: string;
  pluginId: string;
  webAppId: string;
}

export interface PluginWebAppViewRecord<TView>
  extends PluginWebAppViewIdentity {
  senderId: number;
  generation: number;
  origin: string;
  partition: string;
  view: TView;
}

function viewKey(identity: PluginWebAppViewIdentity): string {
  return `${identity.workspaceId}\0${identity.pluginId}\0${identity.webAppId}`;
}

export class PluginWebAppViewRegistry<TView> {
  private readonly views = new Map<string, PluginWebAppViewRecord<TView>>();

  /** Registers a running view; returns the record it displaced at the same
   * identity, which the caller must destroy. */
  register(
    record: PluginWebAppViewRecord<TView>,
  ): PluginWebAppViewRecord<TView> | null {
    const key = viewKey(record);
    const displaced = this.views.get(key) ?? null;
    this.views.set(key, record);
    return displaced;
  }

  /**
   * The record a bounds update may touch, or null when the update is stale:
   * a different renderer, an older renderer generation, or a view that no
   * longer exists. Stale updates are ignored, never applied — a slow update
   * for workspace A must never reposition workspace B's view.
   */
  authorizeBounds(
    request: PluginWebAppViewIdentity & { senderId: number; generation: number },
  ): PluginWebAppViewRecord<TView> | null {
    const record = this.views.get(viewKey(request));
    if (
      !record ||
      record.senderId !== request.senderId ||
      record.generation !== request.generation
    ) {
      return null;
    }
    return record;
  }

  get(identity: PluginWebAppViewIdentity): PluginWebAppViewRecord<TView> | null {
    return this.views.get(viewKey(identity)) ?? null;
  }

  /** Removes one view; the caller destroys the returned record. */
  remove(
    identity: PluginWebAppViewIdentity,
  ): PluginWebAppViewRecord<TView> | null {
    const key = viewKey(identity);
    const record = this.views.get(key) ?? null;
    this.views.delete(key);
    return record;
  }

  hasForPlugin(workspaceId: string, pluginId: string): boolean {
    for (const record of this.views.values()) {
      if (record.workspaceId === workspaceId && record.pluginId === pluginId) {
        return true;
      }
    }
    return false;
  }

  removeForWorkspace(workspaceId: string): PluginWebAppViewRecord<TView>[] {
    return this.removeWhere((record) => record.workspaceId === workspaceId);
  }

  removeForPlugin(
    workspaceId: string,
    pluginId: string,
  ): PluginWebAppViewRecord<TView>[] {
    return this.removeWhere(
      (record) =>
        record.workspaceId === workspaceId && record.pluginId === pluginId,
    );
  }

  removeForSender(senderId: number): PluginWebAppViewRecord<TView>[] {
    return this.removeWhere((record) => record.senderId === senderId);
  }

  removeAll(): PluginWebAppViewRecord<TView>[] {
    return this.removeWhere(() => true);
  }

  private removeWhere(
    predicate: (record: PluginWebAppViewRecord<TView>) => boolean,
  ): PluginWebAppViewRecord<TView>[] {
    const removed: PluginWebAppViewRecord<TView>[] = [];
    for (const [key, record] of this.views) {
      if (!predicate(record)) continue;
      this.views.delete(key);
      removed.push(record);
    }
    return removed;
  }
}

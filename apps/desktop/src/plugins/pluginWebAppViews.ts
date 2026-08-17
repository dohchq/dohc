// Bookkeeping for the main process's running guest views. This module makes
// the decisions — which record a request may touch, which records an event
// tears down — and returns the records; main.ts applies the Electron effects
// (attach, position, destroy) to what it gets back. That split is what keeps
// the async-guard rules here testable without Electron.

export interface PluginWebAppViewIdentity {
  workspaceId: string;
  pluginId: string;
  webAppId: string;
  /** Which instance of the web app this view shows, or null for a web app
   * that opens one view for the whole manifest id. Two instances of one id
   * are two views over two origins, so the instance is part of the identity
   * every lookup here keys on. */
  instanceKey: string | null;
}

export interface PluginWebAppViewRecord<TView>
  extends PluginWebAppViewIdentity {
  senderId: number;
  generation: number;
  origin: string;
  partition: string;
  view: TView;
}

/**
 * One web app instance's identity as a string. The registry keys its views by
 * it and main keys its start locks by it, so the shape is written once: an
 * instance is only ever the same instance if both agree on what names it.
 */
export function webAppInstanceKey(identity: PluginWebAppViewIdentity): string {
  return `${identity.workspaceId}\0${identity.pluginId}\0${identity.webAppId}\0${identity.instanceKey ?? ""}`;
}

export class PluginWebAppViewRegistry<TView> {
  private readonly views = new Map<string, PluginWebAppViewRecord<TView>>();

  /** Registers a running view; returns the record it displaced at the same
   * identity, which the caller must destroy. */
  register(
    record: PluginWebAppViewRecord<TView>,
  ): PluginWebAppViewRecord<TView> | null {
    const key = webAppInstanceKey(record);
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
    const record = this.views.get(webAppInstanceKey(request));
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
    return this.views.get(webAppInstanceKey(identity)) ?? null;
  }

  /** Removes one view; the caller destroys the returned record. */
  remove(
    identity: PluginWebAppViewIdentity,
  ): PluginWebAppViewRecord<TView> | null {
    const key = webAppInstanceKey(identity);
    const record = this.views.get(key) ?? null;
    this.views.delete(key);
    return record;
  }

  /**
   * How many instances of one web app are live, not counting the identity
   * about to replace itself — a restart of an instance that is already open
   * displaces its own view rather than adding one.
   */
  countOtherInstances(identity: PluginWebAppViewIdentity): number {
    const key = webAppInstanceKey(identity);
    let count = 0;
    for (const [candidate, record] of this.views) {
      if (
        record.workspaceId === identity.workspaceId &&
        record.pluginId === identity.pluginId &&
        record.webAppId === identity.webAppId &&
        candidate !== key
      ) {
        count += 1;
      }
    }
    return count;
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

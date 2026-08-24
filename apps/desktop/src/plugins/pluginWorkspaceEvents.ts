import type { WatcherEvent } from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { isAtOrBelow, sdkWorkspacePath } from "../workspaces/workspaceSdkHost";

/**
 * How many workspace file subscriptions one owner may hold.
 *
 * Measured against the plugins this repo has: the codex and claude-code
 * drivers watch nothing, and the sites conversion this primitive exists for
 * watches one prefix — the workspace root — in place of its refresh button.
 * 16 leaves more than five times the largest measured healthy use of three.
 * A plugin process and each panel have separate budgets of 16, so neither
 * owner can starve another. An owner that needs more is a measurement to
 * redo, not a number to guess at.
 */
export const MAX_PLUGIN_FILE_WATCHES_PER_OWNER = 16;

export const PLUGIN_FILE_WATCH_METHOD = "files.watch";

/** The one event name a file subscription emits. */
const FILE_WATCH_EVENT = "change";

/** What one subscriber receives: @dohc/sdk's DohcFileWatchEvent. */
export interface PluginFileWatchEvent {
  path: string;
  operation: "update" | "delete";
  sha256?: string;
}

export type PluginWorkspaceEventsOwner =
  | { kind: "process"; pluginId: string; spawnId: string }
  | {
      kind: "panel";
      workspaceId: string;
      pluginId: string;
      panelId: string;
      surfaceId: number;
    };

export interface PluginWorkspaceEventsContext {
  owner: PluginWorkspaceEventsOwner;
  emitEvent: (subscriptionId: string, event: string, data: unknown) => void;
}

interface WatchRecord {
  owner: PluginWorkspaceEventsOwner;
  /** "." for the whole workspace, otherwise a contained workspace path. */
  prefix: string;
  emitEvent: PluginWorkspaceEventsContext["emitEvent"];
}

function ownerKey(owner: PluginWorkspaceEventsOwner): string {
  return owner.kind === "process"
    ? `${owner.kind}\0${owner.pluginId}\0${owner.spawnId}`
    : `${owner.kind}\0${owner.workspaceId}\0${owner.pluginId}\0${owner.panelId}\0${owner.surfaceId}`;
}

function ownerLabel(owner: PluginWorkspaceEventsOwner): string {
  return owner.kind === "process"
    ? `Plugin "${owner.pluginId}" spawn "${owner.spawnId}"`
    : `Plugin "${owner.pluginId}" panel "${owner.panelId}"`;
}

function watchPrefix(value: unknown): string {
  // "." is the whole workspace, the same way files.list treats an omitted
  // path. Every other prefix goes through the read-path containment
  // files.read uses, so a traversal or absolute prefix is refused here rather
  // than matched against event paths that could never contain it.
  if (value === ".") return ".";
  return sdkWorkspacePath(value, "read");
}

/**
 * Serves `files.watch` for one workspace's plugins.
 *
 * The source is the workspace's settled watcher batch — the same feed the
 * plugin approval pipeline reads (main.ts's onWatcherBatch). There is no
 * second watcher: a subscriber sees what settled, never raw filesystem noise,
 * and never dohc's own metadata writes, which the watcher drops before a
 * batch exists.
 *
 * Delivery is unbuffered: an event goes to the owner's transport as it
 * settles and is never held here. Each transport owns its own buffering.
 */
export class PluginWorkspaceEvents {
  private readonly subscriptions = new Map<string, WatchRecord>();

  subscribe(
    context: PluginWorkspaceEventsContext,
    params: unknown,
  ): { subscriptionId: string } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(`${PLUGIN_FILE_WATCH_METHOD} parameters must be an object.`);
    }
    const prefix = watchPrefix((params as { path?: unknown }).path);
    const open = this.countForOwner(context.owner);
    if (open >= MAX_PLUGIN_FILE_WATCHES_PER_OWNER) {
      throw new Error(
        `${ownerLabel(context.owner)} already holds ${open} workspace file ` +
          "subscriptions. MAX_PLUGIN_FILE_WATCHES_PER_OWNER allows at most " +
          `${MAX_PLUGIN_FILE_WATCHES_PER_OWNER} open ${PLUGIN_FILE_WATCH_METHOD} ` +
          "subscriptions per owner. Unsubscribe one before watching " +
          "another, or watch a shared parent prefix instead.",
      );
    }
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, {
      owner: context.owner,
      prefix,
      emitEvent: context.emitEvent,
    });
    return { subscriptionId };
  }

  /**
   * Ends a subscription this registry owns, and reports whether it owned it.
   * A subscription id it does not know belongs to another subscription kind
   * (the child-process broker's), so the caller passes it on rather than
   * failing here.
   */
  unsubscribe(
    context: Pick<PluginWorkspaceEventsContext, "owner">,
    params: unknown,
  ): boolean {
    if (!params || typeof params !== "object" || Array.isArray(params)) return false;
    const subscriptionId = (params as { subscriptionId?: unknown }).subscriptionId;
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0) return false;
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    if (ownerKey(subscription.owner) !== ownerKey(context.owner)) {
      throw new Error(
        `${ownerLabel(context.owner)} cannot control subscription ` +
          `"${subscriptionId}" because another owner owns it.`,
      );
    }
    this.subscriptions.delete(subscriptionId);
    return true;
  }

  /** Drops every subscription the exact owner holds. */
  disposeOwner(owner: PluginWorkspaceEventsOwner): void {
    const key = ownerKey(owner);
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (ownerKey(subscription.owner) === key) {
        this.subscriptions.delete(subscriptionId);
      }
    }
  }

  /** Drops every subscription one spawn holds. Called when the spawn ends. */
  disposeSpawn(pluginId: string, spawnId: string): void {
    this.disposeOwner({ kind: "process", pluginId, spawnId });
  }

  /** Drops every subscription in this workspace. Called when it closes. */
  dispose(): void {
    this.subscriptions.clear();
  }

  /**
   * Fans one settled batch out to the subscriptions that asked for it. The
   * batch is read, never changed: the approval pipeline reads the same array.
   */
  handleWatcherEvents(events: readonly WatcherEvent[]): void {
    if (this.subscriptions.size === 0) return;
    for (const event of events) {
      // The desktop watcher settles every change into an update or a delete
      // (workspaceWatcher.ts's pathsToEvents). A create or rename would be a
      // new feed shape, and belongs in the SDK's own event type before it is
      // delivered to a plugin as one of these two.
      if (event.operation !== "update" && event.operation !== "delete") continue;
      for (const [subscriptionId, subscription] of this.subscriptions) {
        if (!isAtOrBelow(event.path, subscription.prefix)) continue;
        const delivered: PluginFileWatchEvent = {
          path: event.path,
          operation: event.operation,
          ...(event.sha256 === undefined ? {} : { sha256: event.sha256 }),
        };
        subscription.emitEvent(subscriptionId, FILE_WATCH_EVENT, delivered);
      }
    }
  }

  private countForOwner(owner: PluginWorkspaceEventsOwner): number {
    let count = 0;
    const key = ownerKey(owner);
    for (const subscription of this.subscriptions.values()) {
      if (ownerKey(subscription.owner) === key) count += 1;
    }
    return count;
  }
}

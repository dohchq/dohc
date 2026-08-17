import type { WatcherEvent } from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { isAtOrBelow, sdkWorkspacePath } from "../workspaces/workspaceSdkHost";

/**
 * How many workspace file subscriptions one plugin spawn may hold.
 *
 * Measured against the plugins this repo has: the codex and claude-code
 * drivers watch nothing, and the sites conversion this primitive exists for
 * watches one prefix — the workspace root — in place of its refresh button.
 * 16 leaves sixteen times the largest measured healthy use. A plugin that
 * needs more is a measurement to redo, not a number to guess at.
 */
export const MAX_PLUGIN_FILE_WATCHES_PER_SPAWN = 16;

export const PLUGIN_FILE_WATCH_METHOD = "files.watch";

/** The one event name a file subscription emits. */
const FILE_WATCH_EVENT = "change";

/** What one subscriber receives: @dohc/sdk's DohcFileWatchEvent. */
export interface PluginFileWatchEvent {
  path: string;
  operation: "update" | "delete";
  sha256?: string;
}

export interface PluginWorkspaceEventsContext {
  pluginId: string;
  /** The spawn making the request. Subscriptions belong to a spawn, not to a
   * plugin: a crashed plugin's respawn starts with none. */
  spawnId: string;
  emitEvent: (subscriptionId: string, event: string, data: unknown) => void;
}

interface WatchRecord {
  pluginId: string;
  spawnId: string;
  /** "." for the whole workspace, otherwise a contained workspace path. */
  prefix: string;
  emitEvent: PluginWorkspaceEventsContext["emitEvent"];
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
 * Delivery is unbuffered on purpose, matching the child-process broker: an
 * event goes to the spawn's transport as it settles and is never held here.
 * The real buffer is the spawn's MessagePort queue, which has no high water
 * mark — while a plugin's event loop is blocked, undelivered events pile up
 * on the main side until it drains or exits. @dohc/sdk's 200-event cap does
 * not bound that: it lives in the child and bounds a listener that attaches
 * late or reads slowly while the loop still turns.
 *
 * That is the SDK event transport's property, not this feed's — child process
 * output and driver events ride the same path — and it is smaller here,
 * because the quiet window collapses a burst into one event per path. A
 * plugin that blocks its own host's loop grows the main process's memory and
 * nothing else: plugins run at full trust, so this is self-harm, not a
 * privilege or isolation boundary.
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
    const open = this.countForSpawn(context.pluginId, context.spawnId);
    if (open >= MAX_PLUGIN_FILE_WATCHES_PER_SPAWN) {
      throw new Error(
        `Plugin "${context.pluginId}" already holds ${open} workspace file ` +
          `subscriptions. dohc allows at most ` +
          `${MAX_PLUGIN_FILE_WATCHES_PER_SPAWN} open ${PLUGIN_FILE_WATCH_METHOD} ` +
          "subscriptions per plugin spawn. Unsubscribe one before watching " +
          "another, or watch a shared parent prefix instead.",
      );
    }
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, {
      pluginId: context.pluginId,
      spawnId: context.spawnId,
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
    context: Pick<PluginWorkspaceEventsContext, "pluginId" | "spawnId">,
    params: unknown,
  ): boolean {
    if (!params || typeof params !== "object" || Array.isArray(params)) return false;
    const subscriptionId = (params as { subscriptionId?: unknown }).subscriptionId;
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0) return false;
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    if (
      subscription.pluginId !== context.pluginId ||
      subscription.spawnId !== context.spawnId
    ) {
      throw new Error(
        `Plugin "${context.pluginId}" cannot control subscription "${subscriptionId}" because another plugin spawn owns it.`,
      );
    }
    this.subscriptions.delete(subscriptionId);
    return true;
  }

  /** Drops every subscription one spawn holds. Called when the spawn ends. */
  disposeSpawn(pluginId: string, spawnId: string): void {
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (subscription.pluginId === pluginId && subscription.spawnId === spawnId) {
        this.subscriptions.delete(subscriptionId);
      }
    }
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

  private countForSpawn(pluginId: string, spawnId: string): number {
    let count = 0;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.pluginId === pluginId && subscription.spawnId === spawnId) {
        count += 1;
      }
    }
    return count;
  }
}

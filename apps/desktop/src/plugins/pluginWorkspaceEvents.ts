import type { WatcherEvent } from "@dohc/workspace-core";
import type { z } from "zod";
import {
  PluginPanelRecordChangedData,
  PluginPanelRecordFieldChangedData,
} from "../ipc/bridgeContract";
import { randomUUID } from "node:crypto";
import { isAtOrBelow, sdkWorkspacePath } from "../workspaces/workspaceSdkHost";

/**
 * How many workspace subscriptions one owner may hold, across file watches
 * and collection record subscriptions combined.
 *
 * Measured against the plugins this repo has: the codex and claude-code
 * drivers watch nothing, and the sites conversion this primitive exists for
 * watches one prefix — the workspace root — in place of its refresh button.
 * 16 leaves more than five times the largest measured healthy use of three.
 * A plugin process and each panel have separate budgets of 16, so neither
 * owner can starve another. An owner that needs more is a measurement to
 * redo, not a number to guess at.
 */
export const MAX_PLUGIN_WORKSPACE_SUBSCRIPTIONS_PER_OWNER = 16;

const PLUGIN_FILE_WATCH_METHOD = "files.watch";

const PLUGIN_RECORD_WATCH_METHOD = "collections.watch";

/** The one event name a file subscription emits. */
const FILE_WATCH_EVENT = "change";

/** What one file subscriber receives: @dohc/sdk's DohcFileWatchEvent. */
export interface PluginFileWatchEvent {
  path: string;
  operation: "update" | "delete";
  sha256?: string;
}

/**
 * `record.created` and `record.updated` as one subscriber receives them:
 * the engine payload minus workspaceId — this registry is per-workspace.
 */
/**
 * `record.created` and `record.updated` as one subscriber receives them, and
 * `record.field.changed` with its `previous`/`next` values. An oversized or
 * too-deep value arrives already replaced by the engine's
 * `{ "truncated": true, "bytes": number }` marker; a subscriber reads the
 * record for the whole value. `historyId` is the device-local record-history
 * row id. Delivery is at most once, so a subscriber that misses events reads
 * history past its last seen id. The shapes are the panel IPC schemas: one
 * contract, validated once at the daemon bridge.
 */
type PluginRecordChangedEventData = z.infer<typeof PluginPanelRecordChangedData>;
type PluginRecordFieldChangedEventData = z.infer<
  typeof PluginPanelRecordFieldChangedData
>;

export type PluginRecordEvent =
  | {
      name: "record.created" | "record.updated";
      data: PluginRecordChangedEventData;
    }
  | { name: "record.field.changed"; data: PluginRecordFieldChangedEventData };

export type PluginWorkspaceEventsOwner =
  | { kind: "process"; pluginId: string; spawnId: string }
  | {
      kind: "panel";
      workspaceId: string;
      pluginId: string;
      panelId: string;
      surfaceId: number;
    };

interface PluginWorkspaceEventsContext {
  owner: PluginWorkspaceEventsOwner;
  emitEvent: (subscriptionId: string, event: string, data: unknown) => void;
}

interface SubscriptionScope {
  kind: "files" | "records";
  /**
   * "." for the whole workspace (every collection), otherwise a contained
   * workspace path: a file prefix, or a collection folder.
   */
  prefix: string;
  /**
   * For a root record watch: the collection paths the owner's read port
   * listed at registration. Delivery stays inside this set, so a root watch
   * reaches only what the owner could read; a collection created later
   * needs a new watch.
   */
  readable?: ReadonlySet<string>;
}

interface SubscriptionRecord {
  owner: PluginWorkspaceEventsOwner;
  scope: SubscriptionScope;
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

function requireParamsObject(
  params: unknown,
  method: string,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${method} parameters must be an object.`);
  }
  return params as Record<string, unknown>;
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
 * Serves `files.watch` and `collections.watch` for one workspace's plugins.
 *
 * The file source is the workspace's settled watcher batch — the same feed
 * the plugin approval pipeline reads (main.ts's onWatcherBatch). There is no
 * second watcher: a subscriber sees what settled, never raw filesystem noise,
 * and never dohc's own metadata writes, which the watcher drops before a
 * batch exists. The record source is the daemon's record events, validated
 * and routed here by recordEventsBridge.
 *
 * Delivery is unbuffered: an event goes to the owner's transport as it
 * settles and is never held here. Each transport owns its own buffering.
 */
export class PluginWorkspaceEvents {
  private readonly subscriptions = new Map<string, SubscriptionRecord>();

  subscribe(
    context: PluginWorkspaceEventsContext,
    params: unknown,
  ): { subscriptionId: string } {
    const input = requireParamsObject(params, PLUGIN_FILE_WATCH_METHOD);
    return this.register(context, {
      kind: "files",
      prefix: watchPrefix(input.path),
    });
  }

  subscribeRecords(
    context: PluginWorkspaceEventsContext,
    params: unknown,
    readable?: ReadonlySet<string>,
  ): { subscriptionId: string } {
    const input = requireParamsObject(params, PLUGIN_RECORD_WATCH_METHOD);
    // A collection path is a workspace path, so it gets the same containment
    // a file prefix does: a traversal or absolute path is refused here.
    const prefix = watchPrefix(input.path);
    return this.register(context, {
      kind: "records",
      prefix,
      ...(prefix === "." && readable ? { readable } : {}),
    });
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
   * Fans one settled batch out to the file subscriptions that asked for it.
   * The batch is read, never changed: the approval pipeline reads the same
   * array.
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
        if (subscription.scope.kind !== "files") continue;
        if (!isAtOrBelow(event.path, subscription.scope.prefix)) continue;
        const delivered: PluginFileWatchEvent = {
          path: event.path,
          operation: event.operation,
          ...(event.sha256 === undefined ? {} : { sha256: event.sha256 }),
        };
        subscription.emitEvent(subscriptionId, FILE_WATCH_EVENT, delivered);
      }
    }
  }

  /**
   * Fans one validated record event out to the record subscriptions whose
   * collection path contains it: the event's collectionPath equal to the
   * subscribed path, or below it.
   */
  handleRecordEvent(event: PluginRecordEvent): void {
    if (this.subscriptions.size === 0) return;
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (subscription.scope.kind !== "records") continue;
      if (
        !isAtOrBelow(event.data.collectionPath, subscription.scope.prefix)
      ) {
        continue;
      }
      if (
        subscription.scope.readable &&
        !subscription.scope.readable.has(event.data.collectionPath)
      ) {
        continue;
      }
      subscription.emitEvent(subscriptionId, event.name, event.data);
    }
  }

  private register(
    context: PluginWorkspaceEventsContext,
    scope: SubscriptionScope,
  ): { subscriptionId: string } {
    const open = this.countForOwner(context.owner);
    if (open >= MAX_PLUGIN_WORKSPACE_SUBSCRIPTIONS_PER_OWNER) {
      throw new Error(
        `${ownerLabel(context.owner)} already holds ${open} workspace ` +
          "subscriptions. MAX_PLUGIN_WORKSPACE_SUBSCRIPTIONS_PER_OWNER allows " +
          `at most ${MAX_PLUGIN_WORKSPACE_SUBSCRIPTIONS_PER_OWNER} open ` +
          `subscriptions per owner, across ${PLUGIN_FILE_WATCH_METHOD} and ` +
          `${PLUGIN_RECORD_WATCH_METHOD} combined. Unsubscribe one before ` +
          "opening another, or subscribe to a shared parent prefix instead.",
      );
    }
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, {
      owner: context.owner,
      scope,
      emitEvent: context.emitEvent,
    });
    return { subscriptionId };
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

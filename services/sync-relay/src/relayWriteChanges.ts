import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
export interface LiveHostChanges {
  readonly maxListeners: number;
  subscribe(changed: () => void, document?: LiveDocumentKey | Pick<LiveDocumentKey, "workspaceId" | "objectId">): () => void;
  notify(document?: LiveDocumentKey): void;
  notifyHost(workspaceIds: readonly string[]): void;
}

const observers = new WeakMap<object, Set<() => void>>();
const queued = new WeakSet<object>();
export function hasRelayWriteObservers(storage: object): boolean { return observers.has(storage); }

/** Each shared host owns one observer, released with its connection. */
export function observeRelayWrites(storage: object, changed: () => void): () => void {
  let listeners = observers.get(storage);
  if (!listeners) { listeners = new Set(); observers.set(storage, listeners); }
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (listeners.size === 0) observers.delete(storage);
  };
}

const acceptedObservers = new WeakMap<object, Set<(workspaceId: string) => void>>();

/** Hears each live edit the journal accepts, by its workspace. */
export function observeAcceptedLiveUpdates(storage: object, accepted: (workspaceId: string) => void): () => void {
  let listeners = acceptedObservers.get(storage);
  if (!listeners) { listeners = new Set(); acceptedObservers.set(storage, listeners); }
  listeners.add(accepted);
  return () => {
    listeners.delete(accepted);
    if (listeners.size === 0) acceptedObservers.delete(storage);
  };
}

/** Called where the journal accepts an edit. Listeners hear it after the write leaves SQLite; one rolled back wakes them for nothing. */
export function notifyAcceptedLiveUpdate(storage: object, workspaceId: string): void {
  if (!acceptedObservers.has(storage)) return;
  queueMicrotask(() => {
    for (const listener of [...(acceptedObservers.get(storage) ?? [])]) {
      try { listener(workspaceId); } catch { /* One listener cannot suppress another's wake. */ }
    }
  });
}

const chatWakeObservers = new WeakMap<object, Set<(accountId: string) => void>>();

/** Hears each change to an account's chat wakes, by the account. */
export function observeChatWakeChanges(storage: object, changed: (accountId: string) => void): () => void {
  let listeners = chatWakeObservers.get(storage);
  if (!listeners) { listeners = new Set(); chatWakeObservers.set(storage, listeners); }
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (listeners.size === 0) chatWakeObservers.delete(storage);
  };
}

/** Called where a chat wake changes. Listeners hear it after the write leaves SQLite; one rolled back wakes them for nothing. */
export function notifyChatWakeChange(storage: object, accountId: string): void {
  if (!chatWakeObservers.has(storage)) return;
  queueMicrotask(() => {
    for (const listener of [...(chatWakeObservers.get(storage) ?? [])]) {
      try { listener(accountId); } catch { /* One listener cannot suppress another's wake. */ }
    }
  });
}

const noticeObservers = new WeakMap<object, Set<(recipientUserId: string) => void>>();
const pendingNoticeChanges = new WeakMap<object, Set<string>>();

/** Hears each change to a person's Notice list, by its recipient. */
export function observeNoticeChanges(storage: object, changed: (recipientUserId: string) => void): () => void {
  let listeners = noticeObservers.get(storage);
  if (!listeners) { listeners = new Set(); noticeObservers.set(storage, listeners); }
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (listeners.size === 0) noticeObservers.delete(storage);
  };
}

/**
 * Called where a Notice list's change sequence or floor moves. Listeners hear each recipient once, after the write
 * leaves SQLite; one rolled back wakes them for nothing.
 */
export function notifyNoticeChange(storage: object, recipientUserId: string): void {
  if (!noticeObservers.has(storage)) return;
  const pending = pendingNoticeChanges.get(storage);
  if (pending) { pending.add(recipientUserId); return; }
  const recipients = new Set([recipientUserId]);
  pendingNoticeChanges.set(storage, recipients);
  queueMicrotask(() => {
    pendingNoticeChanges.delete(storage);
    for (const recipient of recipients) {
      for (const listener of [...(noticeObservers.get(storage) ?? [])]) {
        try { listener(recipient); } catch { /* One listener cannot suppress another's wake. */ }
      }
    }
  });
}

/** Notify after leaving SQLite. Ambiguous failures also require a fresh authority check. */
export function notifyRelayWrite(storage: object): void {
  if (!observers.has(storage) || queued.has(storage)) return;
  queued.add(storage);
  queueMicrotask(() => {
    queued.delete(storage);
    for (const listener of [...(observers.get(storage) ?? [])]) {
      try { listener(); } catch { /* One host cannot suppress another host's wake. */ }
    }
  });
}

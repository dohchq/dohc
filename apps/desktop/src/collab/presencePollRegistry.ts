// MU-C5 — main-process ownership registry for in-flight presence long-polls.
//
// Each renderer poll opens a relay long-poll in MAIN; this registry tracks the
// AbortController so presenceCancel can stop the EXACT fetch on unmount /
// workspace switch, and bounds how many a renderer can open. The relay bearer
// token never leaves main, so this is the only place a poll can be governed.
//
// Two robustness properties a buggy or hostile trusted renderer must not break:
//   1. OWNERSHIP — a poll is owned by (senderId, pollId). A presenceCancel from
//      a DIFFERENT window can't abort it, and a pollId COLLISION across windows
//      keeps both cancellable: each handle only ever removes its OWN entry (by
//      identity), so one window's cleanup never deletes another's controller.
//   2. BOUNDEDNESS — at most one active poll per (senderId, scope, topic): a new
//      poll for the same key SUPERSEDES (aborts) the prior, which is natural for
//      presence (one long-poll per scope per window). A per-sender ceiling is a
//      backstop against a renderer looping unique keys to exhaust main's
//      controllers/timers/relay sockets.

interface PollEntry {
  controller: AbortController;
  pollId: string;
  scopeTopicKey: string;
  // Guards double-removal: a superseded/evicted entry must not decrement the
  // count again when its own `finally` later releases it.
  removed: boolean;
}

interface SenderState {
  // Keyed by pollId for cancel, and by scope+topic for supersede. Both point at
  // the SAME entry so either index removes it consistently.
  byPollId: Map<string, PollEntry>;
  byScopeTopic: Map<string, PollEntry>;
}

export interface PresencePollHandle {
  readonly signal: AbortSignal;
  // Abort THIS poll (safety timeout / caller-driven stop).
  abort(): void;
  // Remove THIS poll from the registry — a no-op if it was already superseded,
  // so the poll's `finally` never deletes a newer entry.
  release(): void;
}

export interface PresencePollRegistry {
  begin(senderId: number, pollId: string, scopeTopicKey: string): PresencePollHandle;
  cancel(senderId: number, pollId: string): void;
  disposeSender(senderId: number): void;
  activeCount(): number;
}

export function createPresencePollRegistry(
  options: { maxPerSender?: number } = {},
): PresencePollRegistry {
  // A generous ceiling: legitimate presence uses one poll per open scope/topic
  // per window, so this only ever trips on a runaway renderer.
  const maxPerSender = options.maxPerSender ?? 64;
  const senders = new Map<number, SenderState>();

  const removeEntry = (senderId: number, entry: PollEntry): void => {
    if (entry.removed) return;
    entry.removed = true;
    const sender = senders.get(senderId);
    if (!sender) return;
    // Only delete indices that still point at THIS entry — a superseding poll
    // may have overwritten them under the same pollId/scopeTopicKey.
    if (sender.byPollId.get(entry.pollId) === entry) sender.byPollId.delete(entry.pollId);
    if (sender.byScopeTopic.get(entry.scopeTopicKey) === entry) {
      sender.byScopeTopic.delete(entry.scopeTopicKey);
    }
    if (sender.byPollId.size === 0) senders.delete(senderId);
  };

  const evict = (senderId: number, entry: PollEntry | undefined): void => {
    if (!entry) return;
    entry.controller.abort();
    removeEntry(senderId, entry);
  };

  return {
    begin(senderId, pollId, scopeTopicKey): PresencePollHandle {
      const prior = senders.get(senderId);
      if (prior) {
        // One active poll per (sender, scope, topic): supersede the prior. A
        // reused pollId within the same sender also supersedes, so cancel stays
        // unambiguous and the map can't hold two entries under one id.
        evict(senderId, prior.byScopeTopic.get(scopeTopicKey));
        evict(senderId, prior.byPollId.get(pollId));
      }
      // Re-fetch AFTER the evictions: emptying the sender's maps above removes
      // the sender entry, so create a fresh one rather than reuse a detached ref.
      let sender = senders.get(senderId);
      if (!sender) {
        sender = { byPollId: new Map(), byScopeTopic: new Map() };
        senders.set(senderId, sender);
      }

      const entry: PollEntry = {
        controller: new AbortController(),
        pollId,
        scopeTopicKey,
        removed: false,
      };
      sender.byPollId.set(pollId, entry);
      sender.byScopeTopic.set(scopeTopicKey, entry);

      // Backstop ceiling: a renderer looping UNIQUE (pollId, scopeTopic) pairs
      // can't grow unboundedly — drop this sender's oldest poll past the cap.
      while (sender.byPollId.size > maxPerSender) {
        const oldest = sender.byPollId.values().next().value as PollEntry | undefined;
        if (!oldest || oldest === entry) break;
        evict(senderId, oldest);
      }

      return {
        signal: entry.controller.signal,
        abort: () => entry.controller.abort(),
        release: () => removeEntry(senderId, entry),
      };
    },

    cancel(senderId, pollId): void {
      // Only the OWNING sender can abort. A cancel from another window for the
      // same pollId finds nothing and is a no-op. The poll's own `finally`
      // (release) removes the entry, so cancel only signals the abort.
      senders.get(senderId)?.byPollId.get(pollId)?.controller.abort();
    },

    disposeSender(senderId): void {
      const sender = senders.get(senderId);
      if (!sender) return;
      for (const entry of [...sender.byPollId.values()]) evict(senderId, entry);
      senders.delete(senderId);
    },

    activeCount(): number {
      let total = 0;
      for (const sender of senders.values()) total += sender.byPollId.size;
      return total;
    },
  };
}

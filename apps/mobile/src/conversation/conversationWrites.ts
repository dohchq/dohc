import type { ClearRequest, FieldChange } from "../../modules/chat-composer";
import type { ChatWrite } from "../server/chatWrites";
import { OutboxError, type DiscardTarget, type Outbox, type OutboxState } from "../server/outbox";

// What a conversation's write controls do, apart from how they look. The outbox is the only thing that keeps or sends a
// write: this checks the gate, makes the write the route takes, keeps one attempt of each kind from running twice, and
// says what the screen should do with its text once the outbox answers. A screen whose account or workspace changed
// asks the outbox nothing, and does nothing with an answer that comes after the change.

/** What a conversation's controls need of the outbox. The sample build gives one that keeps its records in memory. */
export type WriteOutbox = Pick<
  Outbox,
  "state" | "subscribe" | "enqueue" | "retryEnqueue" | "discard" | "wake"
>;

export type OutboxRecord = OutboxState["records"][number];

/** Which writes a stream takes: a New post action, and the chat composer. */
export interface Lanes {
  readonly post: boolean;
  readonly send: boolean;
}

/** The lanes the server says a stream takes. A DM or an agent's chat never offers New post. */
export function lanesOf(context: {
  readonly groupKind: "group" | "dm" | "agent";
  readonly canPost: boolean;
  readonly canSend: boolean;
}): Lanes {
  return { post: context.groupKind === "group" && context.canPost, send: context.canSend };
}

/**
 * Why the composer can't send now, or null when it can. `off`: phone writes are off in this build. `deleting`: a Sign
 * out's delete is owed, so nothing is added. `loading`, `locked` and `failed` are the outbox reading its records.
 */
export type Blocked = "off" | "deleting" | "loading" | "locked" | "failed" | null;

export function blockedBy(state: OutboxState, enabled: boolean): Blocked {
  if (!enabled) return "off";
  if (state.deletion !== "none") return "deleting";
  return state.status === "ready" ? null : state.status;
}

/** Where a new message goes: the chat's conversation, or a new post in a Group. Both name the engine channel. */
export type Destination =
  | { readonly kind: "send"; readonly streamId: string }
  | { readonly kind: "post"; readonly groupId: string };

/** The write for a message, or null when the body has only spaces. A blank title is left out. */
export function chatWrite(destination: Destination, body: string, title = ""): ChatWrite | null {
  if (body.trim() === "") return null;
  if (destination.kind === "send")
    return { operation: "send", args: { streamId: destination.streamId, body } };
  const trimmed = title.trim();
  return {
    operation: "post",
    args: { groupId: destination.groupId, body, ...(trimmed === "" ? {} : { title: trimmed }) },
  };
}

/**
 * What the composer holds: the body, a post's title, and whether New post is chosen. Each has a revision that every
 * edit raises, so an edit away and back still counts as an edit. The body's is the native field's.
 */
export interface Draft {
  readonly text: string;
  readonly textRevision: number;
  readonly title: string;
  readonly titleRevision: number;
  readonly chosen: "send" | "post";
  readonly chosenRevision: number;
}

export const EMPTY_DRAFT: Draft = {
  text: "",
  textRevision: 0,
  title: "",
  titleRevision: 0,
  chosen: "send",
  chosenRevision: 0,
};

/**
 * The draft once the outbox keeps `sent`: the title clears if nobody edited it since. The native field clears the body
 * itself, only if nobody edited it since, and New post closes once it has (`closePost`).
 */
export function clearSent(current: Draft, sent: Draft): Draft {
  return current.titleRevision === sent.titleRevision ? { ...current, title: "" } : current;
}

/**
 * The draft once the native field cleared the body of `sent`. New post closes only when its title and choice weren't
 * edited meanwhile either, so a post being written during the enqueue stays a post.
 */
export function closePost(current: Draft, sent: Draft): Draft {
  return current.titleRevision === sent.titleRevision &&
    current.chosenRevision === sent.chosenRevision
    ? { ...current, chosen: "send" }
    : current;
}

/**
 * Where the native field is with `request`, for the body at `textRevision`, given the token it last `refused`. `waiting`:
 * it owes an answer, so a body sent again can't replace the request whose clear closes New post. `refused`: it kept the
 * body the outbox kept, unchanged, as with text still being composed, so Send stays off for that body until an edit.
 * `settled`: it cleared, or the body changed since. Token 0 asks nothing.
 */
export function clearStatus(
  request: ClearRequest,
  textRevision: number,
  refused: number,
): "waiting" | "refused" | "settled" {
  if (request.token === 0 || textRevision > request.revision) return "settled";
  return refused === request.token ? "refused" : "waiting";
}

/** The draft once the field reports `change`. Only its clear for `request` closes New post, by `closePost`. */
export function fieldChanged(
  current: Draft,
  change: FieldChange,
  request: ClearRequest,
  sent: Draft,
): Draft {
  const typed = { ...current, text: change.text, textRevision: change.revision };
  return change.cleared !== 0 && change.cleared === request.token ? closePost(typed, sent) : typed;
}

/** One showing of a workspace store and chat. Showing the same ones again is another activation. */
export interface WriteActivation {
  readonly store: object;
  readonly target: string;
}

/**
 * The activation a screen shows, which its write controllers check before each step. A controller made for another
 * activation, an ended one even when its store and chat return, or one kept past the screen's close, asks nothing.
 */
export function createWriteScope() {
  let shown: WriteActivation | null = null;
  return {
    /** Shows `activation` until the function returned, or the next `show`. */
    show(activation: WriteActivation): () => void {
      shown = activation;
      return () => {
        if (shown === activation) shown = null;
      };
    },
    shows: (activation: WriteActivation) => shown === activation,
  };
}

/**
 * What became of a submit. `kept`: the outbox keeps it, so the composer clears the text it sent. `withheld`: the outbox
 * may keep it, withheld under `operationId`, and its row offers Send, so the composer clears that text too and never
 * sends it again as another message. `not-kept`: nothing was kept, so the text stays, and Try again submits it.
 * `blocked`: nothing was asked, or the outbox wasn't open. `stale`: the account or workspace changed meanwhile.
 */
export type SubmitOutcome =
  | { readonly kind: "kept" }
  | { readonly kind: "withheld"; readonly operationId: string }
  | { readonly kind: "not-kept" }
  | { readonly kind: "blocked" }
  | { readonly kind: "stale" };

/** `not-kept`: the record stays withheld, and Send stays to try again. */
export type RetryOutcome = { readonly kind: "kept" | "not-kept" | "blocked" | "stale" };

/** `may-send`: neither the withheld record nor its delete is durable, so a relaunch may send it. */
export type DiscardOutcome = {
  readonly kind: "discarded" | "failed" | "may-send" | "blocked" | "stale";
};

export interface ConversationWrites {
  submit(workspaceId: string, write: ChatWrite): Promise<SubmitOutcome>;
  /** Sends a withheld record as its own operation, with the body it keeps. */
  retry(operationId: string): Promise<RetryOutcome>;
  /** Deletes a record, or a record that can't be read, from this phone. */
  discard(target: DiscardTarget): Promise<DiscardOutcome>;
}

/**
 * `enabled` is the build's gate: off, nothing reaches the outbox. `isCurrent` says whether the screen's account and
 * workspace are still the ones it asked for.
 */
export function createConversationWrites(options: {
  readonly outbox: WriteOutbox | null;
  readonly enabled: boolean;
  readonly isCurrent: () => boolean;
}): ConversationWrites {
  const { outbox, enabled, isCurrent } = options;
  // One submit at a time, and one Send or Discard at a time per record, so a second tap does nothing.
  const running = new Set<string>();
  // Checked when the action runs, so Discard's confirmation answered after a workspace change asks nothing.
  async function once<T>(
    key: string,
    run: (outbox: WriteOutbox) => Promise<T>,
  ): Promise<T | { readonly kind: "blocked" } | { readonly kind: "stale" }> {
    if (!enabled || !outbox || running.has(key) || blockedBy(outbox.state(), enabled) !== null)
      return { kind: "blocked" };
    if (!isCurrent()) return { kind: "stale" };
    running.add(key);
    try {
      return await run(outbox);
    } finally {
      running.delete(key);
    }
  }

  return {
    submit: (workspaceId, write) =>
      once<SubmitOutcome>("submit", async (box) => {
        try {
          await box.enqueue({ workspaceId, write });
          return isCurrent() ? { kind: "kept" } : { kind: "stale" };
        } catch (error) {
          if (!isCurrent()) return { kind: "stale" };
          if (error instanceof OutboxError && error.kind === "indeterminate" && error.operationId)
            return { kind: "withheld", operationId: error.operationId };
          if (error instanceof OutboxError && error.kind === "closed") return { kind: "blocked" };
          return { kind: "not-kept" };
        }
      }),

    retry: (operationId) =>
      once<RetryOutcome>(`record:${operationId}`, async (box) => {
        try {
          await box.retryEnqueue(operationId);
          return { kind: isCurrent() ? "kept" : "stale" };
        } catch (error) {
          if (!isCurrent()) return { kind: "stale" };
          if (error instanceof OutboxError && (error.kind === "closed" || error.kind === "invalid"))
            return { kind: "blocked" };
          return { kind: "not-kept" };
        }
      }),

    discard: (target) =>
      once<DiscardOutcome>(
        target.kind === "record" ? `record:${target.operationId}` : `unreadable:${target.handle}`,
        async (box) => {
          try {
            await box.discard(target);
            return { kind: isCurrent() ? "discarded" : "stale" };
          } catch (error) {
            if (!isCurrent()) return { kind: "stale" };
            if (error instanceof OutboxError && error.kind === "withheld-in-memory")
              return { kind: "may-send" };
            if (error instanceof OutboxError && error.kind === "closed") return { kind: "blocked" };
            return { kind: "failed" };
          }
        },
      ),
  };
}

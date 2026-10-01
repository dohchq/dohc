import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ChatReactionRecord } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";

// Reactions (WS-MU-C2) for one workspace. Every chat surface (the Chats view
// with its chat lane, post previews, and Home, and the file-rail LinkedChats)
// hands its reaction reads to this store and paints only what the store
// projects, so every surface shows the same rows, and writes on one
// (message, emoji) cell reach the server in the order the person chose them.
//
// Every read and every acknowledged write takes a ticket from one counter.
// The newest read that covers a message is its confirmed state; an older read
// changes nothing it covers. Over that the store lays the writes no read has
// seen yet: accepted writes, then intents in flight.
//   1. A toggle paints at once. While a write on its cell is in flight, only
//      the newest waiting intent is sent after it.
//   2. A rejected write stops painting, so its author's rows show what the
//      server is known to hold: their newest accepted write, else the newest
//      read, whichever surface read it.
//   3. An accepted write stays painted until a read that began after it
//      lands, even when its own listing fails. That failure says the write
//      saved only when the accepted write was this viewer's.
//   4. When a read names a new viewer, the old name follows only on positive
//      evidence that they are one person: a row held under the old name whose
//      stable id the newer read attributes to the new one. A viewer changing,
//      having no rows, or sharing a cell proves nothing.
// Nothing here sets a surface's state. Errors go to the destination the
// toggle named, which each surface gates on its own visit.

export type ReactionState = "added" | "removed";

export interface ReactionRead {
  threadId: string;
  // The messages the read answers for. Absent: the whole thread, so a message
  // it does not mention has no reactions. A post preview or Home item answers
  // for its one message and says nothing about the rest.
  messageIds?: readonly string[];
  reactions: ChatReactionRecord[];
  // Main names the viewer per thread. Absent when a Home item names none.
  viewerAuthorId?: string;
  // Taken before the read started.
  ticket: number;
}

export interface ReactionView {
  reactions: ChatReactionRecord[];
  viewerAuthorId: string;
}

export interface ReactionToggle {
  threadId: string;
  messageId: string;
  emoji: string;
  nextState: ReactionState;
  // The viewer as the store's view names them. Empty only for a Home item
  // that named none: the write goes unpainted and its listing names them.
  viewerAuthorId: string;
  // The name the painted row shows. The viewer id when absent.
  viewerLabel?: string;
  // Where this toggle's errors go, already gated on the surface's visit.
  onError: (message: string, cause?: unknown) => void;
}

export interface ReactionStore {
  // Take one before a reaction read starts and ingest the read with it.
  ticket: () => number;
  ingest: (reads: readonly ReactionRead[]) => void;
  toggle: (input: ReactionToggle) => void;
  // A thread's rows, or one message's. The same answer object until they
  // change.
  view: (threadId: string, messageId?: string) => ReactionView;
  // A write or listing for this message is in flight.
  pending: (threadId: string, messageId: string) => boolean;
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  // Runs once nothing is in flight. The session owner retires a store with it.
  whenIdle: (callback: () => void) => void;
}

interface Intent {
  author: string;
  label: string;
  state: ReactionState;
  onError: ReactionToggle["onError"];
}

// A write the server accepted, at the ticket of its acknowledgement.
interface Accepted extends Omit<Intent, "onError"> {
  at: number;
}

interface Cell {
  messageId: string;
  emoji: string;
  writing: Intent | null;
  // The newest intent waiting for the write in flight.
  queued: Intent | null;
  // The newest intent chosen. Its destination hears a listing failure.
  latest: Intent;
  // Accepted writes no read has covered yet, one per author, oldest first.
  accepted: Accepted[];
  // A write was accepted since the cell's newest listing started.
  unlisted: boolean;
  listings: number;
}

interface Confirmed {
  rows: ChatReactionRecord[];
  at: number;
}

interface Thread {
  // The newest whole-thread read.
  full: Confirmed | null;
  // Messages read since then, each by its newest read.
  messages: Map<string, Confirmed>;
  viewer: { id: string; at: number } | null;
  // Each name proven, by a stable reaction id, to be one person with another.
  people: Map<string, Person>;
  cells: Map<string, Cell>;
  revision: number;
}

// One person's proven names. Rows show under the thread's viewer when the
// viewer is one of them, else under the name the newest proof gave.
interface Person {
  names: Set<string>;
  current: string;
}

interface Rows {
  reactions: ChatReactionRecord[];
  viewerAuthorId?: string;
}

const NO_VIEW: ReactionView = { reactions: [], viewerAuthorId: "" };

const inMessage = (messageId: string) => (row: ChatReactionRecord) => row.messageId === messageId;

function provenAlias(older: Rows, newer: Rows) {
  const from = older.viewerAuthorId ?? "";
  const to = newer.viewerAuthorId ?? "";
  if (!from || !to || from === to) return null;
  const renamed = new Set(
    newer.reactions.filter((row) => row.authorId === to).map((row) => row.reactionId),
  );
  return older.reactions.some((row) => row.authorId === from && renamed.has(row.reactionId))
    ? { from, to }
    : null;
}

// Main maps a local fallback's rows to the signed-in account and back again
// on sign-out, so a proof can run either way between the same names.
function proveSamePerson(thread: Thread, from: string, to: string) {
  const left = thread.people.get(from);
  const right = thread.people.get(to);
  const person = left ?? right ?? { names: new Set<string>(), current: to };
  for (const name of [from, to, ...(left?.names ?? []), ...(right?.names ?? [])]) {
    person.names.add(name);
    thread.people.set(name, person);
  }
  person.current = to;
}

function renamer(thread: Thread) {
  const viewer = thread.viewer?.id;
  return (name: string) => {
    const person = thread.people.get(name);
    if (!person) return name;
    return viewer !== undefined && person.names.has(viewer) ? viewer : person.current;
  };
}

// Replace the rows `matches` selects, in place; new rows go last. Unchanged
// rows keep the array.
function replaceRows(
  rows: ChatReactionRecord[],
  matches: (row: ChatReactionRecord) => boolean,
  next: ChatReactionRecord[],
): ChatReactionRecord[] {
  const current = rows.filter(matches);
  if (current.length === next.length && current.every((row, index) => row === next[index])) {
    return rows;
  }
  const at = rows.findIndex(matches);
  const kept = rows.filter((row) => !matches(row));
  const index = at < 0 ? kept.length : at;
  return [...kept.slice(0, index), ...next, ...kept.slice(index)];
}

// One author's rows on a cell, as an intent or accepted write leaves them.
// A row a read already holds for them stays as it is.
function withAuthor(
  rows: ChatReactionRecord[],
  threadId: string,
  cell: Cell,
  author: string,
  write: Omit<Intent, "onError">,
): ChatReactionRecord[] {
  const own = rows.find((row) => row.authorId === author);
  if (write.state === "removed") return own ? rows.filter((row) => row.authorId !== author) : rows;
  if (own) return rows.filter((row) => row.authorId !== author || row === own);
  return [
    ...rows,
    {
      reactionId: `optimistic:${cell.messageId}:${cell.emoji}:${author}`,
      messageId: cell.messageId,
      threadId,
      emoji: cell.emoji,
      authorId: author,
      authorKind: "human",
      authorDisplayName: write.label,
    },
  ];
}

function confirmedAt(thread: Thread, messageId: string): number {
  return thread.messages.get(messageId)?.at ?? thread.full?.at ?? 0;
}

function confirmedRows(thread: Thread, messageId?: string): ChatReactionRecord[] {
  if (messageId !== undefined) {
    return thread.messages.get(messageId)?.rows ?? thread.full?.rows.filter(inMessage(messageId)) ?? [];
  }
  let rows = thread.full?.rows ?? [];
  for (const [id, record] of thread.messages) rows = replaceRows(rows, inMessage(id), record.rows);
  return rows;
}

function ingestRead(thread: Thread, read: ReactionRead) {
  const { ticket } = read;
  const viewer = read.viewerAuthorId ?? "";
  if (viewer) {
    const known = thread.viewer;
    if (known && known.id !== viewer) {
      const before = { reactions: confirmedRows(thread), viewerAuthorId: known.id };
      const alias = known.at < ticket ? provenAlias(before, read) : provenAlias(read, before);
      if (alias) proveSamePerson(thread, alias.from, alias.to);
    }
    if (!known || known.at < ticket) thread.viewer = { id: viewer, at: ticket };
  }
  const covered = read.messageIds;
  if (covered === undefined) {
    if (!thread.full || thread.full.at < ticket) {
      thread.full = { rows: read.reactions, at: ticket };
      for (const [id, record] of thread.messages) {
        if (record.at <= ticket) thread.messages.delete(id);
      }
    }
  } else {
    for (const id of covered) {
      if (confirmedAt(thread, id) < ticket) {
        thread.messages.set(id, { rows: read.reactions.filter(inMessage(id)), at: ticket });
      }
    }
  }
  // A read that began after a write was accepted already shows it. So every
  // accepted write still held is newer than its message's confirmed state.
  for (const cell of thread.cells.values()) {
    if (covered && !covered.includes(cell.messageId)) continue;
    cell.accepted = cell.accepted.filter((write) => write.at > ticket);
  }
}

function project(threadId: string, thread: Thread, messageId: string | undefined): ReactionView {
  const rename = renamer(thread);
  let rows = confirmedRows(thread, messageId);
  if (thread.people.size > 0) {
    rows = rows.map((row) => {
      const authorId = rename(row.authorId);
      return authorId === row.authorId ? row : { ...row, authorId };
    });
  }
  for (const cell of thread.cells.values()) {
    if (messageId !== undefined && cell.messageId !== messageId) continue;
    const inCell = (row: ChatReactionRecord) =>
      row.messageId === cell.messageId && row.emoji === cell.emoji;
    let cellRows = rows.filter(inCell);
    // Accepted writes no read has seen, then intents in flight. An unknown
    // viewer's writes paint nothing: their listing names them.
    for (const write of [...cell.accepted, cell.writing, cell.queued]) {
      if (write?.author) cellRows = withAuthor(cellRows, threadId, cell, rename(write.author), write);
    }
    rows = replaceRows(rows, inCell, cellRows);
  }
  return { reactions: rows, viewerAuthorId: rename(thread.viewer?.id ?? "") };
}

function sameRow(left: ChatReactionRecord, right: ChatReactionRecord): boolean {
  if (left === right) return true;
  const keys = Object.keys(left) as (keyof ChatReactionRecord)[];
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function sameView(left: ReactionView, right: ReactionView): boolean {
  return (
    left.viewerAuthorId === right.viewerAuthorId &&
    left.reactions.length === right.reactions.length &&
    left.reactions.every((row, index) => {
      const other = right.reactions[index];
      return other !== undefined && sameRow(row, other);
    })
  );
}

export function createReactionStore(workspaceId: string): ReactionStore {
  let seq = 0;
  let version = 0;
  const threads = new Map<string, Thread>();
  const listeners = new Set<() => void>();
  let idleCallbacks: Array<() => void> = [];
  // Projections by thread and message, so an unchanged answer keeps its
  // identity across renders and across reads that changed nothing.
  const views = new Map<string, { revision: number; view: ReactionView }>();

  const busy = (cell: Cell) => cell.writing !== null || cell.queued !== null || cell.listings > 0;
  const idle = () =>
    [...threads.values()].every((thread) => [...thread.cells.values()].every((cell) => !busy(cell)));

  function threadOf(threadId: string): Thread {
    let thread = threads.get(threadId);
    if (!thread) {
      thread = { full: null, messages: new Map(), viewer: null, people: new Map(), cells: new Map(), revision: 0 };
      threads.set(threadId, thread);
    }
    return thread;
  }

  function changed(...touched: Thread[]) {
    for (const thread of touched) thread.revision += 1;
    version += 1;
    for (const listener of [...listeners]) listener();
    if (idleCallbacks.length > 0 && idle()) {
      const callbacks = idleCallbacks;
      idleCallbacks = [];
      for (const callback of callbacks) callback();
    }
  }

  function list(threadId: string, thread: Thread, cell: Cell) {
    cell.unlisted = false;
    cell.listings += 1;
    const ticket = ++seq;
    const latest = cell.latest;
    const accepted = cell.accepted.at(-1);
    void bridge()
      .listChatReactions({ workspaceId, threadId })
      .then(
        (result) => ingestRead(thread, { threadId, ...result, ticket }),
        (error: unknown) => {
          // A newer toggle's own listing or rejection speaks for it.
          if (cell.latest !== latest) return;
          const rename = renamer(thread);
          const saved = accepted !== undefined && rename(accepted.author) === rename(latest.author);
          latest.onError(
            withErrorWords(
              saved
                ? "Your reaction was saved, but dohc could not reload reactions."
                : "dohc could not reload reactions.",
              error,
            ),
            error,
          );
        },
      )
      .then(() => {
        cell.listings -= 1;
        changed(thread);
      });
  }

  function write(threadId: string, thread: Thread, cell: Cell, intent: Intent) {
    cell.writing = intent;
    const { messageId, emoji } = cell;
    void bridge()
      .setChatReaction({ workspaceId, threadId, messageId, emoji, state: intent.state })
      .then(
        () => {
          // Only a read names the viewer: this write's own result can carry a
          // removed alias.
          const { author, label, state } = intent;
          cell.accepted = [
            ...cell.accepted.filter((write) => write.author !== author),
            { author, label, state, at: ++seq },
          ];
          cell.unlisted = true;
        },
        (error: unknown) => {
          intent.onError(ipcErrorMessage(error, "Could not update that reaction."), error);
        },
      )
      .then(() => {
        cell.writing = null;
        const next = cell.queued;
        cell.queued = null;
        if (next) write(threadId, thread, cell, next);
        else if (cell.unlisted) list(threadId, thread, cell);
        changed(thread);
      });
  }

  return {
    ticket: () => ++seq,
    ingest(reads) {
      const touched = new Set<Thread>();
      for (const read of reads) {
        const thread = threadOf(read.threadId);
        ingestRead(thread, read);
        touched.add(thread);
      }
      if (touched.size > 0) changed(...touched);
    },
    toggle(input) {
      const thread = threadOf(input.threadId);
      const intent: Intent = {
        author: input.viewerAuthorId,
        label: input.viewerLabel ?? input.viewerAuthorId,
        state: input.nextState,
        onError: input.onError,
      };
      // NUL-joined so a message id that ends with the emoji (or vice versa)
      // can't alias another cell's key.
      const key = `${input.messageId}\u0000${input.emoji}`;
      let cell = thread.cells.get(key);
      if (!cell) {
        cell = {
          messageId: input.messageId,
          emoji: input.emoji,
          writing: null,
          queued: null,
          latest: intent,
          accepted: [],
          unlisted: false,
          listings: 0,
        };
        thread.cells.set(key, cell);
      }
      cell.latest = intent;
      // A newer intent replaces the one waiting: the server only needs the last.
      if (cell.writing) cell.queued = intent;
      else write(input.threadId, thread, cell, intent);
      changed(thread);
    },
    view(threadId, messageId) {
      const thread = threads.get(threadId);
      if (!thread) return NO_VIEW;
      const key = messageId === undefined ? threadId : `${threadId}\u0000${messageId}`;
      const cached = views.get(key);
      if (cached?.revision === thread.revision) return cached.view;
      const next = project(threadId, thread, messageId);
      const view = cached && sameView(cached.view, next) ? cached.view : next;
      views.set(key, { revision: thread.revision, view });
      return view;
    },
    pending(threadId, messageId) {
      for (const cell of threads.get(threadId)?.cells.values() ?? []) {
        if (cell.messageId === messageId && busy(cell)) return true;
      }
      return false;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    whenIdle(callback) {
      if (idle()) callback();
      else idleCallbacks.push(callback);
    },
  };
}

const ReactionStoreContext = createContext<ReactionStore | null>(null);

// The session's reaction stores. A workspace left with writes or listings in
// flight keeps its store until they settle, so a return keeps their order.
export function ReactionStoreProvider(props: { workspaceId: string | null; children: ReactNode }) {
  const { workspaceId } = props;
  const [stores] = useState(() => new Map<string, ReactionStore>());
  const open = useRef(workspaceId);
  let store: ReactionStore | null = null;
  if (workspaceId !== null) {
    store = stores.get(workspaceId) ?? createReactionStore(workspaceId);
    stores.set(workspaceId, store);
  }
  useEffect(() => {
    open.current = workspaceId;
    for (const [id, left] of stores) {
      if (id === workspaceId) continue;
      left.whenIdle(() => {
        if (open.current !== id && stores.get(id) === left) stores.delete(id);
      });
    }
  }, [stores, workspaceId]);
  return <ReactionStoreContext.Provider value={store}>{props.children}</ReactionStoreContext.Provider>;
}

// The open workspace's reactions. The caller renders again whenever they change.
export function useReactions(): ReactionStore {
  const store = useContext(ReactionStoreContext);
  if (!store) throw new Error("useReactions needs a ReactionStoreProvider.");
  useSyncExternalStore(store.subscribe, store.version);
  return store;
}

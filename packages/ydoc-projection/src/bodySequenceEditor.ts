import { keydownHandler } from "@tiptap/pm/keymap";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
} from "./bodySequenceGrammar.js";
import {
  blockHolding,
  changes,
  createBodyReader,
  indexAt,
  positionAt,
  positionOf,
  shareAContainerId,
  startBefore,
  tokenBefore,
  tokenFrom,
  whatFollowsStartOf,
  type BodyReader,
  type BodyReading,
  type Followed,
} from "./bodySequenceReading.js";
import {
  changesBlocks,
  giveBoundaries,
  keepsContainers,
  keepsPairs,
  linesGivenBoundaries,
  linesMade,
  linesWithNoBoundary,
  writeTransaction,
} from "./bodySequenceWriting.js";

export type BodySequenceOptions = {
  /** The note's `sequence`, declared before any update was applied to its document. */
  sequence: Y.Text;
  /** The note's `containers`, declared before any update was applied to its document. */
  containers: Y.Map<unknown>;
  /**
   * The guard a host puts around a person's change, for a host that has one. It runs `change`
   * before it returns, inside a Yjs transaction of its own with no origin if it likes, and
   * returns whether it ran it. When it did not, the editor shows the note as it stands.
   *
   * One dispatch of the editor asks for one change. It asks for two, one after the other, when
   * it edits a line that has no boundary of its own, or needs such a line to have one: the first
   * gives the line its boundary and undo does not record it, the second is the dispatch.
   *
   * The host opens no Yjs transaction around the dispatch itself. A dispatch that changes the
   * document is refused, so the editor stays as it is and nothing is written:
   *
   * - while a Yjs transaction is open on the note's document, or Yjs has not told of every
   *   finished one yet. That is the case inside every Yjs callback, and for good once a listener
   *   of the host has thrown from `update`: Yjs then tells of nothing more on that document, and
   *   the host mounts the note again. Undo and redo are refused then too;
   * - while that document holds a change the editor does not show yet;
   * - while the editor shows the note. What another plugin adds to such a transaction is not
   *   applied, so showing a peer's change, a mounted note, a correction, an undo or a redo writes
   *   nothing.
   *
   * A plugin that dispatches from its own view update before the adapter has written the edit
   * that caused it has its edit written with that edit: one update and one undo step.
   */
  edit?: (change: () => void) => boolean;
  /**
   * A history that outlives this editor, made with `createBodySequenceHistory`. Without one the
   * plugin makes its own and destroys it with the view. Editors given one history share its undo
   * steps, as two panes on one note do.
   */
  history?: Y.UndoManager;
};

const NONE: readonly Transaction[] = [];
const ADD_TO_HISTORY = "addToHistory";

/** The plugin's key. Its state is the editor changes not yet written to the sequence. */
export const bodySequenceKey = new PluginKey<readonly Transaction[]>("dohcBodySequence");

/**
 * True for a transaction that shows what the sequence reads as. A host must apply it, must not
 * refuse it, and must not run it inside the guard it puts around a person's own change.
 */
export function isBodySequenceChange(transaction: Transaction): boolean {
  return transaction.getMeta(bodySequenceKey) === true;
}

const originOfHistory = new WeakMap<Y.UndoManager, symbol>();

/**
 * A history of one person's own changes to a note's sequence and container records. It follows
 * a Yjs transaction only when an editor given this history marked it as the person's change, so
 * it works the same when the host runs an editor change inside its own Yjs transaction with no
 * origin. Each history has an origin of its own for those changes, so two histories on one
 * document never undo each other's.
 *
 * An undo puts an earlier value back over someone else's later one. It never deletes a container
 * record, and never an attribute of a boundary that still stands. An inline item's attribute is
 * not kept that way: it may have had no value before a person first set it, and undo removes it.
 *
 * A boundary the adapter gives a line that had none of its own is written in a change of its own
 * that the history does not follow, so no undo removes it and text someone else typed in that
 * line since stays in it. The boundary an Enter makes is part of the Enter.
 */
export function createBodySequenceHistory(
  doc: Y.Doc,
  options: { captureTimeout?: number } = {},
): Y.UndoManager {
  const origin = Symbol("one person's changes to a note's body");
  const containers = doc.getMap(BODY_CONTAINERS_FIELD);
  const history: Y.UndoManager = new Y.UndoManager([doc.getText(BODY_SEQUENCE_FIELD), containers], {
    trackedOrigins: new Set([origin, null]),
    captureTransaction: (transaction) =>
      transaction.origin === history || transaction.meta.get(bodySequenceKey) === origin,
    ignoreRemoteMapChanges: true,
    deleteFilter: (item) =>
      item.parent !== containers &&
      !(
        item.parent instanceof Y.XmlElement &&
        item.parent.nodeName === BLOCK_ELEMENT &&
        item.parentSub !== null
      ),
    ...(options.captureTimeout === undefined ? {} : { captureTimeout: options.captureTimeout }),
  });
  originOfHistory.set(history, origin);
  return history;
}

/**
 * Stops Yjs from deleting formatting items of a note's sequence on its own after a change from
 * elsewhere, until the returned function is called. Those deletes are in nobody's change, and
 * neither the server's checks nor the engine make them, so a page that made them would stop
 * reading as the stored note. The plugin does this for the sequence it binds. A host that holds a
 * note's document with no editor on it calls this itself.
 *
 * Yjs has no setting for this, and decides it for a whole transaction: after `afterTransaction`,
 * from this field of the transaction. So a transaction from elsewhere that changes the sequence
 * also leaves alone the formatting items of any other text it changes in the same document.
 * Those items change nothing that text reads as; they stay stored. A transaction that does not
 * change the sequence is cleaned as Yjs cleans it.
 */
export function keepBodySequenceFormatting(sequence: Y.Text): () => void {
  const doc = sequence.doc;
  if (!doc) throw new Error("The body sequence must be part of a Yjs document.");
  const keep = (transaction: Y.Transaction) => {
    if (changes(transaction.changedParentTypes, sequence))
      transaction._needFormattingCleanup = false;
  };
  doc.on("afterTransaction", keep);
  return () => doc.off("afterTransaction", keep);
}

type Bound = { sequence: Y.Text; history: Y.UndoManager; reader: BodyReader };

function boundOf(state: EditorState): Bound | null {
  const read = bodySequenceKey.get(state)?.spec.bound as (() => Bound | null) | undefined;
  return read?.() ?? null;
}

/** Whether Yjs has a transaction open on a document, or has not told of every finished one yet. */
function isBusy(doc: Y.Doc): boolean {
  return doc._transaction !== null || doc._transactionCleanups.length > 0;
}

function stepOfHistory(step: "undo" | "redo"): Command {
  return (state, dispatch) => {
    const bound = boundOf(state);
    const doc = bound?.sequence.doc;
    if (!bound || !doc || isBusy(doc)) return false;
    const steps = step === "undo" ? bound.history.undoStack : bound.history.redoStack;
    if (steps.length === 0) return false;
    if (dispatch) bound.history[step]();
    return true;
  };
}

/**
 * Undoes this person's last change. The change comes back from the sequence as its own
 * transaction, so a host whose commands carry a transaction must not dispatch that one too. Like
 * an edit, it is refused while a Yjs transaction is open on the note's document or Yjs has not
 * told of every finished one: Yjs would lose the redo.
 */
export const undoBodySequence: Command = stepOfHistory("undo");

/** Redoes the change this person last undid. It dispatches and is refused as `undoBodySequence` is. */
export const redoBodySequence: Command = stepOfHistory("redo");

const HELD_BY_WHAT_FOLLOWS = 2;

/**
 * A place in the note that stays with its letters through everyone's changes: for a caret shown
 * to other people, or a mark that must survive a reload of the editor. `state` is the view's
 * current state. `assoc` is read by its sign, as Yjs reads it: negative keeps the place with
 * what stands before it. At the start of a block with no boundary of its own the place is kept
 * with what follows it, so it stays in that block, unless `assoc` is negative. Such an anchor
 * carries an association of 2, which no anchor made here for another place has.
 */
export function bodySequenceAnchor(
  state: EditorState,
  pos: number,
  assoc = 0,
): Y.RelativePosition | null {
  const bound = boundOf(state);
  if (!bound) return null;
  const reading = bound.reader.reading();
  const side = assoc < 0 ? -1 : 0;
  const follows = side < 0 ? -1 : whatFollowsStartOf(reading, pos);
  return follows < 0
    ? Y.createRelativePositionFromTypeIndex(bound.sequence, indexAt(reading, pos), side)
    : Y.createRelativePositionFromTypeIndex(bound.sequence, follows, HELD_BY_WHAT_FOLLOWS);
}

/** Where an anchor stands in the editor now, or null when it is not of this note. */
export function bodySequenceAnchorPosition(
  state: EditorState,
  anchor: Y.RelativePosition,
): number | null {
  const bound = boundOf(state);
  const doc = bound?.sequence.doc;
  const place = doc && Y.createAbsolutePositionFromRelativePosition(anchor, doc);
  if (!bound || !place || place.type !== bound.sequence) return null;
  const reading = bound.reader.reading();
  const held = place.assoc === HELD_BY_WHAT_FOLLOWS && anchor.item !== null;
  if (held && !Y.getItem(doc.store, anchor.item!).deleted) {
    const start = startBefore(reading, place.index);
    if (start >= 0) return start;
  }
  return positionAt(reading, place.index);
}

type Held = { index: number; after: boolean };
type Place = (reading: BodyReading, found: readonly Followed[], doc: ProseMirrorNode) => Selection;

function holdSelection(
  reading: BodyReading,
  selection: Selection,
): { follow: number[]; place: Place } | null {
  const held: Held[] = [];
  const hold = (pos: number, first: boolean) => {
    const follows = whatFollowsStartOf(reading, pos);
    if (follows >= 0) return held.push({ index: follows, after: false });
    const at = first ? tokenFrom(reading, pos) : null;
    if (at && at.piece !== null && at.block === blockHolding(reading, pos))
      return held.push({ index: at.index, after: false });
    return held.push({ index: tokenBefore(reading, pos)?.index ?? -1, after: true });
  };
  const follow = () => [...new Set(held.map((each) => each.index))].sort((a, b) => a - b);
  const position = (each: Held, now: BodyReading, found: readonly Followed[]): number => {
    if (each.index < 0) return positionAt(now, 0);
    const went = found[follow().indexOf(each.index)]!;
    const shown = !went.alive
      ? -1
      : each.after
        ? positionOf(now, went.index)
        : startBefore(now, went.index);
    if (shown >= 0) return shown + (each.after ? 1 : 0);
    return positionAt(now, went.index + (went.alive && each.after ? 1 : 0));
  };

  if (selection instanceof TextSelection) {
    const backward = selection.anchor > selection.head;
    hold(selection.anchor, !selection.empty && !backward);
    hold(selection.head, !selection.empty && backward);
    return {
      follow: follow(),
      place: (now, found, doc) =>
        TextSelection.between(
          doc.resolve(position(held[0]!, now, found)),
          doc.resolve(position(held[1]!, now, found)),
        ),
    };
  }
  if (selection instanceof NodeSelection) {
    const at = tokenFrom(reading, selection.from);
    if (!at || positionOf(reading, at.index) !== selection.from) return null;
    held.push({ index: at.index, after: false });
    return {
      follow: follow(),
      place: (now, found, doc) => {
        const shown = found[0]!.alive ? positionOf(now, found[0]!.index) : -1;
        const node = shown < 0 ? null : doc.nodeAt(shown);
        return node && NodeSelection.isSelectable(node)
          ? NodeSelection.create(doc, shown)
          : Selection.near(doc.resolve(shown < 0 ? positionAt(now, found[0]!.index) : shown));
      },
    };
  }
  return null;
}

/**
 * Binds an editor to a note's body sequence, in place of y-prosemirror's sync and undo plugins.
 *
 * The editor always shows what `readBodySequence` reads. A person's change is written to the
 * sequence step by step, each step by its own step map, and what the sequence then reads as is
 * shown again where it differs. One dispatch of the editor, with what other plugins append to
 * it, is one Yjs transaction and one update. The history follows it unless every editor
 * transaction in it is kept out (`addToHistory` false), so undoing a typed letter also takes back
 * what a plugin appended to that dispatch. When the dispatch edits a line that has no boundary of
 * its own, or needs such a line to have one, that boundary is written first, in a transaction and
 * an update of its own that the history does not follow.
 *
 * A change of the sequence from elsewhere, and an undo or redo, is shown as one transaction that
 * replaces what differs, keeps the nodes of the blocks it does not touch, and keeps the selection
 * around its letters. It shows every change the note's document holds by then, also the ones
 * Yjs has not told of yet. Such a transaction is never written back.
 *
 * A transaction that would start, change or cut a list, quote, callout or table is refused, also
 * one that would remove the last line between two of them that share an id. So is one that would
 * write between the two units of a surrogate pair, and one dispatched while a Yjs transaction is
 * open, while Yjs has not told of every finished one, or before the editor shows a change the
 * note's document holds: its offsets may be of a document the sequence no longer reads as. So is
 * what a plugin adds to a transaction that shows the note.
 *
 * What the editor has not shown is counted from Yjs's `beforeTransaction`. When a listener of the
 * host throws from `afterTransaction` before the editor's own is called, the editor shows what it
 * missed once Yjs has told of everything.
 */
export function bodySequencePlugin(options: BodySequenceOptions): Plugin<readonly Transaction[]> {
  const { sequence, containers } = options;
  const edit =
    options.edit ??
    ((change: () => void) => {
      change();
      return true;
    });
  let flushed = NONE;
  let bound: Bound | null = null;
  let showsWhatStands: ((base: ProseMirrorNode) => boolean) | null = null;
  return new Plugin<readonly Transaction[]>({
    key: bodySequenceKey,
    bound: () => bound,
    state: {
      init: () => NONE,
      apply: (transaction, pending) =>
        !transaction.docChanged || isBodySequenceChange(transaction)
          ? pending
          : [...(pending === flushed ? NONE : pending), transaction],
    },
    filterTransaction(transaction, state) {
      if (!transaction.docChanged || isBodySequenceChange(transaction)) return true;
      const pending = bodySequenceKey.getState(state) ?? NONE;
      const unwritten = pending === flushed ? undefined : pending[0];
      if (showsWhatStands && !showsWhatStands(unwritten ? unwritten.before : state.doc))
        return false;
      let reading: BodyReading | null | undefined;
      const shareAnId = (at: number) => (endOfUpper: number, startOfLower: number) => {
        if (reading === undefined) {
          const read = bound?.reader.reading();
          reading = read && (read.doc === state.doc || read.doc.eq(state.doc)) ? read : null;
        }
        if (!reading) return bound !== null;
        const atStart = (pos: number, side: -1 | 1) => {
          let mapped = pos;
          for (let step = at - 1; step >= 0; step--)
            mapped = transaction.mapping.maps[step]!.invert().map(mapped, side);
          return mapped;
        };
        return shareAContainerId(reading, atStart(endOfUpper, -1), atStart(startOfLower, 1));
      };
      return transaction.steps.every(
        (step, at) =>
          keepsPairs(step, transaction.docs[at]!) &&
          keepsContainers(
            step,
            transaction.docs[at]!,
            transaction.docs[at + 1] ?? transaction.doc,
            shareAnId(at),
          ),
      );
    },
    props: {
      handleKeyDown: keydownHandler({
        "Mod-z": undoBodySequence,
        "Mod-Shift-z": redoBodySequence,
        "Mod-y": redoBodySequence,
      }),
    },
    view(view) {
      const doc = sequence.doc;
      if (!doc) throw new Error("The body sequence must be part of a Yjs document.");
      const releaseFormatting = keepBodySequenceFormatting(sequence);
      const reader = createBodyReader(view.state.schema, sequence, containers);
      const here: Bound = {
        sequence,
        reader,
        history: options.history ?? createBodySequenceHistory(doc),
      };
      const origin = originOfHistory.get(here.history);
      if (!origin) throw new Error("The history must be one createBodySequenceHistory made.");
      bound = here;
      const unread: Y.Transaction[] = [];
      let shown: ProseMirrorNode | null = null;
      let destroyed = false;
      let writing = false;
      let showing = false;
      const stands = (base: ProseMirrorNode) =>
        !isBusy(doc) && unread.length === 0 && reader.reading().doc === base;
      showsWhatStands = (base) => !showing && stands(base);

      const show = (select?: (transaction: Transaction, end: number) => void) => {
        if (destroyed) return;
        const reading = reader.reading();
        const current = view.state.doc;
        const start =
          current === reading.doc ? null : current.content.findDiffStart(reading.doc.content);
        if (start === null) reader.adopt(current);
        else {
          let { a, b } = current.content.findDiffEnd(reading.doc.content)!;
          const overlap = start - Math.min(a, b);
          if (overlap > 0) {
            a += overlap;
            b += overlap;
          }
          let transaction = view.state.tr;
          const step = new ReplaceStep(start, a, reading.doc.slice(start, b));
          let same = !transaction.maybeStep(step).failed && transaction.doc.eq(reading.doc);
          if (!same) {
            transaction = view.state.tr.replaceWith(0, current.content.size, reading.doc.content);
            same = transaction.doc.eq(reading.doc);
          }
          if (same) reader.adopt(transaction.doc);
          select?.(transaction, b);
          if (view.state.storedMarks) transaction.setStoredMarks(view.state.storedMarks);
          showing = true;
          try {
            view.dispatch(
              transaction.setMeta(bodySequenceKey, true).setMeta(ADD_TO_HISTORY, false),
            );
          } finally {
            showing = false;
          }
        }
        shown = view.state.doc;
      };

      const showUnread = () => {
        const told = unread.splice(0);
        if (told.length === 0) return show();
        const undone = told.length === 1 && told[0]!.origin === here.history;
        const before = reader.reading();
        const held =
          undone || before.doc !== view.state.doc
            ? null
            : holdSelection(before, view.state.selection);
        const found = reader.read({ transactions: told, follow: held?.follow });
        show((transaction, end) => {
          if (undone)
            transaction
              .setSelection(Selection.near(transaction.doc.resolve(end), -1))
              .scrollIntoView();
          else if (held)
            transaction.setSelection(held.place(reader.reading(), found, transaction.doc));
        });
      };

      const catchUp = () => {
        if (destroyed || writing || doc._transaction !== null) return;
        flushed = bodySequenceKey.getState(view.state) ?? NONE;
        showUnread();
      };

      const onStart = (started: Y.Transaction) => {
        unread.push(started);
      };
      const onTransaction = () => {
        if (!writing) showUnread();
        else if (unread.length > 0) reader.read({ transactions: unread.splice(0) });
      };
      const onSettled = () => {
        if (unread.length > 0) catchUp();
      };

      const change = (recorded: boolean, write: () => void) => {
        let wrote = false;
        edit(() =>
          doc.transact((carrier) => {
            const own = carrier.changed.size === 0 ? unread.lastIndexOf(carrier) : -1;
            if (own < 0) return;
            unread.splice(own, 1);
            if (unread.length > 0) return;
            if (recorded) carrier.meta.set(bodySequenceKey, origin);
            write();
            wrote = true;
          }, origin),
        );
        return wrote;
      };

      const write = () => {
        if (writing) return;
        const pending = bodySequenceKey.getState(view.state) ?? NONE;
        if (pending === flushed) {
          if (view.state.doc !== shown) show();
          return;
        }
        flushed = pending;
        const base = pending[0]!.before;
        if (!stands(base)) return catchUp();
        const target = { sequence, reader };
        writing = true;
        try {
          const lines = linesGivenBoundaries(target, pending);
          if (lines.length > 0) {
            if (!change(false, () => giveBoundaries(target, lines))) return;
            if (isBusy(doc) || unread.length > 0 || !reader.reading().doc.eq(base)) return;
            reader.adopt(base);
          }
          const recorded = pending.some(
            (transaction) => transaction.getMeta(ADD_TO_HISTORY) !== false,
          );
          const had = changesBlocks(pending) ? linesWithNoBoundary(reader.reading()) : null;
          change(recorded, () => {
            for (const transaction of pending) if (!writeTransaction(target, transaction)) break;
            if (had) giveBoundaries(target, linesMade(reader.reading(), had));
            writing = false;
          });
        } finally {
          writing = false;
          show();
        }
      };

      doc.on("beforeTransaction", onStart);
      doc.on("afterTransaction", onTransaction);
      doc.on("afterAllTransactions", onSettled);
      show();
      write();
      return {
        update: write,
        destroy() {
          destroyed = true;
          doc.off("beforeTransaction", onStart);
          doc.off("afterTransaction", onTransaction);
          doc.off("afterAllTransactions", onSettled);
          releaseFormatting();
          if (!options.history) here.history.destroy();
          if (bound === here) {
            bound = null;
            showsWhatStands = null;
          }
        },
      };
    },
  });
}

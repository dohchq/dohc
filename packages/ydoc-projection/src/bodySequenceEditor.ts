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
  blockStartingAt,
  boundaryAt,
  changes,
  createBodyReader,
  indexAt,
  isAddedParagraph,
  positionAt,
  positionOf,
  shareAContainerId,
  tokenBefore,
  tokenFrom,
  type BodyReader,
  type BodyReading,
  type Followed,
} from "./bodySequenceReading.js";
import { keepsContainers, keepsPairs, writeTransaction } from "./bodySequenceWriting.js";

export type BodySequenceOptions = {
  /** The note's `sequence`, declared before any update was applied to its document. */
  sequence: Y.Text;
  /** The note's `containers`, declared before any update was applied to its document. */
  containers: Y.Map<unknown>;
  /**
   * The origin of the Yjs transaction each editor change is written in. A host may instead run a
   * change inside a Yjs transaction of its own that has no origin. Give the history the same
   * origin. Defaults to `bodySequenceKey`.
   */
  origin?: unknown;
  /**
   * A history that outlives this editor, made with `createBodySequenceHistory`. Without one the
   * plugin makes its own and destroys it with the view.
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

/**
 * A history of this person's own changes to a note's sequence and container records. It follows
 * a Yjs transaction only when the editor adapter marked it as the person's change, so it works
 * the same when the host runs an editor change inside its own Yjs transaction with no origin.
 * Apply other people's changes with any other origin, or with none.
 *
 * An undo puts an earlier value back over someone else's later one. It never deletes a container
 * record, and never an attribute of a boundary that still stands. An inline item's attribute is
 * not kept that way: it may have had no value before a person first set it, and undo removes it.
 */
export function createBodySequenceHistory(
  doc: Y.Doc,
  options: { origin?: unknown; captureTimeout?: number } = {},
): Y.UndoManager {
  const origin = options.origin ?? bodySequenceKey;
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

/**
 * Undoes this person's last change. The change comes back from the sequence as its own
 * transaction, so a host whose commands carry a transaction must not dispatch that one too.
 */
export const undoBodySequence: Command = (state, dispatch) => {
  const history = boundOf(state)?.history;
  if (!history || history.undoStack.length === 0) return false;
  if (dispatch) history.undo();
  return true;
};

/** Redoes the change this person last undid. It dispatches as `undoBodySequence` does. */
export const redoBodySequence: Command = (state, dispatch) => {
  const history = boundOf(state)?.history;
  if (!history || history.redoStack.length === 0) return false;
  if (dispatch) history.redo();
  return true;
};

/**
 * A place in the note that stays with its letters through everyone's changes: for a caret shown
 * to other people, or a mark that must survive a reload of the editor. `state` is the view's
 * current state.
 */
export function bodySequenceAnchor(
  state: EditorState,
  pos: number,
  assoc = 0,
): Y.RelativePosition | null {
  const bound = boundOf(state);
  if (!bound) return null;
  const index = indexAt(bound.reader.reading(), pos);
  return Y.createRelativePositionFromTypeIndex(bound.sequence, index, assoc);
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
  return positionAt(bound.reader.reading(), place.index);
}

type Held = { index: number; after: boolean; added?: true };
type Place = (reading: BodyReading, found: readonly Followed[], doc: ProseMirrorNode) => Selection;

function holdSelection(
  reading: BodyReading,
  selection: Selection,
): { follow: number[]; place: Place } | null {
  const held: Held[] = [];
  const hold = (pos: number, first: boolean) => {
    const block = blockHolding(reading, pos);
    if (block >= 0 && pos === reading.starts[block]! + 1 && boundaryAt(reading, block) < 0) {
      const follows = reading.blocks[block]!.shown[0];
      if (follows) return held.push({ index: reading.bases[block]! + follows.index, after: false });
      if (isAddedParagraph(reading, block))
        return held.push({ index: reading.bases[block]!, after: false, added: true });
      return held.push({ index: -1, after: true });
    }
    const at = first ? tokenFrom(reading, pos) : null;
    if (at && at.piece !== null && at.block === blockHolding(reading, pos))
      return held.push({ index: at.index, after: false });
    return held.push({ index: tokenBefore(reading, pos)?.index ?? -1, after: true });
  };
  const follow = () => [...new Set(held.map((each) => each.index))].sort((a, b) => a - b);
  const position = (each: Held, now: BodyReading, found: readonly Followed[]): number => {
    if (each.index < 0) return positionAt(now, 0);
    const went = found[follow().indexOf(each.index)]!;
    const shown = went.alive ? positionOf(now, went.index) : -1;
    if (shown >= 0 && each.added) {
      const block = blockStartingAt(now, shown);
      const inFront =
        block > 0 && now.lines[block - 1] === now.lines[block] && isAddedParagraph(now, block - 1);
      return inFront ? now.starts[block - 1]! + 1 : shown + 1;
    }
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
        const pos = position(held[0]!, now, found);
        const node = doc.nodeAt(pos);
        return found[0]!.alive && node && NodeSelection.isSelectable(node)
          ? NodeSelection.create(doc, pos)
          : Selection.near(doc.resolve(pos));
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
 * shown again where it differs. Editor transactions that are kept out of the history
 * (`addToHistory` false) are written in a Yjs transaction of their own, apart from the ones the
 * history follows. Where the host's own Yjs transaction is open around the editor's change, it
 * takes the first of them and the rest are written when it ends. A change of the sequence from elsewhere, and an undo or redo, is
 * shown as one transaction that replaces what differs, keeps the nodes of the blocks it does not
 * touch, and keeps the selection around its letters. Such a transaction is never written back.
 *
 * A transaction that would start, change or cut a list, quote, callout or table is refused, also
 * one that would remove the last line between two of them that share an id. So is one that would
 * write between the two units of a surrogate pair.
 */
export function bodySequencePlugin(options: BodySequenceOptions): Plugin<readonly Transaction[]> {
  const { sequence, containers } = options;
  const origin = options.origin ?? bodySequenceKey;
  let flushed = NONE;
  let bound: Bound | null = null;
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
        history: options.history ?? createBodySequenceHistory(doc, { origin }),
      };
      bound = here;
      const written = new WeakSet<Y.Transaction>();
      let shown: ProseMirrorNode | null = null;
      let runs: { tracked: boolean; transactions: Transaction[] }[] = [];
      let hostCarrier: Y.Transaction | null = null;
      let writingRuns = false;

      const show = (select?: (transaction: Transaction, end: number) => void) => {
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
          if (transaction.maybeStep(step).failed || !transaction.doc.eq(reading.doc))
            transaction = view.state.tr.replaceWith(0, current.content.size, reading.doc.content);
          select?.(transaction, b);
          if (view.state.storedMarks) transaction.setStoredMarks(view.state.storedMarks);
          view.dispatch(transaction.setMeta(bodySequenceKey, true).setMeta(ADD_TO_HISTORY, false));
        }
        shown = view.state.doc;
      };

      const writeRuns = () => {
        if (writingRuns) return;
        writingRuns = true;
        try {
          while (runs.length > 0 && hostCarrier === null) {
            const run = runs.shift()!;
            const hosted = doc._transaction !== null;
            let whole = false;
            doc.transact((carrier) => {
              written.add(carrier);
              if (hosted) hostCarrier = carrier;
              if (run.tracked) carrier.meta.set(bodySequenceKey, origin);
              const writing = { sequence, reader };
              whole = run.transactions.every((each) => writeTransaction(writing, each));
            }, origin);
            if (!whole) runs = [];
          }
        } catch (error) {
          runs = [];
          throw error;
        } finally {
          writingRuns = false;
          if (runs.length === 0) show();
        }
      };

      const onTransaction = (changed: Y.Transaction) => {
        const hostEnded = changed === hostCarrier;
        if (hostEnded) hostCarrier = null;
        const touched =
          changes(changed.changedParentTypes, sequence) || changes(changed.changed, containers);
        if (written.has(changed)) {
          if (touched) reader.note(changed);
          if (hostEnded) writeRuns();
          else if (touched && runs.length === 0 && !writingRuns) show();
          return;
        }
        if (!touched) return;
        if (changed.origin === here.history) {
          reader.read({ transaction: changed });
          show((transaction, end) =>
            transaction
              .setSelection(Selection.near(transaction.doc.resolve(end), -1))
              .scrollIntoView(),
          );
          return;
        }
        const held = holdSelection(reader.reading(), view.state.selection);
        const found = reader.read({ transaction: changed, follow: held?.follow });
        show((transaction) => {
          if (held) transaction.setSelection(held.place(reader.reading(), found, transaction.doc));
        });
      };

      const write = () => {
        const pending = bodySequenceKey.getState(view.state) ?? NONE;
        if (pending === flushed) {
          if (runs.length === 0 && !writingRuns && view.state.doc !== shown) show();
          return;
        }
        flushed = pending;
        for (const transaction of pending) {
          const tracked = transaction.getMeta(ADD_TO_HISTORY) !== false;
          const last = runs.at(-1);
          if (last?.tracked === tracked) last.transactions.push(transaction);
          else runs.push({ tracked, transactions: [transaction] });
        }
        writeRuns();
      };

      show();
      write();
      doc.on("afterTransaction", onTransaction);
      return {
        update: write,
        destroy() {
          doc.off("afterTransaction", onTransaction);
          releaseFormatting();
          if (!options.history) here.history.destroy();
          if (bound === here) bound = null;
        },
      };
    },
  });
}

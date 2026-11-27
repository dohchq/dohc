import {
  baseKeymap,
  chainCommands,
  exitCode,
  lift,
  setBlockType,
  toggleMark,
  wrapIn,
} from "@tiptap/pm/commands";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "@tiptap/pm/inputrules";
import { keymap } from "@tiptap/pm/keymap";
import {
  Fragment,
  Slice,
  type MarkType,
  type Node as ProseMirrorNode,
  type NodeType,
  type ResolvedPos,
  type Schema,
} from "@tiptap/pm/model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "@tiptap/pm/schema-list";
import {
  EditorState,
  Selection,
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import { findWrapping } from "@tiptap/pm/transform";
import { EditorView } from "@tiptap/pm/view";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  redo,
  undo,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
} from "y-prosemirror";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import {
  bodySequencePlugin,
  createBodySequenceHistory,
  redoBodySequence,
  undoBodySequence,
  type BodySequenceUnwritten,
} from "./bodySequenceEditor.js";
import {
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  readsBodySequence,
} from "./bodySequenceStore.js";
import { getDohcProseMirrorSchema } from "./import-export.js";

/** A live page as Markdown, so a browser can hand back text it could not send. */
export { yDocToMarkdown } from "./import-export.js";

const EDITOR_CHANGE = "dohcEditorChange";
const BLOB_IMAGE = /^\/api\/view\/blob\/[a-f0-9]{64}(?:\?session=[A-Za-z0-9_-]{12})?$/u;

export type LiveEditorMark = "bold" | "italic" | "strike" | "code" | "highlight";

export interface LiveEditorToolbarState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  heading: 0 | 1 | 2 | 3;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  blockquote: boolean;
  codeBlock: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function hasMark(state: EditorState, markType: MarkType | undefined): boolean {
  if (!markType) return false;
  if (state.selection.empty) {
    return Boolean(markType.isInSet(state.storedMarks || state.selection.$from.marks()));
  }
  return state.doc.rangeHasMark(state.selection.from, state.selection.to, markType);
}

function activeBlock(state: EditorState): { node: ProseMirrorNode; $pos: ResolvedPos } {
  const { $from } = state.selection;
  if ($from.depth > 0) return { node: $from.parent, $pos: $from };
  const inner = TextSelection.findFrom($from, 1, true);
  if (inner) return { node: inner.$from.parent, $pos: inner.$from };
  return { node: $from.parent, $pos: $from };
}

function inAncestor(state: EditorState, nodeType: NodeType | undefined): boolean {
  if (!nodeType) return false;
  const { $pos } = activeBlock(state);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type === nodeType) return true;
  }
  return false;
}

function activeHeading(state: EditorState, schema: Schema): 0 | 1 | 2 | 3 {
  const { node } = activeBlock(state);
  if (node.type !== schema.nodes.heading) return 0;
  const level = Number(node.attrs.level);
  return level === 1 || level === 2 || level === 3 ? level : 0;
}

function readToolbarState(
  state: EditorState,
  schema: Schema,
  history: Y.UndoManager,
): LiveEditorToolbarState {
  return {
    bold: hasMark(state, schema.marks.bold),
    italic: hasMark(state, schema.marks.italic),
    strike: hasMark(state, schema.marks.strike),
    code: hasMark(state, schema.marks.code),
    heading: activeHeading(state, schema),
    bulletList: inAncestor(state, schema.nodes.bulletList),
    orderedList: inAncestor(state, schema.nodes.orderedList),
    taskList: inAncestor(state, schema.nodes.taskList),
    blockquote: inAncestor(state, schema.nodes.blockquote),
    codeBlock: activeBlock(state).node.type === schema.nodes.codeBlock,
    canUndo: history.undoStack.length > 0,
    canRedo: history.redoStack.length > 0,
  };
}

function sameToolbarState(left: LiveEditorToolbarState, right: LiveEditorToolbarState): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.strike === right.strike &&
    left.code === right.code &&
    left.heading === right.heading &&
    left.bulletList === right.bulletList &&
    left.orderedList === right.orderedList &&
    left.taskList === right.taskList &&
    left.blockquote === right.blockquote &&
    left.codeBlock === right.codeBlock &&
    left.canUndo === right.canUndo &&
    left.canRedo === right.canRedo
  );
}

function setHeadingCommand(schema: Schema, level: 0 | 1 | 2 | 3): Command {
  const { heading, paragraph } = schema.nodes;
  return (state, dispatch, view) => {
    if (!heading || !paragraph) return false;
    const { node } = activeBlock(state);
    if (level === 0 || (node.type === heading && Number(node.attrs.level) === level)) {
      return setBlockType(paragraph)(state, dispatch, view);
    }
    return setBlockType(heading, { level })(state, dispatch, view);
  };
}

function changeListKind(
  state: EditorState,
  depth: number,
  listType: NodeType,
  itemType: NodeType,
): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $from, $to } = selection;
  if ($from.depth !== depth + 2 || $to.depth !== depth + 2) return null;
  if ($to.before(depth) !== $from.before(depth)) return null;
  const holder = $from.node(depth - 1).type.name;
  if (holder === "listItem" || holder === "taskItem") return null;
  const list = $from.node(depth);
  const items: ProseMirrorNode[] = [];
  for (let at = $from.index(depth); at <= $to.index(depth); at++) {
    const item = list.child(at);
    if (item.childCount !== 1 || !itemType.validContent(item.content)) return null;
    items.push(itemType.create(null, item.content));
  }
  const start = $from.start(depth);
  const before = $from.before(depth + 1) - start;
  const after = $to.after(depth + 1) - start;
  const lists = [listType.create(null, items)];
  if (before > 0) lists.unshift(list.copy(list.content.cut(0, before)));
  if (after < list.content.size) lists.push(list.copy(list.content.cut(after)));
  const tr = state.tr.replaceWith($from.before(depth), $from.after(depth), lists);
  const shift = before > 0 ? 2 : 0;
  return tr
    .setSelection(TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift))
    .scrollIntoView();
}

/** Turns the lines in the selection into a list of `target`'s kind, or out of it when they are one. */
export function toggleListCommand(
  schema: Schema,
  target: "bulletList" | "orderedList" | "taskList",
): Command {
  const listType = schema.nodes[target];
  const targetItemType = target === "taskList" ? schema.nodes.taskItem : schema.nodes.listItem;
  return (state, dispatch, view) => {
    if (!listType || !targetItemType) return false;
    const { $from } = state.selection;
    let enclosingListDepth = -1;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const name = $from.node(depth).type.name;
      if (name === "bulletList" || name === "orderedList" || name === "taskList") {
        enclosingListDepth = depth;
        break;
      }
    }
    if (enclosingListDepth > 0) {
      const currentList = $from.node(enclosingListDepth);
      const currentItemType =
        currentList.type.name === "taskList" ? schema.nodes.taskItem : schema.nodes.listItem;
      if (!currentItemType) return false;
      if (currentList.type === listType) {
        return liftListItem(currentItemType)(state, dispatch, view);
      }
      const changed = changeListKind(state, enclosingListDepth, listType, targetItemType);
      if (changed) {
        dispatch?.(changed);
        return true;
      }
      let liftTr: Transaction | null = null;
      const lifted = liftListItem(currentItemType)(
        state,
        (tr) => {
          liftTr = tr;
        },
        view,
      );
      if (!lifted || !liftTr) return false;
      const afterLift = state.apply(liftTr);
      let wrapTr: Transaction | null = null;
      const wrapped = wrapInList(listType)(
        afterLift,
        (tr) => {
          wrapTr = tr;
        },
        view,
      );
      if (!wrapped || !wrapTr) return false;
      if (!dispatch) return true;
      const combined = state.tr;
      for (const step of (liftTr as Transaction).steps) combined.step(step);
      for (const step of (wrapTr as Transaction).steps) combined.step(step);
      combined.setSelection(
        Selection.fromJSON(combined.doc, (wrapTr as Transaction).selection.toJSON()),
      );
      dispatch(combined.scrollIntoView());
      return true;
    }
    return wrapInList(listType)(state, dispatch, view);
  };
}

function toggleBlockquoteCommand(schema: Schema): Command {
  const blockquote = schema.nodes.blockquote;
  return (state, dispatch, view) => {
    if (!blockquote) return false;
    if (inAncestor(state, blockquote)) return lift(state, dispatch);
    return wrapIn(blockquote)(state, dispatch, view);
  };
}

function toggleCodeBlockCommand(schema: Schema): Command {
  const { codeBlock, paragraph } = schema.nodes;
  return (state, dispatch, view) => {
    if (!codeBlock || !paragraph) return false;
    if (state.selection.$from.parent.type === codeBlock) {
      return setBlockType(paragraph)(state, dispatch, view);
    }
    return setBlockType(codeBlock)(state, dispatch, view);
  };
}

function insertHardBreakCommand(schema: Schema): Command {
  const hardBreak = schema.nodes.hardBreak;
  return (state, dispatch) => {
    if (!hardBreak) return false;
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
    }
    return true;
  };
}

function enterShortcutCommand(schema: Schema): Command {
  const { codeBlock, horizontalRule, paragraph } = schema.nodes;
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty || !paragraph || $from.parent.type !== paragraph) return false;
    if ($from.parentOffset !== $from.parent.content.size) return false;
    const text = $from.parent.textContent;
    const fence = /^```([a-z0-9_-]*)$/i.exec(text);
    if (fence && codeBlock) {
      if (dispatch) {
        const from = $from.before();
        const to = $from.after();
        const node = codeBlock.create({ language: fence[1] || null });
        const tr = state.tr.replaceWith(from, to, node);
        tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    if (/^(?:---|___|\*\*\*)$/.test(text) && horizontalRule) {
      if (dispatch) {
        const from = $from.before();
        const to = $from.after();
        const tr = state.tr.replaceWith(from, to, [horizontalRule.create(), paragraph.create()]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2)));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return false;
  };
}

function applyTaskChecked(
  tr: Transaction,
  pos: number,
  taskItem: NodeType,
  checked: boolean,
): void {
  const $after = tr.doc.resolve(pos);
  for (let depth = $after.depth; depth > 0; depth -= 1) {
    if ($after.node(depth).type === taskItem) {
      tr.setNodeMarkup($after.before(depth), taskItem, { checked });
      break;
    }
  }
}

function buildMarkdownInputRules(schema: Schema, canEdit: () => boolean) {
  const rules: InputRule[] = [];
  const {
    blockquote,
    bulletList,
    codeBlock,
    heading,
    horizontalRule,
    listItem,
    orderedList,
    paragraph,
    taskItem,
    taskList,
  } = schema.nodes;

  const guard = (rule: InputRule): InputRule => {
    const raw = rule as unknown as {
      match: RegExp;
      handler:
        | string
        | ((
            state: EditorState,
            match: RegExpMatchArray,
            start: number,
            end: number,
          ) => Transaction | null);
    };
    const original = raw.handler;
    return new InputRule(raw.match, (state, match, start, end) => {
      if (!canEdit()) return null;
      return typeof original === "function"
        ? original(state, match, start, end)
        : state.tr.insertText(original, start, end);
    });
  };

  if (heading) {
    rules.push(
      guard(
        textblockTypeInputRule(/^(#{1,6})\s$/, heading, (match) => ({
          level: match[1]!.length,
        })),
      ),
    );
  }

  if (paragraph && taskList && taskItem) {
    rules.push(
      new InputRule(/^\s*[-+*]\s\[([ xX])\]\s$/, (state, match, start, end) => {
        if (!canEdit()) return null;
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== paragraph || $start.parentOffset !== 0) return null;
        const checked = match[1]?.toLowerCase() === "x";
        const tr = state.tr.delete(start, end);
        const $pos = tr.doc.resolve(tr.mapping.map(start));
        const range = $pos.blockRange();
        if (!range) return null;
        const wrapping = findWrapping(range, taskList);
        if (!wrapping) return null;
        tr.wrap(range, wrapping);
        applyTaskChecked(tr, tr.mapping.map(start), taskItem, checked);
        return tr;
      }),
    );
  }

  if (paragraph && bulletList && listItem && taskList && taskItem) {
    rules.push(
      new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
        if (!canEdit()) return null;
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== paragraph || $start.parentOffset !== 0) return null;
        const itemDepth = $start.depth - 1;
        const listDepth = $start.depth - 2;
        if (
          itemDepth < 1 ||
          listDepth < 1 ||
          $start.node(itemDepth).type !== listItem ||
          $start.node(listDepth).type !== bulletList ||
          $start.index(itemDepth) !== 0
        ) {
          return null;
        }
        const checked = match[1]?.toLowerCase() === "x";
        const tr = state.tr.delete(start, end);
        const $pos = tr.doc.resolve(tr.mapping.map(start));
        if ($pos.node(listDepth).childCount === 1) {
          const listFrom = $pos.before(listDepth);
          const listTo = $pos.after(listDepth);
          const replacement = taskList.create(
            null,
            taskItem.create({ checked }, $pos.node(itemDepth).content),
          );
          tr.replaceWith(listFrom, listTo, replacement);
          tr.setSelection(TextSelection.near(tr.doc.resolve(listFrom + 3)));
          return tr;
        }
        const afterDelete = state.apply(tr);
        let liftedTr: Transaction | null = null;
        const lifted = liftListItem(listItem)(afterDelete, (stepTr) => {
          liftedTr = stepTr;
        });
        if (!lifted || !liftedTr) return null;
        for (const step of (liftedTr as Transaction).steps) tr.step(step);
        const $lifted = tr.doc.resolve(tr.mapping.map(start));
        const wrapRange = $lifted.blockRange();
        if (!wrapRange) return null;
        const wrapping = findWrapping(wrapRange, taskList);
        if (!wrapping) return null;
        tr.wrap(wrapRange, wrapping);
        applyTaskChecked(tr, tr.mapping.map(start), taskItem, checked);
        return tr;
      }),
    );
  }

  if (bulletList) {
    rules.push(guard(wrappingInputRule(/^\s*([-+*])\s$/, bulletList)));
  }

  if (orderedList) {
    rules.push(
      guard(
        wrappingInputRule(
          /^(\d+)\.\s$/,
          orderedList,
          (match) => ({ start: Number(match[1]) }),
          (match, node) => node.childCount + Number(node.attrs.start ?? 1) === Number(match[1]),
        ),
      ),
    );
  }

  if (blockquote) {
    rules.push(guard(wrappingInputRule(/^\s*>\s$/, blockquote)));
  }

  if (codeBlock) {
    rules.push(
      guard(
        textblockTypeInputRule(/^```([a-z0-9_-]*)\s$/i, codeBlock, (match) => ({
          language: match[1] || null,
        })),
      ),
    );
  }

  if (horizontalRule && paragraph) {
    rules.push(
      new InputRule(/^(?:---|___|\*\*\*)\s$/, (state, _match, start, end) => {
        if (!canEdit()) return null;
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== paragraph || $start.parentOffset !== 0 || end !== $start.end()) {
          return null;
        }
        const from = $start.before();
        const to = $start.after();
        const tr = state.tr.replaceWith(from, to, [horizontalRule.create(), paragraph.create()]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2)));
        return tr;
      }),
    );
  }

  return inputRules({ rules });
}

/**
 * An editor on a note's body, in the format the note reads in when it mounts. Admission remains
 * the session owner's responsibility. `edit` runs `change` and nothing else: a transaction it
 * opens around `change` is recorded whole as this editor's undo step. `unwritten` hears why a
 * change to a note in format 2 was not written.
 */
export function mountLiveBodyEditor(
  element: HTMLElement,
  input: {
    doc: Y.Doc;
    canEdit(): boolean;
    edit(change: () => void): boolean;
    label: string;
    unwritten?: (why: BodySequenceUnwritten) => void;
    resolveImage?: (src: string) => string | null;
  },
) {
  const schema = getDohcProseMirrorSchema();
  const thisEditor = Symbol("this editor's change");
  const sequence = readsBodySequence(input.doc);
  const body = sequence ? null : getDohcYDocBodyFragment(input.doc);
  const history = !body
    ? createBodySequenceHistory(input.doc)
    : new Y.UndoManager(body, {
        trackedOrigins: new Set([ySyncPluginKey, null]),
        deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
        captureTransaction: (transaction) =>
          transaction.meta.get("addToHistory") !== false &&
          (transaction.origin !== null || transaction.meta.get(EDITOR_CHANGE) === thisEditor),
        ignoreRemoteMapChanges: true,
      });
  const stepBack: Command = sequence ? undoBodySequence : (state) => undo(state);
  const stepForward: Command = sequence ? redoBodySequence : (state) => redo(state);
  const listeners = new Set<(state: LiveEditorToolbarState) => void>();
  let lastToolbar: LiveEditorToolbarState | null = null;

  const notifyToolbar = (editorState?: EditorState) => {
    const currentState = editorState ?? view.state;
    const next = readToolbarState(currentState, schema, history);
    if (lastToolbar && sameToolbarState(lastToolbar, next)) return;
    lastToolbar = next;
    for (const listener of listeners) listener(next);
  };

  // A redo key the editor declines goes on to ProseMirror's keymap, which retries
  // Ctrl+Shift+z without Shift as Undo, and then to the browser's own history.
  const historyKey =
    (step: Command, keep: boolean): Command =>
    (state, dispatch) => {
      if (!input.canEdit()) return true;
      const done = step(state, dispatch);
      notifyToolbar();
      return done || keep;
    };

  const gated =
    (command: Command): Command =>
    (state, dispatch, editorView) =>
      input.canEdit() && command(state, dispatch, editorView);

  const formattingKeymap: Record<string, Command> = {
    "Mod-Alt-1": gated(setHeadingCommand(schema, 1)),
    "Mod-Alt-2": gated(setHeadingCommand(schema, 2)),
    "Mod-Alt-3": gated(setHeadingCommand(schema, 3)),
    "Shift-Enter": gated(chainCommands(exitCode, insertHardBreakCommand(schema))),
  };
  if (schema.marks.bold) formattingKeymap["Mod-b"] = gated(toggleMark(schema.marks.bold));
  if (schema.marks.italic) formattingKeymap["Mod-i"] = gated(toggleMark(schema.marks.italic));
  if (schema.marks.strike) {
    formattingKeymap["Mod-Shift-x"] = gated(toggleMark(schema.marks.strike));
  }
  if (schema.marks.code) formattingKeymap["Mod-e"] = gated(toggleMark(schema.marks.code));

  const enterCommands: Command[] = [enterShortcutCommand(schema)];
  const tabCommands: Command[] = [];
  const shiftTabCommands: Command[] = [];
  if (schema.nodes.taskItem) {
    enterCommands.push(splitListItem(schema.nodes.taskItem, { checked: false }));
    tabCommands.push(sinkListItem(schema.nodes.taskItem));
    shiftTabCommands.push(liftListItem(schema.nodes.taskItem));
  }
  if (schema.nodes.listItem) {
    enterCommands.push(splitListItem(schema.nodes.listItem));
    tabCommands.push(sinkListItem(schema.nodes.listItem));
    shiftTabCommands.push(liftListItem(schema.nodes.listItem));
  }
  formattingKeymap.Enter = gated(chainCommands(...enterCommands));
  if (tabCommands.length > 0) formattingKeymap.Tab = gated(chainCommands(...tabCommands));
  if (shiftTabCommands.length > 0) {
    formattingKeymap["Shift-Tab"] = gated(chainCommands(...shiftTabCommands));
  }

  const view = new EditorView(element, {
    state: EditorState.create({
      schema,
      plugins: [
        ...(body ? [ySyncPlugin(body), yUndoPlugin({ undoManager: history })] : []),
        keymap({
          "Mod-z": historyKey(stepBack, false),
          "Mod-Shift-z": historyKey(stepForward, true),
          "Mod-y": historyKey(stepForward, true),
        }),
        ...(sequence
          ? [
              bodySequencePlugin({
                sequence: input.doc.getText(BODY_SEQUENCE_FIELD),
                containers: input.doc.getMap(BODY_CONTAINERS_FIELD),
                history,
                edit: input.edit,
                ...(input.unwritten ? { unwritten: input.unwritten } : {}),
              }),
            ]
          : []),
        buildMarkdownInputRules(schema, input.canEdit),
        keymap(formattingKeymap),
        keymap(baseKeymap),
      ],
    }),
    attributes: {
      role: "textbox",
      "aria-label": input.label,
      "aria-multiline": "true",
      class: "markdown",
    },
    editable: input.canEdit,
    dispatchTransaction(this: EditorView, transaction) {
      const apply = () => this.updateState(this.state.apply(transaction));
      const fromDocument = transaction.getMeta(ySyncPluginKey)?.isChangeOrigin === true;
      if (!sequence && transaction.docChanged && !fromDocument)
        input.edit(() => {
          input.doc.transact((hosts) => hosts.meta.set(EDITOR_CHANGE, thisEditor));
          apply();
        });
      else apply();
      notifyToolbar(this.state);
    },
    nodeViews: {
      image(node) {
        const resolved = input.resolveImage?.(String(node.attrs.src ?? "")) ?? null;
        if (resolved && BLOB_IMAGE.test(resolved)) {
          const img = document.createElement("img");
          img.src = resolved;
          img.alt = String(node.attrs.alt ?? "");
          if (typeof node.attrs.title === "string" && node.attrs.title.length > 0) {
            img.title = node.attrs.title;
          }
          return { dom: img };
        }
        const dom = document.createElement("span");
        dom.textContent = node.attrs.alt ? `[Image: ${String(node.attrs.alt)}]` : "[Image]";
        return { dom };
      },
      // The schema draws a to-do box as a bare checkbox, which only the browser toggles. This one
      // sends the tick as an edit and then shows the document's value, so a tick that isn't
      // saved doesn't stay on screen.
      taskItem(node, view, getPos) {
        const dom = document.createElement("li"),
          label = document.createElement("label"),
          box = document.createElement("input"),
          contentDOM = document.createElement("div");
        const show = () => {
          dom.dataset.checked = String(node.attrs.checked === true);
          box.checked = node.attrs.checked === true;
          box.setAttribute("aria-label", node.textContent || "To-do");
        };
        dom.dataset.type = "taskItem";
        label.contentEditable = "false";
        box.type = "checkbox";
        box.addEventListener("mousedown", (event) => event.preventDefault());
        box.addEventListener("change", () => {
          const position = getPos();
          if (input.canEdit() && position !== undefined)
            view.dispatch(
              view.state.tr.setNodeMarkup(position, undefined, {
                ...node.attrs,
                checked: box.checked,
              }),
            );
          show();
        });
        const marker = document.createElement("span");
        // A browser joining text into the item can delete the box with it. The editor redraws
        // nothing outside the item's text, so the view puts its box back itself.
        const restore = () => {
          if (box.parentNode !== label || marker.parentNode !== label)
            label.replaceChildren(box, marker);
          if (dom.firstChild !== label) dom.insertBefore(label, dom.firstChild);
        };
        restore();
        dom.append(contentDOM);
        show();
        return {
          dom,
          contentDOM,
          update(next) {
            if (next.type !== node.type) return false;
            node = next;
            restore();
            show();
            return true;
          },
          // The box and its marker are this view's own; only the item's text is the document's.
          ignoreMutation(mutation) {
            if (mutation.type === "selection" || contentDOM.contains(mutation.target)) return false;
            restore();
            return true;
          },
        };
      },
    },
    handlePaste(_view, event) {
      event.preventDefault();
      const raw = event.clipboardData?.getData("text/plain");
      if (!raw || !input.canEdit()) return true;
      const normalized = raw.replace(/\r\n?/g, "\n");
      const inCodeBlock = view.state.selection.$from.parent.type === schema.nodes.codeBlock;
      const blocks = inCodeBlock ? [normalized] : normalized.split(/\n{2,}/);
      if (blocks.length === 1) {
        view.dispatch(view.state.tr.insertText(normalized));
        return true;
      }
      const paragraphType = schema.nodes.paragraph;
      if (!paragraphType) {
        view.dispatch(view.state.tr.insertText(normalized));
        return true;
      }
      const nodes = blocks.map((block) =>
        block.length > 0 ? paragraphType.create(null, schema.text(block)) : paragraphType.create(),
      );
      view.dispatch(
        view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 1, 1)).scrollIntoView(),
      );
      return true;
    },
    handleDOMEvents: {
      drop(_view, event) {
        event.preventDefault();
        return true;
      },
      click(_view, event) {
        if (event.target instanceof Element && event.target.closest("a")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });

  const onUndoChange = () => notifyToolbar();
  history.on("stack-item-added", onUndoChange);
  history.on("stack-item-popped", onUndoChange);
  history.on("stack-item-updated", onUndoChange);

  const runCommand = (command: Command): boolean => {
    if (!input.canEdit()) return false;
    const result = command(view.state, view.dispatch, view);
    view.focus();
    notifyToolbar();
    return result;
  };

  let refocus = false;
  return {
    focus() {
      view.focus();
    },
    getToolbarState(): LiveEditorToolbarState {
      const state = readToolbarState(view.state, schema, history);
      lastToolbar = state;
      return state;
    },
    subscribeToolbar(listener: (state: LiveEditorToolbarState) => void): () => void {
      listeners.add(listener);
      listener(this.getToolbarState());
      return () => {
        listeners.delete(listener);
      };
    },
    toggleMark(mark: LiveEditorMark): boolean {
      const markType = schema.marks[mark];
      return markType ? runCommand(toggleMark(markType)) : false;
    },
    setHeading(level: 0 | 1 | 2 | 3): boolean {
      return runCommand(setHeadingCommand(schema, level));
    },
    toggleBulletList(): boolean {
      return runCommand(toggleListCommand(schema, "bulletList"));
    },
    toggleOrderedList(): boolean {
      return runCommand(toggleListCommand(schema, "orderedList"));
    },
    toggleTaskList(): boolean {
      return runCommand(toggleListCommand(schema, "taskList"));
    },
    toggleBlockquote(): boolean {
      return runCommand(toggleBlockquoteCommand(schema));
    },
    toggleCodeBlock(): boolean {
      return runCommand(toggleCodeBlockCommand(schema));
    },
    undo(): boolean {
      return runCommand(stepBack);
    },
    redo(): boolean {
      return runCommand(stepForward);
    },
    refresh() {
      const editable = input.canEdit();
      if (!editable && view.hasFocus()) refocus = true;
      view.setProps({ editable: input.canEdit });
      notifyToolbar();
      if (!editable || !refocus) return;
      refocus = false;
      const active = element.ownerDocument.activeElement;
      if (active === null || active === element.ownerDocument.body) view.focus();
    },
    destroy() {
      history.off("stack-item-added", onUndoChange);
      history.off("stack-item-popped", onUndoChange);
      history.off("stack-item-updated", onUndoChange);
      listeners.clear();
      view.destroy();
      if (sequence) history.destroy();
    },
  };
}

export type LiveBodyEditorHandle = ReturnType<typeof mountLiveBodyEditor>;

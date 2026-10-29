import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { ShellErrorReporter } from "../shell/useShellError";
import {
  Extension,
  resolveFocusPosition,
  type Editor,
  type JSONContent,
} from "@tiptap/core";
import { parseRichdocMarkdown, serializeRichdocBody } from "@dohc/ydoc-projection";
import {
  DohcMarkdownTable,
  DohcTaskItem,
  escapeHighlightMarkdown,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
} from "@dohc/ydoc-projection/markdown-extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  Bold,
  Code,
  Highlighter,
  Italic,
  Strikethrough,
  Underline as UnderlineIcon,
} from "lucide-react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { caretSelectionRender, resolveCaretUser } from "../collab/caretPresence";
import { desktopMarkdownExtensions, type DohcImageStorage } from "./extensions";
import { getDohcYDocSelectionSeed } from "./import-export";
import type { ImageSrcContext } from "./imageSrc";
import {
  documentReplacementMap,
  handleImageDrop,
  handleImagePaste,
  handlePaneImageDragOver,
  handlePaneImageDrop,
  pickAndInsertImages,
  type ImagePasteContext,
} from "./imagePaste";
import {
  chooseUrlForm,
  dismissUrlPasteOffer,
  makeUrlPasteOfferPlugin,
  urlPasteOfferKeyDown,
  type UrlForm,
  type UrlPasteOfferState,
} from "./urlPaste";
import { UrlPasteOffer } from "./UrlPasteOffer";
import { bridge } from "../bridge";
import { FindReplaceBar } from "./FindReplaceBar";
import { findReplaceExtension, runFindCommand } from "./findReplace";
import { onEditorMenuCommand } from "./editorMenuCommands";
import { makeInlineAtomPlugin } from "./inlineAtomPlugin";
import { makeTableControlsPlugin } from "./tableControls";
import {
  CLOSED_LINK_MENU_STATE,
  LinkBubbleButton,
  LinkMenu,
  makeLinkMenuExtension,
  makeLinkMenuPlugin,
  type LinkMenuState,
} from "./linkMenu";
import type { WorkspaceLinkTarget } from "../linkActivation";
import {
  makeWikilinkPlugin,
  type AutocompleteState,
  type WikilinkFile,
} from "./wikilinkPlugin";
import { makeMentionPlugin } from "./mentionTrigger";
import { WikilinkPicker, type WikilinkPickerState } from "./WikilinkPicker";
import { makeEmojiPlugin } from "./emojiTrigger";
import { EmojiPicker, type EmojiPickerState } from "./EmojiPicker";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";
import {
  CLOSED_SLASH_COMMAND_STATE,
  makeSlashCommandPlugin,
  runSlashCommand as runSlashCommandCore,
  slashCommandStatesEqual,
  SlashCommandMenu,
  type SlashCommandId,
  type SlashCommandState,
} from "./slashCommands";
import {
  BlockMenu,
  CLOSED_BLOCK_MENU_STATE,
  copyBlockAsMarkdown,
  deleteBlock,
  duplicateBlock,
  insertBlockAfter as insertBlockAfterCore,
  makeBlockControlsPlugin,
  resolveBlockMenuState,
  turnBlockInto,
  TurnIntoMenu,
  type BlockMenuEntry,
  type BlockMenuState,
} from "./blockControls";
import { TABLE_CELL_MIN_WIDTH } from "./tableSizing";
import {
  makeCodeBlockChromePlugin,
  makeCodeBlockContinuationPlugin,
  makeEmptyListItemFocusPlugin,
} from "./codeBlockChrome";
import { makeBlockExitPlugin } from "./blockExit";
import { makeCalloutChromePlugin } from "./calloutChrome";
import { makeCodeHighlightPlugin } from "./codeHighlight";
import { makeMermaidPreviewPlugin } from "./mermaidRender";
import {
  FLASH_CLASS,
  OutlinePanel,
  makeHeadingFlashPlugin,
  revealDocPosition,
  type HeadingNavigationTarget,
} from "./OutlinePanel";
import { intraBlockRange, type IntraBlockMatch } from "./intraBlock";
import { SafeTrailingNode } from "./safeTrailingNode";
import { hasFormattableSelection, selectionFormat } from "./selectionFormat";
import { CollaborationHistoryInput, createCollaborationHistoryHandle } from "./sharedCollaborationHistory";
import { ListConversions, parseMarkdownListClipboard } from "./listEditing";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";

export type MarkdownEditorHandle = {
  focus: (position?: "start" | "end") => void;
  getMarkdown: () => string;
  replaceMarkdown: (markdown: string) => void;
  insertTypedText: (text: string, caret: number) => void;
};

type MarkdownEditorCollab = {
  ydoc: Y.Doc;
  status: "disabled" | "connecting" | "connected" | "disconnected";
  peerCount: number;
  synced: boolean;
  // The Awareness bound to `ydoc` (docPresence.ts's bindDocPresence), if the
  // caller has one — wires up CollaborationCaret for live remote carets.
  // Optional and additive: undefined means "no presence yet" (today's only
  // caller, FileInspector's engine-mode branch, doesn't pass one) and the
  // editor renders exactly as it did before, presence indicator included.
  awareness?: Awareness;
};

type MarkdownEditorPendingUndo = {
  token: number;
  restoredText: string;
  undoText: string;
};

/** A one-shot request to reveal a top-level block, by its index in document
 * order. `nonce` lets a caller repeat the same block. This is the seam a
 * search line jump lands on: the caller maps its Markdown line to a block
 * (renderer/editor/lineBlocks.ts) and the editor reveals it.
 *
 * `match` carries the block's own source lines and which of them matched, so
 * a hundred-item list or a long fence reveals the matched line rather than
 * its top. The refinement is resolved against the live nodes at reveal
 * time and drops to the block start whenever it cannot be proven — the same
 * one-shot target either way. */
export type BlockNavigationTarget = {
  index: number;
  nonce: number;
  match?: IntraBlockMatch;
};

export type MarkdownEditorProps = {
  value: string;
  onDirty: (materialize?: () => string) => void;
  onFocus?: () => void;
  workspaceId: string;
  path: string;
  knownFiles: ReadonlyArray<WikilinkFile>;
  onOpenWikilink?: (path: string) => void;
  onOpenWorkspaceLink?: (target: WorkspaceLinkTarget) => void;
  headingTarget?: HeadingNavigationTarget;
  blockTarget?: BlockNavigationTarget;
  onBlockTargetConsumed?: (nonce: number) => void;
  resolveWorkspaceAssetUrl?: (workspacePath: string) => string | null;
  autoFocus?: boolean;
  readOnly?: boolean;
  collab?: MarkdownEditorCollab | null;
  pendingUndo?: MarkdownEditorPendingUndo;
  onPendingUndoConsumed?: (token: number) => void;
};

type CollaborationExtension = typeof import("@tiptap/extension-collaboration").Collaboration;
type CollaborationCaretExtension =
  typeof import("@tiptap/extension-collaboration-caret").CollaborationCaret;
type YTiptap = typeof import("@tiptap/y-tiptap");

// Both extensions bind to the same ydoc/awareness pair and are only ever
// used together, so they load as one lazy bundle — a caller with an
// `awareness` never waits on a second dynamic import, and a caller without
// one still pays for exactly the bytes it did before (CollaborationCaret is
// tiny, and it's simply never configured into the extensions array below).
type CollaborationExtensions = {
  Collaboration: CollaborationExtension;
  CollaborationCaret: CollaborationCaretExtension;
  yTiptap: YTiptap;
};

let collaborationExtensionsPromise: Promise<CollaborationExtensions> | null = null;

function loadCollaborationExtensions(): Promise<CollaborationExtensions> {
  collaborationExtensionsPromise ??= Promise.all([
    import("@tiptap/extension-collaboration"),
    import("@tiptap/extension-collaboration-caret"),
    import("@tiptap/y-tiptap"),
  ]).then(([collaboration, collaborationCaret, yTiptap]) => ({
    Collaboration: collaboration.Collaboration,
    CollaborationCaret: collaborationCaret.CollaborationCaret,
    yTiptap,
  }));
  return collaborationExtensionsPromise;
}

type CollaborationExtensionsLoad =
  | { status: "loading" }
  | { status: "ready"; extensions: CollaborationExtensions }
  | { status: "failed"; error: Error };

function collaborationLoadError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Collaboration extensions failed to load", { cause: error });
}

type MarkdownEditorInnerProps = MarkdownEditorProps & {
  collaborationExtensions: CollaborationExtensions | null;
};

const LARGE_DOCUMENT_PLACEHOLDER_LIMIT_CHARS = 64 * 1024;

// Link's default openOnClick calls window.open directly — a pure deny in
// this app's security model (see electronSecurity.ts) — and linkOnPaste
// would double up with linkMenu.tsx's own paste-over-selection handling.
// Both are owned by linkMenu.tsx's plugin instead.
const LINK_MARK_OPTIONS = { openOnClick: false, linkOnPaste: false };
// Dropcursor defaults to a thin `currentColor` line (width 1). Paint it in the
// brand accent at 2px so the "this is where the drop lands" indicator reads
// clearly against warm paper and charcoal alike — the inline style resolves the
// CSS variable against the editor's cascade.
const DROP_CURSOR_OPTIONS = { color: "var(--dohc-accent)", width: 2 };
// orderedList: false on both starter kits hands the node to the projection's
// MarkdownOrderedList in STATIC_EDITOR_EXTENSIONS, as the projection's own
// schema does. The editor lists the projection's Markdown extensions before
// the starter kit, as the projection does, so the two schemas rank marks the
// same: highlight above bold, italic, strike, underline, and code.
const LOCAL_STARTER_KIT = StarterKit.configure({
  trailingNode: false,
  orderedList: false,
  listItem: false,
  dropcursor: DROP_CURSOR_OPTIONS,
  link: LINK_MARK_OPTIONS,
});
const COLLAB_STARTER_KIT = StarterKit.configure({
  trailingNode: false,
  undoRedo: false,
  orderedList: false,
  listItem: false,
  dropcursor: DROP_CURSOR_OPTIONS,
  link: LINK_MARK_OPTIONS,
});
const TRAILING_NODE_EXTENSION = SafeTrailingNode.configure({
  node: "paragraph",
  notAfter: ["paragraph"],
});
const PLACEHOLDER_EXTENSION = Placeholder.configure({
  includeChildren: true,
  // Only the block the cursor is in shows its hint — with `false`, every
  // empty paragraph in the document stamps "Type '/' for commands" at once.
  showOnlyCurrent: true,
  placeholder: ({ node }) => {
    if (
      node.type.name === "tableCell" ||
      node.type.name === "tableHeader"
    ) {
      return "";
    }
    if (node.type.name === "heading") return "Heading";
    return "Type '/' for commands";
  },
});
// The projection's table parses and writes the row-height annotation, so a
// source-view edit keeps resized rows. Column resizing is off by default in
// Tiptap; it is turned on here so the grip/menu UI (tableControls.tsx) has
// resizing to coexist with. These are runtime options: they do not change
// the schema, so the projection's unconfigured table stays in parity. See
// schema-parity.test.ts.
const TABLE_EXTENSION = DohcMarkdownTable.configure({
  resizable: true,
  // A useful default column measure makes appended columns grow the table
  // past the reading column instead of compressing every cell indefinitely.
  // The tableWrapper owns horizontal scrolling in styles.css.
  cellMinWidth: TABLE_CELL_MIN_WIDTH,
  // The block gutter selects a whole table as a node, so Backspace and Delete
  // remove it. Tiptap otherwise turns that selection into a cell selection.
  allowTableNodeSelection: true,
});
const STATIC_EDITOR_EXTENSIONS = [
  ListConversions,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
  DohcTaskItem,
  TableKit.configure({ table: false }),
  TABLE_EXTENSION,
];

// The editor reads Markdown through the projection's parser, so it keeps
// exactly what every other surface keeps. An empty body is left to the
// editor's own empty document, which fills in a paragraph.
function markdownContent(markdown: string): JSONContent | string {
  const json = parseRichdocMarkdown(markdown);
  return json.content?.length ? json : "";
}

function BubbleButton(props: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      className={`dohc-bubble-menu__button${props.active ? " is-active" : ""}`}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

// The bubble menu's contents. The editor does not re-render React on each
// transaction, so the toolbar reads the block and marks under the selection
// from the editor's state; a render-time read showed the previous
// selection's. selectionFormat keeps that read cheap on every keystroke.
function SelectionToolbar(props: {
  editor: Editor;
  onOpenLink: (state: LinkMenuState) => void;
}) {
  const { editor } = props;
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => selectionFormat(current.state),
  });
  return (
    <>
      <TurnIntoMenu editor={editor} activeId={active.block} />
      <span className="dohc-bubble-menu__divider" aria-hidden="true" />
      <BubbleButton
        label="Bold"
        active={active.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={14} aria-hidden />
      </BubbleButton>
      <BubbleButton
        label="Italic"
        active={active.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={14} aria-hidden />
      </BubbleButton>
      <BubbleButton
        label="Underline"
        active={active.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon size={14} aria-hidden />
      </BubbleButton>
      <BubbleButton
        label="Strikethrough"
        active={active.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough size={14} aria-hidden />
      </BubbleButton>
      <BubbleButton
        label="Code"
        active={active.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code size={14} aria-hidden />
      </BubbleButton>
      <BubbleButton
        label="Highlight"
        active={active.highlight}
        onClick={() => editor.chain().focus().toggleMark("highlight").run()}
      >
        <Highlighter size={14} aria-hidden />
      </BubbleButton>
      <LinkBubbleButton editor={editor} active={active.link} onOpen={props.onOpenLink} />
    </>
  );
}

/** Reveal the block `target` names, clamped to the last block — the caller's
 *  index comes from Markdown that can have drifted from the live document,
 *  and the nearest block is the honest answer. No cursor move: an external
 *  jump reveals the passage, it does not take over the caret (the heading
 *  seam navigates the same way).
 *
 *  A matched line inside the block is revealed instead when intraBlock.ts can
 *  prove where it sits. Two ways that refinement is dropped: it says
 *  so, or it resolved to a range that rendered nothing to scroll. Both leave
 *  the block start, which is what this did before it could refine anything. */
function scrollToBlock(
  editor: Editor,
  target: BlockNavigationTarget,
): (() => void) | undefined {
  const doc = editor.state.doc;
  if (doc.childCount === 0) return;
  const child = Math.min(Math.max(target.index, 0), doc.childCount - 1);
  let pos = 0;
  for (let before = 0; before < child; before += 1) pos += doc.child(before).nodeSize;
  // A clamped index is a different block from the one the lines were sliced
  // from, so the refinement no longer speaks for it.
  const range =
    target.match && child === target.index
      ? intraBlockRange(doc.child(child), pos, target.match, (source) =>
          renderInlineText(editor, source),
        )
      : null;
  if (range) {
    const revealed = revealDocPosition(editor, range, () =>
      editor.view.dom.querySelector<HTMLElement>(`.${FLASH_CLASS}`),
    );
    if (revealed) return revealed;
  }
  return revealDocPosition(editor, pos, () => {
    const dom = editor.view.nodeDOM(pos);
    return dom instanceof HTMLElement ? dom : null;
  });
}

function renderInlineText(editor: Editor, source: string): string {
  try {
    return editor.schema.nodeFromJSON(parseRichdocMarkdown(source)).textContent;
  } catch {
    return source;
  }
}

/** Tab focus leaves Chromium's caret at the editor root, (view.dom, 0), and
 *  here the Selection API usually reports no range at all. ProseMirror's
 *  focus handler finds that equal to its last, empty, selection and writes
 *  nothing, so typed text has no caret. Write the state selection unless the
 *  DOM caret is already inside the content. A click places its caret later. */
function placeCaretOnFocus(view: EditorView): void {
  const anchor = view.dom.ownerDocument.getSelection()?.anchorNode;
  if (anchor && anchor !== view.dom && view.dom.contains(anchor)) return;
  view.focus();
}

/** ProseMirror reads a caret the browser moved when selectionchange arrives,
 *  and Chromium can deliver that event after the next key. Enter right after
 *  a click then split the block at the old selection. Read the DOM selection
 *  first. ProseMirror's own keydown flushes only pending DOM mutations. */
function readCaretBeforeKey(view: EditorView, event: KeyboardEvent): false {
  if (event.keyCode !== 229) {
    (view as EditorView & { domObserver: { flush(): void } }).domObserver.flush();
  }
  return false;
}

const MarkdownEditorInner = forwardRef<MarkdownEditorHandle, MarkdownEditorInnerProps>(
  function MarkdownEditorInner(
    {
      value,
      onDirty,
      onFocus,
      knownFiles,
      onOpenWikilink,
      onOpenWorkspaceLink,
      headingTarget,
      blockTarget,
      onBlockTargetConsumed,
      resolveWorkspaceAssetUrl,
      autoFocus,
      readOnly,
      collab,
      pendingUndo,
      onPendingUndoConsumed,
      collaborationExtensions,
      workspaceId,
      path,
    },
    ref,
  ) {
    const [acState, setAcState] = useState<AutocompleteState>({ active: false });
    const [mentionState, setMentionState] = useState<AutocompleteState>({
      active: false,
    });
    const [emojiState, setEmojiState] = useState<AutocompleteState>({
      active: false,
    });
    const [slashState, setSlashState] = useState<SlashCommandState>(
      CLOSED_SLASH_COMMAND_STATE,
    );
    const [blockMenuState, setBlockMenuState] = useState<BlockMenuState>(
      CLOSED_BLOCK_MENU_STATE,
    );
    const [chromeReady, setChromeReady] = useState(false);
    const [linkMenuState, setLinkMenuState] = useState<LinkMenuState>(
      CLOSED_LINK_MENU_STATE,
    );
    const linkMenuStateRef = useRef<LinkMenuState>(linkMenuState);
    const containerRef = useRef<HTMLDivElement>(null);
    const slashStateRef = useRef<SlashCommandState>(slashState);
    const blockMenuStateRef = useRef<BlockMenuState>(blockMenuState);
    const slashCommandRunnerRef = useRef<(id: SlashCommandId) => void>(() => {});
    const blockInsertRef = useRef<(pos: number) => void>(() => {});
    const blockMenuOpenRef = useRef<(pos: number, handle: HTMLElement) => void>(() => {});
    const knownFilesRef = useRef<ReadonlyMap<string, WikilinkFile>>(new Map());
    const applyingPendingUndoRef = useRef(false);
    const appliedPendingUndoToken = useRef<number | null>(null);
    const includePlaceholdersRef = useRef(
      value.length <= LARGE_DOCUMENT_PLACEHOLDER_LIMIT_CHARS,
    );
    const onOpenWikilinkRef = useRef<((target: string) => void) | null>(
      onOpenWikilink ?? null,
    );
    const onOpenWorkspaceLinkRef = useRef<
      ((target: WorkspaceLinkTarget) => void) | null
    >(onOpenWorkspaceLink ?? null);
    // The offer a URL pasted on its own line raises, and its row. Mod+K in
    // the editor moves focus to the row.
    const [urlOffer, setUrlOffer] = useState<UrlPasteOfferState | null>(null);
    const urlOfferRowRef = useRef<HTMLDivElement>(null);
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    // The shell's error hook, for a code block's copy the clipboard refused.
    const reportError = useContext(ShellErrorReporter);
    const reportErrorRef = useRef(reportError);
    reportErrorRef.current = reportError;

    // ProseMirror invokes menu handlers outside React's render cycle. Keep the
    // imperative ref current in the same tick as the visual state so rapid
    // typing/arrow keys never read the previous menu query or selection.
    const publishSlashState = useCallback<
      Dispatch<SetStateAction<SlashCommandState>>
    >((update) => {
      const current = slashStateRef.current;
      const next = typeof update === "function" ? update(current) : update;
      slashStateRef.current = next;
      setSlashState((rendered) =>
        slashCommandStatesEqual(rendered, next) ? rendered : next,
      );
    }, []);

    // Refs (not props) so the editorProps closures below — created once with
    // the editor — always resolve/write against the current document, even if
    // the same editor instance is reused across a path change.
    const imageContextRef = useRef<ImageSrcContext>({
      workspaceId,
      docPath: path,
      resolveWorkspaceAssetUrl,
    });
    const pasteContextRef = useRef<ImagePasteContext>({
      workspaceId,
      docPath: path,
      writeAsset: (relativePath, bytes) =>
        bridge().writeWorkspaceAsset({
          workspaceId: imageContextRef.current.workspaceId,
          relativePath,
          bytes,
        }),
      // `/image` opens a MAIN-process dialog at the workspace root and comes
      // back with the chosen files' bytes — one round trip into the same
      // write+insert path paste and drop use.
      pickImages: async () =>
        (
          await bridge().pickImageFiles({
            workspaceId: imageContextRef.current.workspaceId,
          })
        ).files,
      // Read WHEN an image is written, not once when the editor mounts. The
      // setting is workspace state the user can change from the settings dialog
      // without this editor ever remounting — a cached copy would keep saving to
      // the old location — and it is per-workspace, so a copy taken before a
      // workspace switch would be the wrong workspace's. Reading through
      // imageContextRef (kept current below) makes the current workspace's
      // setting the only one this can ever apply. A failed read falls back to
      // the per-document default inside placeImageFiles.
      readAttachments: async () => {
        const result = await bridge().getWorkspaceSettings({
          workspaceId: imageContextRef.current.workspaceId,
        });
        return {
          location: result.settings.files.attachmentLocation,
          folderName: result.settings.files.attachmentFolderName,
        };
      },
      onBeforeInsert: () => onFocusRef.current?.(),
    });

    useEffect(() => {
      imageContextRef.current = {
        workspaceId,
        docPath: path,
        resolveWorkspaceAssetUrl,
      };
      pasteContextRef.current = {
        ...pasteContextRef.current,
        workspaceId,
        docPath: path,
      };
    }, [workspaceId, path, resolveWorkspaceAssetUrl]);

    useEffect(() => {
      linkMenuStateRef.current = linkMenuState;
    }, [linkMenuState]);

    useEffect(() => {
      blockMenuStateRef.current = blockMenuState;
    }, [blockMenuState]);

    useEffect(() => {
      const map = new Map<string, WikilinkFile>();
      for (const file of knownFiles) {
        map.set(file.path, file);
        map.set(file.path.replace(/\.md$/i, ""), file);
      }
      knownFilesRef.current = map;
    }, [knownFiles]);

    useEffect(() => {
      onOpenWikilinkRef.current = onOpenWikilink ?? null;
    }, [onOpenWikilink]);

    useEffect(() => {
      onOpenWorkspaceLinkRef.current = onOpenWorkspaceLink ?? null;
    }, [onOpenWorkspaceLink]);

    const dohcPlugins = useMemo(
      () =>
        Extension.create({
          name: "dohcDecorations",
          addProseMirrorPlugins() {
            const wikilinkClickPlugin = new Plugin({
              key: new PluginKey("dohc-wikilink-click"),
              props: {
                handleClick(_view, _pos, event) {
                  const target = event.target as HTMLElement | null;
                  const el = target?.closest(
                    "[data-wikilink-target], [data-dohc-wikilink]",
                  ) as HTMLElement | null;
                  if (!el) return false;
                  const path =
                    el.getAttribute("data-wikilink-target") ??
                    el.getAttribute("data-dohc-wikilink");
                  if (!path) return false;
                  event.preventDefault();
                  onOpenWikilinkRef.current?.(path);
                  return true;
                },
              },
            });

            return [
              makeSlashCommandPlugin({
                stateRef: slashStateRef,
                setState: publishSlashState,
                runCommandRef: slashCommandRunnerRef,
                yTiptap: collaborationExtensions?.yTiptap ?? null,
              }),
              makeBlockControlsPlugin({
                onInsertRef: blockInsertRef,
                onOpenMenuRef: blockMenuOpenRef,
              }),
              makeWikilinkPlugin(
                () => knownFilesRef.current,
                (state) => setAcState(state),
              ),
              makeMentionPlugin((state) => setMentionState(state)),
              makeEmojiPlugin((state) => setEmojiState(state)),
              wikilinkClickPlugin,
              makeHeadingFlashPlugin(),
              makeLinkMenuPlugin({
                stateRef: linkMenuStateRef,
                setState: setLinkMenuState,
                openWorkspaceLink: (target) =>
                  onOpenWorkspaceLinkRef.current?.(target),
              }),
              makeCodeBlockChromePlugin(() => reportErrorRef.current),
              // After the slash-command plugin (menu keeps ArrowDown while
              // open), before code-block continuation (nested code escapes
              // past its callout) and StarterKit keymaps (Mod-Enter beats
              // HardBreak). Top-level code falls through on Mod-Enter.
              makeBlockExitPlugin(),
              makeCodeBlockContinuationPlugin(),
              makeCalloutChromePlugin(),
              makeCodeHighlightPlugin(),
              makeMermaidPreviewPlugin(),
              makeEmptyListItemFocusPlugin(),
              makeInlineAtomPlugin(),
              makeTableControlsPlugin({
                rowResizeEnabled: Boolean(collab?.ydoc),
              }),
              makeUrlPasteOfferPlugin(
                setUrlOffer,
                collaborationExtensions?.yTiptap ?? null,
              ),
            ];
          },
        }),
      [collab?.ydoc, collaborationExtensions, publishSlashState],
    );

    // Cmd/Ctrl+K registered via addKeyboardShortcuts on its own extension —
    // linkMenu.tsx owns the shortcut logic; this is the one-line hookup.
    const linkMenuExtension = useMemo(
      () => makeLinkMenuExtension({ setState: setLinkMenuState }),
      [],
    );

    const collaborationHistory = useMemo(() => {
      if (!collab?.ydoc || !collaborationExtensions) return null;
      const protectedNodes = new Set(["paragraph"]);
      return createCollaborationHistoryHandle(collab.ydoc, {
        trackedOrigin: collaborationExtensions.yTiptap.ySyncPluginKey,
        deleteFilter: (item) =>
          collaborationExtensions.yTiptap.defaultDeleteFilter(
            item,
            protectedNodes,
          ),
      });
    }, [collab?.ydoc, collaborationExtensions]);

    const extensions = useMemo(
      () => {
        const collabYDoc = collab?.ydoc ?? null;
        const awareness = collab?.awareness ?? null;
        const isCollab = Boolean(collabYDoc && collaborationExtensions);
        return [
          ...desktopMarkdownExtensions,
          isCollab ? COLLAB_STARTER_KIT : LOCAL_STARTER_KIT,
          ...STATIC_EDITOR_EXTENSIONS,
          findReplaceExtension,
          ...(includePlaceholdersRef.current ? [PLACEHOLDER_EXTENSION] : []),
          ...(isCollab
            ? [
                collaborationExtensions!.Collaboration.configure({
                  document: collabYDoc,
                  field: "body",
                  yUndoOptions: { undoManager: collaborationHistory! },
                }),
                CollaborationHistoryInput,
                // Only wired when the caller hands us an Awareness
                // bound to this same ydoc (docPresence.ts's bindDocPresence).
                // No awareness (today's only caller, or a peer that dropped
                // off the presence channel) means no carets, never a crash —
                // the calm "N editing" indicator above the editor is
                // unaffected either way.
                ...(awareness
                  ? [
                      collaborationExtensions!.CollaborationCaret.configure({
                        provider: { awareness },
                        user: resolveCaretUser(awareness),
                        selectionRender: caretSelectionRender,
                      }),
                    ]
                  : []),
              ]
            : [TRAILING_NODE_EXTENSION]),
          dohcPlugins,
          linkMenuExtension,
        ];
      },
      [
        collab?.ydoc,
        collab?.awareness,
        collaborationExtensions,
        collaborationHistory,
        dohcPlugins,
        linkMenuExtension,
      ],
    );

    const collabActive = Boolean(collab?.ydoc && collaborationExtensions);
    // Recomputed on the same deps as useEditor's own rebuild trigger below
    // ([extensions, collabActive]), not just [collab?.ydoc]: extensions
    // changes (and useEditor tears down and rebuilds the editor) whenever
    // awareness is added, removed, or swapped — a stale seed keyed on ydoc
    // identity alone would reseed the rebuild from the doc's shape at MOUNT
    // time, recreating the invalid-selection bug on a doc whose leading
    // structure has since changed to a taskList.
    const collabInitialContent = useMemo(
      () => (collab?.ydoc ? getDohcYDocSelectionSeed(collab.ydoc) : undefined),
      [collab?.ydoc, extensions, collabActive],
    );

    const editor = useEditor(
      {
        extensions,
        // y-tiptap preserves the initial numeric selection without finding a
        // valid text cursor. This structural seed (first-node path only, not
        // the full body) puts Selection.atStart at the same inline depth as
        // the bound document, so the selection y-tiptap restores after sync
        // still resolves into inline content there too — trimmed to one path
        // rather than the whole document so mounting doesn't build the full
        // DOM twice per open (once for the seed, once for the synced body).
        // undefined (empty/frontmatter-only body) falls back to the normal
        // empty-doc path below, same as non-collab mounts.
        content: collabActive ? collabInitialContent : value,
        editable: !readOnly,
        // Register the image node view's per-editor context before the
        // ProseMirror view is built (createView reads the extension's storage),
        // so workspace-relative image srcs resolve on the very first paint.
        // Node views themselves are registered through their extensions'
        // addNodeView (TipTap 3.x ignores editorProps.nodeViews).
        onBeforeCreate({ editor }) {
          const imageStorage = editor.storage.image as DohcImageStorage | undefined;
          if (imageStorage) {
            imageStorage.resolveContext = () => imageContextRef.current;
          }
          // Markdown is parsed once, as the editor is built, not on every
          // render that passes the current value.
          if (!collabActive && typeof editor.options.content === "string") {
            editor.options.content = markdownContent(editor.options.content);
          }
        },
        editorProps: {
          clipboardTextParser: parseMarkdownListClipboard,
          attributes: {
            class: "dohc-notion-editor",
            "data-testid": "markdown-editor",
          },
          handlePaste: (view, event) =>
            handleImagePaste(view, event, pasteContextRef.current),
          handleDrop: (view, event) =>
            handleImageDrop(view, event as DragEvent, pasteContextRef.current),
          handleKeyDown: (view, event) => {
            readCaretBeforeKey(view, event);
            return urlPasteOfferKeyDown(view, event, () =>
              urlOfferRowRef.current?.querySelector("button")?.focus(),
            );
          },
          handleDOMEvents: {
            focus: (view) => {
              collaborationHistory?.stopCapturing();
              onFocusRef.current?.();
              placeCaretOnFocus(view);
              return false;
            },
          },
        },
        immediatelyRender: true,
        // Every programmatic change this component makes says so at the point
        // it makes it: `setContent` passes `emitUpdate: false`, `setEditable`
        // passes its own false, and a pending undo raises
        // `applyingPendingUndoRef`. What reaches here after those is the user's
        // own edit, so it is reported. There is deliberately no window in which
        // updates are ignored — one used to exist, keyed on an animation frame,
        // and it dropped keystrokes that arrived first.
        onUpdate({ editor, transaction }) {
          if (collabActive) return;
          if (applyingPendingUndoRef.current) return;
          if (!transaction.docChanged) return;
          const document = editor.state.doc;
          onDirty(() =>
            serializeRichdocBody(escapeHighlightMarkdown(document.toJSON())),
          );
        },
      },
      [extensions, collabActive],
    );

    useEffect(() => {
      // Tiptap 3's setEditable defaults emitUpdate to true — an editability
      // flip alone must not run the update pipeline (dirty tracking, save
      // scheduling) in non-collab mode; nothing about the document changed.
      editor?.setEditable(!readOnly, false);
    }, [editor, readOnly]);

    useEffect(() => {
      setChromeReady(false);
      if (!editor) return;
      const frame = requestAnimationFrame(() => setChromeReady(true));
      return () => cancelAnimationFrame(frame);
    }, [editor]);

    // The whole document pane is the image drop zone, not just the ProseMirror
    // element inside it. ProseMirror's handleDrop only fires for drops that land
    // on view.dom (it is also the only thing that preventDefaults `dragover`),
    // which left the page top-matter — icon, title, properties — dead to file
    // drops: dropping an image there did nothing at all. The pane listeners fill
    // that gap and route into the same placeImageFiles path; they ignore drags
    // without files, so in-editor block/image reordering stays ProseMirror's.
    useEffect(() => {
      const container = containerRef.current;
      const view = editor?.view;
      if (!container || !view) return;
      const pane =
        container.closest<HTMLElement>("[data-dohc-doc-pane]") ?? container;
      const onDragOver = (event: DragEvent) => {
        handlePaneImageDragOver(event);
      };
      const onDrop = (event: DragEvent) => {
        handlePaneImageDrop(view, event, pasteContextRef.current);
      };
      pane.addEventListener("dragenter", onDragOver);
      pane.addEventListener("dragover", onDragOver);
      pane.addEventListener("drop", onDrop);
      return () => {
        pane.removeEventListener("dragenter", onDragOver);
        pane.removeEventListener("dragover", onDragOver);
        pane.removeEventListener("drop", onDrop);
      };
    }, [editor]);

    // Edit > Find on macOS, while focus is in this editor or its find bar.
    useEffect(() => {
      const container = containerRef.current;
      if (!container || !editor) return;
      return onEditorMenuCommand(container, (command) => runFindCommand(editor, command));
    }, [editor]);

    // A choice is its own undo step in either history, so Undo, like Ctrl+Z,
    // takes back the choice and keeps the paste.
    const chooseUrlOffer = useCallback(
      (form: UrlForm) => {
        if (!editor || editor.isDestroyed) return;
        collaborationHistory?.stopCapturing();
        chooseUrlForm(editor.view, form);
        collaborationHistory?.stopCapturing();
      },
      [editor, collaborationHistory],
    );
    const undoUrlOffer = useCallback(() => {
      if (!editor || editor.isDestroyed) return;
      editor.chain().focus().undo().run();
      dismissUrlPasteOffer(editor.view);
    }, [editor]);
    const dismissUrlOffer = useCallback(() => {
      if (editor && !editor.isDestroyed) dismissUrlPasteOffer(editor.view);
    }, [editor]);

    const openSlashMenuAtPosition = useCallback(
      (pos: number) => {
        const view = editor?.view;
        if (!view) return;

        let x = 12;
        let y = 40;
        let bottom: number | null = null;
        let maxHeight = FLOATING_MENU_MAX_HEIGHT;
        let placement: FloatingMenuPlacement = "below";
        try {
          const coords = view.coordsAtPos(pos);
          const position = resolveFloatingMenuPosition({ cursorRect: coords });
          x = position.x;
          y = position.y;
          bottom = position.bottom ?? null;
          maxHeight = position.maxHeight;
          placement = position.placement;
        } catch {
          // Offscreen/jsdom editors cannot always resolve coordinates.
        }

        publishSlashState({
          open: true,
          from: pos,
          to: pos,
          query: "",
          selected: 0,
          x,
          y,
          bottom,
          maxHeight,
          placement,
        });
      },
      [editor, publishSlashState],
    );

    const insertBlockAfter = useCallback(
      (pos: number) => {
        insertBlockAfterCore(editor, pos, openSlashMenuAtPosition);
      },
      [editor, openSlashMenuAtPosition],
    );

    // The handle of the block whose menu is open closes it, like any trigger.
    const openBlockMenu = useCallback((pos: number, handle: HTMLElement) => {
      const current = blockMenuStateRef.current;
      setBlockMenuState(
        current.open && current.pos === pos
          ? CLOSED_BLOCK_MENU_STATE
          : resolveBlockMenuState(pos, handle),
      );
    }, []);

    const closeBlockMenu = useCallback(() => {
      setBlockMenuState(CLOSED_BLOCK_MENU_STATE);
    }, []);

    const runBlockMenuAction = useCallback(
      (entry: BlockMenuEntry) => {
        const current = blockMenuStateRef.current;
        if (!current.open) return;
        const { pos } = current;
        setBlockMenuState(CLOSED_BLOCK_MENU_STATE);
        if (entry.kind === "turn-into") {
          turnBlockInto(editor, pos, entry.id);
          return;
        }
        switch (entry.id) {
          case "duplicate":
            duplicateBlock(editor, pos);
            return;
          case "delete":
            deleteBlock(editor, pos);
            return;
          case "copy-markdown":
            void copyBlockAsMarkdown(editor, pos);
            return;
        }
      },
      [editor],
    );

    useEffect(() => {
      blockInsertRef.current = insertBlockAfter;
      blockMenuOpenRef.current = openBlockMenu;
    }, [insertBlockAfter, openBlockMenu]);

    const insertImageAtSlash = useCallback((view: EditorView, pos: number) => {
      void pickAndInsertImages(view, pos, pasteContextRef.current);
    }, []);

    const runSlashCommand = useCallback(
      (id: SlashCommandId) => {
        runSlashCommandCore(
          editor,
          id,
          slashStateRef.current,
          publishSlashState,
          insertImageAtSlash,
        );
      },
      [editor, insertImageAtSlash, publishSlashState],
    );

    useEffect(() => {
      slashCommandRunnerRef.current = runSlashCommand;
    }, [runSlashCommand]);

    useEffect(() => {
      if (!autoFocus || !editor) return;
      const frame = requestAnimationFrame(() => editor.commands.focus("end"));
      return () => cancelAnimationFrame(frame);
    }, [autoFocus, editor]);

    useEffect(() => {
      if (!editor || collabActive || !pendingUndo) return;
      if (appliedPendingUndoToken.current === pendingUndo.token) return;
      const current = serializeRichdocBody(escapeHighlightMarkdown(editor.getJSON()));
      // The restore arrives as the file's source, which can spell raw HTML and
      // escapes differently from a save, so compare the document it reads as.
      const restored = editor.schema.nodeFromJSON(
        parseRichdocMarkdown(pendingUndo.restoredText),
      );
      if (current !== serializeRichdocBody(escapeHighlightMarkdown(restored.toJSON()))) {
        onPendingUndoConsumed?.(pendingUndo.token);
        return;
      }
      appliedPendingUndoToken.current = pendingUndo.token;
      applyingPendingUndoRef.current = true;
      try {
        editor
          .chain()
          .setContent(markdownContent(pendingUndo.undoText), { emitUpdate: false })
          .setMeta("addToHistory", false)
          .run();
        // Closing the history group keeps the restore from joining the event
        // before it, so one undo lands on undoText.
        editor
          .chain()
          .setContent(markdownContent(pendingUndo.restoredText), { emitUpdate: false })
          .command(({ tr }) => {
            closeHistory(tr);
            return true;
          })
          .run();
        editor.commands.focus("end");
      } finally {
        applyingPendingUndoRef.current = false;
      }
      onPendingUndoConsumed?.(pendingUndo.token);
    }, [editor, collabActive, pendingUndo, onPendingUndoConsumed]);

    // Where a search line jump lands. Same shape as the heading jump in
    // OutlinePanel: two frames for the editor's decorations to settle, then
    // apply — and if the document has no block to reveal yet (a collaborative
    // doc still filling in), keep one update listener rather than dropping the
    // jump. Applied once per nonce.
    //
    // Reporting back is what makes it once. A version switch unbinds the Y.Doc
    // and unmounts this editor (useEngineDoc drops `doc` while the reopen
    // runs), and the instance that replaces it has no memory of having applied
    // anything — a target still held above would land a second time, on a
    // document the reader did not search. The caller retires it instead.
    // The flash is deliberately not torn down here, unlike the heading seam.
    // Reporting the jump retires the target, which re-runs this effect — a
    // cleanup that cancelled the flash would erase the highlight in the frame
    // it was drawn. revealDocPosition's own timer owns it, and a second jump
    // supersedes the first by token, so nothing is left behind.
    useEffect(() => {
      if (!editor || !blockTarget) return;
      let applied = false;
      let firstFrame = 0;
      let secondFrame = 0;
      const applyTarget = () => {
        if (!scrollToBlock(editor, blockTarget)) return;
        applied = true;
        editor.off("update", applyTarget);
        onBlockTargetConsumed?.(blockTarget.nonce);
      };
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          applyTarget();
          if (!applied) editor.on("update", applyTarget);
        });
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(secondFrame);
        editor.off("update", applyTarget);
      };
    }, [editor, blockTarget?.index, blockTarget?.nonce, onBlockTargetConsumed]);

    useImperativeHandle(
      ref,
      () => ({
        // Synchronous on purpose. The page title's Enter handler calls this,
        // and Tiptap's focus command defers to the next frame, which let the
        // next character typed land in the title instead of the body.
        // ProseMirror scrolls only to a caret already inside the editor, so
        // the scroll request comes after focus.
        focus(position) {
          if (!editor || editor.isDestroyed) return;
          const { view } = editor;
          const selection = resolveFocusPosition(view.state.doc, position);
          if (selection) view.dispatch(view.state.tr.setSelection(selection));
          view.focus();
          view.dispatch(view.state.tr.scrollIntoView());
        },
        getMarkdown() {
          if (!editor) return value;
          // Escape literal `==` inside highlight marks before serializing so a
          // WYSIWYG highlight over text containing `==` saves as an unambiguous,
          // losslessly reversible `==a\=\=b==` (matches import-export.ts).
          return serializeRichdocBody(escapeHighlightMarkdown(editor.getJSON()));
        },
        replaceMarkdown(markdown) {
          if (!editor || collabActive) return;
          const documentBefore = editor.state.doc;
          const selection = editor.state.selection.getBookmark();
          editor
            .chain()
            .setContent(markdownContent(markdown), {
              emitUpdate: false,
            })
            .command(({ tr }) => {
              tr.setMeta("addToHistory", false);
              return true;
            })
            .run();
          const documentAfter = editor.state.doc;
          const mappedSelection = selection
            .map(documentReplacementMap(documentBefore, documentAfter))
            .resolve(documentAfter);
          editor.view.dispatch(editor.state.tr.setSelection(mappedSelection));
        },
        // What a new page held while this editor loaded: each line becomes a
        // paragraph at the start, and the caret lands where it stood in
        // `text` (a UTF-16 offset, as a textarea counts).
        insertTypedText(text, caret) {
          if (!editor || editor.isDestroyed || text === "") return;
          const { view } = editor;
          const { doc, schema, tr } = view.state;
          const paragraphs = text
            .split("\n")
            .map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
          // An empty document's one empty paragraph gives way to the text.
          const empty = doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;
          tr.replaceWith(0, empty ? doc.content.size : 0, paragraphs);
          // Each paragraph before the caret's line is its text plus its two
          // boundaries; 1 enters the first paragraph.
          const lines = text.slice(0, caret).split("\n");
          const position = lines.reduce((sum, line) => sum + line.length + 2, 1) - 2;
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, position)));
        },
      }),
      [collabActive, editor, value],
    );

    const pickerView = editor ? editor.view : null;
    const pickerState: WikilinkPickerState = acState.active
      ? { open: true, from: acState.from, query: acState.query }
      : { open: false };
    const mentionPickerState: WikilinkPickerState = mentionState.active
      ? { open: true, from: mentionState.from, query: mentionState.query }
      : { open: false };
    const emojiPickerState: EmojiPickerState = emojiState.active
      ? { open: true, from: emojiState.from, query: emojiState.query }
      : { open: false };

    return (
      <div
        className="dohc-tiptap-editor"
        data-collab-state={collab?.status ?? "local"}
        ref={containerRef}
      >
        {collab && collab.status !== "disabled" ? (
          <div className="dohc-editor-presence" role="status" aria-live="polite">
            <span className="dohc-editor-presence-dot" aria-hidden="true" />
            <span>
              {collab.synced
                ? collab.peerCount === 0
                  ? "Live · just you"
                  : `${collab.peerCount + 1} editing`
                : "Syncing"}
            </span>
          </div>
        ) : null}
        {/* .dohc-editor-surface — not.dohc-tiptap-editor — is the CSS
         * container-query context for the outline/word-count grid trick.
         * Every position: fixed popover below (slash menu, block menu,
         * wikilink/@-mention/emoji pickers, link menu) must stay a sibling
         * of this wrapper, never a descendant: container-type makes an
         * element the containing block for fixed descendants too, which
         * would turn their view.coordsAtPos(...) viewport coordinates into
         * editor-pane-relative ones. See the comment on .dohc-editor-surface
         * in styles.css for the full mechanism. */}
        <div className="dohc-editor-surface">
          <EditorContent editor={editor} />
          <OutlinePanel
            editor={editor}
            containerRef={containerRef}
            headingTarget={headingTarget}
          />
        </div>
        {editor ? <FindReplaceBar editor={editor} /> : null}
        {editor && chromeReady ? (
          <BubbleMenu
            editor={editor}
            className="dohc-bubble-menu"
            shouldShow={({ editor: instance }) =>
              hasFormattableSelection(instance.state.selection)
            }
          >
            <SelectionToolbar editor={editor} onOpenLink={setLinkMenuState} />
          </BubbleMenu>
        ) : null}
        {chromeReady ? (
          <>
            <SlashCommandMenu
              state={slashState}
              onSelect={runSlashCommand}
              onHover={(index) =>
                publishSlashState((current) =>
                  current.open ? { ...current, selected: index } : current,
                )
              }
            />
            <BlockMenu
              state={blockMenuState}
              onSelect={runBlockMenuAction}
              onClose={closeBlockMenu}
            />
            <WikilinkPicker
              state={pickerState}
              files={knownFiles}
              view={pickerView}
              onDismiss={() => setAcState({ active: false })}
            />
            <WikilinkPicker
              state={mentionPickerState}
              files={knownFiles}
              view={pickerView}
              insertMode="node"
              onDismiss={() => setMentionState({ active: false })}
            />
            <EmojiPicker
              state={emojiPickerState}
              view={pickerView}
              onDismiss={() => setEmojiState({ active: false })}
            />
            <LinkMenu
              editor={editor}
              state={linkMenuState}
              onDismiss={() => setLinkMenuState(CLOSED_LINK_MENU_STATE)}
            />
            <UrlPasteOffer
              offer={urlOffer}
              view={pickerView}
              rowRef={urlOfferRowRef}
              onChoose={chooseUrlOffer}
              onUndo={undoUrlOffer}
              onDismiss={dismissUrlOffer}
            />
          </>
        ) : null}
      </div>
    );
  },
);

const MarkdownEditorCollabLoader = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditorCollabLoader(props, ref) {
  const [load, setLoad] = useState<CollaborationExtensionsLoad>({
    status: "loading",
  });

  useAsyncResponseEffect(
    loadCollaborationExtensions,
    {
      onSuccess: (extensions) => setLoad({ status: "ready", extensions }),
      onError: (error) =>
        setLoad({ status: "failed", error: collaborationLoadError(error) }),
    },
    [],
  );

  if (load.status === "failed") throw load.error;

  if (load.status === "loading") {
    return (
      <div className="dohc-tiptap-editor h-full" data-collab-state={props.collab?.status ?? "connecting"}>
        <SkeletonRows layout="document" label="Loading editor..." className="pt-1.5" />
      </div>
    );
  }

  return (
    <MarkdownEditorInner
      {...props}
      ref={ref}
      collaborationExtensions={load.extensions}
    />
  );
});

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(props, ref) {
    if (props.collab?.ydoc) {
      return <MarkdownEditorCollabLoader {...props} ref={ref} />;
    }
    return <MarkdownEditorInner {...props} ref={ref} collaborationExtensions={null} />;
  },
);

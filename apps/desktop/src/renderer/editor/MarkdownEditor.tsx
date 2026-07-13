import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { TrailingNode } from "@tiptap/extensions/trailing-node";
import { Plugin, PluginKey } from "@tiptap/pm/state";
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
import {
  dohcMarkdownExtensions,
  escapeHighlightMarkdown,
  type DohcImageStorage,
} from "./extensions";
import type { ImageSrcContext } from "./imageSrc";
import {
  handleImageDrop,
  handleImagePaste,
  handlePaneImageDragOver,
  handlePaneImageDrop,
  pickAndInsertImages,
  type ImagePasteContext,
} from "./imagePaste";
import { bridge } from "../bridge";
import { FindReplaceBar } from "./FindReplaceBar";
import { findReplaceExtension } from "./findReplace";
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
import {
  makeWikilinkPlugin,
  type AutocompleteState,
  type WikilinkFile,
} from "./wikilinkPlugin";
import { makeMentionPlugin } from "./mentionTrigger";
import { WikilinkPicker } from "./WikilinkPicker";
import { makeEmojiPlugin } from "./emojiTrigger";
import { EmojiPicker } from "./EmojiPicker";
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
import {
  makeCodeBlockChromePlugin,
  makeCodeBlockContinuationPlugin,
  makeEmptyListItemFocusPlugin,
} from "./codeBlockChrome";
import { makeCalloutChromePlugin } from "./calloutChrome";
import { makeCodeHighlightPlugin } from "./codeHighlight";
import { makeMermaidPreviewPlugin } from "./mermaidRender";
import { OutlinePanel } from "./OutlinePanel";

export type MarkdownEditorHandle = {
  focus: (position?: "start" | "end") => void;
  getMarkdown: () => string;
};

export type MarkdownEditorCollab = {
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

export type MarkdownEditorPendingUndo = {
  token: number;
  restoredText: string;
  undoText: string;
};

export type MarkdownEditorProps = {
  value: string;
  onDirty: () => void;
  workspaceId: string;
  path: string;
  knownFiles: ReadonlyArray<WikilinkFile>;
  onOpenWikilink?: (path: string) => void;
  autoFocus?: boolean;
  collab?: MarkdownEditorCollab | null;
  pendingUndo?: MarkdownEditorPendingUndo;
  onPendingUndoConsumed?: (token: number) => void;
};

type CollaborationExtension = typeof import("@tiptap/extension-collaboration").Collaboration;
type CollaborationCaretExtension =
  typeof import("@tiptap/extension-collaboration-caret").CollaborationCaret;

// Both extensions bind to the same ydoc/awareness pair and are only ever
// used together, so they load as one lazy bundle — a caller with an
// `awareness` never waits on a second dynamic import, and a caller without
// one still pays for exactly the bytes it did before (CollaborationCaret is
// tiny, and it's simply never configured into the extensions array below).
type CollaborationExtensions = {
  Collaboration: CollaborationExtension;
  CollaborationCaret: CollaborationCaretExtension;
};

let collaborationExtensionsPromise: Promise<CollaborationExtensions> | null = null;

async function loadCollaborationExtensions(): Promise<CollaborationExtensions> {
  if (!collaborationExtensionsPromise) {
    collaborationExtensionsPromise = Promise.all([
      import("@tiptap/extension-collaboration"),
      import("@tiptap/extension-collaboration-caret"),
    ]).then(([collaboration, collaborationCaret]) => ({
      Collaboration: collaboration.Collaboration,
      CollaborationCaret: collaborationCaret.CollaborationCaret,
    }));
  }
  return collaborationExtensionsPromise;
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
const LOCAL_STARTER_KIT = StarterKit.configure({
  trailingNode: false,
  dropcursor: DROP_CURSOR_OPTIONS,
  link: LINK_MARK_OPTIONS,
});
const COLLAB_STARTER_KIT = StarterKit.configure({
  trailingNode: false,
  undoRedo: false,
  dropcursor: DROP_CURSOR_OPTIONS,
  link: LINK_MARK_OPTIONS,
});
const MARKDOWN_EXTENSION = Markdown.configure({
  indentation: { style: "space", size: 2 },
});
const TRAILING_NODE_EXTENSION = TrailingNode.configure({
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
// TableKit ships column resizing but leaves it off by default — turned on
// here so the grip/menu UI (tableControls.tsx) has resizing to coexist
// with. Purely a runtime option: it does not change the schema TableKit
// contributes, so import-export.ts's unconfigured TableKit (parsing only,
// never rendered) stays in parity — see schema-parity.test.ts.
const TABLE_KIT_EXTENSION = TableKit.configure({ table: { resizable: true } });
const STATIC_EDITOR_EXTENSIONS = [
  ...dohcMarkdownExtensions,
  TaskList,
  TaskItem,
  TABLE_KIT_EXTENSION,
  MARKDOWN_EXTENSION,
  findReplaceExtension,
];

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

const MarkdownEditorInner = forwardRef<MarkdownEditorHandle, MarkdownEditorInnerProps>(
  function MarkdownEditorInner(
    {
      value,
      onDirty,
      knownFiles,
      onOpenWikilink,
      autoFocus,
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
    const blockMenuOpenRef = useRef<(pos: number, rect: DOMRect) => void>(() => {});
    const knownFilesRef = useRef<ReadonlyMap<string, WikilinkFile>>(new Map());
    const dirtyTrackingReadyRef = useRef(false);
    const applyingPendingUndoRef = useRef(false);
    const appliedPendingUndoToken = useRef<number | null>(null);
    const includePlaceholdersRef = useRef(
      value.length <= LARGE_DOCUMENT_PLACEHOLDER_LIMIT_CHARS,
    );
    const onOpenWikilinkRef = useRef<((target: string) => void) | null>(
      onOpenWikilink ?? null,
    );

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
    // the editor — always resolve/write against the CURRENT document, even if
    // the same editor instance is reused across a path change.
    const imageContextRef = useRef<ImageSrcContext>({ workspaceId, docPath: path });
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
      // imageContextRef (kept current below) makes the CURRENT workspace's
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
    });

    useEffect(() => {
      imageContextRef.current = { workspaceId, docPath: path };
      pasteContextRef.current = {
        ...pasteContextRef.current,
        workspaceId,
        docPath: path,
      };
    }, [workspaceId, path]);

    useEffect(() => {
      slashStateRef.current = slashState;
    }, [slashState]);

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
              makeLinkMenuPlugin({ stateRef: linkMenuStateRef, setState: setLinkMenuState }),
              makeCodeBlockChromePlugin(),
              makeCodeBlockContinuationPlugin(),
              makeCalloutChromePlugin(),
              makeCodeHighlightPlugin(),
              makeMermaidPreviewPlugin(),
              makeEmptyListItemFocusPlugin(),
              makeInlineAtomPlugin(),
              makeTableControlsPlugin(),
            ];
          },
        }),
      [publishSlashState],
    );

    // Cmd/Ctrl+K registered via addKeyboardShortcuts on its own extension —
    // linkMenu.tsx owns the shortcut logic; this is the one-line hookup.
    const linkMenuExtension = useMemo(
      () => makeLinkMenuExtension({ setState: setLinkMenuState }),
      [],
    );

    const extensions = useMemo(
      () => {
        const collabYDoc = collab?.ydoc ?? null;
        const awareness = collab?.awareness ?? null;
        const isCollab = Boolean(collabYDoc && collaborationExtensions);
        return [
          isCollab ? COLLAB_STARTER_KIT : LOCAL_STARTER_KIT,
          ...STATIC_EDITOR_EXTENSIONS,
          ...(includePlaceholdersRef.current ? [PLACEHOLDER_EXTENSION] : []),
          ...(isCollab
            ? [
                collaborationExtensions!.Collaboration.configure({
                  document: collabYDoc,
                  field: "body",
                }),
                // Additive: only wired when the caller hands us an Awareness
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
      [collab?.ydoc, collab?.awareness, collaborationExtensions, dohcPlugins, linkMenuExtension],
    );

    const collabActive = Boolean(collab?.ydoc && collaborationExtensions);

    const editor = useEditor(
      {
        extensions,
        content: collabActive ? undefined : value,
        contentType: collabActive ? undefined : "markdown",
        // Register the image node view's per-editor context BEFORE the
        // ProseMirror view is built (createView reads the extension's storage),
        // so workspace-relative image srcs resolve on the very first paint.
        // Node views themselves are registered through their extensions'
        // addNodeView (TipTap 3.x ignores editorProps.nodeViews).
        onBeforeCreate({ editor }) {
          const imageStorage = editor.storage.image as DohcImageStorage | undefined;
          if (imageStorage) {
            imageStorage.resolveContext = () => imageContextRef.current;
          }
        },
        editorProps: {
          attributes: {
            class: "dohc-notion-editor",
            "data-testid": "markdown-editor",
          },
          handlePaste: (view, event) =>
            handleImagePaste(view, event, pasteContextRef.current),
          handleDrop: (view, event) =>
            handleImageDrop(view, event as DragEvent, pasteContextRef.current),
        },
        immediatelyRender: true,
        onUpdate() {
          if (collabActive) return;
          if (applyingPendingUndoRef.current) return;
          if (!dirtyTrackingReadyRef.current) return;
          onDirty();
        },
      },
      [extensions, collabActive],
    );

    useEffect(() => {
      dirtyTrackingReadyRef.current = false;
      if (!editor) return;
      const frame = requestAnimationFrame(() => {
        dirtyTrackingReadyRef.current = true;
      });
      return () => cancelAnimationFrame(frame);
    }, [editor]);

    useEffect(() => {
      setChromeReady(false);
      if (!editor) return;
      const frame = requestAnimationFrame(() => setChromeReady(true));
      return () => cancelAnimationFrame(frame);
    }, [editor]);

    // The whole document PANE is the image drop zone, not just the ProseMirror
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

    const openSlashMenuAtPosition = useCallback(
      (pos: number) => {
        const view = editor?.view;
        if (!view) return;

        let x = 12;
        let y = 40;
        let maxHeight = FLOATING_MENU_MAX_HEIGHT;
        let placement: FloatingMenuPlacement = "below";
        try {
          const coords = view.coordsAtPos(pos);
          const position = resolveFloatingMenuPosition({ cursorRect: coords });
          x = position.x;
          y = position.y;
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

    const openBlockMenu = useCallback((pos: number, rect: DOMRect) => {
      setBlockMenuState(resolveBlockMenuState(pos, rect));
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
      const current = editor.getMarkdown();
      if (current !== pendingUndo.restoredText) {
        onPendingUndoConsumed?.(pendingUndo.token);
        return;
      }
      appliedPendingUndoToken.current = pendingUndo.token;
      applyingPendingUndoRef.current = true;
      try {
        editor.commands.setContent(pendingUndo.undoText, {
          contentType: "markdown",
          emitUpdate: false,
        });
        editor.commands.setContent(pendingUndo.restoredText, {
          contentType: "markdown",
          emitUpdate: false,
        });
        editor.commands.focus("end");
      } finally {
        applyingPendingUndoRef.current = false;
      }
      onPendingUndoConsumed?.(pendingUndo.token);
    }, [editor, collabActive, pendingUndo, onPendingUndoConsumed]);

    useImperativeHandle(
      ref,
      () => ({
        focus(position) {
          editor?.commands.focus(position);
        },
        getMarkdown() {
          // `editor.markdown` is @tiptap/markdown's documented public accessor
          // for the MarkdownManager (it's the same instance as the internal
          // `editor.storage.markdown.manager`, just the stable surface).
          if (!editor?.markdown) return value;
          // Escape literal `==` inside highlight marks before serializing so a
          // WYSIWYG highlight over text containing `==` saves as an unambiguous,
          // losslessly reversible `==a\=\=b==` (matches import-export.ts).
          return editor.markdown.serialize(escapeHighlightMarkdown(editor.getJSON()));
        },
      }),
      [editor, value],
    );

    const pickerView = editor
      ? (editor.view as Parameters<typeof WikilinkPicker>[0]["view"])
      : null;
    const emojiPickerView = editor
      ? (editor.view as Parameters<typeof EmojiPicker>[0]["view"])
      : null;
    const pickerState: Parameters<typeof WikilinkPicker>[0]["state"] =
      acState.active
        ? { open: true, from: acState.from, query: acState.query }
        : { open: false };
    const mentionPickerState: Parameters<typeof WikilinkPicker>[0]["state"] =
      mentionState.active
        ? { open: true, from: mentionState.from, query: mentionState.query }
        : { open: false };
    const emojiPickerState: Parameters<typeof EmojiPicker>[0]["state"] =
      emojiState.active
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
        {/* .dohc-editor-surface — NOT .dohc-tiptap-editor — is the CSS
         * container-query context for the outline/word-count grid trick.
         * Every position: fixed popover below (slash menu, block menu,
         * wikilink/@-mention/emoji pickers, link menu) MUST stay a sibling
         * of this wrapper, never a descendant: container-type makes an
         * element the containing block for fixed descendants too, which
         * would turn their view.coordsAtPos(...) viewport coordinates into
         * editor-pane-relative ones. See the comment on .dohc-editor-surface
         * in styles.css for the full mechanism. */}
        <div className="dohc-editor-surface">
          <EditorContent editor={editor} />
          <OutlinePanel editor={editor} containerRef={containerRef} />
        </div>
        {editor ? <FindReplaceBar editor={editor} /> : null}
        {editor && chromeReady ? (
          <BubbleMenu
            editor={editor}
            className="dohc-bubble-menu"
            shouldShow={({ editor: instance }) => !instance.state.selection.empty}
          >
            <TurnIntoMenu editor={editor} />
            <span className="dohc-bubble-menu__divider" aria-hidden="true" />
            <BubbleButton
              label="Bold"
              active={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold size={14} aria-hidden />
            </BubbleButton>
            <BubbleButton
              label="Italic"
              active={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic size={14} aria-hidden />
            </BubbleButton>
            <BubbleButton
              label="Underline"
              active={editor.isActive("underline")}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            >
              <UnderlineIcon size={14} aria-hidden />
            </BubbleButton>
            <BubbleButton
              label="Strikethrough"
              active={editor.isActive("strike")}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              <Strikethrough size={14} aria-hidden />
            </BubbleButton>
            <BubbleButton
              label="Code"
              active={editor.isActive("code")}
              onClick={() => editor.chain().focus().toggleCode().run()}
            >
              <Code size={14} aria-hidden />
            </BubbleButton>
            <BubbleButton
              label="Highlight"
              active={editor.isActive("highlight")}
              onClick={() => editor.chain().focus().toggleMark("highlight").run()}
            >
              <Highlighter size={14} aria-hidden />
            </BubbleButton>
            <LinkBubbleButton editor={editor} onOpen={setLinkMenuState} />
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
              view={emojiPickerView}
              onDismiss={() => setEmojiState({ active: false })}
            />
            <LinkMenu
              editor={editor}
              state={linkMenuState}
              onDismiss={() => setLinkMenuState(CLOSED_LINK_MENU_STATE)}
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
  const [collaborationExtensions, setCollaborationExtensions] =
    useState<CollaborationExtensions | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadCollaborationExtensions().then((extensions) => {
      if (!cancelled) setCollaborationExtensions(extensions);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!collaborationExtensions) {
    return (
      <div
        className="dohc-tiptap-editor flex h-full items-center justify-center text-xs text-subtle"
        data-collab-state={props.collab?.status ?? "connecting"}
      >
        Loading editor...
      </div>
    );
  }

  return (
    <MarkdownEditorInner
      {...props}
      ref={ref}
      collaborationExtensions={collaborationExtensions}
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

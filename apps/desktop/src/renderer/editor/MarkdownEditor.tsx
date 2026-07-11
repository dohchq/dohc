import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { Bold, Code, Italic, Strikethrough } from "lucide-react";
import type * as Y from "yjs";
import { dohcMarkdownExtensions } from "./extensions";
import { makeImageNodeView, type ImageSrcContext } from "./imageSrc";
import {
  handleImageDrop,
  handleImagePaste,
  type ImagePasteContext,
} from "./imagePaste";
import { bridge } from "../bridge";
import { makeInlineAtomPlugin } from "./inlineAtomPlugin";
import {
  makeWikilinkPlugin,
  type AutocompleteState,
  type WikilinkFile,
} from "./wikilinkPlugin";
import { WikilinkPicker } from "./WikilinkPicker";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";
import {
  CLOSED_SLASH_COMMAND_STATE,
  makeSlashCommandPlugin,
  runSlashCommand as runSlashCommandCore,
  SlashCommandMenu,
  type SlashCommandId,
  type SlashCommandState,
} from "./slashCommands";
import {
  insertBlockAfter as insertBlockAfterCore,
  makeBlockControlsPlugin,
  selectBlock as selectBlockCore,
} from "./blockControls";
import {
  makeCodeBlockChromePlugin,
  makeCodeBlockContinuationPlugin,
  makeEmptyListItemFocusPlugin,
} from "./codeBlockChrome";

export type MarkdownEditorHandle = {
  focus: () => void;
  getMarkdown: () => string;
};

export type MarkdownEditorCollab = {
  ydoc: Y.Doc;
  status: "disabled" | "connecting" | "connected" | "disconnected";
  peerCount: number;
  synced: boolean;
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

let collaborationExtensionPromise: Promise<CollaborationExtension> | null = null;

async function loadCollaborationExtension(): Promise<CollaborationExtension> {
  if (!collaborationExtensionPromise) {
    collaborationExtensionPromise = import("@tiptap/extension-collaboration").then(
      (mod) => mod.Collaboration,
    );
  }
  return collaborationExtensionPromise;
}

type MarkdownEditorInnerProps = MarkdownEditorProps & {
  collaborationExtension: CollaborationExtension | null;
};

const LARGE_DOCUMENT_PLACEHOLDER_LIMIT_CHARS = 64 * 1024;

const LOCAL_STARTER_KIT = StarterKit.configure({
  trailingNode: false,
});
const COLLAB_STARTER_KIT = StarterKit.configure({
  trailingNode: false,
  undoRedo: false,
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
const STATIC_EDITOR_EXTENSIONS = [
  ...dohcMarkdownExtensions,
  TaskList,
  TaskItem,
  TableKit,
  MARKDOWN_EXTENSION,
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
      collaborationExtension,
      workspaceId,
      path,
    },
    ref,
  ) {
    const [acState, setAcState] = useState<AutocompleteState>({ active: false });
    const [slashState, setSlashState] = useState<SlashCommandState>(
      CLOSED_SLASH_COMMAND_STATE,
    );
    const [chromeReady, setChromeReady] = useState(false);
    const slashStateRef = useRef<SlashCommandState>(slashState);
    const slashCommandRunnerRef = useRef<(id: SlashCommandId) => void>(() => {});
    const blockInsertRef = useRef<(pos: number) => void>(() => {});
    const blockSelectRef = useRef<(pos: number) => void>(() => {});
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
                setState: setSlashState,
                runCommandRef: slashCommandRunnerRef,
              }),
              makeBlockControlsPlugin({
                onInsertRef: blockInsertRef,
                onSelectRef: blockSelectRef,
              }),
              makeWikilinkPlugin(
                () => knownFilesRef.current,
                (state) => setAcState(state),
              ),
              wikilinkClickPlugin,
              makeCodeBlockChromePlugin(),
              makeCodeBlockContinuationPlugin(),
              makeEmptyListItemFocusPlugin(),
              makeInlineAtomPlugin(),
            ];
          },
        }),
      [],
    );

    const extensions = useMemo(
      () => {
        const collabYDoc = collab?.ydoc ?? null;
        const isCollab = Boolean(collabYDoc && collaborationExtension);
        return [
          isCollab ? COLLAB_STARTER_KIT : LOCAL_STARTER_KIT,
          ...STATIC_EDITOR_EXTENSIONS,
          ...(includePlaceholdersRef.current ? [PLACEHOLDER_EXTENSION] : []),
          ...(isCollab
            ? [
                collaborationExtension!.configure({
                  document: collabYDoc,
                  field: "body",
                }),
              ]
            : [TRAILING_NODE_EXTENSION]),
          dohcPlugins,
        ];
      },
      [collab?.ydoc, collaborationExtension, dohcPlugins],
    );

    const collabActive = Boolean(collab?.ydoc && collaborationExtension);

    const editor = useEditor(
      {
        extensions,
        content: collabActive ? undefined : value,
        contentType: collabActive ? undefined : "markdown",
        editorProps: {
          attributes: {
            class: "dohc-notion-editor",
            "data-testid": "markdown-editor",
          },
          // Render-time src resolution for workspace-relative images (canonical
          // attr stays the original relative path).
          nodeViews: {
            image: makeImageNodeView(() => imageContextRef.current),
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

        setSlashState({
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
      [editor],
    );

    const insertBlockAfter = useCallback(
      (pos: number) => {
        insertBlockAfterCore(editor, pos, openSlashMenuAtPosition);
      },
      [editor, openSlashMenuAtPosition],
    );

    const selectBlock = useCallback(
      (pos: number) => {
        selectBlockCore(editor, pos);
      },
      [editor],
    );

    useEffect(() => {
      blockInsertRef.current = insertBlockAfter;
      blockSelectRef.current = selectBlock;
    }, [insertBlockAfter, selectBlock]);

    const runSlashCommand = useCallback(
      (id: SlashCommandId) => {
        runSlashCommandCore(editor, id, slashStateRef.current, setSlashState);
      },
      [editor],
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
        focus() {
          editor?.commands.focus();
        },
        getMarkdown() {
          return editor?.getMarkdown() ?? value;
        },
      }),
      [editor, value],
    );

    const pickerView = editor
      ? (editor.view as Parameters<typeof WikilinkPicker>[0]["view"])
      : null;
    const pickerState: Parameters<typeof WikilinkPicker>[0]["state"] =
      acState.active
        ? { open: true, from: acState.from, query: acState.query }
        : { open: false };

    return (
      <div className="dohc-tiptap-editor" data-collab-state={collab?.status ?? "local"}>
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
        <EditorContent editor={editor} />
        {editor && chromeReady ? (
          <BubbleMenu
            editor={editor}
            className="dohc-bubble-menu"
            shouldShow={({ editor: instance }) => !instance.state.selection.empty}
          >
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
          </BubbleMenu>
        ) : null}
        {chromeReady ? (
          <>
            <SlashCommandMenu
              state={slashState}
              onSelect={runSlashCommand}
              onHover={(index) =>
                setSlashState((current) =>
                  current.open ? { ...current, selected: index } : current,
                )
              }
            />
            <WikilinkPicker
              state={pickerState}
              files={knownFiles}
              view={pickerView}
              onDismiss={() => setAcState({ active: false })}
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
  const [collaborationExtension, setCollaborationExtension] =
    useState<CollaborationExtension | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadCollaborationExtension().then((extension) => {
      if (!cancelled) setCollaborationExtension(extension);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!collaborationExtension) {
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
      collaborationExtension={collaborationExtension}
    />
  );
});

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(props, ref) {
    if (props.collab?.ydoc) {
      return <MarkdownEditorCollabLoader {...props} ref={ref} />;
    }
    return <MarkdownEditorInner {...props} ref={ref} collaborationExtension={null} />;
  },
);

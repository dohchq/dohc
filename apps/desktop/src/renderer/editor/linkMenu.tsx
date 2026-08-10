// Link editing UI: the StarterKit Link mark + autolink are already active in
// the schema (round-trips as `[text](url)` via @tiptap/markdown) — this file
// is the missing UI layer on top of it.
//
//   - Cmd/Ctrl+K opens a popover: editing an existing link (selection or
//     cursor inside one) prefills its URL; a plain selection wraps in a new
//     link on confirm; an empty selection outside a link inserts the typed
//     URL as its own link text.
//   - Clicking a rendered link opens the same popover (edit/open/remove);
//     Cmd/Ctrl+click opens it directly instead.
//   - Pasting a single URL over a non-empty selection links the selection.
//
// StarterKit's Link ships its own `openOnClick` (calls `window.open` — a
// pure deny in this app's security model, see electronSecurity.ts) and
// `linkOnPaste`. MarkdownEditor.tsx disables both via `.configure({ link: {
// openOnClick: false, linkOnPaste: false } })` so this file owns click and
// paste behavior exclusively, through a ProseMirror plugin (not
// editorProps, which the image paste/drop handlers already own).

import { useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { Extension, getMarkRange, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { ExternalLink, Link as LinkIcon, Trash2 } from "lucide-react";
import { bridge } from "../bridge";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";

// ── URL validation / normalization ──────────────────────────────────────

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
// Anything that already looks like `scheme:...` (mailto:, javascript:,
// data:, ftp://, tel:, ...). We never rewrite a declared scheme — either
// it's on the allowlist below or the whole input is refused.
const EXPLICIT_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// `localhost:3000` / `example.com:8080` — a hostname followed by a numeric
// port reads as a `scheme:` to EXPLICIT_SCHEME_RE, so without this it would
// fall through to `null` instead of getting the usual https:// prefix.
// Restricted to `localhost` or a dotted host so declared schemes with numeric
// tails (`tel:1234`) aren't misread as host:port.
const HOST_PORT_RE =
  /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d+(?:[/?#].*)?$/i;

/** Validates + normalizes user-entered link text. Returns the safe,
 *  absolute URL string, or null if the input isn't a usable http(s)/mailto
 *  link. Bare hosts (`example.com`) get `https://` prepended; bare emails
 *  (`a@b.com`) get `mailto:` prepended; anything else must already declare
 *  an allowed scheme. */
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const candidate = trimmed.startsWith("//")
    ? `https:${trimmed}`
    : HOST_PORT_RE.test(trimmed)
      ? `https://${trimmed}`
      : EXPLICIT_SCHEME_RE.test(trimmed)
        ? trimmed
        : EMAIL_RE.test(trimmed)
          ? `mailto:${trimmed}`
          : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    return ALLOWED_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Opens a URL through the app's audited external-open pathway
 *  (desktop:open-external-url → shell.openExternal, gated to http(s)/mailto
 *  by isSafeExternalUrl). Invalid URLs and OS open failures are contained. */
export async function openLinkExternally(rawUrl: string): Promise<void> {
  const normalized = normalizeLinkUrl(rawUrl);
  if (!normalized) return;
  try {
    await bridge().openExternalUrl({ url: normalized });
  } catch (error) {
    console.warn("[dohc] could not open external link:", error);
  }
}

// ── popover state ────────────────────────────────────────────────────────

export type LinkMenuState =
  | { open: false }
  | {
      open: true;
      /** Range being edited: an existing link's full mark range, a plain
       *  text selection to wrap, or a collapsed cursor position to insert
       *  at (from === to). */
      from: number;
      to: number;
      url: string;
      hasLink: boolean;
      x: number;
      y: number;
      maxHeight: number;
      placement: FloatingMenuPlacement;
    };

export const CLOSED_LINK_MENU_STATE: LinkMenuState = { open: false };

function isEditableEditor(editor: Editor | null | undefined): boolean {
  if (!editor) return false;
  if ((editor as { isEditable?: boolean }).isEditable === false) return false;
  if ((editor.view as { editable?: boolean }).editable === false) return false;
  return true;
}

function isViewEditable(view: EditorView): boolean {
  return (view as { editable?: boolean }).editable !== false;
}

function percentByteAt(value: string, index: number): number | null {
  const escape = value.slice(index, index + 3);
  return /^%[\da-f]{2}$/iu.test(escape)
    ? Number.parseInt(escape.slice(1), 16)
    : null;
}

function decodeHrefComponent(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length;) {
    const firstByte = percentByteAt(value, index);
    if (firstByte === null) {
      decoded += value[index];
      index += 1;
      continue;
    }
    if (firstByte < 0x80) {
      decoded += String.fromCharCode(firstByte);
      index += 3;
      continue;
    }

    const width =
      firstByte >= 0xc2 && firstByte <= 0xdf
        ? 2
        : firstByte >= 0xe0 && firstByte <= 0xef
          ? 3
          : firstByte >= 0xf0 && firstByte <= 0xf4
            ? 4
            : 0;
    if (width === 0) {
      decoded += value.slice(index, index + 3);
      index += 3;
      continue;
    }

    let end = index + 3;
    let continuationCount = 0;
    while (continuationCount < width - 1) {
      const byte = percentByteAt(value, end);
      if (byte === null || byte < 0x80 || byte > 0xbf) break;
      continuationCount += 1;
      end += 3;
    }
    const encoded = value.slice(index, end);
    if (continuationCount !== width - 1) {
      decoded += encoded;
      index = end;
      continue;
    }
    try {
      decoded += decodeURIComponent(encoded);
    } catch {
      decoded += encoded;
    }
    index = end;
  }
  return decoded;
}

export type WorkspaceLinkTarget = {
  path: string;
  rawFragment?: string;
};

type ReadOnlyLinkTarget =
  | { kind: "blocked" }
  | { kind: "external"; href: string }
  | { kind: "workspace"; target: WorkspaceLinkTarget };

function parseReadOnlyLinkHref(href: string): ReadOnlyLinkTarget {
  const trimmed = href.trim();
  if (!trimmed) return { kind: "blocked" };
  if (EXPLICIT_SCHEME_RE.test(trimmed) || trimmed.startsWith("//")) {
    return { kind: "external", href: trimmed };
  }

  const fragmentIndex = trimmed.indexOf("#");
  const beforeFragment =
    fragmentIndex === -1 ? trimmed : trimmed.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  const pathEnd = queryIndex === -1 ? beforeFragment.length : queryIndex;
  const rawPath = beforeFragment.slice(0, pathEnd);
  const rawFragment =
    fragmentIndex === -1 ? null : trimmed.slice(fragmentIndex + 1);
  const decodedPath = decodeHrefComponent(rawPath);

  // URL parsers ignore these controls inside a scheme. Check the same
  // collapsed spelling before the value can reach workspace navigation.
  const schemeCandidate = decodedPath.replace(/[\t\n\r]/g, "");
  if (EXPLICIT_SCHEME_RE.test(schemeCandidate)) return { kind: "blocked" };

  if (decodedPath.startsWith("//")) {
    return {
      kind: "external",
      href: `${decodedPath}${trimmed.slice(pathEnd)}`,
    };
  }

  if (!rawPath && rawFragment === null) return { kind: "blocked" };
  const explicitlyRelative =
    decodedPath.startsWith("./") ||
    decodedPath.startsWith("../") ||
    decodedPath.startsWith("/");
  const path = rawPath && !explicitlyRelative ? `./${decodedPath}` : decodedPath;
  return {
    kind: "workspace",
    target: {
      path,
      ...(rawFragment === null
        ? {}
        : { rawFragment }),
    },
  };
}

type ReadOnlyLinkEvent = {
  readonly detail: number;
  readonly repeat?: boolean;
  preventDefault(): void;
};

export function activateReadOnlyLinkHref(
  href: string,
  event: ReadOnlyLinkEvent,
  openWorkspaceLink?: (target: WorkspaceLinkTarget) => void,
): boolean {
  event.preventDefault();
  if (event.detail > 1 || event.repeat) return true;
  const target = parseReadOnlyLinkHref(href);
  if (target.kind === "external") void openLinkExternally(target.href);
  if (target.kind === "workspace") openWorkspaceLink?.(target.target);
  return true;
}

function linkHrefAt(
  doc: { nodeAt(pos: number): { marks: ReadonlyArray<{ type: { name: string }; attrs: Record<string, unknown> }> } | null },
  pos: number,
): string | null {
  const node = doc.nodeAt(pos);
  const mark = node?.marks.find((m) => m.type.name === "link");
  const href = mark?.attrs.href;
  return typeof href === "string" && href.length > 0 ? href : null;
}

/** Pure-ish state builder shared by the keyboard shortcut, the bubble
 *  button, and the click plugin. Without an explicit range it derives one
 *  from the current selection: a non-empty selection is used as-is; an
 *  empty selection expands to the enclosing link's mark range, if any. */
export function computeLinkMenuState(
  view: EditorView,
  explicitRange?: { from: number; to: number },
): LinkMenuState {
  const { state } = view;
  const linkType = state.schema.marks.link;
  let from: number;
  let to: number;
  if (explicitRange) {
    ({ from, to } = explicitRange);
  } else {
    const selection = state.selection;
    from = selection.from;
    to = selection.to;
    if (selection.empty && linkType) {
      const existing = getMarkRange(state.doc.resolve(selection.from), linkType);
      if (existing) {
        from = existing.from;
        to = existing.to;
      }
    }
  }

  const href = linkHrefAt(state.doc, from);

  let x = 12;
  let y = 40;
  let maxHeight = FLOATING_MENU_MAX_HEIGHT;
  let placement: FloatingMenuPlacement = "below";
  try {
    const coords = view.coordsAtPos(from);
    const position = resolveFloatingMenuPosition({
      cursorRect: coords,
      menuWidth: 340,
      menuMaxHeight: 140,
    });
    x = position.x;
    y = position.y;
    maxHeight = position.maxHeight;
    placement = position.placement;
  } catch {
    // Offscreen/jsdom editors cannot always resolve coordinates.
  }

  return {
    open: true,
    from,
    to,
    url: href ?? "",
    hasLink: href != null,
    x,
    y,
    maxHeight,
    placement,
  };
}

type OpenLinkMenuState = Extract<LinkMenuState, { open: true }>;

/** Commits the popover's edited URL: extends/creates a link mark over an
 *  existing range, or — for a collapsed Cmd+K-with-no-selection case —
 *  inserts the URL itself as new linked text. Returns false (without
 *  mutating the doc) when the input doesn't normalize to a safe URL. */
export function applyLinkMenu(
  editor: Editor,
  state: OpenLinkMenuState,
  rawUrl: string,
): boolean {
  const normalized = normalizeLinkUrl(rawUrl);
  if (!normalized) return false;

  const { from, to } = state;
  if (from === to) {
    editor
      .chain()
      .focus()
      .insertContentAt(from, {
        type: "text",
        text: normalized,
        marks: [{ type: "link", attrs: { href: normalized } }],
      })
      .setTextSelection(from + normalized.length)
      .run();
  } else {
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .extendMarkRange("link")
      .setLink({ href: normalized })
      .run();
  }
  return true;
}

export function removeLinkMenu(editor: Editor, state: OpenLinkMenuState): void {
  editor
    .chain()
    .focus()
    .setTextSelection({ from: state.from, to: state.to })
    .extendMarkRange("link")
    .unsetLink()
    .run();
}

// ── Cmd/Ctrl+K keyboard shortcut ────────────────────────────────────────

/** Standalone extension so MarkdownEditor.tsx only needs to add it to the
 *  extensions array — no editorProps/plugin-array surgery required for the
 *  shortcut itself. */
export function makeLinkMenuExtension({
  setState,
}: {
  setState: Dispatch<SetStateAction<LinkMenuState>>;
}) {
  return Extension.create({
    name: "dohcLinkMenu",
    addKeyboardShortcuts() {
      const open = () => {
        if (!isEditableEditor(this.editor)) return false;
        setState(computeLinkMenuState(this.editor.view));
        return true;
      };
      return { "Mod-k": open };
    },
  });
}

/** Click-to-edit/open + paste-URL-over-selection, as a single ProseMirror
 *  plugin (added into MarkdownEditor's existing dohcDecorations plugin
 *  array) so both behaviors live at the plugin level, not editorProps. */
export function makeLinkMenuPlugin({
  stateRef,
  setState,
  openWorkspaceLink,
}: {
  stateRef: RefObject<LinkMenuState>;
  setState: Dispatch<SetStateAction<LinkMenuState>>;
  openWorkspaceLink?: (target: WorkspaceLinkTarget) => void;
}) {
  function activateReadOnlyLink(event: MouseEvent | KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return false;

    // A read-only document must keep links useful without allowing renderer
    // navigation. Consume every anchor first. Route known external protocols
    // through the audited bridge and relative paths through the workspace
    // resolver.
    const href = (anchor.getAttribute("href") ?? "").trim();
    return activateReadOnlyLinkHref(href, event, openWorkspaceLink);
  }

  return new Plugin({
    key: new PluginKey("dohc-link-menu"),
    props: {
      handleClick(view, pos, event) {
        if (!isViewEditable(view)) return false;
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
        if (!anchor) {
          if (stateRef.current.open) setState(CLOSED_LINK_MENU_STATE);
          return false;
        }

        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          void openLinkExternally(anchor.getAttribute("href") ?? "");
          return true;
        }

        event.preventDefault();
        const linkType = view.state.schema.marks.link;
        if (!linkType) return false;
        const range =
          getMarkRange(view.state.doc.resolve(pos), linkType) ?? { from: pos, to: pos };
        setState(computeLinkMenuState(view, range));
        return true;
      },
      handlePaste(view, event) {
        if (!isViewEditable(view)) return false;
        const { state } = view;
        if (state.selection.empty) return false;
        const linkType = state.schema.marks.link;
        if (!linkType) return false;

        const text = (event.clipboardData?.getData("text/plain") ?? "").trim();
        if (!text || /\s/.test(text)) return false;
        const normalized = normalizeLinkUrl(text);
        if (!normalized) return false;

        const { from, to } = state.selection;
        view.dispatch(state.tr.addMark(from, to, linkType.create({ href: normalized })));
        event.preventDefault();
        setState(CLOSED_LINK_MENU_STATE);
        return true;
      },
      handleDOMEvents: {
        click(view, event) {
          if (isViewEditable(view)) return false;
          return activateReadOnlyLink(event);
        },
        auxclick(view, event) {
          if (isViewEditable(view) || event.button !== 1) return false;
          return activateReadOnlyLink(event);
        },
        keydown(view, event) {
          if (isViewEditable(view)) return false;
          if (event.key !== "Enter") return false;
          return activateReadOnlyLink(event);
        },
      },
    },
  });
}

// ── popover UI ───────────────────────────────────────────────────────────

export function LinkMenu({
  editor,
  state,
  onDismiss,
}: {
  editor: Editor | null;
  state: LinkMenuState;
  onDismiss: () => void;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const key = state.open ? `${state.from}:${state.to}:${state.url}` : "closed";

  useEffect(() => {
    if (!state.open) return;
    setValue(state.url);
    setInvalid(false);
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!state.open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    }
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      onDismiss();
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [state.open, onDismiss]);

  if (!state.open || !editor || !isEditableEditor(editor)) return null;
  const openState = state;

  function confirm() {
    if (!editor) return;
    if (!applyLinkMenu(editor, openState, value)) {
      setInvalid(true);
      return;
    }
    onDismiss();
  }

  function remove() {
    if (!editor) return;
    removeLinkMenu(editor, openState);
    onDismiss();
  }

  const normalizedPreview = normalizeLinkUrl(value);

  return (
    <div
      ref={containerRef}
      className="dohc-link-menu"
      data-placement={state.placement}
      style={{ left: state.x, top: state.y }}
      onMouseDown={(event) => {
        // Let the input itself receive focus/caret; only block the editor
        // from stealing selection when clicking the surrounding chrome.
        if (event.target !== inputRef.current) event.preventDefault();
      }}
    >
      <div className="dohc-link-menu__row">
        <input
          ref={inputRef}
          type="text"
          inputMode="url"
          className="dohc-link-menu__input"
          placeholder="Paste or type a URL"
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirm();
            }
          }}
        />
        <button
          type="button"
          className="dohc-link-menu__button"
          aria-label="Open link"
          title="Open"
          disabled={!normalizedPreview}
          onClick={() => void openLinkExternally(value)}
        >
          <ExternalLink size={13} aria-hidden />
        </button>
        {openState.hasLink ? (
          <button
            type="button"
            className="dohc-link-menu__button dohc-link-menu__button--danger"
            aria-label="Remove link"
            title="Remove link"
            onClick={remove}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        ) : null}
      </div>
      {invalid ? (
        <div className="dohc-link-menu__error">
          Enter a valid http(s) or mailto link.
        </div>
      ) : null}
    </div>
  );
}

/** Small, self-contained bubble-menu button (matches the styling of
 *  MarkdownEditor's inline BubbleButton helper without needing that helper
 *  exported) — active whenever the selection sits inside a link. */
export function LinkBubbleButton({
  editor,
  onOpen,
}: {
  editor: Editor;
  onOpen: (state: LinkMenuState) => void;
}) {
  return (
    <button
      type="button"
      aria-label="Link"
      title="Link (Cmd+K)"
      className={`dohc-bubble-menu__button${editor.isActive("link") ? " is-active" : ""}`}
      onClick={() => onOpen(computeLinkMenuState(editor.view))}
    >
      <LinkIcon size={14} aria-hidden />
    </button>
  );
}

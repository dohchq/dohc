import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { IconButton } from "./ui/controls";
import { bridge } from "./bridge";

// The document header's "…" menu (ViewHeader): copy the raw markdown, or
// export a self-contained HTML/PDF file. Styled and keyboard-driven like
// TurnIntoMenu (editor/blockControls.tsx) — same trigger/list shape, own
// class names since this lives in the header chrome, not the bubble menu.
type DocumentMenuItemId = "copy-markdown" | "export-html" | "export-pdf";

const ITEMS: ReadonlyArray<{ id: DocumentMenuItemId; label: string }> = [
  { id: "copy-markdown", label: "Copy as Markdown" },
  { id: "export-html", label: "Export as HTML…" },
  { id: "export-pdf", label: "Export as PDF…" },
];

// How long a quiet inline confirmation ("Copied") replaces an item's label —
// mirrors the code-block copy button's "copy" → "copied" swap
// (editor/codeBlockChrome.tsx).
const FEEDBACK_MS = 1200;

export function DocumentMenu(props: {
  workspaceId: string;
  // Filename stem (no extension) — becomes the export dialog's suggested
  // name and, absent a `title` frontmatter key, the document's title.
  suggestedName: string;
  // Called fresh on every action: always the CURRENT document markdown
  // (frontmatter included), matching the code editor's own save path.
  getMarkdown: () => string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [feedback, setFeedback] = useState<
    Partial<Record<DocumentMenuItemId, string>>
  >({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(0);
    menuRef.current?.focus();
    // On every close path (Escape, outside pointer-down, post-feedback
    // auto-close) the menu div unmounts and focus would fall to document.body,
    // breaking the WAI-ARIA menu-button contract. Return focus to the trigger
    // when the menu closes — mirrors PageIdentity's emoji picker (phase 2).
    return () => {
      triggerRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown, true);
    return () => window.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  function showFeedback(id: DocumentMenuItemId, text: string) {
    setFeedback((current) => ({ ...current, [id]: text }));
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => {
      setFeedback((current) => ({ ...current, [id]: undefined }));
      setOpen(false);
    }, FEEDBACK_MS);
  }

  async function copyAsMarkdown() {
    const write = navigator.clipboard?.writeText(props.getMarkdown());
    if (!write) return;
    try {
      await write;
      showFeedback("copy-markdown", "Copied");
    } catch {
      showFeedback("copy-markdown", "Couldn't copy");
    }
  }

  async function exportDocument(kind: "html" | "pdf") {
    setOpen(false);
    try {
      // Imported on demand, not at module load: documentExport statically
      // pulls in the Tiptap MarkdownManager/schema stack and KaTeX, which the
      // lazy MarkdownEditor split otherwise keeps out of the initial/open
      // path. A user who never exports never pays for it.
      const { buildStandaloneDocumentHtml } = await import(
        "./editor/documentExport"
      );
      const html = buildStandaloneDocumentHtml(
        props.getMarkdown(),
        props.suggestedName,
      );
      await bridge().exportDocumentFile({
        workspaceId: props.workspaceId,
        suggestedName: props.suggestedName,
        content: html,
        kind,
      });
    } catch (error) {
      // The save dialog's own cancel path never throws — a rejection here is
      // a real (uncommon) failure. No toast infra for this: a console trace
      // is enough to debug, and the menu is already closed.
      console.error(`Export as ${kind.toUpperCase()} failed`, error);
    }
  }

  function runItem(id: DocumentMenuItemId) {
    if (id === "copy-markdown") {
      void copyAsMarkdown();
      return;
    }
    void exportDocument(id === "export-pdf" ? "pdf" : "html");
  }

  const move = (delta: number) =>
    setSelected((current) => (current + delta + ITEMS.length) % ITEMS.length);

  return (
    <div className="dohc-document-menu" ref={containerRef}>
      <IconButton
        ref={triggerRef}
        data-testid="document-menu-trigger"
        aria-label="Document actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Document actions"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={14} aria-hidden />
      </IconButton>
      {open ? (
        <div
          ref={menuRef}
          className="dohc-document-menu-list"
          role="menu"
          aria-label="Document actions"
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = ITEMS[selected];
              if (item) runItem(item.id);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          {ITEMS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-testid={`document-menu-item-${item.id}`}
              aria-selected={index === selected}
              className={`dohc-document-menu-item${index === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => runItem(item.id)}
            >
              {feedback[item.id] ?? item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { IconButton } from "./ui/controls";
import { bridge } from "./bridge";

// The document header's "…" menu (ViewHeader): copy the raw markdown, export
// it as a .md file, or export a self-contained HTML/PDF render. Styled and
// keyboard-driven like TurnIntoMenu (editor/blockControls.tsx) — same
// trigger/list shape, own class names since this lives in the header chrome,
// not the bubble menu.
type DocumentMenuItemId =
  | "copy-markdown"
  | "export-markdown"
  | "export-html"
  | "export-pdf";

const ITEMS: ReadonlyArray<{ id: DocumentMenuItemId; label: string }> = [
  { id: "copy-markdown", label: "Copy as Markdown" },
  { id: "export-markdown", label: "Export as Markdown…" },
  { id: "export-html", label: "Export as HTML…" },
  { id: "export-pdf", label: "Export as PDF…" },
];

// How long a quiet inline confirmation ("Copied") replaces an item's label —
// mirrors the code-block copy button's "copy" → "copied" swap
// (editor/codeBlockChrome.tsx).
export const FEEDBACK_MS = 1200;

// What every action says when the document has no serializer: the editor is
// not showing this document, so there is nothing honest to copy or export.
// It states the fact and NOT the cause, because this menu cannot tell an
// editor that is still opening from one that failed to — and copy.md says to
// give a reason only when we know it. "document" is the noun this surface
// already uses (the menu is "Document actions"), and the per-action next step
// is stated below the items.
const REFUSAL_LABEL = "Document not open";

export function DocumentMenu(props: {
  workspaceId: string;
  // Filename stem (no extension) — becomes the export dialog's suggested
  // name and, absent a `title` frontmatter key, the document's title.
  suggestedName: string;
  // Called fresh on every action: always the CURRENT document markdown
  // (frontmatter included), matching the code editor's own save path.
  //
  // NULL when the document cannot be serialized yet — an engine-backed
  // document whose editor has not mounted (or failed to). Every action here
  // REFUSES on null rather than falling back to a stale or empty body: a
  // copy or an export that silently produces nothing is a file the user
  // believes is their document (#564).
  getMarkdown: () => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  // The transient half: an item's label swaps for 1.2s to say what happened.
  const [feedback, setFeedback] = useState<
    Partial<Record<DocumentMenuItemId, string>>
  >({});
  // The lasting half. A refusal owes the user a next step
  // (the dohc-interface skill), and a label that swaps for 1.2s has no room for one
  // and no time to be read. It is stated in the menu's status line, which
  // every user reaches — a tooltip is not one, because focus stays on the
  // menu container and never presents it (#666). It stands until the user
  // closes the menu or another action supersedes it, never on a timer.
  const [instruction, setInstruction] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every attempt gets a number, and only the newest one may speak. A
  // clipboard write settles after the click that started it, so its outcome
  // can land on a menu that has moved on — over a refusal the user is still
  // reading, on a menu that closed, or on the next one they open.
  const attempts = useRef(0);

  useEffect(() => {
    if (!open) return;
    setSelected(0);
    // A freshly opened menu says nothing about the last one.
    setFeedback({});
    setInstruction("");
    menuRef.current?.focus();
    // Closing ends every attempt this menu started. The token moves past
    // them, so a clipboard write settling afterwards cannot speak into a menu
    // that is gone or one the user has since reopened, and the timer it would
    // arm never exists. Nothing can arm one while the menu is closed either,
    // which is why this is the only cleanup the timer needs — including at
    // unmount, where this cleanup also runs.
    //
    // Focus goes back to the trigger on every close path (Escape, outside
    // pointer-down, post-feedback auto-close): the menu div unmounts and
    // focus would fall to document.body, breaking the WAI-ARIA menu-button
    // contract. Mirrors PageIdentity's emoji picker (phase 2).
    return () => {
      attempts.current += 1;
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
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

  // ONE timer, so one label. Merging into the previous feedback stranded it:
  // the replacement timer only ever clears the newest item, so a second
  // refusal inside the window left the first item showing its refusal with
  // nothing left to retire it.
  //
  // A next step is what tells the two outcomes apart. A confirmation is over
  // once it is read, so the timer retires the label and closes the menu. A
  // refusal is not: closing takes its instruction off the screen, which is
  // how the tooltip failed keyboard users in the first place. So the timer
  // retires the label and the menu stays, until the user closes it.
  function showFeedback(
    id: DocumentMenuItemId,
    label: string,
    nextStep?: string,
  ) {
    setFeedback({ [id]: label });
    setInstruction(nextStep ?? "");
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => {
      setFeedback({});
      if (nextStep === undefined) setOpen(false);
    }, FEEDBACK_MS);
  }

  // NULL is the refusal this menu expects and handles. A THROW is not: the
  // serializer reads a live editor, and reading it can fail. Called outside a
  // boundary it rejected the action's promise into nothing — no feedback, no
  // log, and the menu still open as though the click had missed (#564,
  // codex r23). Both actions serialize through here, so both answer a throw
  // the way they answer any other failure.
  function serializeOrFail(
    id: DocumentMenuItemId,
    failureLabel: string,
    what: string,
  ): { markdown: string | null } | null {
    try {
      return { markdown: props.getMarkdown() };
    } catch (error) {
      console.error(`${what} failed`, error);
      showFeedback(id, failureLabel);
      return null;
    }
  }

  async function copyAsMarkdown(attempt: number) {
    const serialized = serializeOrFail(
      "copy-markdown",
      "Couldn't copy",
      "Copy as Markdown",
    );
    if (!serialized) return;
    const markdown = serialized.markdown;
    if (markdown === null) {
      showFeedback(
        "copy-markdown",
        REFUSAL_LABEL,
        "You can copy this document when it opens.",
      );
      return;
    }
    const write = navigator.clipboard?.writeText(markdown);
    if (!write) return;
    let label = "Copied";
    try {
      await write;
    } catch {
      label = "Couldn't copy";
    }
    // A later attempt already answered. Its answer is what the menu shows,
    // and this one describes a click the user has moved past.
    if (attempt !== attempts.current) return;
    showFeedback("copy-markdown", label);
  }

  async function exportDocument(kind: "markdown" | "html" | "pdf") {
    const serialized = serializeOrFail(
      `export-${kind}`,
      "Couldn't export",
      `Export as ${kind.toUpperCase()}`,
    );
    if (!serialized) return;
    const documentMarkdown = serialized.markdown;
    if (documentMarkdown === null) {
      // BEFORE closing: the feedback replaces the item's label, so a refusal
      // shown into a closed menu is a refusal the user never sees — the
      // export would just appear to do nothing.
      showFeedback(
        `export-${kind}`,
        REFUSAL_LABEL,
        "You can export this document when it opens.",
      );
      return;
    }
    setOpen(false);
    try {
      let content: string;
      if (kind === "markdown") {
        // The text-first export: the raw document source, written verbatim
        // to a .md file. A brand-new empty document still exports one
        // newline — the IPC contract requires non-empty content.
        content = documentMarkdown.length > 0 ? documentMarkdown : "\n";
      } else {
        // Imported on demand, not at module load: documentExport statically
        // pulls in the Tiptap MarkdownManager/schema stack and KaTeX, which
        // the lazy MarkdownEditor split otherwise keeps out of the
        // initial/open path. A user who never exports never pays for it.
        const { buildStandaloneDocumentHtml } = await import(
          "./editor/documentExport"
        );
        content = buildStandaloneDocumentHtml(
          documentMarkdown,
          props.suggestedName,
        );
      }
      await bridge().exportDocumentFile({
        workspaceId: props.workspaceId,
        suggestedName: props.suggestedName,
        content,
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
    const attempt = ++attempts.current;
    // The token says who may speak next. This says the last one has stopped —
    // a new action retires its predecessor's answer when it STARTS, not when
    // it finishes. Its own result can be a while away (a clipboard write can
    // sit behind an OS permission prompt), and until then the menu would
    // state a refusal the user is already retrying, under a timer that closes
    // the menu on behalf of an attempt that is over.
    setFeedback({});
    setInstruction("");
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    if (id === "copy-markdown") {
      void copyAsMarkdown(attempt);
      return;
    }
    // The export path needs no token: it decides everything it says before
    // its first await, and closes the menu before the bridge call.
    void exportDocument(
      id === "export-pdf" ? "pdf" : id === "export-html" ? "html" : "markdown",
    );
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
          {/* The refusal's next step, stated where every user reads it, for as
              long as the menu is open. It mounts with the menu and stays empty
              until there is something to say, so a screen reader is already
              watching the region when the instruction arrives — a region that
              appears with its text is announced unreliably. Empty, it paints
              nothing. */}
          <div
            data-testid="document-menu-status"
            className="dohc-document-menu-status"
            role="status"
          >
            {instruction}
          </div>
        </div>
      ) : null}
    </div>
  );
}

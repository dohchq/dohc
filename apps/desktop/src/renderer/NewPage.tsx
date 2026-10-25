import { useCallback, useRef, useState, type ReactNode } from "react";
import { displayFrontmatterValue, parseFrontmatter } from "./markdown/frontmatter";
import type { PageEditor } from "./MarkdownView";
import { PageIdentity } from "./PageIdentity";
import { PROPERTIES_LINE, PROPERTIES_PANEL } from "./pageTopmatter";

export type NewPageFile = (onEditorReady: ((editor: PageEditor | null) => void) | undefined) => ReactNode;

// A page whose file does not exist yet. It opens at once with the cursor in
// its title, drawn as the empty document it will be, and nothing is written
// until the person leaves the title. The shell then creates the file and
// renders it here, hidden and inert, while what is typed waits in the body.
// When the file's editor is ready, the page gives it the title, the icon and
// the body, caret included, and steps aside, all in one task, so no
// keystroke lands between them. A file that opens with no editor, read-only
// or unreadable, shows itself at once.
export function NewPage(props: {
  // The title and icon so far, as frontmatter.
  draft: string;
  onDraftChange: (draft: string) => void;
  // Enter or Tab from the title, or a click into the body.
  onLeaveTitle: () => void;
  // The page's file, once it exists.
  file: NewPageFile | null;
  // An earlier mount of this page already handed its body over.
  handedOff: boolean;
  onHandedOff: () => void;
}) {
  const [draft, setDraft] = useState(props.draft);
  const draftRef = useRef(draft);
  const [handedOff, setHandedOff] = useState(props.handedOff);
  const handedOffRef = useRef(handedOff);
  const onHandedOffRef = useRef(props.onHandedOff);
  onHandedOffRef.current = props.onHandedOff;
  const pageRef = useRef<HTMLDivElement | null>(null);
  const identityRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLDivElement | null>(null);
  // An input method's text reaches the body only when its composition ends,
  // so an editor ready mid-composition waits for it.
  const composing = useRef(false);
  const waitingEditor = useRef<PageEditor | null>(null);

  const handOff = useCallback((page: PageEditor | null) => {
    if (handedOffRef.current) return;
    if (page && composing.current) {
      waitingEditor.current = page;
      return;
    }
    handedOffRef.current = true;
    // Focus cannot enter an inert subtree, and React clears it only when it
    // renders again.
    if (fileRef.current) fileRef.current.inert = false;
    if (page) {
      const { meta } = parseFrontmatter(draftRef.current);
      page.setIdentity({ title: displayFrontmatterValue(meta.title), icon: displayFrontmatterValue(meta.icon) });
      const body = bodyRef.current;
      const text = body?.value ?? "";
      const focused = pageRef.current?.contains(document.activeElement) ?? false;
      page.editor.insertTypedText(text, body?.selectionEnd ?? text.length);
      if (focused) page.editor.focus(text ? undefined : "start");
    }
    setHandedOff(true);
    onHandedOffRef.current();
  }, []);

  const focusBodyEnd = () => {
    const body = bodyRef.current;
    body?.focus();
    body?.setSelectionRange(body.value.length, body.value.length);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={fileRef}
        inert={!handedOff || undefined}
        aria-hidden={!handedOff || undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {props.file?.(handedOff ? undefined : handOff)}
      </div>
      {handedOff ? null : (
        // The document pane's own frame (MarkdownView), so nothing moves when
        // the editor takes over. A press anywhere below the title leaves it,
        // as Enter does.
        <div
          ref={pageRef}
          data-testid="new-page"
          className="absolute inset-0 overflow-auto bg-bg text-[length:var(--dohc-editor-font-size)] [scrollbar-gutter:stable]"
          onPointerDown={(event) => {
            if (event.button !== 0 || event.target === bodyRef.current || identityRef.current?.contains(event.target as Node)) return;
            event.preventDefault();
            focusBodyEnd();
          }}
        >
          <div className="group/topmatter">
            <div ref={identityRef} className="contents">
              <PageIdentity
                body={draft}
                onChange={(next) => {
                  draftRef.current = next;
                  setDraft(next);
                  props.onDraftChange(next);
                }}
                filenameStem="Untitled"
                autoFocus
                onEnterBody={() => bodyRef.current?.focus()}
              />
            </div>
            <div className={PROPERTIES_PANEL}>
              <div className={PROPERTIES_LINE} />
            </div>
          </div>
          <div className="dohc-notion-editor">
            <textarea
              ref={bodyRef}
              aria-label="Page body"
              rows={1}
              placeholder="Type '/' for commands"
              onFocus={props.onLeaveTitle}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
                const waiting = waitingEditor.current;
                waitingEditor.current = null;
                if (waiting) handOff(waiting);
              }}
              className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 field-sizing-content [font:inherit] tracking-[inherit] text-ink outline-none placeholder:text-transparent focus:shadow-none! focus:placeholder:text-subtle"
            />
          </div>
        </div>
      )}
    </div>
  );
}

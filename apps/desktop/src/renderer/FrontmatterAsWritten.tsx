import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { leadingFrontmatter, loadMarkdownFrontmatter } from "@dohc/ydoc-projection/frontmatter";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { bridge } from "./bridge";
import { displayFrontmatterValue } from "./markdown/frontmatter";

// A leading block's text, found cheaply so the block parses again only when
// it changes. The projection still decides whether it is frontmatter.
const LEADING_BLOCK = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;
// Keys the properties hide; PageIdentity shows `title` and `icon`.
const HIDDEN_KEYS = new Set(["id", "title", "icon"]);

/**
 * A live document's file text, read from disk and never from the document,
 * whose edits reach the file only when the engine saves. It starts from the
 * inspector's read and takes each later one. It reads the file again when
 * workspace activity names the file, when the engine reports the file
 * changed on disk, and when it reports every edit saved here after the
 * document's frontmatter changed. A save to the host or a pending or failed
 * save keeps the text read last.
 */
export function useFileText(input: {
  workspaceId: string;
  path: string;
  body: string;
  ydoc: Y.Doc | null;
  saveState: SaveState;
}): string {
  const { workspaceId, path, body, ydoc } = input;
  const key = `${workspaceId}\n${path}`;
  const [read, setRead] = useState({ key, body, text: body });
  let current = read;
  if (read.key !== key || read.body !== body) {
    current = { key, body, text: body };
    setRead(current);
  }

  // Frontmatter edits counted against the last read that covered them. A
  // body edit cannot change the block, so its save needs no read. A read that
  // fails or is dropped leaves its edits owed.
  const edits = useRef({ made: 1, read: 0 });
  useEffect(() => {
    if (!ydoc) return;
    edits.current.made += 1;
    const mark = () => {
      edits.current.made += 1;
    };
    const maps = [ydoc.getMap("frontmatter"), ydoc.getMap("meta")];
    for (const map of maps) map.observeDeep(mark);
    return () => {
      for (const map of maps) map.unobserveDeep(mark);
    };
  }, [ydoc]);

  // One order for both readers: a newer inspector read, or another document,
  // drops every read still pending, and only the newest read lands.
  const latest = useRef(0);
  useLayoutEffect(() => {
    latest.current += 1;
  }, [key, body, ydoc]);
  const readFile = useCallback(() => {
    const id = ++latest.current;
    const covers = edits.current.made;
    void Promise.resolve()
      .then(() => bridge().readWorkspaceText({ workspaceId, relativePath: path }))
      .then(
        (result) => {
          if (latest.current !== id) return;
          edits.current.read = Math.max(edits.current.read, covers);
          setRead((last) => (last.key === key ? { ...last, text: result.text } : last));
        },
        // The text read last stays. The inspector reports a file it cannot read.
        () => undefined,
      );
  }, [key, workspaceId, path]);

  const kind = input.saveState.kind;
  useEffect(() => {
    if (!ydoc) return;
    if (kind === "changed-on-disk" || (kind === "saved-here" && edits.current.made > edits.current.read)) readFile();
  }, [readFile, kind, ydoc]);

  // A write from outside dohc reaches an open document's file without a save.
  useEffect(() => {
    if (!ydoc) return;
    return bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId !== undefined && event.workspaceId !== workspaceId) return;
      if (event.paths === undefined || event.paths.includes(path)) readFile();
    });
  }, [readFile, workspaceId, path, ydoc]);
  return current.text;
}

// The document's frontmatter exactly as the file holds it, never rendered as
// Markdown. The body leaves the block out, and an agent reading the file
// receives all of it, so a person sees all of it here. It opens when the
// properties do not show every line as written: a comment, an anchor, a hidden
// key, a block that does not read, or anything else. `markdown` is file text:
// a live document passes `useFileText`.
export function FrontmatterAsWritten(props: { markdown: string; propertiesShown: boolean }) {
  const leading = LEADING_BLOCK.exec(props.markdown)?.[0] ?? "";
  const block = useMemo(() => (leading ? (leadingFrontmatter(leading)?.text ?? "") : ""), [leading]);
  const text = block.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const open = useMemo(() => !props.propertiesShown || !everyLineShown(text), [props.propertiesShown, text]);
  if (!text) return null;

  return (
    <section data-testid="frontmatter-as-written" className="dohc-page-properties" aria-label="As written in the file">
      <div className="dohc-page-properties__inner">
        <details open={open} className="group">
          <summary className="flex h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted transition-colors duration-75 hover:text-ink">
            <ChevronRight size={13} aria-hidden className="transition-transform duration-150 group-open:rotate-90" />
            As written in the file
          </summary>
          <pre className="m-0 mb-1 overflow-x-auto rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] leading-5 text-ink">
            {text}
          </pre>
        </details>
      </div>
    </section>
  );
}

/** Whether the properties and page title show every line of the block as written. */
function everyLineShown(text: string): boolean {
  const meta = loadMarkdownFrontmatter(`${text}\n`)?.meta;
  if (!meta) return false;
  return text.split("\n").every((line) => {
    if (line === "" || line === "---") return true;
    const match = /^([^\s:#][^:]*?):(?: (.*))?$/.exec(line);
    const key = match?.[1];
    if (!match || key === undefined || !Object.hasOwn(meta, key)) return false;
    if (HIDDEN_KEYS.has(key.trim().toLowerCase()) && key !== "title" && key !== "icon") return false;
    const value = meta[key];
    if (value === null) return match[2] === undefined;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return false;
    return match[2] === displayFrontmatterValue(value);
  });
}

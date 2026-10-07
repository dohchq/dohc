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

/** The file's leading frontmatter block, or "" when it has none. */
function blockOf(markdown: string): string {
  const leading = LEADING_BLOCK.exec(markdown)?.[0] ?? "";
  const block = leading ? (leadingFrontmatter(leading)?.text ?? "") : "";
  return block.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/** The section opens when the properties do not show every line as written. */
function opensByDefault(text: string, propertiesShown: boolean): boolean {
  return !propertiesShown || !everyLineShown(text);
}

/**
 * A live document's file text, read from disk and never from the document,
 * whose edits reach the file only when the engine saves. The section is the
 * only reader: the inspector's read is the first text, and after that only
 * the section's own reads of this document change it. While `open`, it
 * reads the file again when workspace activity names the file, when the
 * engine reports the file changed on disk, and when it reports every edit
 * saved here after the document's frontmatter changed. Activity reads
 * nothing while the text has no block; a later inspector read with a block
 * asks for one read instead. Closed, it reads nothing, and any reason to
 * read hides its text. Opening hides the text until a read started after
 * opening succeeds. A save to the host or a pending or failed save keeps the text
 * read last.
 */
function useFileText(input: {
  workspaceId: string;
  path: string;
  body: string;
  ydoc: Y.Doc;
  saveState: SaveState;
  open: boolean;
}): { text: string; stale: boolean } {
  const { workspaceId, path, ydoc, open } = input;
  const [file, setFile] = useState({ text: input.body, stale: false });

  // Frontmatter edits counted against the last read that covered them. A
  // body edit cannot change the block, so its save needs no read. A read that
  // fails or is dropped leaves its edits owed.
  const edits = useRef({ made: 1, read: 0 });
  useEffect(() => {
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

  // `present`: the text read last has a block, so the section shows.
  const present = blockOf(file.text) !== "";
  const live = useRef({ open, mounted: true, present });
  useLayoutEffect(() => {
    live.current.open = open;
    live.current.present = present;
  }, [open, present]);
  useEffect(() => {
    live.current.mounted = true;
    return () => {
      live.current.mounted = false;
    };
  }, []);

  // At most one read in flight and one owed, and only the newest read
  // lands. Requests made before a read reaches the file share it. A request
  // while it is out owes one more, which starts when the read settles.
  const latest = useRef(0);
  const flight = useRef<"idle" | "queued" | "reading">("idle");
  const owed = useRef(false);
  const start = useCallback(() => {
    flight.current = "queued";
    const id = ++latest.current;
    void Promise.resolve()
      .then(() => {
        flight.current = "reading";
        const covers = edits.current.made;
        return bridge()
          .readWorkspaceText({ workspaceId, relativePath: path })
          .then((result) => ({ result, covers }));
      })
      .then(
        ({ result, covers }) => {
          if (latest.current !== id) return;
          edits.current.read = Math.max(edits.current.read, covers);
          setFile({ text: result.text, stale: false });
        },
        // The text read last stays, or stays hidden while stale. The
        // inspector reports a file it cannot read.
        () => undefined,
      )
      .finally(() => {
        flight.current = "idle";
        if (!owed.current) return;
        owed.current = false;
        if (live.current.mounted && live.current.open) start();
      });
  }, [workspaceId, path]);
  // Closed, a reason to read instead marks the text stale, so the DOM never
  // holds text the file may no longer hold.
  const readFile = useCallback(() => {
    if (!live.current.open) {
      setFile((last) => (last.stale ? last : { ...last, stale: true }));
      return;
    }
    if (flight.current === "queued") return;
    if (flight.current === "reading") owed.current = true;
    else start();
  }, [start]);

  // Opening shows only the file as it is now: text read earlier is hidden,
  // and a read already out is dropped for a fresh one.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      latest.current += 1;
      setFile((last) => ({ ...last, stale: true }));
      if (flight.current === "idle") start();
      else owed.current = true;
    }
    wasOpen.current = open;
  }, [open, start]);

  const kind = input.saveState.kind;
  useEffect(() => {
    if (kind === "changed-on-disk" || (kind === "saved-here" && edits.current.made > edits.current.read)) readFile();
  }, [readFile, kind]);

  // A write from outside dohc reaches an open document's file without a save.
  // A file with no block shows nothing, so its saves read nothing.
  useEffect(
    () =>
      bridge().onWorkspaceActivity((event) => {
        if (!live.current.present) return;
        if (event.workspaceId !== undefined && event.workspaceId !== workspaceId) return;
        if (event.paths === undefined || event.paths.includes(path)) readFile();
      }),
    [readFile, workspaceId, path],
  );

  // The inspector's later reads give no text, but each says the file
  // changed. Closed, that marks the text stale. Open, a read that finds a
  // block the section lacks makes the section read the file itself.
  const inspected = useRef(input.body);
  useEffect(() => {
    if (inspected.current === input.body) return;
    inspected.current = input.body;
    if (!live.current.open || (blockOf(input.body) !== "" && !live.current.present)) readFile();
  }, [input.body, readFile]);
  return file;
}

/**
 * The section for a live document, whose file changes only when the engine
 * saves. `body` is the inspector's read of the file: the section's first
 * text, and what decides whether it starts open, so a closed section costs
 * no read. Each document gets its own reads, so nothing read for one settles
 * or clears another.
 */
export function LiveFrontmatterAsWritten(props: {
  workspaceId: string;
  path: string;
  body: string;
  ydoc: Y.Doc;
  saveState: SaveState;
  propertiesShown: boolean;
}) {
  return <LiveSection key={`${props.workspaceId}\n${props.path}`} {...props} />;
}

function LiveSection(props: {
  workspaceId: string;
  path: string;
  body: string;
  ydoc: Y.Doc;
  saveState: SaveState;
  propertiesShown: boolean;
}) {
  // Whether it starts open is read once, from the inspector's first read.
  const [opens] = useState(() => opensByDefault(blockOf(props.body), props.propertiesShown));
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? opens;
  const file = useFileText({ ...props, open });
  return (
    <FrontmatterAsWritten
      markdown={file.text}
      propertiesShown={props.propertiesShown}
      open={open}
      stale={file.stale}
      onToggle={setToggled}
    />
  );
}

// The document's frontmatter exactly as the file holds it, never rendered as
// Markdown. The body leaves the block out, and an agent reading the file
// receives all of it, so a person sees all of it here. It opens when the
// properties do not show every line as written: a comment, an anchor, a hidden
// key, a block that does not read, or anything else. `markdown` is file text.
// A live document passes `open`, `stale` and `onToggle` from
// LiveFrontmatterAsWritten. Stale text is not shown.
export function FrontmatterAsWritten(props: {
  markdown: string;
  propertiesShown: boolean;
  open?: boolean;
  stale?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  const text = useMemo(() => blockOf(props.markdown), [props.markdown]);
  const opens = useMemo(() => opensByDefault(text, props.propertiesShown), [props.propertiesShown, text]);
  const open = props.open ?? opens;
  const onToggle = props.onToggle;
  if (!text) return null;

  return (
    <section data-testid="frontmatter-as-written" className="dohc-page-properties" aria-label="As written in the file">
      <div className="dohc-page-properties__inner">
        <details
          open={open}
          className="group"
          onToggle={
            onToggle
              ? (event) => {
                  if (event.currentTarget.open !== open) onToggle(event.currentTarget.open);
                }
              : undefined
          }
        >
          <summary className="flex h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted transition-colors duration-75 hover:text-ink">
            <ChevronRight size={13} aria-hidden className="transition-transform duration-150 group-open:rotate-90" />
            As written in the file
          </summary>
          {props.stale ? null : (
            <pre className="m-0 mb-1 overflow-x-auto rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] leading-5 text-ink">
              {text}
            </pre>
          )}
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

import { frontmatterAsWritten } from "@dohc/ydoc-projection/frontmatter";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { displayFrontmatterValue, parseFrontmatter } from "./markdown/frontmatter";

// A leading block's text, found cheaply so the block parses again only when
// it changes. The loader still decides whether it is frontmatter.
const LEADING_BLOCK = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;
// Keys the properties hide; PageIdentity shows `title` and `icon`.
const HIDDEN_KEYS = new Set(["id", "title", "icon"]);

// The document's frontmatter exactly as the file holds it. The body leaves the
// block out, and an agent reading the file receives all of it, so a person
// sees all of it here. It opens when the properties do not show every line as
// written: a comment, an anchor, a hidden key, or anything else.
export function FrontmatterAsWritten(
  props: ({ markdown: string; ydoc?: never } | { ydoc: Y.Doc; markdown?: never }) & {
    propertiesShown: boolean;
  },
) {
  const ydoc = props.ydoc ?? null;
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!ydoc) return;
    const update = () => setRevision((value) => value + 1);
    const maps = [ydoc.getMap("frontmatter"), ydoc.getMap("meta")];
    for (const map of maps) map.observe(update);
    return () => {
      for (const map of maps) map.unobserve(update);
    };
  }, [ydoc]);

  const leading = ydoc ? null : (LEADING_BLOCK.exec(props.markdown ?? "")?.[0] ?? "");
  const block = useMemo(() => {
    if (ydoc) return frontmatterAsWritten(ydoc);
    if (!leading) return "";
    return parseFrontmatter(leading).body === leading ? "" : leading;
    // revision re-reads the observed maps after a shared write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leading, ydoc, revision]);
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
  const { meta } = parseFrontmatter(`${text}\n`);
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

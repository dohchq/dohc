import { useLayoutEffect, useRef, useState } from "react";

// A path on one line: its first folder, the folders after it, and its name.
// Too long for the line, the folders after the first give way first, cut
// from their start behind an "…" that always stays. Then the name gives way,
// cut at its end. The first folder never shrinks. The caller puts the full
// path in a tooltip.

export type PathParts = { first: string; middle: string; name: string };

// Splits a path as the OS spells it: a Windows path starts with a drive or
// "\\" and uses "\"; any other path uses "/". The three parts join back into
// the path.
export function splitPath(path: string): PathParts {
  const separator = /^([A-Za-z]:\\|\\\\)/.test(path) ? "\\" : "/";
  const nameStart = path.lastIndexOf(separator) + 1;
  // The first folder runs through the separator after its own name: "C:\",
  // "\\server\", "/home/". Without one, or past the name, it is all before the name.
  const afterFirst = path.indexOf(separator, path.search(separator === "\\" ? /[^\\]/ : /[^/]/)) + 1;
  const firstEnd = afterFirst === 0 ? nameStart : Math.min(afterFirst, nameStart);
  return { first: path.slice(0, firstEnd), middle: path.slice(firstEnd, nameStart), name: path.slice(nameStart) };
}

export function PathLine(props: { path: string; className?: string }) {
  const { first, middle, name } = splitPath(props.path);
  const line = useRef<HTMLSpanElement>(null);
  const firstPart = useRef<HTMLSpanElement>(null);
  const dots = useRef<HTMLSpanElement>(null);
  const folders = useRef<HTMLElement>(null);
  const namePart = useRef<HTMLSpanElement>(null);
  // The width of the whole characters the middle keeps from its end, or null
  // while it all fits. A CSS ellipsis would leave the leftover space between
  // the first folder and "…".
  const [kept, setKept] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = line.current;
    const firstElement = firstPart.current;
    const text = folders.current?.firstChild;
    if (!element || !firstElement || !text || typeof ResizeObserver === "undefined") return;
    const range = document.createRange();
    const widthFrom = (start: number) => {
      range.setStart(text, start);
      range.setEnd(text, middle.length);
      return range.getBoundingClientRect().width;
    };
    const measure = () => {
      const lineWidth = element.getBoundingClientRect().width;
      const nameElement = namePart.current;
      if (!lineWidth || !dots.current || !nameElement) return;
      // A cut name reports its whole width only as a rounded scrollWidth.
      const nameWidth = nameElement.scrollWidth > nameElement.clientWidth
        ? nameElement.scrollWidth + 1
        : nameElement.getBoundingClientRect().width;
      const room = lineWidth - firstElement.getBoundingClientRect().width - nameWidth;
      if (widthFrom(0) <= room) {
        setKept(null);
        return;
      }
      const roomAfterDots = room - dots.current.getBoundingClientRect().width;
      let start = 0;
      let end = middle.length;
      while (start < end) {
        const half = (start + end) >> 1;
        if (widthFrom(half) <= roomAfterDots) end = half;
        else start = half + 1;
      }
      setKept(widthFrom(start));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(firstElement);
    return () => observer.disconnect();
  }, [first, middle, name]);

  return (
    <span ref={line} className={`flex w-full min-w-0 whitespace-nowrap ${props.className ?? ""}`}>
      <span ref={firstPart} className="shrink-0">{first}</span>
      {middle ? (
        <>
          <span
            ref={dots}
            aria-hidden
            data-path-cut={kept === null ? undefined : ""}
            className={`before:content-['…'] ${kept === null ? "invisible absolute" : "shrink-0"}`}
          />
          {/* Laid out from the right, so a cut takes the start. */}
          <span dir="rtl" className="shrink-0 overflow-clip" style={kept === null ? undefined : { width: kept }}>
            <bdi ref={folders} dir="ltr">{middle}</bdi>
          </span>
        </>
      ) : null}
      <span ref={namePart} className="min-w-0 truncate">{name}</span>
    </span>
  );
}

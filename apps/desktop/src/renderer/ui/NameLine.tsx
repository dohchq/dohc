import { useLayoutEffect, useRef, useState } from "react";

let measure: OffscreenCanvasRenderingContext2D | null | undefined;

// The longest start of `head` that fits the element with an ellipsis after
// it, measured in the element's font.
function fitted(head: string, element: HTMLElement): string | null {
  measure ??= typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  if (!measure) return null;
  const style = getComputedStyle(element);
  measure.font = style.font;
  measure.letterSpacing = style.letterSpacing;
  const width = element.getBoundingClientRect().width;
  const chars = Array.from(head);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure.measureText(`${chars.slice(0, mid).join("")}…`).width <= width) low = mid;
    else high = mid - 1;
  }
  return `${chars.slice(0, low).join("")}…`;
}

// A name cut in its middle, so a short extension stays: "product-pl….md".
// Only the last part of a path has an extension: "v1.2/README" has none.
// The whole name keeps the layout; a cut one is drawn over it, so the
// ellipsis meets the extension with no gap.
export function NameLine(props: { name: string; title?: string; className?: string }) {
  const dot = props.name.lastIndexOf(".");
  const base = props.name.lastIndexOf("/") + 1;
  const cut = dot > base && props.name.length - dot <= 12 ? dot : props.name.length;
  const head = props.name.slice(0, cut);
  const extension = props.name.slice(cut);
  const headRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = headRef.current;
    if (!element || !extension || typeof ResizeObserver === "undefined") {
      setShown(null);
      return;
    }
    const fit = () => setShown(element.scrollWidth > element.clientWidth ? fitted(head, element) : null);
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) fit();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [head, extension]);
  const hidden = shown === null ? "" : " text-transparent";
  return (
    <span className={`relative flex min-w-0 ${props.className ?? ""}`} title={props.title}>
      <span ref={headRef} className={`truncate${hidden}`}>{head}</span>
      <span className={`shrink-0 whitespace-pre${hidden}`}>{extension}</span>
      {shown === null ? null : (
        <span aria-hidden className="absolute inset-0 overflow-hidden whitespace-pre">{shown}{extension}</span>
      )}
    </span>
  );
}

import { useLayoutEffect, useRef, type ReactNode } from "react";

// What a surface shows while its content loads. For the first 150ms it shows
// nothing, so a load that finishes in that time never flashes. After that,
// quiet lines appear where the content will be, and the content replaces them
// in the same box. The status keeps its name for a screen reader the whole
// time. Nothing moves: the lines fade in once (`dohc-reveal-if-slow` in
// styles.css), and reduced motion drops the fade but keeps the wait.
//
// `list` lines fill the box the caller gives them, such as a list in a
// dialog. `panel` lines fill a whole panel or tab, starting where its rows'
// text starts. `document` lines sit in the editor's reading column, where a
// file's text lands when it opens.
//
// The line widths repeat the drawing's four. Their fill is the ink-at-7% step,
// so the lines read on paper, on a panel and on an inset alike.
const WIDTHS = ["w-[80%]", "w-[62%]", "w-[90%]", "w-[54%]"] as const;

const LAYOUT = {
  list: "",
  panel: "min-h-0 flex-1 p-3",
  // The editor's 720px measure inside its 56px gutters (styles.css,
  // .dohc-notion-editor and .dohc-page-identity). The width is explicit:
  // auto margins alone would shrink the column to nothing in a flex parent.
  document: "mx-auto w-full max-w-[832px] px-14",
} as const;

type LinesProps = {
  rows?: number;
  layout?: keyof typeof LAYOUT;
  className?: string;
};

// The wait in styles.css (.dohc-reveal-if-slow).
const WAIT_MS = 150;

// When lines that were showing leave the page. A lazy view's fallback lines
// often give way to the view's own loading lines in the same commit; those
// show at once, so the lines never blink off and back on.
let shownLinesLeftAt = Number.NEGATIVE_INFINITY;
const HANDOFF_MS = 50;

function Frame(props: LinesProps & { children?: ReactNode; role?: "status"; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const mountedAt = performance.now();
    const handedOff = mountedAt - shownLinesLeftAt < HANDOFF_MS;
    if (element && handedOff) element.style.animation = "none";
    return () => {
      const now = performance.now();
      if (handedOff || now - mountedAt >= WAIT_MS) shownLinesLeftAt = now;
    };
  }, []);
  return (
    <div
      ref={ref}
      role={props.role}
      aria-hidden={props.role ? undefined : true}
      data-testid={props.testId}
      className={`dohc-reveal-if-slow flex flex-col gap-[9px] ${LAYOUT[props.layout ?? "list"]} ${props.className ?? ""}`}
    >
      {props.children}
      {Array.from({ length: props.rows ?? WIDTHS.length }, (_, row) => (
        <span key={row} aria-hidden className={`block h-2 shrink-0 rounded bg-hover ${WIDTHS[row % WIDTHS.length]}`} />
      ))}
    </div>
  );
}

export function SkeletonRows(props: LinesProps & {
  /** What a screen reader hears, such as "Loading history...". */
  label: string;
  testId?: string;
}) {
  return (
    <Frame {...props} role="status">
      <span className="sr-only">{props.label}</span>
    </Frame>
  );
}

/** The lines alone, for a surface whose own status line already says it is loading. */
export function SkeletonLines(props: LinesProps) {
  return <Frame {...props} />;
}

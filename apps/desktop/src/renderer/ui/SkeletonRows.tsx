import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
  // .dohc-notion-editor and .dohc-page-identity; pageTopmatter.ts). The width is explicit:
  // auto margins alone would shrink the column to nothing in a flex parent.
  // Put it in a pane that keeps its scrollbar's room, as document panes do,
  // or it centres 5px off a long document.
  document: "mx-auto w-full max-w-[832px] px-14",
} as const;

type LinesProps = {
  rows?: number;
  layout?: keyof typeof LAYOUT;
  className?: string;
  /** These lines stand in the nearest SkeletonSlot's place. */
  inSlot?: boolean;
};

// One place on screen where a lazy view's fallback lines give way to the
// view's own loading lines, in the same position. Only lines marked
// `inSlot` take part, so loaders nested deeper in the view keep their own
// wait. Lines that take over in the slot from lines a person could already
// see show at once, so they never blink off and back on.
type Slot = { shownLeftAt: number };
const SlotContext = createContext<Slot | null>(null);
const HANDOFF_MS = 50;

export function SkeletonSlot(props: { children: ReactNode }) {
  const [slot] = useState<Slot>(() => ({ shownLeftAt: Number.NEGATIVE_INFINITY }));
  return <SlotContext.Provider value={slot}>{props.children}</SlotContext.Provider>;
}

function Frame(props: LinesProps & { children?: ReactNode; role?: "status"; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const nearest = useContext(SlotContext);
  const slot = props.inSlot ? nearest : null;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!slot || !element) return;
    if (performance.now() - slot.shownLeftAt < HANDOFF_MS) element.style.animation = "none";
    // Still blank in its wait, it hands nothing over. The element is still
    // on the page while React runs this cleanup.
    return () => {
      if (Number(getComputedStyle(element).opacity) > 0) slot.shownLeftAt = performance.now();
    };
  }, [slot]);
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

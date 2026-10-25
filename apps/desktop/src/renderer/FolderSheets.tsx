import type { CSSProperties } from "react";

// Four sheets tucked into the new-workspace folder: a Page, a Collection, a
// Drawing and an App, each in its kind's colour. Only their tops show above
// the card, beside the name tab. They are a picture of what a workspace
// holds, so they take no pointer, focus or name.

// Each sheet draws in a 164 x 112 box, turned and scaled about (82, 90).
// `left` and `top` place that box in the folder; the card's front starts 31px
// below the folder's top, and each paper's top lands 46 to 56px above it.
const placement = (left: number, top: number, turn: number): CSSProperties => ({
  left,
  top,
  transform: `rotate(${turn}deg) scale(0.62)`,
});

const SHEET = "absolute h-28 w-41 origin-[82px_90px]";
const PAPER = "absolute top-[18px] rounded-md border border-line bg-bg";
const LINE = "block h-[5px] rounded-[3px] bg-line";
// The Collection's rows: a teal header, then cells with text or a tag.
const COLLECTION_CELLS = "hhh" + "ctc" + "ctc" + "ccc" + "ctc";

export function FolderSheets() {
  return (
    <div data-testid="folder-sheets" aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-1 h-0">
      <div className={SHEET} style={placement(94, -64, -6)}>
        <div className={`${PAPER} inset-x-[22px] -bottom-2 flex flex-col gap-[7px] p-3`}>
          <span className="mb-[3px] block h-2 w-[55%] rounded-[3px] bg-ink/55" />
          <span className={LINE} />
          <span className={`${LINE} w-4/5`} />
          <span className={LINE} />
          <span className={`${LINE} w-3/5`} />
        </div>
      </div>
      <div className={SHEET} style={placement(158, -70, -2)}>
        <div className={`${PAPER} inset-x-4 -bottom-1.5 grid auto-rows-[17px] grid-cols-[1.4fr_1fr_1fr] overflow-hidden`}>
          {[...COLLECTION_CELLS].map((cell, index) => (
            <span
              key={index}
              className={`relative border-b border-line${index % 3 === 2 ? "" : " border-r"}${cell === "h" ? " bg-hue-teal/16" : ""}`}
            >
              {cell === "c" ? <span className={`absolute left-1.5 top-1.5 w-3/5 ${LINE}`} /> : null}
              {cell === "t" ? <span className="absolute left-1.5 top-[5px] h-[7px] w-[34px] rounded bg-hue-teal/35" /> : null}
            </span>
          ))}
        </div>
      </div>
      <div className={SHEET} style={placement(222, -66, 2.5)}>
        <div className={`${PAPER} inset-x-[22px] -bottom-2`}>
          <svg
            viewBox="0 0 160 112"
            fill="none"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute -left-[23px] -top-[19px] h-28 w-41"
          >
            <circle cx="54" cy="52" r="20" className="stroke-hue-plum" />
            <rect x="92" y="34" width="38" height="30" rx="4" className="stroke-ink/55" />
            <path d="M74 54 L90 50" className="stroke-ink/55" />
            <path d="M84 46 L90 50 L85 56" className="stroke-ink/55" />
            <path d="M40 86 C 60 76, 80 96, 112 82" className="stroke-hue-plum" />
          </svg>
        </div>
      </div>
      <div className={SHEET} style={placement(284, -60, 6.5)}>
        <div className={`${PAPER} inset-x-5 -bottom-1.5 overflow-hidden`}>
          <div className="flex h-3.5 items-center gap-[3px] border-b border-line px-1.5">
            <span className="size-[5px] rounded-full bg-line" />
            <span className="size-[5px] rounded-full bg-line" />
            <span className="size-[5px] rounded-full bg-line" />
          </div>
          <div className="mx-auto mt-3 flex w-[70%] flex-col gap-1.5">
            <span className="block h-2.5 rounded-[3px] border border-line" />
            <span className="block h-2.5 rounded-[3px] border border-line" />
            <span className="block h-3 w-1/2 rounded bg-hue-amber/85" />
          </div>
        </div>
      </div>
    </div>
  );
}

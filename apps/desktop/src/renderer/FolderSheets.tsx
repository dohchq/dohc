import type { CSSProperties } from "react";
import { START_TILE_ART } from "./workbench/StartTileArt";

// Four sheets tucked into the new-workspace folder: a Page, a Collection, a
// Drawing and an App, with the pictures of START_TILE_ART.
// Only their tops show above the card, beside the name tab. They are a
// picture of what a workspace holds, so they take no pointer, focus or name.

// Each sheet draws in a 164 x 112 box, a start tile's height, turned and
// scaled about (82, 90). `left` and `top` place that box in the folder; the
// card's front starts 31px below the folder's top, and each paper's top lands
// 46 to 56px above it.
const SHEETS: readonly { kind: keyof typeof START_TILE_ART; left: number; top: number; turn: number }[] = [
  { kind: "markdown", left: 94, top: -64, turn: -6 },
  { kind: "collection", left: 158, top: -70, turn: -2 },
  { kind: "drawing", left: 222, top: -66, turn: 2.5 },
  { kind: "app", left: 284, top: -60, turn: 6.5 },
];

const placement = (sheet: (typeof SHEETS)[number]): CSSProperties => ({
  left: sheet.left,
  top: sheet.top,
  transform: `rotate(${sheet.turn}deg) scale(0.62)`,
});

export function FolderSheets() {
  return (
    <div data-testid="folder-sheets" aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-1 h-0">
      {SHEETS.map((sheet) => (
        <div key={sheet.kind} className="absolute h-28 w-41 origin-[82px_90px]" style={placement(sheet)}>
          {/* The drawing sits on its tile, so its sheet adds the paper the
              other pictures bring. */}
          {sheet.kind === "drawing" ? (
            <span className="absolute inset-x-5.5 top-4.5 -bottom-2 rounded-md border border-line bg-bg" />
          ) : null}
          {START_TILE_ART[sheet.kind]}
        </div>
      ))}
    </div>
  );
}

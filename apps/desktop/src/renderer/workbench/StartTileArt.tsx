import type { ReactNode } from "react";

// The kinds a person can make from the start surface. Files go by their kind
// registry id.
export type StartKind = "markdown" | "collection" | "drawing" | "app";

// A table's cells, row by row: a header row, then text and tag cells.
const CELLS = ["head", "head", "head", "text", "tag", "text", "text", "tag", "text", "text", "text", "text", "text", "tag", "text"] as const;

// The picture on each start tile: a sketch of what the kind holds once made.
// Decorative; the tile's label names it.
export const START_TILE_ART: Record<StartKind, ReactNode> = {
  markdown: (
    <span className="absolute inset-x-5.5 top-4.5 -bottom-2 flex flex-col gap-1.75 rounded-md border border-line bg-bg p-3">
      <span className="mb-0.75 h-2 w-[55%] rounded-full bg-ink/55" />
      <span className="h-1.25 rounded-full bg-line" />
      <span className="h-1.25 w-4/5 rounded-full bg-line" />
      <span className="h-1.25 rounded-full bg-line" />
      <span className="h-1.25 w-3/5 rounded-full bg-line" />
    </span>
  ),
  collection: (
    <span className="absolute inset-x-4 top-4.5 -bottom-1.5 grid auto-rows-[17px] grid-cols-[1.4fr_1fr_1fr] overflow-hidden rounded-md border border-line bg-bg">
      {CELLS.map((cell, index) => (
        <span key={index} className={`relative border-b border-line ${index % 3 === 2 ? "" : "border-r"} ${cell === "head" ? "bg-hue-teal/15" : ""}`}>
          {cell === "text" ? <span className="absolute top-1.5 left-1.5 h-1.25 w-3/5 rounded-full bg-line" /> : null}
          {cell === "tag" ? <span className="absolute inset-x-1.5 top-1.25 h-1.75 rounded-full bg-hue-teal/35" /> : null}
        </span>
      ))}
    </span>
  ),
  drawing: (
    <svg viewBox="0 0 160 112" fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 size-full">
      <circle cx={54} cy={52} r={20} className="stroke-hue-plum" />
      <g className="stroke-ink opacity-55">
        <rect x={92} y={34} width={38} height={30} rx={4} />
        <path d="M74 54 L90 50" />
        <path d="M84 46 L90 50 L85 56" />
      </g>
      <path d="M40 86 C 60 76, 80 96, 112 82" className="stroke-hue-plum" />
    </svg>
  ),
  app: (
    <span className="absolute inset-x-5 top-4.5 -bottom-1.5 overflow-hidden rounded-md border border-line bg-bg">
      <span className="flex h-3.5 items-center gap-0.75 border-b border-line px-1.5">
        <span className="size-1.25 rounded-full bg-line" />
        <span className="size-1.25 rounded-full bg-line" />
        <span className="size-1.25 rounded-full bg-line" />
      </span>
      <span className="mx-auto mt-3 flex w-[70%] flex-col gap-1.5">
        <span className="h-2.5 rounded-sm border border-line" />
        <span className="h-2.5 rounded-sm border border-line" />
        <span className="h-3 w-1/2 rounded bg-hue-amber/85" />
      </span>
    </span>
  ),
};

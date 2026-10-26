import { Check } from "lucide-react";
import type { ReactNode } from "react";

export type EmptyArtKind = "files" | "apps" | "posts" | "history" | "shares" | "automations" | "table" | "versions" | "search";

const CARD = "absolute inset-x-3 top-1.5 -bottom-2.5 overflow-hidden rounded-md border border-line bg-bg";
const ROW = "flex items-center gap-1.25";
const LINE = "h-1.25 shrink-0 rounded-full bg-ink/13";
const HEAD = "shrink-0 rounded-full bg-ink/55";
const SQUARE = "size-1.75 shrink-0 rounded-xs";
const DOT = "size-2.5 shrink-0 rounded-full";
const AVATAR = `${DOT} border-[1.5px] border-bg`;

// A table's cells, row by row: a header row, then text and tag cells.
const CELLS = ["head", "head", "head", "text", "tag", "text", "text", "text", "tag", "text", "tag", "text"] as const;

// The picture on each empty state: a sketch of what the surface holds once it
// has items. Decorative; EmptyState hides it and its line names what is missing.
export const EMPTY_ART: Record<EmptyArtKind, ReactNode> = {
  files: (
    <span className={`${CARD} flex flex-col gap-2 p-2`}>
      <span className={ROW}><span className={`${SQUARE} border-[1.5px] border-subtle`} /><span className={`${LINE} w-[42%]`} /></span>
      <span className={`${ROW} ml-3`}><span className={`${SQUARE} bg-ink/55`} /><span className={`${LINE} w-[52%]`} /></span>
      <span className={`${ROW} ml-3`}><span className={`${SQUARE} bg-hue-teal`} /><span className={`${LINE} w-[38%]`} /></span>
      <span className={ROW}><span className={`${SQUARE} bg-hue-plum`} /><span className={`${LINE} w-[46%]`} /></span>
    </span>
  ),
  apps: (
    <span className={`${CARD} flex flex-col`}>
      <span className="flex h-3.25 shrink-0 items-center gap-0.75 border-b border-line px-1.5">
        <span className={`${LINE} w-1.25`} />
        <span className={`${LINE} w-1.25`} />
        <span className={`${LINE} w-1.25`} />
      </span>
      <span className="mx-auto mt-2.5 flex w-[70%] flex-col gap-1.5">
        <span className="h-2.5 rounded-xs border border-line" />
        <span className="h-2.5 rounded-xs border border-line" />
        <span className="h-2.75 w-1/2 rounded-[3px] bg-hue-amber/85" />
      </span>
    </span>
  ),
  posts: (
    <span className={`${CARD} flex flex-col gap-2.5 p-2`}>
      <span className="flex items-start gap-1.5">
        <span className={`${DOT} bg-hue-blue`} />
        <span className="flex flex-1 flex-col gap-1 pt-0.5">
          <span className={`${HEAD} h-1.25 w-[34%]`} />
          <span className={`${LINE} w-[90%]`} />
          <span className={`${LINE} w-[65%]`} />
        </span>
      </span>
      <span className="flex items-start gap-1.5">
        <span className={`${DOT} bg-agent`} />
        <span className="flex flex-1 flex-col gap-1 pt-0.5">
          <span className={`${HEAD} h-1.25 w-[44%]`} />
          <span className={`${LINE} w-4/5`} />
        </span>
      </span>
    </span>
  ),
  history: (
    <span className={`${CARD} flex flex-col gap-2.25 p-2 pl-5.5`}>
      <span className="absolute top-2.5 bottom-0 left-3 w-px bg-line" />
      {([["bg-hue-blue", "w-[60%]"], ["bg-agent", "w-[48%]"], ["bg-hue-blue", "w-[55%]"]] as const).map(([hue, width]) => (
        <span key={width} className={ROW}>
          <span className={`absolute left-2 size-2.25 rounded-full ${hue}`} />
          <span className={`${LINE} ${width}`} />
          <span className={`${LINE} ml-auto w-[16%]`} />
        </span>
      ))}
    </span>
  ),
  shares: (
    <span className={`${CARD} flex flex-col gap-2.25 p-2`}>
      <span className={ROW}>
        <span className={`${SQUARE} bg-ink/55`} /><span className={`${LINE} w-[44%]`} />
        <span className="ml-auto flex"><span className={`${AVATAR} bg-hue-blue`} /><span className={`${AVATAR} -ml-1 bg-hue-rose`} /></span>
      </span>
      <span className={ROW}>
        <span className={`${SQUARE} bg-hue-teal`} /><span className={`${LINE} w-[36%]`} />
        <span className={`${AVATAR} ml-auto bg-agent`} />
      </span>
      <span className={ROW}>
        <span className={`${SQUARE} bg-hue-amber`} /><span className={`${LINE} w-1/2`} />
        <span className={`${AVATAR} ml-auto bg-hue-blue`} />
      </span>
    </span>
  ),
  automations: (
    <span className={`${CARD} flex flex-col px-2.5 py-2`}>
      <span className="flex flex-col gap-1 rounded border border-l-[3px] border-line border-l-hue-teal px-1.5 py-1.25">
        <span className={`${HEAD} h-1.25 w-2/5`} />
        <span className={`${LINE} w-3/4`} />
      </span>
      <span className="ml-4 h-2 w-px shrink-0 bg-line" />
      <span className="flex flex-col gap-1 rounded border border-line px-1.5 py-1.25">
        <span className={`${HEAD} h-1.25 w-[30%]`} />
        <span className={`${LINE} w-[65%]`} />
      </span>
    </span>
  ),
  table: (
    <span className={`${CARD} grid auto-rows-[15px] grid-cols-[1.4fr_1fr_1fr]`}>
      {CELLS.map((cell, index) => (
        <span key={index} className={`relative border-b border-line ${index % 3 === 2 ? "" : "border-r"} ${cell === "head" ? "bg-hue-teal/15" : ""}`}>
          {cell === "text" ? <span className="absolute top-1.25 left-1.25 h-1.25 w-[55%] rounded-full bg-ink/13" /> : null}
          {cell === "tag" ? <span className="absolute inset-x-1.25 top-1 h-1.75 rounded-full bg-hue-teal/35" /> : null}
        </span>
      ))}
    </span>
  ),
  versions: (
    <>
      <span className="absolute top-3 right-5 -bottom-2.5 left-5.5 rounded-md border border-line bg-bg opacity-60" />
      <span className="absolute top-1.5 right-6.5 -bottom-2.5 left-4 flex flex-col gap-1.75 overflow-hidden rounded-md border border-line bg-bg p-2">
        <span className={`${HEAD} h-1.75 w-[55%]`} />
        <span className={LINE} />
        <span className={`${LINE} w-4/5`} />
        <span className={LINE} />
      </span>
      <span className="absolute top-0 right-4 grid size-4.5 place-items-center rounded-full bg-bg text-success">
        <Check size={14} strokeWidth={2.4} />
      </span>
    </>
  ),
  search: (
    <span className={`${CARD} flex flex-col gap-2 p-2`}>
      <span className="flex h-3.5 shrink-0 items-center gap-1 rounded border border-line px-1">
        <span className="size-1.5 shrink-0 rounded-full border-[1.5px] border-subtle" />
        <span className={`${HEAD} h-1 w-[30%]`} />
      </span>
      <span className="h-2.5 shrink-0 rounded-[3px] border border-dashed border-line" />
      <span className="h-2.5 shrink-0 rounded-[3px] border border-dashed border-line" />
    </span>
  ),
};

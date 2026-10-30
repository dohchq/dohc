import { ChevronRight, Plus, RotateCcw, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { SwitchControl } from "../settings/SettingRow";
import { GhostButton, IconButton } from "../ui/controls";
import { GROUP_HUES, DEFAULT_DISPLAY, type GraphDisplay, type GraphShape } from "./GraphCanvas";
import { DEFAULT_FORCES, type GraphForces } from "./graphLayout";

export type GraphKind = "page" | "drawing" | "file" | "chat" | "heading";
export const GRAPH_KINDS: readonly { kind: GraphKind; name: string; shape: GraphShape }[] = [
  { kind: "page", name: "Document", shape: "circle" },
  { kind: "drawing", name: "Drawing", shape: "diamond" },
  { kind: "file", name: "File", shape: "ring" },
  { kind: "chat", name: "Chat", shape: "bubble" },
  { kind: "heading", name: "Heading", shape: "pill" },
];

export type GraphGroup = { id: number; query: string; hue: number };

export type GraphSettingsValue = {
  hidden: readonly GraphKind[];
  orphans: boolean;
  depth: number;
  groups: readonly GraphGroup[];
  display: GraphDisplay;
  forces: GraphForces;
};

export const DEFAULT_SETTINGS: GraphSettingsValue = {
  hidden: [],
  orphans: true,
  depth: 1,
  groups: [],
  display: DEFAULT_DISPLAY,
  forces: DEFAULT_FORCES,
};

// Spelled out so Tailwind sees every class.
const HUE_TEXT: Record<(typeof GROUP_HUES)[number], string> = {
  teal: "text-hue-teal",
  amber: "text-hue-amber",
  plum: "text-hue-plum",
  blue: "text-hue-blue",
  rust: "text-hue-rust",
  indigo: "text-hue-indigo",
  rose: "text-hue-rose",
};

export function ShapeMark(props: { shape: GraphShape; className?: string; hollow?: boolean }) {
  const paint = props.hollow
    ? { fill: "none", stroke: "currentColor", strokeWidth: 1.5 }
    : props.shape === "ring"
      ? { fill: "none", stroke: "currentColor", strokeWidth: 2 }
      : { fill: "currentColor" };
  return (
    <svg aria-hidden viewBox="-8 -8 16 16" width={12} height={12} className={`shrink-0 ${props.className ?? ""}`}>
      {props.shape === "diamond" ? (
        <path d="M0 -6.5 L6.5 0 L0 6.5 L-6.5 0 Z" {...paint} />
      ) : props.shape === "square" ? (
        <rect x={-5.5} y={-5.5} width={11} height={11} rx={3} {...paint} />
      ) : props.shape === "pill" ? (
        <rect x={-6.5} y={-3.5} width={13} height={7} rx={3.5} {...paint} />
      ) : props.shape === "bubble" ? (
        <path d="M-3.1 3.95 L-4.75 5.5 L-1 4.9 A5 5 0 1 0 -3.1 3.95 Z" {...paint} />
      ) : (
        <circle r={props.shape === "ring" ? 4.5 : 5} {...paint} />
      )}
    </svg>
  );
}

function Section(props: { title: string; open: boolean; onToggle: () => void; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col">
      <div className="flex h-7 items-center gap-1 px-2">
        <button
          type="button"
          aria-expanded={props.open}
          onClick={props.onToggle}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md text-left text-[13px] font-medium text-ink"
        >
          <ChevronRight
            size={13}
            aria-hidden
            className={`shrink-0 text-subtle transition-transform duration-150 ${props.open ? "rotate-90" : ""}`}
          />
          {props.title}
        </button>
        {props.action}
      </div>
      {props.open ? <div className="flex flex-col pb-2">{props.children}</div> : null}
    </section>
  );
}

function Row(props: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2 pl-6">
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-[13px] text-muted">{props.label}</span>
      {props.children}
    </div>
  );
}

function Slider(props: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <Row label={props.label}>
      <input
        type="range"
        aria-label={props.label}
        min={props.min ?? 0}
        max={props.max ?? 1}
        step={props.step ?? 0.01}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="h-4 w-28 shrink-0 cursor-pointer accent-accent"
      />
    </Row>
  );
}

export function GraphSettings(props: {
  value: GraphSettingsValue;
  counts: Readonly<Record<GraphKind, number>>;
  local: boolean;
  onChange: (value: GraphSettingsValue) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState({ filters: true, groups: false, display: false, forces: false });
  const { value, onChange } = props;
  const toggle = (key: keyof typeof open) => setOpen((current) => ({ ...current, [key]: !current[key] }));
  const setDisplay = (patch: Partial<GraphDisplay>) => onChange({ ...value, display: { ...value.display, ...patch } });
  const setForces = (patch: Partial<GraphForces>) => onChange({ ...value, forces: { ...value.forces, ...patch } });
  const setGroup = (id: number, patch: Partial<GraphGroup>) =>
    onChange({ ...value, groups: value.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)) });
  const forcesChanged = (Object.keys(DEFAULT_FORCES) as (keyof GraphForces)[]).some((key) => value.forces[key] !== DEFAULT_FORCES[key]);

  return (
    <div
      data-testid="graph-settings"
      role="group"
      aria-label="Graph settings"
      className="dohc-popover dohc-pop-in absolute right-3 top-3 z-10 flex max-h-[calc(100%-24px)] w-72 max-w-[calc(100%-24px)] flex-col overflow-y-auto rounded-xl border border-line bg-panel py-1"
    >
      <div className="flex h-7 items-center justify-end px-2">
        <IconButton aria-label="Close graph settings" title="Close graph settings" onClick={props.onClose}>
          <X size={13} aria-hidden />
        </IconButton>
      </div>
      <Section title="Filters" open={open.filters} onToggle={() => toggle("filters")}>
        {props.local ? (
          <Slider label="Depth" min={1} max={3} step={1} value={value.depth} onChange={(depth) => onChange({ ...value, depth })} />
        ) : null}
        {GRAPH_KINDS.map(({ kind, name, shape }) => {
          const shown = !value.hidden.includes(kind);
          return (
            <Row
              key={kind}
              label={
                <>
                  <ShapeMark shape={shape} hollow={!shown && shape !== "ring"} className="text-subtle" />
                  <span className="truncate">{name}</span>
                  <span className="text-[12px] tabular-nums text-subtle">{props.counts[kind].toLocaleString()}</span>
                </>
              }
            >
              <SwitchControl
                label={`Show ${name.toLowerCase()} nodes`}
                checked={shown}
                onChange={(checked) =>
                  onChange({
                    ...value,
                    hidden: checked ? value.hidden.filter((hidden) => hidden !== kind) : [...value.hidden, kind],
                  })
                }
              />
            </Row>
          );
        })}
        <Row label="Orphans">
          <SwitchControl label="Show files with no links" checked={value.orphans} onChange={(orphans) => onChange({ ...value, orphans })} />
        </Row>
      </Section>
      <Section title="Groups" open={open.groups} onToggle={() => toggle("groups")}>
        {value.groups.map((group) => {
          const hue = GROUP_HUES[group.hue % GROUP_HUES.length]!;
          return (
            <div key={group.id} className="flex h-8 items-center gap-2 px-2 pl-6">
              <button
                type="button"
                aria-label={`Group colour, ${hue}. Change colour`}
                title="Change colour"
                onClick={() => setGroup(group.id, { hue: (group.hue + 1) % GROUP_HUES.length })}
                className={`grid size-6 shrink-0 place-items-center rounded-md hover:bg-hover ${HUE_TEXT[hue]}`}
              >
                <ShapeMark shape="circle" />
              </button>
              <input
                aria-label="Group search"
                placeholder="Name or folder"
                value={group.query}
                onChange={(event) => setGroup(group.id, { query: event.target.value })}
                className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
              />
              <IconButton
                aria-label="Remove group"
                title="Remove group"
                onClick={() => onChange({ ...value, groups: value.groups.filter((other) => other.id !== group.id) })}
              >
                <X size={13} aria-hidden />
              </IconButton>
            </div>
          );
        })}
        <div className="px-2 pl-5">
          <GhostButton
            onClick={() =>
              onChange({
                ...value,
                groups: [
                  ...value.groups,
                  { id: Math.max(0, ...value.groups.map((group) => group.id)) + 1, query: "", hue: value.groups.length % GROUP_HUES.length },
                ],
              })
            }
          >
            <Plus size={12} aria-hidden />
            New group
          </GhostButton>
        </div>
      </Section>
      <Section title="Display" open={open.display} onToggle={() => toggle("display")}>
        <Row label="Arrows">
          <SwitchControl label="Arrows" checked={value.display.arrows} onChange={(arrows) => setDisplay({ arrows })} />
        </Row>
        <Slider label="Text fade" value={value.display.textFade} onChange={(textFade) => setDisplay({ textFade })} />
        <Slider label="Node size" value={value.display.nodeSize} onChange={(nodeSize) => setDisplay({ nodeSize })} />
        <Slider label="Link thickness" value={value.display.linkThickness} onChange={(linkThickness) => setDisplay({ linkThickness })} />
      </Section>
      <Section
        title="Forces"
        open={open.forces}
        onToggle={() => toggle("forces")}
        action={
          forcesChanged ? (
            <IconButton aria-label="Reset forces" title="Reset forces" onClick={() => onChange({ ...value, forces: DEFAULT_FORCES })}>
              <RotateCcw size={12} aria-hidden />
            </IconButton>
          ) : null
        }
      >
        <Slider label="Center force" value={value.forces.center} onChange={(center) => setForces({ center })} />
        <Slider label="Repel force" value={value.forces.repel} onChange={(repel) => setForces({ repel })} />
        <Slider label="Link force" value={value.forces.link} onChange={(link) => setForces({ link })} />
        <Slider label="Link distance" value={value.forces.distance} onChange={(distance) => setForces({ distance })} />
      </Section>
    </div>
  );
}

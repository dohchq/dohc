import {
  CalendarDays,
  CheckSquare,
  Hash,
  Link,
  List,
  ListChecks,
  MousePointerClick,
  Paperclip,
  Type,
  User,
} from "lucide-react";
import {
  chosenOptionColor,
  type FieldDefinition,
  type OptionColor,
} from "@dohc/workspace-contracts";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";

// How values look in every view: option pills, people, dates, and field
// type icons. Class names are literal so the host's Tailwind scan sees them.

const TONES: Record<OptionColor, { pill: string; dot: string; column: string }> = {
  gray: { pill: "bg-muted/12 text-muted", dot: "bg-muted", column: "bg-muted/[0.06]" },
  rust: { pill: "bg-hue-rust/15 text-hue-rust", dot: "bg-hue-rust", column: "bg-hue-rust/[0.06]" },
  amber: { pill: "bg-hue-amber/15 text-hue-amber", dot: "bg-hue-amber", column: "bg-hue-amber/[0.06]" },
  teal: { pill: "bg-hue-teal/15 text-hue-teal", dot: "bg-hue-teal", column: "bg-hue-teal/[0.06]" },
  blue: { pill: "bg-hue-blue/15 text-hue-blue", dot: "bg-hue-blue", column: "bg-hue-blue/[0.06]" },
  indigo: { pill: "bg-hue-indigo/15 text-hue-indigo", dot: "bg-hue-indigo", column: "bg-hue-indigo/[0.06]" },
  plum: { pill: "bg-hue-plum/15 text-hue-plum", dot: "bg-hue-plum", column: "bg-hue-plum/[0.06]" },
  rose: { pill: "bg-hue-rose/15 text-hue-rose", dot: "bg-hue-rose", column: "bg-hue-rose/[0.06]" },
};

export function optionTone(color: OptionColor) {
  return TONES[color];
}

/**
 * The color an option shows: the one the schema chose, else one picked from
 * its name, so it holds when options are reordered.
 */
export function optionColor(field: FieldDefinition, option: string): OptionColor {
  const chosen = field.type === "select" || field.type === "multi-select"
    ? chosenOptionColor(field.colors, option)
    : undefined;
  return chosen ?? ACTOR_HUES[actorHueSlot(option)]!;
}

export function OptionPill({
  label,
  color,
  dot = false,
}: {
  label: string;
  color: OptionColor;
  /** A select shows a dot before its label; a multi-select tag does not. */
  dot?: boolean;
}) {
  const tone = TONES[color];
  return (
    <span
      data-option-color={color}
      className={`inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 rounded px-1.5 text-[12px] font-medium leading-none ${tone.pill}`}
    >
      {dot ? <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone.dot}`} /> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** A person or agent: an initial on their hue, then their name. */
export function PersonChip({ id, label }: { id: string; label: string }) {
  const hue = ACTOR_HUES[actorHueSlot(id)]!;
  const initial = Array.from(label.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-[13px] text-ink">
      <span
        aria-hidden
        className={`grid size-[18px] shrink-0 place-items-center rounded-full text-[10px] font-semibold ${TONES[hue].pill}`}
      >
        {initial}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A stored date as people read it: "Nov 8" this year, "Nov 8, 2025"
 * otherwise. Anything that is not a YYYY-MM-DD date shows as stored.
 */
export function shortDate(value: string, today: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  if (!name) return value;
  const text = `${name} ${Number(day)}`;
  return Number(year) === today.getFullYear() ? text : `${text}, ${year}`;
}

/** A field type's icon. Dataset fields add types such as attachment. */
export function FieldTypeIcon({
  type,
  className = "shrink-0 text-muted",
}: {
  type: string;
  className?: string;
}) {
  const Icon = type === "number" ? Hash
    : type === "date" ? CalendarDays
    : type === "checkbox" ? CheckSquare
    : type === "select" ? List
    : type === "multi-select" ? ListChecks
    : type === "attachment" ? Paperclip
    : type === "relation" || type === "url" ? Link
    : type === "person" ? User
    : type === "button" ? MousePointerClick
    : Type;
  return <Icon size={14} strokeWidth={1.9} aria-hidden className={className} />;
}

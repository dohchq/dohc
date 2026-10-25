import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Minus, Plus, RotateCcw } from "lucide-react";
import { AGENT_HUES, IDENTITY_HUES, palette, type AgentHue, type IdentityHue } from "../tokens";
import { useRadioGroup } from "../ui/SegmentedControl";

export function SettingRow(props: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  modified?: boolean;
  onReset?: () => void;
  testId?: string;
  // The row a Customize… command opened Settings for. Settings focuses it.
  highlighted?: boolean;
  // Under the title, such as the way to ask your agent.
  aside?: ReactNode;
  // Before the title, such as the signed-in account's avatar.
  lead?: ReactNode;
  // A row of a long list that only shows a value, such as a shortcut's keys.
  // Its title needs less room than a description, so the value stays beside it
  // in a narrower pane.
  compact?: boolean;
  // For a control that is a list of 32 px rows: the title and Reset sit
  // beside its first row, not its middle.
  top?: boolean;
}) {
  // The controls keep their size and the text takes what is left, from a
  // readable width: 15rem, or 8rem for a compact row's title. Controls that
  // don't fit beside that wrap under the text.
  const first = props.compact ? "min-w-0 flex-[1_1_8rem]" : "min-w-0 flex-[1_1_15rem]";
  const text = (
    <div className={`${props.lead ? "min-w-0 flex-1" : first}${props.top ? " pt-1.5" : ""}`}>
      {/* The dot hangs left of the title, so marking a row moves nothing in it. */}
      <div className="relative flex items-center">
        {props.modified ? (
          <span title="Modified" className="absolute right-full top-1/2 mr-1 size-1.5 -translate-y-1/2 rounded-full bg-accent">
            <span className="sr-only">Modified</span>
          </span>
        ) : null}
        <span className="text-[13px] font-medium text-ink">{props.title}</span>
      </div>
      {props.description ? (
        <p className="m-0 mt-1 text-[12px] text-muted">{props.description}</p>
      ) : null}
      {props.aside ? <div className="mt-2">{props.aside}</div> : null}
    </div>
  );
  return (
    <div
      data-testid={props.testId}
      {...(props.highlighted
        ? { "data-highlighted": true, role: "group", "aria-label": props.title, tabIndex: -1 }
        : {})}
      className={`flex flex-wrap ${props.top ? "items-start" : "items-center"} gap-x-6 gap-y-2 border-b border-line last:border-b-0 ${
        props.compact ? "py-2" : "py-4"
      } ${props.highlighted ? "-mx-2 rounded-md bg-selected px-2" : ""}`}
    >
      {props.lead ? (
        <div className={`flex items-center gap-3 ${first}`}>
          {props.lead}
          {text}
        </div>
      ) : (
        text
      )}
      <div className={`ml-auto flex max-w-full shrink-0 flex-wrap gap-2 ${props.top ? "items-start" : "items-center"}`}>
        {/* A row that can reset keeps Reset's place left of the controls, so
            they share the right edge and never move or wrap when it appears. */}
        {props.onReset && !props.modified ? <span aria-hidden className="size-6 shrink-0" /> : null}
        {props.onReset && props.modified ? (
          <button
            type="button"
            aria-label="Reset"
            title="Reset"
            onClick={props.onReset}
            className={`grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink ${props.top ? "mt-1" : ""}`}
          >
            <RotateCcw size={14} strokeWidth={1.9} aria-hidden />
          </button>
        ) : null}
        {props.children}
      </div>
    </div>
  );
}

/** A named group of settings: its heading over a card of rows. A page with one group leaves out the heading. */
export function SettingsSection(props: { title?: string; children: ReactNode }) {
  return (
    <section aria-label={props.title} className="mt-8 first:mt-0">
      {props.title ? <h4 className="m-0 mb-2 text-sm font-semibold text-ink">{props.title}</h4> : null}
      <div className="rounded-lg border border-line bg-panel px-4">{props.children}</div>
    </section>
  );
}

type ThemeMode = "system" | "light" | "dark";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies ReadonlyArray<{ value: ThemeMode; label: string }>;

// A window in one theme, drawn from that theme's tokens whatever the current
// theme is. `half` keeps only the lower right triangle, for System.
function ThemeWindow(props: { theme: "light" | "dark"; half?: boolean }) {
  const tokens = palette[props.theme];
  return (
    <span
      className="absolute inset-0"
      style={{ background: tokens.bg, clipPath: props.half ? "polygon(100% 0, 100% 100%, 0 100%)" : undefined }}
    >
      <span
        className="absolute inset-y-0 left-0 w-[18px]"
        style={{ background: props.theme === "dark" ? tokens.panel2 : tokens.panel }}
      />
      <span className="absolute left-[26px] top-3.5 h-1 w-9 rounded-sm opacity-40" style={{ background: tokens.ink }} />
      <span className="absolute left-[26px] top-6 h-1 w-6 rounded-sm opacity-20" style={{ background: tokens.ink }} />
    </span>
  );
}

/** The theme as three windows, one per choice, in a radiogroup. */
export function ThemeControl(props: { value: ThemeMode; onChange: (value: ThemeMode) => void }) {
  const group = useRadioGroup({ value: props.value, options: THEME_OPTIONS, onChange: props.onChange });
  return (
    <div role="radiogroup" aria-label="Theme" onKeyDown={group.onKeyDown} className="flex items-start gap-3.5">
      {THEME_OPTIONS.map((option, index) => {
        const checked = props.value === option.value;
        return (
          <button
            key={option.value}
            {...group.radio(index)}
            className={`group flex flex-col items-center gap-1.5 rounded-lg text-[11px] transition-colors focus-visible:outline-offset-4 ${
              checked ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            <span
              aria-hidden
              className={`relative h-[50px] w-[76px] overflow-hidden rounded-lg border border-line ${
                checked ? "outline-2 outline-offset-2 outline-accent" : ""
              }`}
            >
              {option.value === "system" ? (
                <>
                  <ThemeWindow theme="light" />
                  <ThemeWindow theme="dark" half />
                </>
              ) : (
                <ThemeWindow theme={option.value} />
              )}
            </span>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

type StepperPart = {
  // The tooltip's words. For − and + it is also the button's name.
  label: string;
  // The keys that do the same, shown as chips in the tooltip.
  keys?: readonly string[];
  disabled?: boolean;
  onClick: () => void;
};

type StepperPartName = "decrease" | "reset" | "increase";

/**
 * One bordered stepper: −, the value, +. Clicking the value resets it. Each
 * part's tooltip names it and its keys while the pointer is over it or the
 * keyboard focused it. A click does not open one.
 */
export function StepperControl(props: {
  // The setting's name in a sentence, such as "zoom".
  setting: string;
  value: string;
  decrease: StepperPart;
  reset: StepperPart & { to: string };
  increase: StepperPart;
}) {
  const [hovered, setHovered] = useState<StepperPartName | null>(null);
  const [focused, setFocused] = useState<StepperPartName | null>(null);
  // The part whose tooltip Escape put away, until the pointer or focus moves.
  const [dismissed, setDismissed] = useState<StepperPartName | null>(null);
  const shown = hovered ?? focused;
  const tip = shown === dismissed ? null : shown;
  const tipId = useId();
  const part = (name: StepperPartName, className: string, content: ReactNode) => {
    const spec = props[name];
    const open = tip === name;
    return (
      <span
        className="relative flex"
        onMouseEnter={() => {
          setHovered(name);
          setDismissed(null);
        }}
        onMouseLeave={() => {
          setHovered(null);
          setDismissed(null);
        }}
      >
        <button
          type="button"
          aria-label={name === "reset" ? `Reset ${props.setting} to ${props.reset.to}, now ${props.value}` : spec.label}
          aria-describedby={open ? `${tipId}-${name}` : undefined}
          // Overlay leaves this Escape to the control: it closes the tooltip.
          data-tooltip-open={open ? "" : undefined}
          disabled={spec.disabled}
          onClick={spec.onClick}
          // A click is the pointer's, even on a part the keyboard focused
          // before, so it leaves no keyboard tooltip behind.
          onPointerDown={() => setFocused((current) => (current === name ? null : current))}
          onFocus={(event) => {
            if (!event.currentTarget.matches(":focus-visible")) return;
            setFocused(name);
            setDismissed(null);
          }}
          onBlur={() => setFocused((current) => (current === name ? null : current))}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.stopPropagation();
              setDismissed(name);
            }
          }}
          className={`grid h-[26px] place-items-center transition-colors focus-visible:-outline-offset-2 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-50 ${className}`}
        >
          {content}
        </button>
        {open ? (
          <span
            id={`${tipId}-${name}`}
            role="tooltip"
            className="dohc-popover dohc-pop-in pointer-events-none absolute right-0 top-full z-50 mt-2 flex w-max items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-ink"
          >
            {spec.label}
            {spec.keys?.map((key) => (
              <kbd key={key} className="rounded border border-line bg-bg px-1 font-sans text-[11px] text-subtle">
                {key}
              </kbd>
            ))}
          </span>
        ) : null}
      </span>
    );
  };
  return (
    <div className="flex h-7 items-center rounded-md border border-line">
      {part("decrease", "w-7 rounded-l-[5px] text-subtle", <Minus size={14} strokeWidth={1.9} aria-hidden />)}
      {part("reset", "w-[52px] border-x border-line font-mono text-[12px] text-ink", props.value)}
      {part("increase", "w-7 rounded-r-[5px] text-subtle", <Plus size={14} strokeWidth={1.9} aria-hidden />)}
    </div>
  );
}

export function TextControl(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  // The setting's schema bound. Settings save on change through a schema parse
  // that throws on an over-long value, so a bounded setting must bound its input
  // — `maxLength` truncates typing and paste, and the caller clamps besides.
  maxLength?: number;
}) {
  return (
    <input
      type="text"
      spellCheck={false}
      aria-label={props.label}
      value={props.value}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      data-testid={props.testId}
      onChange={(event) => props.onChange(event.target.value)}
      className="h-8 w-40 rounded-md border border-line bg-bg px-2 font-mono text-[12px] text-ink placeholder:text-subtle focus:border-ink"
    />
  );
}

export function SwitchControl(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  // The change it asked for is still running.
  busy?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      aria-busy={props.busy || undefined}
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) props.onChange(!props.checked);
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress ${
        props.checked ? "border-accent bg-accent" : "border-line bg-line"
      }`}
    >
      {/* Anchored at the track's left edge: without left-0.5 the thumb
          started from the button's centered content and slid off the end. */}
      <span
        aria-hidden
        className={`absolute left-0.5 top-0.5 size-3.5 rounded-full transition-transform ${
          props.checked ? "translate-x-4 bg-bg" : "translate-x-0 bg-muted"
        }`}
      />
    </button>
  );
}

// Spelled out so Tailwind sees every class.
const HUE_FILLS: Record<AgentHue, string> = {
  olive: "bg-agent",
  rust: "bg-hue-rust",
  amber: "bg-hue-amber",
  teal: "bg-hue-teal",
  blue: "bg-hue-blue",
  indigo: "bg-hue-indigo",
  plum: "bg-hue-plum",
  rose: "bg-hue-rose",
};

/**
 * One swatch per hue. A person's swatches are round, and null checks none:
 * dohc picks the color. An agent's are rounded squares, the shapes of their
 * avatars, with olive first.
 *
 * The arrows choose as they move, unless `arrowsMoveFocus`: then they move
 * focus only and Enter or Space chooses, for a list where each choice saves.
 */
export function HueControl(props: {
  label: string;
  arrowsMoveFocus?: boolean;
} & (
  | { shape: "person"; value: IdentityHue | null; onChange: (value: IdentityHue) => void }
  | { shape: "agent"; value: AgentHue; onChange: (value: AgentHue) => void }
)) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hues: readonly AgentHue[] = props.shape === "agent" ? AGENT_HUES : IDENTITY_HUES;
  const currentIndex = props.value === null ? 0 : Math.max(0, hues.indexOf(props.value));
  const choose = (hue: AgentHue) => {
    if (props.shape === "agent") props.onChange(hue);
    else if (hue !== "olive") props.onChange(hue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const focused = optionRefs.current.indexOf(event.target as HTMLButtonElement);
    const index = ((focused >= 0 ? focused : currentIndex) + step + hues.length) % hues.length;
    if (!props.arrowsMoveFocus) choose(hues[index]!);
    optionRefs.current[index]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={props.label} onKeyDown={handleKeyDown} className="flex items-center gap-1.5">
      {hues.map((hue, index) => {
        const name = hue[0]!.toUpperCase() + hue.slice(1);
        return (
          <button
            key={hue}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-label={name}
            title={name}
            aria-checked={props.value === hue}
            tabIndex={index === currentIndex ? 0 : -1}
            onClick={() => choose(hue)}
            className={`grid size-5 place-items-center text-bg transition-opacity hover:opacity-80 ${
              props.shape === "person" ? "rounded-full" : "rounded-md"
            } ${HUE_FILLS[hue]}`}
          >
            {props.value === hue ? <Check size={12} strokeWidth={2.5} aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The system color picker. It saves when the picker closes, on the input's
 * native change event: React's onChange fires on every step of a drag.
 */
export function ColorControl(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const changed = () => onChange.current(input.value);
    input.addEventListener("change", changed);
    return () => input.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (inputRef.current) inputRef.current.value = props.value;
  }, [props.value]);
  return (
    <label className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="color"
        aria-label={props.label}
        defaultValue={props.value}
        className="h-6 w-8 cursor-pointer rounded-md border border-line bg-bg p-0.5"
      />
      <span className="font-mono text-[11px] text-muted">{props.value}</span>
    </label>
  );
}

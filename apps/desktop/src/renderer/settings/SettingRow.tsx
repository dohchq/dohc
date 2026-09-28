import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { IDENTITY_HUES, type IdentityHue } from "../tokens";

export function SettingRow(props: {
  title: string;
  description?: string;
  children: ReactNode;
  modified?: boolean;
  onReset?: () => void;
  testId?: string;
  // The row a Customize… command opened Settings for. Settings focuses it.
  highlighted?: boolean;
  // Under the description, such as the way to ask your agent.
  aside?: ReactNode;
}) {
  return (
    <div
      data-testid={props.testId}
      {...(props.highlighted
        ? { "data-highlighted": true, role: "group", "aria-label": props.title, tabIndex: -1 }
        : {})}
      className={`grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(220px,auto)] gap-4 border-b border-line py-3 last:border-b-0 max-[720px]:grid-cols-1 ${
        props.highlighted ? "-mx-3 rounded-lg bg-selected px-3" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{props.title}</span>
          {props.modified ? (
            <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase text-subtle">
              Modified
            </span>
          ) : null}
        </div>
        {props.description ? (
          <p className="m-0 mt-1 max-w-2xl text-[11px] leading-relaxed text-muted">
            {props.description}
          </p>
        ) : null}
        {props.aside ? <div className="mt-2">{props.aside}</div> : null}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2 max-[720px]:justify-start">
        {props.children}
        {props.modified && props.onReset ? (
          <button
            type="button"
            onClick={props.onReset}
            className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SegmentedControl<T extends string>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const currentIndex = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  );

  const focusOption = (index: number) => {
    const option = props.options[index];
    if (!option) return;
    props.onChange(option.value);
    optionRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.options.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusOption((currentIndex + 1) % props.options.length);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusOption((currentIndex - 1 + props.options.length) % props.options.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(props.options.length - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={handleKeyDown}
      className="inline-flex rounded-md border border-line bg-panel-2 p-0.5"
    >
      {props.options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            optionRefs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          tabIndex={index === currentIndex ? 0 : -1}
          onClick={() => props.onChange(option.value)}
          className={`min-w-16 rounded px-2 py-1 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            props.value === option.value
              ? "bg-bg text-ink shadow-sm"
              : "text-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
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
      className="h-7 w-40 rounded-md border border-line bg-bg px-2 font-mono text-[11px] text-ink placeholder:text-subtle focus:border-ink"
    />
  );
}

export function SwitchControl(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) props.onChange(!props.checked);
      }}
      className={`relative h-5 w-9 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
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
const HUE_FILLS: Record<IdentityHue, string> = {
  rust: "bg-hue-rust",
  amber: "bg-hue-amber",
  olive: "bg-hue-olive",
  teal: "bg-hue-teal",
  blue: "bg-hue-blue",
  indigo: "bg-hue-indigo",
  plum: "bg-hue-plum",
  rose: "bg-hue-rose",
};

/**
 * One swatch per identity hue. A person's swatches are round and an agent's
 * are rounded squares, the shapes of their avatars. null checks none: dohc
 * picks the color.
 */
export function HueControl(props: {
  label: string;
  value: IdentityHue | null;
  shape: "person" | "agent";
  onChange: (value: IdentityHue) => void;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const currentIndex = Math.max(0, props.value === null ? 0 : IDENTITY_HUES.indexOf(props.value));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = (currentIndex + step + IDENTITY_HUES.length) % IDENTITY_HUES.length;
    props.onChange(IDENTITY_HUES[index]!);
    optionRefs.current[index]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={props.label} onKeyDown={handleKeyDown} className="flex items-center gap-1.5">
      {IDENTITY_HUES.map((hue, index) => (
        <button
          key={hue}
          ref={(element) => {
            optionRefs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-label={hue[0]!.toUpperCase() + hue.slice(1)}
          title={hue[0]!.toUpperCase() + hue.slice(1)}
          aria-checked={props.value === hue}
          tabIndex={index === currentIndex ? 0 : -1}
          onClick={() => props.onChange(hue)}
          className={`grid size-5 place-items-center text-bg transition-opacity hover:opacity-80 ${
            props.shape === "person" ? "rounded-full" : "rounded-md"
          } ${HUE_FILLS[hue]}`}
        >
          {props.value === hue ? <Check size={12} strokeWidth={2.5} aria-hidden /> : null}
        </button>
      ))}
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

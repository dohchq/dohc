import { useRef, type KeyboardEvent, type ReactNode } from "react";

export function SettingRow(props: {
  title: string;
  description: string;
  children: ReactNode;
  modified?: boolean;
  onReset?: () => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={props.testId}
      className="grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(220px,auto)] gap-4 border-b border-line py-3 last:border-b-0 max-[720px]:grid-cols-1"
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
        <p className="m-0 mt-1 max-w-2xl text-[11px] leading-relaxed text-muted">
          {props.description}
        </p>
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2 max-[720px]:justify-start">
        {props.children}
        {props.modified && props.onReset ? (
          <button
            type="button"
            onClick={props.onReset}
            className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
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

export function SwitchControl(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      className={`relative h-5 w-9 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        props.checked ? "border-ink bg-ink" : "border-line bg-panel-2"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 size-3.5 rounded-full bg-bg transition-transform ${
          props.checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

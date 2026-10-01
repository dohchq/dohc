import { useRef, type KeyboardEvent } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

/**
 * One choice among a few, as a radiogroup of radios. The arrow keys move the
 * choice and the focus together, Home and End go to the ends, and only the
 * chosen option is in the tab order. A disabled option is skipped; a disabled
 * group takes no input.
 */
export function SegmentedControl<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = (index: number) => !props.disabled && props.options[index]?.disabled !== true;
  const currentIndex = props.options.findIndex((option) => option.value === props.value);
  const firstEnabled = props.options.findIndex((_, index) => enabled(index));
  const tabbableIndex = currentIndex >= 0 && enabled(currentIndex) ? currentIndex : firstEnabled;

  const choose = (index: number) => {
    const option = props.options[index];
    if (!option || !enabled(index)) return;
    props.onChange(option.value);
    optionRefs.current[index]?.focus();
  };

  // The next enabled option from `from` in `direction`, wrapping.
  const step = (from: number, direction: 1 | -1) => {
    const count = props.options.length;
    for (let moved = 1; moved <= count; moved += 1) {
      const index = (((from + direction * moved) % count) + count) % count;
      if (enabled(index)) return index;
    }
    return -1;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled || props.options.length === 0) return;
    // The arrows move from the focused radio. The checked one can be disabled
    // or absent, and then the tab stop is where the person started from.
    const focused = optionRefs.current.indexOf(event.target as HTMLButtonElement);
    const from = focused >= 0 ? focused : tabbableIndex;
    let target: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = step(from, 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = step(Math.max(from, 0), -1);
    else if (event.key === "Home") target = firstEnabled;
    else if (event.key === "End") target = step(0, -1);
    else return;
    event.preventDefault();
    choose(target);
  };

  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={handleKeyDown}
      className="flex rounded-lg border border-line bg-panel-2 p-0.5"
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
          disabled={!enabled(index)}
          tabIndex={index === tabbableIndex ? 0 : -1}
          onClick={() => props.onChange(option.value)}
          className={`flex-1 rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
            props.value === option.value
              ? "bg-bg text-ink shadow-sm"
              : "text-muted enabled:hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

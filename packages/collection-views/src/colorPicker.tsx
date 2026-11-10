import { useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { OPTION_COLORS, type OptionColor } from "@dohc/workspace-contracts";
import { optionTone } from "./values";

export function optionColorName(color: OptionColor): string {
  return color[0]!.toUpperCase() + color.slice(1);
}

/**
 * One swatch per option color. Arrows move focus and Enter or Space
 * chooses, because each choice saves.
 */
export function OptionColorPicker(props: {
  label: string;
  value: OptionColor;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (color: OptionColor) => void;
}) {
  const swatches = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(0, OPTION_COLORS.indexOf(props.value));
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const focused = swatches.current.indexOf(event.target as HTMLButtonElement);
    const next = ((focused >= 0 ? focused : current) + step + OPTION_COLORS.length) % OPTION_COLORS.length;
    swatches.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={props.label} onKeyDown={move} className="flex items-center gap-1">
      {OPTION_COLORS.map((color, index) => {
        const name = optionColorName(color);
        const chosen = props.value === color;
        return (
          <button
            key={color}
            ref={(element) => {
              swatches.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-label={name}
            title={name}
            aria-checked={chosen}
            disabled={props.disabled}
            autoFocus={props.autoFocus && chosen}
            tabIndex={index === current ? 0 : -1}
            onClick={() => props.onChange(color)}
            className={`grid size-5 place-items-center rounded-full text-bg transition-transform duration-75 hover:scale-110 disabled:opacity-50 disabled:hover:scale-100 ${optionTone(color).dot}`}
          >
            {chosen ? <Check size={12} strokeWidth={2.75} aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

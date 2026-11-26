import { ChevronDown, type LucideIcon } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  MENU_ACTIVE_OPTION,
  MENU_DETAIL,
  MENU_ENTER,
  MENU_FRAME,
  MENU_ICON,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_TONE,
  MENU_TITLE,
  movedPointer,
  revealMenuRow,
} from "./Menu";
import { isComposingKey } from "./keys";

export type Suggestion = {
  /** What picking it puts in the field. */
  value: string;
  label: string;
  detail?: string;
};

const SHOWN = 50;

/**
 * A text field with a list of suggestions under it. Typing filters the list,
 * and the person can still enter something the list doesn't have. The list
 * opens on typing, on the arrow keys, or from the chevron.
 */
export function SuggestInput(props: {
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly Suggestion[];
  /** The field's accessible name, when no visible label names it. */
  label?: string;
  listLabel: string;
  icon: LucideIcon;
  name?: string;
  id?: string;
  type?: "text" | "email";
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [shown, setShown] = useState(false);
  // The value of the row the arrow keys or the pointer chose. None until
  // then, so Enter after typing keeps what was typed. It follows the value
  // rather than a position, so a list that changes never puts another row
  // under Enter.
  const [active, setActive] = useState<string | null>(null);
  const Icon = props.icon;

  const options = useMemo(() => {
    const query = props.value.trim().toLowerCase();
    const matches = query
      ? props.suggestions.filter((option) =>
          `${option.label}\n${option.detail ?? ""}\n${option.value}`.toLowerCase().includes(query),
        )
      : props.suggestions;
    return matches.slice(0, SHOWN);
  }, [props.suggestions, props.value]);
  // A value the list doesn't have is still a fine answer, so nothing to
  // offer shows no list at all.
  const open = shown && !props.disabled && options.length > 0;
  const activeIndex = options.findIndex((option) => option.value === active);
  const optionId = (index: number) => `${id}-option-${index}`;

  const pick = (option: Suggestion) => {
    props.onChange(option.value);
    setShown(false);
  };
  // Only the list scrolls to show a row the arrow keys chose. A row the
  // pointer is on stays put, so the click lands on it.
  const reveal = useRef(false);
  useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    if (open && list.current && activeIndex >= 0)
      revealMenuRow(
        list.current,
        list.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`),
      );
  });

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isComposingKey(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // From no row, ArrowDown goes to the first and ArrowUp to the last.
      const down = event.key === "ArrowDown";
      const next =
        open && activeIndex >= 0
          ? (activeIndex + (down ? 1 : -1) + options.length) % options.length
          : down
            ? 0
            : options.length - 1;
      reveal.current = true;
      setShown(true);
      setActive(options[next]?.value ?? null);
      return;
    }
    // The Overlay leaves this Escape to an open list, so it closes the list
    // and the next one closes the dialog.
    if (event.key === "Escape" && open) {
      setShown(false);
      return;
    }
    // Enter picks a row the person chose, and otherwise submits the form.
    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      pick(options[activeIndex]);
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <div
        // The field draws the keyboard halo around the whole box, chevron
        // included, so the input inside it wears none of its own.
        className={`flex h-8 items-center gap-2 rounded-md border bg-bg pl-2 text-[13px] focus-within:border-ink keyboard:has-[input:focus-visible]:outline-2 keyboard:has-[input:focus-visible]:outline-focus ${
          props.invalid ? "border-danger" : "border-line"
        } ${props.disabled ? "opacity-60" : ""}`}
      >
        <Icon size={14} aria-hidden className="shrink-0 text-subtle" />
        <input
          ref={field}
          id={props.id}
          name={props.name}
          type={props.type ?? "text"}
          role="combobox"
          aria-label={props.label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-invalid={props.invalid || undefined}
          aria-describedby={props.describedBy}
          autoComplete="off"
          spellCheck={false}
          autoFocus={props.autoFocus}
          disabled={props.disabled}
          value={props.value}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          onChange={(event) => {
            props.onChange(event.target.value);
            setShown(true);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setShown(false)}
          className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none! placeholder:text-subtle focus:shadow-none!"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Show ${props.listLabel.toLowerCase()}`}
          title={`Show ${props.listLabel.toLowerCase()}`}
          disabled={props.disabled}
          // Keep focus in the field, so the list stays open.
          onMouseDown={(event) => {
            if (event.button === 0) event.preventDefault();
          }}
          onClick={() => {
            field.current?.focus();
            setShown(!open);
            setActive(null);
          }}
          className="grid h-full w-7 shrink-0 place-items-center rounded-r-md text-subtle transition-colors hover:text-ink"
        >
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
      {open ? (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={props.listLabel}
          className={`${MENU_FRAME} ${MENU_ENTER} absolute inset-x-0 top-full z-10 m-0 mt-1 max-h-60 list-none`}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              data-index={index}
              data-active={index === activeIndex || undefined}
              onMouseDown={(event) => {
                if (event.button === 0) event.preventDefault();
              }}
              onClick={() => pick(option)}
              onMouseMove={(event) => {
                if (movedPointer(event)) setActive(option.value);
              }}
              className={`${MENU_ROW} ${MENU_ACTIVE_OPTION} ${MENU_ROW_TONE.rest} h-8 cursor-pointer data-active:text-ink`}
            >
              <span className={MENU_ICON}>
                <Icon size={14} aria-hidden />
              </span>
              <span className={option.detail ? MENU_TITLE : MENU_LABEL}>{option.label}</span>
              {option.detail ? <span className={MENU_DETAIL}>{option.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

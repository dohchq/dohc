import { Plus, Trash2, X } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, type Ref } from "react";
import { MAX_POLL_CHOICE_LENGTH, MAX_POLL_CHOICES, repeatedPollChoices, trimChoice, type PollDraft } from "./chatPoll";

const GHOST_ICON =
  "grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink dohc-focus-visible disabled:opacity-40";

// A poll's choices while it is written. Each row looks like the choice it
// posts as. Enter moves to the next choice, adding one at the end while there
// is room; Backspace in an empty choice removes it and moves up.
export function ComposerPoll(props: {
  testIdPrefix: string;
  choices: PollDraft;
  disabled: boolean;
  surface: "stream" | "post";
  onChange: (choices: PollDraft) => void;
  // Removes the whole poll. The composer keeps its choices for when a poll
  // is opened again.
  onRemove: () => void;
  onFocusQuestion: () => void;
  rootRef?: Ref<HTMLFieldSetElement>;
}) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  // The choice to focus once the new choices have rendered.
  const pendingFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    inputs.current[index]?.focus();
  }, [props.choices]);
  // Moves focus to the choice at `focusAfter`, or to the question below zero.
  const remove = (index: number, focusAfter: number) => {
    if (focusAfter >= 0) pendingFocus.current = focusAfter;
    else props.onFocusQuestion();
    props.onChange(props.choices.filter((_, at) => at !== index));
  };
  const add = () => {
    pendingFocus.current = props.choices.length;
    props.onChange([...props.choices, ""]);
  };
  const repeated = repeatedPollChoices(props.choices);
  // One message, under the first repeat, naming the choice it repeats.
  const firstRepeat = repeated.size > 0 ? Math.min(...repeated) : -1;
  const repeatedText = firstRepeat >= 0 ? trimChoice(props.choices[firstRepeat]!) : null;
  const errorId = `${props.testIdPrefix}-poll-error`;
  const canAdd = props.choices.length < MAX_POLL_CHOICES;
  return (
    <fieldset
      ref={props.rootRef}
      data-testid={`${props.testIdPrefix}-poll`}
      aria-label="Poll"
      disabled={props.disabled}
      className={`flex min-w-0 flex-col gap-1 ${
        props.surface === "post" ? "mt-2" : "border-x border-t border-line bg-panel-2 px-2.5 py-2"
      }`}
    >
      {props.choices.map((choice, index) => {
        const isRepeat = repeated.has(index);
        const named = isRepeat && trimChoice(choice) === repeatedText;
        return (
          <Fragment key={index}>
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-3.5 shrink-0 rounded-full border border-line" />
              <input
                ref={(node) => { inputs.current[index] = node; }}
                data-testid={`${props.testIdPrefix}-poll-choice`}
                aria-label={`Choice ${index + 1}`}
                aria-invalid={isRepeat || undefined}
                aria-describedby={named ? errorId : undefined}
                placeholder={`Choice ${index + 1}`}
                maxLength={MAX_POLL_CHOICE_LENGTH}
                value={choice}
                onChange={(event) =>
                  props.onChange(props.choices.map((entry, at) => (at === index ? event.target.value : entry)))
                }
                onKeyDown={(event) => {
                  // IME guard first: Enter confirms the composed characters.
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    // Never the form's send: Enter here moves between choices.
                    event.preventDefault();
                    if (index + 1 < props.choices.length) inputs.current[index + 1]?.focus();
                    else if (canAdd) add();
                    return;
                  }
                  if (event.key === "Backspace" && choice.length === 0 && props.choices.length > 1) {
                    event.preventDefault();
                    remove(index, index - 1);
                  }
                }}
                // A repeat stays red while the person is still typing in it.
                // dohc-focus-input sets the focused border too and comes later
                // in the stylesheet, so the red is marked important.
                className={`h-7 min-w-0 flex-1 rounded-md border bg-bg px-2.5 text-[13px] text-ink placeholder:text-subtle dohc-focus-input ${
                  isRepeat ? "border-danger focus:border-danger!" : "border-line"
                }`}
              />
              <button
                type="button"
                data-testid={`${props.testIdPrefix}-poll-remove-choice`}
                aria-label={`Remove choice ${index + 1}`}
                title="Remove choice"
                disabled={props.choices.length === 1}
                onClick={() => remove(index, Math.min(index, props.choices.length - 2))}
                className={GHOST_ICON}
              >
                <X size={12} aria-hidden />
              </button>
            </div>
            {index === firstRepeat ? (
              <p id={errorId} data-testid={`${props.testIdPrefix}-poll-error`} role="alert" className="m-0 pl-5.5 text-[11px] text-danger">
                {repeatedText} is already a choice.
              </p>
            ) : null}
          </Fragment>
        );
      })}
      <div className="flex items-center gap-1">
        {/* The plus sits in the circles' column and its words under the choices. */}
        {canAdd ? (
          <button
            type="button"
            data-testid={`${props.testIdPrefix}-poll-add`}
            onClick={add}
            className="-ml-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-ink dohc-focus-visible"
          >
            <Plus size={12} aria-hidden />
            Add a choice
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          data-testid={`${props.testIdPrefix}-poll-remove`}
          aria-label="Remove poll"
          title="Remove poll"
          onClick={props.onRemove}
          className={GHOST_ICON}
        >
          <Trash2 size={12} aria-hidden />
        </button>
      </div>
    </fieldset>
  );
}

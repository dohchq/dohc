import { SecondaryButton } from "../ui/controls";

/** A calendar view whose Collection has no date field to place records by. Only someone who can change fields gets the button. */
export function CalendarNeedsDateField(props: { disabled?: boolean; onAddDateField?: () => void }) {
  return (
    <div className="flex min-h-60 flex-1 flex-col items-center justify-center gap-4 text-center">
      <span className="text-sm text-muted">A calendar needs a date field.</span>
      {props.onAddDateField ? (
        <SecondaryButton type="button" disabled={props.disabled} onClick={props.onAddDateField}>
          Add a date field
        </SecondaryButton>
      ) : null}
    </div>
  );
}

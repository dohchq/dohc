import { CalendarDays } from "lucide-react";
import { SecondaryButton } from "../ui/controls";

/** A calendar view whose Collection has no date field to place records by. Only someone who can change fields gets the button. */
export function CalendarNeedsDateField(props: { disabled?: boolean; onAddDateField?: () => void }) {
  return (
    <div className="flex min-h-60 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-xl border border-line bg-panel-2 text-muted"
      >
        <CalendarDays size={18} strokeWidth={1.8} />
      </span>
      <span className="text-sm text-muted">A calendar needs a date field.</span>
      {props.onAddDateField ? (
        <SecondaryButton type="button" disabled={props.disabled} onClick={props.onAddDateField}>
          Add a date field
        </SecondaryButton>
      ) : null}
    </div>
  );
}

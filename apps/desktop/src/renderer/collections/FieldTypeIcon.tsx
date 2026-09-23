import { CalendarDays, CheckSquare, Hash, Link, List, ListChecks, Paperclip, Type, User } from "lucide-react";

export function FieldTypeIcon({ type, className = "shrink-0 text-muted" }: { type: string; className?: string }) {
  const Icon = type === "number" ? Hash : type === "date" ? CalendarDays : type === "checkbox" ? CheckSquare
    : type === "select" ? List : type === "multi-select" ? ListChecks : type === "attachment" ? Paperclip
      : type === "relation" || type === "url" ? Link : type === "person" ? User : Type;
  return <Icon size={14} strokeWidth={1.9} aria-hidden className={className} />;
}

import { collectionWords } from "@dohc/interface-words/collections";
import type { CollectionField, RecordValue } from "../server/phoneCollections";

// How the phone shows a record's values, read-only and plain, by field type.

export type ShownValue =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "check"; readonly checked: boolean }
  /** A web address, which opens through the external-link rule (src/apps/appNavigation.ts). */
  | { readonly kind: "link"; readonly url: string };

const EMPTY: ShownValue = { kind: "empty" };
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const plain = (value: RecordValue): string =>
  Array.isArray(value)
    ? value.map(plain).join(", ")
    : typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value);

/** A date as the phone's locale writes it: a day alone, or a day and time. Anything else as it is. */
function date(value: string): string {
  const day = DAY.exec(value);
  if (day) {
    const shown = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return shown.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  const moment = new Date(value);
  return Number.isNaN(moment.getTime())
    ? value
    : moment.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** One field's value. `files` names attached files by ID. */
export function shownValue(
  field: Pick<CollectionField, "type">,
  value: RecordValue | undefined,
  files: Readonly<Record<string, string>>,
): ShownValue {
  if (field.type === "checkbox") return { kind: "check", checked: value === true };
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
    return EMPTY;
  switch (field.type) {
    case "date":
      return { kind: "text", text: typeof value === "string" ? date(value) : plain(value) };
    case "url":
      return typeof value === "string"
        ? { kind: "link", url: value }
        : { kind: "text", text: plain(value) };
    case "attachment":
      return {
        kind: "text",
        text:
          typeof value === "string" ? (files[value] ?? collectionWords.attachedFile) : plain(value),
      };
    // Text, a number, a choice or several, and a relation's record IDs.
    default:
      return { kind: "text", text: plain(value) };
  }
}

/** A value as one line of a record's row: a link's address, and a checkbox as its field's name only when checked. */
export function rowText(shown: ShownValue, fieldName: string): string | null {
  switch (shown.kind) {
    case "empty":
      return null;
    case "check":
      return shown.checked ? fieldName : null;
    case "link":
      return shown.url;
    default:
      return shown.text;
  }
}

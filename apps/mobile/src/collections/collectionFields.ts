import { collectionWords } from "@dohc/interface-words/collections";
import {
  isRelationKey,
  type CollectionField,
  type CreateCollectionField,
  type RecordId,
  type RecordValue,
  type RelationLabels,
} from "../server/phoneCollections";

// How the phone shows a record's values, read-only and plain, by field type.

export type ShownValue =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "check"; readonly checked: boolean }
  /** A web address, which opens through the external-link rule (src/apps/appNavigation.ts). */
  | { readonly kind: "link"; readonly url: string };

const EMPTY: ShownValue = { kind: "empty" };
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
let fieldOffset = Number.NaN;
let dayFormat: Intl.DateTimeFormat;
let momentFormat: Intl.DateTimeFormat;
function ensureFieldFormats() {
  const offset = new Date().getTimezoneOffset();
  if (offset === fieldOffset) return;
  fieldOffset = offset;
  dayFormat = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  momentFormat = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const plain = (value: RecordValue): string =>
  Array.isArray(value)
    ? value.map(plain).join(", ")
    : typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value);

/** A date as the phone's locale writes it: a day alone, or a day and time. Anything else as it is. */
function date(value: string): string {
  ensureFieldFormats();
  const day = DAY.exec(value);
  if (day) {
    const shown = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return dayFormat.format(shown);
  }
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? value : momentFormat.format(moment);
}

/** One field's value. `files` names attached files by ID; `relationLabels` maps JSON-encoded keys to labels. */
export function shownValue(
  field: Pick<CollectionField, "type">,
  value: RecordValue | undefined,
  files: Readonly<Record<string, string>>,
  relationLabels?: Readonly<Record<string, string>>,
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
    case "relation": {
      const label = (item: RecordValue) => relationLabels?.[JSON.stringify(item)] ?? plain(item);
      return {
        kind: "text",
        text: Array.isArray(value) ? value.map(label).join(", ") : label(value),
      };
    }
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

/** A record's name, from the field that names it: Untitled when it has none, or only spaces, as on the desktop. */
export function recordName(
  lead: CollectionField | null,
  values: Readonly<Record<string, RecordValue>>,
  files: Readonly<Record<string, string>>,
  relations?: RelationLabels,
): string {
  const text =
    lead &&
    rowText(shownValue(lead, values[lead.fieldId], files, relations?.[lead.fieldId]), lead.name);
  return text?.trim() ? text : collectionWords.untitledRecord;
}

export const supportsSearch = (fields: readonly Pick<CollectionField, "type">[]): boolean =>
  fields.some((f) => f.type === "text" || f.type === "url" || f.type === "select");

export const supportsSort = (field: Pick<CollectionField, "type" | "relation">): boolean =>
  field.type !== "attachment" &&
  field.type !== "multi-select" &&
  (field.type !== "relation" || field.relation?.many === false);

export type EditorKind =
  | "text"
  | "number"
  | "url"
  | "checkbox"
  | "select"
  | "multi-select"
  | "date"
  | "relation";

export function editorKind(field: Pick<CollectionField, "type" | "relation">): EditorKind | null {
  if (field.type === "relation") return field.relation ? "relation" : null;
  return field.type === "attachment" ? null : field.type;
}

/**
 * A date field's day, `YYYY-MM-DD` as the Collection takes it, at local midnight; null for anything else. Read in local
 * calendar terms, never through UTC, so a picker shows the stored day in every time zone.
 */
export function dateOf(day: string): Date | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const date = new Date(2000, 0, 1);
  // setFullYear, unlike the constructor, keeps years before 100.
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dayOf(date) === day ? date : null;
}

/** The local calendar day a picked date falls on, as a date field stores it. */
export function dayOf(date: Date): string {
  const pad = (part: number, width = 2) => String(part).padStart(width, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type Draft = string | boolean | readonly RecordId[];

/** A date starts from today when editing alone and empty, or empty in a multi-field form. */
export function draftOf(
  field: Pick<CollectionField, "type" | "relation">,
  value: RecordValue | undefined,
  options?: { readonly emptyDate?: boolean },
): Draft {
  switch (field.type) {
    case "date":
      return typeof value === "string" && dateOf(value)
        ? value
        : options?.emptyDate
          ? ""
          : dayOf(new Date());
    case "checkbox":
      return value === true;
    case "select":
      return typeof value === "string" ? [value] : [];
    case "multi-select":
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    case "relation":
      return field.relation?.many
        ? Array.isArray(value)
          ? value.filter(isRelationKey)
          : []
        : isRelationKey(value)
          ? [value]
          : [];
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * The value an editor saves, which the Collection checks; empty saves as null. Null for text that isn't a number, which
 * the editor keeps rather than send as null and empty the field.
 */
export function valueOf(
  field: Pick<CollectionField, "type" | "options" | "relation">,
  draft: Draft,
): { readonly value: RecordValue } | null {
  if (field.type === "checkbox") return { value: draft === true };
  if (field.type === "select" || field.type === "multi-select") {
    const chosen = Array.isArray(draft) ? field.options.filter((item) => draft.includes(item)) : [];
    return { value: field.type === "multi-select" ? chosen : (chosen[0] ?? null) };
  }
  if (field.type === "relation") {
    const chosen = Array.isArray(draft) ? draft.filter(isRelationKey) : [];
    return { value: field.relation?.many ? chosen : (chosen[0] ?? null) };
  }
  if (typeof draft !== "string") return { value: null };
  if (field.type === "text") return { value: draft === "" ? null : draft };
  const typed = draft.trim();
  if (typed === "") return { value: null };
  if (field.type !== "number") return { value: typed };
  // A decimal comma, as some keyboards type it.
  const number = typed.replace(",", ".");
  return NUMBER.test(number) && Number.isFinite(Number(number)) ? { value: Number(number) } : null;
}

export function draftProblem(
  field: Pick<CreateCollectionField, "name" | "type" | "required" | "options" | "relation">,
  draft: Draft,
): string | null {
  const parsed = valueOf(field, draft);
  if (!parsed) return collectionWords.enterNumber;
  const v = parsed.value;
  const empty = v === null || v === "" || (Array.isArray(v) && v.length === 0);
  if (empty) {
    if (!field.required) return null;
    return ["relation", "select", "multi-select", "date"].includes(field.type)
      ? collectionWords.chooseField(field.name)
      : collectionWords.enterField(field.name);
  }
  if (field.type === "url" && typeof v === "string") {
    try {
      if (/\s/u.test(v) || !["http:", "https:"].includes(new URL(v).protocol))
        return collectionWords.enterUrl;
    } catch {
      return collectionWords.enterUrl;
    }
  }
  if (field.type === "relation" && field.relation?.many && Array.isArray(v) && v.length > 100)
    return collectionWords.tooManyRelations;
  return null;
}

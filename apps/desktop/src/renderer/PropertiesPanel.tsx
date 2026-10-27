import {
  FRONTMATTER_SOURCE_META_KEY,
  frontmatterEditsRefused,
  loadMarkdownFrontmatter,
  markdownFrontmatterEditsRefused,
  nullPrototypeRecord,
} from "@dohc/ydoc-projection/frontmatter";
import { frontmatterMapValues, patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { Tooltip, useTooltip } from "@dohc/collection-views/tooltip";
import { Lock, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { AutomationFieldMark } from "./collections/collectionFieldMarks";
import {
  applyFrontmatter,
  FRONTMATTER_EDIT_REFUSED_MESSAGE,
  frontmatterEntries,
  frontmatterEntriesFromPairs,
  type FrontmatterEntry,
  listItems,
} from "./markdown/frontmatter";
import { PROPERTIES_LINE, PROPERTIES_PANEL, TOPMATTER_FLAG } from "./pageTopmatter";

const HIDDEN_KEYS = new Set(["id", "title", "icon"]);
const FRONTMATTER_FIELD = "frontmatter";

// Each property is one pill: its name, then its value. The inputs size to
// their text, so a pill is as wide as what it says.
const PILL =
  "group/pill relative inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-line px-[9px] text-[12px] transition-colors duration-100 hover:bg-hover focus-within:border-muted";
const ADD =
  "grid size-6 shrink-0 place-items-center rounded-full border border-dashed border-line text-subtle";
const PILL_FIELD =
  "h-5 min-w-[2ch] max-w-64 text-ellipsis border-0 bg-transparent p-0 leading-5 field-sizing-content placeholder:text-subtle";

export type PropertiesPanelProps = (
  | {
      body: string;
      onChange: (nextBody: string) => void;
      ydoc?: never;
    }
  | {
      ydoc: Y.Doc;
      body?: never;
      onChange?: never;
    }
) & {
  // For a Collection record: the automations that set each field, by name.
  fieldMarks?: ReadonlyMap<string, readonly string[]>;
  // A document still opening shows its properties where they will be and
  // refuses edits until it opens: no write, no ×, and the + holds its box.
  opening?: boolean;
};

function isReserved(key: string): boolean {
  return HIDDEN_KEYS.has(key.trim().toLowerCase());
}

function editableKey(entry: FrontmatterEntry): string | null {
  const key = entry.key.trim();
  if (!key || isReserved(key)) return null;
  return key;
}

function duplicateKeySet(entries: FrontmatterEntry[]): Set<string> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = editableKey(entry)?.toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([key]) => key),
  );
}

function hasDuplicateKeys(entries: FrontmatterEntry[]): boolean {
  return duplicateKeySet(entries).size > 0;
}

function shouldDeferKeyCommit(
  index: number,
  key: string,
  entries: FrontmatterEntry[],
): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return true;
  if (Array.from(HIDDEN_KEYS).some((reserved) => reserved.startsWith(normalized))) {
    return true;
  }
  return entries.some((entry, i) => {
    if (i === index) return false;
    return editableKey(entry)?.toLowerCase().startsWith(normalized) ?? false;
  });
}

function editableEntries(entries: FrontmatterEntry[]): FrontmatterEntry[] {
  return entries.filter((entry) => !isReserved(entry.key));
}

function buildProperties(
  currentEntries: FrontmatterEntry[],
  nextEntries: FrontmatterEntry[],
): Record<string, unknown> {
  // A property named `__proto__` stays a property.
  const props = nullPrototypeRecord();
  for (const entry of currentEntries) {
    if (isReserved(entry.key)) props[entry.key] = entryValue(entry);
  }
  for (const entry of nextEntries) {
    const key = propertyKey(entry);
    if (key) props[key] = entryValue(entry);
  }
  return props;
}

function entryValue(entry: FrontmatterEntry): unknown {
  if (entry.sourceValue === entry.value && Object.hasOwn(entry, "rawValue")) {
    return entry.rawValue;
  }
  return entry.list ? listItems(entry.value) : entry.value;
}

function propertyKey(entry: FrontmatterEntry): string | null {
  const key = editableKey(entry);
  if (!key) {
    return entry.sourceKey && !isReserved(entry.sourceKey) ? entry.sourceKey : null;
  }
  return key;
}

function valuesByEditableKey(entries: FrontmatterEntry[]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const entry of entries) {
    const key = propertyKey(entry);
    if (key) values.set(key, entryValue(entry));
  }
  return values;
}

/** Each renamed property's old key and new key. */
function renamedKeys(
  previousEntries: FrontmatterEntry[],
  nextEntries: FrontmatterEntry[],
): Map<string, string> {
  const previous = valuesByEditableKey(previousEntries);
  const next = valuesByEditableKey(nextEntries);
  const renamed = new Map<string, string>();
  for (const entry of nextEntries) {
    const to = propertyKey(entry);
    if (entry.sourceKey !== undefined && to !== null && entry.sourceKey !== to
      && previous.has(entry.sourceKey) && !next.has(entry.sourceKey)) {
      renamed.set(entry.sourceKey, to);
    }
  }
  return renamed;
}

// A live document's map adds a renamed key last. Rows keep the order they
// show, so the row being renamed stays under the person typing. A key renamed
// on another device takes the row its old key left; other new keys follow.
function inShownOrder(entries: FrontmatterEntry[], shown: FrontmatterEntry[]): FrontmatterEntry[] {
  const rows = entries.map((entry) => {
    const held = shown.findIndex((candidate) => candidate.sourceKey === entry.key);
    return held === -1 ? shown.findIndex((candidate) => propertyKey(candidate) === entry.key) : held;
  });
  const left = shown.flatMap((_, row) => (rows.includes(row) ? [] : [row]));
  const added = rows.flatMap((row, index) => (row === -1 ? [index] : []));
  if (left.length === 1 && added.length === 1) rows[added[0]!] = left[0]!;
  return entries
    .map((entry, index) => ({ entry, row: rows[index] === -1 ? shown.length : rows[index]! }))
    .sort((first, second) => first.row - second.row)
    .map(({ entry }) => entry);
}

function applySharedFrontmatterPatch(
  doc: Y.Doc,
  previousEntries: FrontmatterEntry[],
  nextEntries: FrontmatterEntry[],
) {
  const previous = valuesByEditableKey(previousEntries);
  const next = valuesByEditableKey(nextEntries);

  const remove = [...previous.keys()].filter(key => !next.has(key));
  // A row holds the key and value it was read or written with. A row the
  // person left alone never writes, whatever a later read decoded for it.
  const values = new Map<string, unknown>();
  for (const entry of nextEntries) {
    const key = propertyKey(entry);
    if (key !== null && (key !== entry.sourceKey || entry.value !== entry.sourceValue)) {
      values.set(key, entryValue(entry));
    }
  }
  patchFrontmatter(doc, values, remove, renamedKeys(previousEntries, nextEntries));
}

// The map has no order of its own, so rows follow the kept text, as the file
// does. Keys the text does not hold follow in map order. Values arrive decoded,
// so a shared-type value shows as the YAML the file holds.
function liveEntries(doc: Y.Doc): FrontmatterEntry[] {
  const source = doc.getMap("meta").get(FRONTMATTER_SOURCE_META_KEY);
  const order = typeof source === "string" ? (loadMarkdownFrontmatter(source)?.keys ?? []) : [];
  const place = (key: string): number => (order.includes(key) ? order.indexOf(key) : order.length);
  const map = doc.getMap(FRONTMATTER_FIELD);
  const values = frontmatterMapValues(map);
  return frontmatterEntriesFromPairs(Array.from(map.keys(), (key) => [key, values[key]] as const))
    .map((entry) => ({ entry, place: place(entry.key) }))
    .sort((first, second) => first.place - second.place)
    .map(({ entry }) => entry);
}

// A value the pill shows but can't change, such as a list with a comma in an
// item. The lock is always there; the pointer or keyboard focus shows why,
// with the whole value.
function ReadOnlyValue(props: { label: string; value: string; reason: string }) {
  const tooltip = useTooltip();
  return (
    <span {...tooltip.hoverProps} className="relative inline-flex min-w-0 items-center gap-1">
      <input
        {...tooltip.focusProps}
        data-testid="property-value"
        aria-label={props.label}
        value={props.value}
        readOnly
        spellCheck={false}
        className={`${PILL_FIELD} cursor-default text-ink`}
      />
      <Lock size={11} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
      <Tooltip {...tooltip.tooltipProps}>
        <span className="block wrap-anywhere">{props.value}</span>
        <span data-testid="property-read-only" className="mt-0.5 block text-muted">{props.reason}</span>
      </Tooltip>
    </span>
  );
}

export function PropertiesPanel(props: PropertiesPanelProps) {
  const ydoc = props.ydoc ?? null;
  const body = props.body ?? "";
  const [ydocRevision, setYdocRevision] = useState(0);
  const [editRefused, setEditRefused] = useState(false);
  const sourceEntries = useMemo(
    () => (ydoc ? liveEntries(ydoc) : frontmatterEntries(body)),
    [body, ydoc, ydocRevision],
  );
  const [entries, setEntries] = useState<FrontmatterEntry[]>(() =>
    editableEntries(sourceEntries),
  );

  useEffect(() => {
    if (!ydoc) return;
    const map = ydoc.getMap(FRONTMATTER_FIELD);
    const update = () => setYdocRevision((revision) => revision + 1);
    map.observe(update);
    return () => map.unobserve(update);
  }, [ydoc]);

  useEffect(() => {
    // This can apply after the person's next keystroke has changed the
    // document, so a live document's rows read the document as it is now.
    setEntries((shown) =>
      ydoc ? inShownOrder(editableEntries(liveEntries(ydoc)), shown) : editableEntries(sourceEntries),
    );
    setEditRefused(false);
  }, [sourceEntries, ydoc]);

  // An unsplittable block cannot change one property without
  // rewriting the others, so the panel refuses edits before any write.
  const locked = ydoc ? frontmatterEditsRefused(ydoc) : markdownFrontmatterEditsRefused(body);
  const opening = props.opening ?? false;
  const refused = locked || opening;

  function commit(next: FrontmatterEntry[]) {
    if (refused) return;
    const previous = editableEntries(sourceEntries);
    setEntries(next);
    if (hasDuplicateKeys(next)) return;
    try {
      if (ydoc) {
        applySharedFrontmatterPatch(ydoc, previous, next);
        // Each row now holds the key and value it wrote. The document's update
        // reaches the rows later, and a keystroke before then edits from here.
        setEntries(next.map((entry) => {
          const key = propertyKey(entry);
          return key === null
            ? entry
            : { ...entry, sourceKey: key, sourceValue: entry.value, rawValue: entryValue(entry) };
        }));
      } else {
        props.onChange?.(
          applyFrontmatter(body, buildProperties(sourceEntries, next), renamedKeys(previous, next)),
        );
      }
      setEditRefused(false);
    } catch {
      setEntries(previous);
      setEditRefused(true);
    }
  }

  function setKey(index: number, key: string) {
    const next = entries.map((entry, i) => (i === index ? { ...entry, key } : entry));
    if (shouldDeferKeyCommit(index, key, next)) {
      setEntries(next);
      return;
    }
    commit(next);
  }

  // The list being typed in, by the key it was read with. It saves when the
  // person leaves it or presses Enter. Until then it sits apart from the rows,
  // so another device's change to any property leaves its text alone.
  const [listDraft, setListDraft] = useState<{ key: string; text: string } | null>(null);
  const draftKey = (entry: FrontmatterEntry) => entry.sourceKey ?? entry.key;

  function setValue(index: number, value: string) {
    const entry = entries[index];
    if (entry?.list) setListDraft({ key: draftKey(entry), text: value });
    else commit(entries.map((row, i) => (i === index ? { ...row, value } : row)));
  }

  // A list edit that leaves the same items writes nothing, so the file keeps
  // the list as it was written.
  function settleList(index: number) {
    const entry = entries[index];
    const draft = listDraft;
    setListDraft(null);
    if (!entry || draft?.key !== draftKey(entry)) return;
    const items = listItems(draft.text);
    const before = entry.rawValue;
    if (Array.isArray(before) && items.length === before.length && items.every((item, i) => item === before[i])) {
      return;
    }
    commit(entries.map((row, i) => (i === index ? { ...row, value: draft.text } : row)));
  }

  // Where focus goes once the pills render: a pill's name, or the +.
  const line = useRef<HTMLDivElement | null>(null);
  const focusNext = useRef<number | "add" | null>(null);
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    const element = target === "add"
      ? line.current?.querySelector<HTMLElement>('[data-testid="property-add"]')
      : line.current?.querySelectorAll<HTMLElement>('[data-testid="property-key"]')[target];
    element?.focus();
  });

  function add() {
    focusNext.current = entries.length;
    setEntries((current) => [...current, { key: "", value: "" }]);
  }

  // Focus moves to the next pill, else the one before, else the +.
  function remove(index: number) {
    focusNext.current = index < entries.length - 1 ? index : index > 0 ? index - 1 : "add";
    commit(entries.filter((_, i) => i !== index));
  }

  const isEmpty = entries.length === 0;
  const duplicates = duplicateKeySet(entries);

  return (
    <section data-testid="properties-panel" className={PROPERTIES_PANEL} aria-label="Properties">
      <div ref={line} className={PROPERTIES_LINE}>
        {locked || editRefused ? (
          <span data-testid="properties-locked" className={TOPMATTER_FLAG} title={FRONTMATTER_EDIT_REFUSED_MESSAGE}>
            Edit in Source
          </span>
        ) : null}
        {entries.map((entry, index) => {
          const reserved = isReserved(entry.key);
          const duplicate = duplicates.has(entry.key.trim().toLowerCase());
          const automations = props.fieldMarks?.get(entry.key.trim());
          return (
            <div key={index} data-testid="property-row" className={PILL}>
              <input
                data-testid="property-key"
                aria-label={`Property ${index + 1} name`}
                value={entry.key}
                placeholder="Property"
                spellCheck={false}
                readOnly={refused}
                onChange={(event) => setKey(index, event.target.value)}
                onBlur={() => commit(entries)}
                className={`${PILL_FIELD} ${reserved || duplicate ? "text-danger" : "text-subtle"}`}
              />
              {automations ? <AutomationFieldMark automations={automations} /> : null}
              {reserved ? (
                <span
                  data-testid="property-reserved"
                  className={TOPMATTER_FLAG}
                  title="dohc uses this name for the page's title, icon or ID. Choose another name."
                >
                  reserved name
                </span>
              ) : duplicate ? (
                <span data-testid="property-duplicate" className={TOPMATTER_FLAG} title="Use a unique property name.">
                  duplicate name
                </span>
              ) : entry.readOnly !== undefined ? (
                <ReadOnlyValue label={`Property ${entry.key || index + 1} value`} value={entry.value} reason={entry.readOnly} />
              ) : (
                <input
                  data-testid="property-value"
                  aria-label={`Property ${entry.key || index + 1} value`}
                  value={entry.list && listDraft?.key === draftKey(entry) ? listDraft.text : entry.value}
                  // A value longer than the pill ends in an ellipsis; its
                  // tooltip holds all of it.
                  title={entry.value || undefined}
                  placeholder="Empty"
                  spellCheck={false}
                  readOnly={refused}
                  onChange={(event) => setValue(index, event.target.value)}
                  onBlur={entry.list ? () => settleList(index) : undefined}
                  onKeyDown={entry.list ? (event) => { if (event.key === "Enter") settleList(index); } : undefined}
                  className={`${PILL_FIELD} text-ink`}
                />
              )}
              {/* On the pill's corner, so showing it moves nothing. A locked
                  block cannot lose one property, so it offers no ×. */}
              {refused ? null : (
                <button
                  type="button"
                  data-testid="property-remove"
                  aria-label={`Remove property ${entry.key || index + 1}`}
                  title="Remove property"
                  onClick={() => remove(index)}
                  className="absolute -top-2 -right-2 grid size-[18px] place-items-center rounded-full border border-line bg-bg text-subtle opacity-0 transition duration-100 group-hover/pill:opacity-100 group-focus-within/pill:opacity-100 hover:text-danger"
                >
                  <X size={12} aria-hidden />
                </button>
              )}
            </div>
          );
        })}
        {/* Alone on a page with no properties, it shows while the pointer is
            over the title and properties, like "Add icon". A locked block
            cannot gain a property, so it offers no +. */}
        {locked ? null : opening ? (
          <button type="button" disabled tabIndex={-1} aria-hidden className={`${ADD} invisible`}>
            <Plus size={12} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            data-testid="property-add"
            aria-label="Add a property"
            title="Add a property"
            onClick={add}
            className={`${ADD} transition duration-100 hover:bg-hover hover:text-muted${
              isEmpty ? " opacity-0 group-hover/topmatter:opacity-100 focus-visible:opacity-100" : ""
            }`}
          >
            <Plus size={12} aria-hidden />
          </button>
        )}
      </div>
    </section>
  );
}

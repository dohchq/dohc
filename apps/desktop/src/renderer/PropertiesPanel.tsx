import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import {
  applyFrontmatter,
  frontmatterEntries,
  frontmatterEntriesFromMeta,
  type FrontmatterEntry,
} from "./markdown/frontmatter";

const HIDDEN_KEYS = new Set(["id", "title", "icon"]);
const FRONTMATTER_FIELD = "frontmatter";

export type PropertiesPanelProps =
  | {
      body: string;
      onChange: (nextBody: string) => void;
      ydoc?: never;
    }
  | {
      ydoc: Y.Doc;
      body?: never;
      onChange?: never;
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

function mapToObject(map: Y.Map<unknown>): Record<string, unknown> {
  return Object.fromEntries(map.entries());
}

function buildProperties(
  currentEntries: FrontmatterEntry[],
  nextEntries: FrontmatterEntry[],
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
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
  return entry.value;
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

function applySharedFrontmatterPatch(
  map: Y.Map<unknown>,
  previousEntries: FrontmatterEntry[],
  nextEntries: FrontmatterEntry[],
) {
  const previous = valuesByEditableKey(previousEntries);
  const next = valuesByEditableKey(nextEntries);

  for (const key of previous.keys()) {
    if (!next.has(key)) map.delete(key);
  }
  for (const [key, value] of next) {
    if (!previous.has(key) || !Object.is(previous.get(key), value)) {
      map.set(key, value);
    }
  }
}

export function PropertiesPanel(props: PropertiesPanelProps) {
  const ydoc = props.ydoc ?? null;
  const body = props.body ?? "";
  const [ydocRevision, setYdocRevision] = useState(0);
  const sourceEntries = useMemo(() => {
    if (ydoc) {
      return frontmatterEntriesFromMeta(mapToObject(ydoc.getMap(FRONTMATTER_FIELD)));
    }
    return frontmatterEntries(body);
  }, [body, ydoc, ydocRevision]);
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
    setEntries(editableEntries(sourceEntries));
  }, [sourceEntries]);

  function commit(next: FrontmatterEntry[]) {
    const previous = editableEntries(sourceEntries);
    setEntries(next);
    if (hasDuplicateKeys(next)) return;
    if (ydoc) {
      ydoc.transact(() => {
        const map = ydoc.getMap(FRONTMATTER_FIELD);
        applySharedFrontmatterPatch(map, previous, next);
      });
      return;
    }
    props.onChange?.(applyFrontmatter(body, buildProperties(sourceEntries, next)));
  }

  function setKey(index: number, key: string) {
    const next = entries.map((entry, i) => (i === index ? { ...entry, key } : entry));
    if (shouldDeferKeyCommit(index, key, next)) {
      setEntries(next);
      return;
    }
    commit(next);
  }

  function setValue(index: number, value: string) {
    commit(entries.map((entry, i) => (i === index ? { ...entry, value } : entry)));
  }

  function remove(index: number) {
    commit(entries.filter((_, i) => i !== index));
  }

  const isEmpty = entries.length === 0;

  return (
    <section
      data-testid="properties-panel"
      className="dohc-page-properties"
      aria-label="Properties"
    >
      <div className="dohc-page-properties__inner">
        {entries.map((entry, index) => {
          const reserved = isReserved(entry.key);
          const duplicate = duplicateKeySet(entries).has(entry.key.trim().toLowerCase());
          return (
            <div key={index} data-testid="property-row" className="dohc-page-properties__row">
              <input
                data-testid="property-key"
                aria-label={`Property ${index + 1} name`}
                value={entry.key}
                placeholder="Property"
                spellCheck={false}
                onChange={(event) => setKey(index, event.target.value)}
                onBlur={() => commit(entries)}
                className={`dohc-page-properties__key${
                  reserved || duplicate ? " is-invalid" : ""
                }`}
              />
              {reserved ? (
                <span
                  data-testid="property-reserved"
                  className="dohc-page-properties__flag"
                  title="Reserved names are managed by the document system."
                >
                  reserved name
                </span>
              ) : duplicate ? (
                <span
                  data-testid="property-duplicate"
                  className="dohc-page-properties__flag"
                  title="Use a unique property name."
                >
                  duplicate name
                </span>
              ) : (
                <input
                  data-testid="property-value"
                  aria-label={`Property ${entry.key || index + 1} value`}
                  value={entry.value}
                  placeholder="Empty"
                  spellCheck={false}
                  onChange={(event) => setValue(index, event.target.value)}
                  className="dohc-page-properties__value"
                />
              )}
              <button
                type="button"
                data-testid="property-remove"
                aria-label={`Remove property ${entry.key || index + 1}`}
                title="Remove property"
                onClick={() => remove(index)}
                className="dohc-page-properties__remove"
              >
                <X size={13} aria-hidden />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          data-testid="property-add"
          onClick={() => setEntries((current) => [...current, { key: "", value: "" }])}
          className={`dohc-page-properties__add${
            isEmpty ? " dohc-page-properties__add--empty" : ""
          }`}
        >
          <Plus size={13} aria-hidden />
          Add a property
        </button>
      </div>
    </section>
  );
}

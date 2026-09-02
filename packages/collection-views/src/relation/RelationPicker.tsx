import { useEffect, useMemo, useState } from "react";
import type {
  CollectionQueryCursor,
  CollectionRecord,
  CollectionValue,
  RelationFieldDefinition,
} from "@dohc/workspace-contracts";
import type { CollectionQueryExecutor } from "../store";
import { recordLabel } from "../recordLabel";

const RELATION_PICKER_LIMIT = 100;
// Five pages bounds memory and query count on a huge related collection.
const RELATION_PICKER_MAX_PAGES = 5;

export interface RelationPickerProps {
  field: RelationFieldDefinition;
  /** The record's current value for the field: record ids, per the contract. */
  value: CollectionValue;
  /**
   * Runs the picker's query against the related collection. Hosts bind this
   * to their transport; the picker never writes.
   */
  executor: CollectionQueryExecutor;
  /**
   * Receives the standard cell value: one record id or null when the field
   * is single, the full id array when it is many.
   */
  emit: (value: CollectionValue) => void;
  close: () => void;
}

function selectedIds(value: CollectionValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

export function RelationPicker({
  field,
  value,
  executor,
  emit,
  close,
}: RelationPickerProps) {
  const [records, setRecords] = useState<CollectionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    // A new related collection must not offer the prior collection's
    // records: a stale id picked here would be written to the new field.
    setRecords(null);
    setError(null);
    setTruncated(false);
    let stale = false;

    void (async () => {
      try {
        const collected: CollectionRecord[] = [];
        let cursor: CollectionQueryCursor | undefined;
        let pages = 0;
        do {
          const result = await executor({
            collectionPath: field.collection,
            limit: RELATION_PICKER_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          });
          if (stale) return;
          collected.push(...result.records);
          cursor = result.nextCursor ?? undefined;
          pages += 1;
        } while (cursor !== undefined && pages < RELATION_PICKER_MAX_PAGES);

        if (stale) return;
        setTruncated(cursor !== undefined);
        setRecords(collected);
      } catch (failure: unknown) {
        if (stale) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();

    return () => {
      stale = true;
    };
  }, [executor, field.collection]);

  // Optimistic selection: the host applies emitted changes through a
  // serialized write queue, so the `value` prop lags behind rapid toggles.
  // Deriving each toggle from the prop would drop the previous one; derive
  // from local state instead, reconciled whenever the prop catches up (the
  // effect also covers a collection switch, which remounts via key upstream
  // but must not carry a stale selection if it ever does not).
  const propSelected = useMemo(() => selectedIds(value), [value]);
  const [selected, setSelected] = useState(propSelected);
  useEffect(() => {
    setSelected(propSelected);
  }, [propSelected]);
  const shown = useMemo(() => {
    if (records === null) return [];
    const needle = search.trim().toLowerCase();
    if (needle === "") return records;
    return records.filter((record) =>
      recordLabel(record).toLowerCase().includes(needle),
    );
  }, [records, search]);

  return (
    <span
      className="flex w-full flex-col gap-0.5"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <input
        autoFocus
        type="text"
        aria-label="Search records"
        placeholder="Search records"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        className="w-full rounded border border-line bg-bg px-1 text-[13px] placeholder:text-subtle"
      />
      {error !== null ? (
        <span className="text-[11px] text-danger">
          dohc could not read the related collection's records. {error}
        </span>
      ) : records === null ? (
        <span className="text-[11px] text-subtle">Loading records...</span>
      ) : shown.length === 0 ? (
        <span className="text-[11px] text-muted">
          {search.trim() === ""
            ? "No records in the related collection yet."
            : `No records match "${search.trim()}".`}
        </span>
      ) : field.many ? (
        <span
          role="listbox"
          aria-multiselectable="true"
          aria-label={`Records in ${field.collection}`}
          className="flex max-h-48 flex-col gap-0.5 overflow-y-auto"
        >
          {shown.map((record) => (
            <label
              key={record.id}
              className="flex items-center gap-1.5 text-[13px]"
            >
              <input
                type="checkbox"
                checked={selected.includes(record.id)}
                onChange={() => {
                  const next = selected.includes(record.id)
                    ? selected.filter((id) => id !== record.id)
                    : [...selected, record.id];
                  setSelected(next);
                  emit(next);
                }}
              />
              {recordLabel(record)}
            </label>
          ))}
        </span>
      ) : (
        <span
          role="listbox"
          aria-label={`Records in ${field.collection}`}
          className="flex max-h-48 flex-col gap-0.5 overflow-y-auto"
        >
          {shown.map((record) => (
            <button
              key={record.id}
              type="button"
              role="option"
              aria-selected={selected.includes(record.id)}
              className={`rounded px-1 text-left text-[13px] transition-colors duration-75 hover:bg-panel-2 ${
                selected.includes(record.id) ? "bg-line/60 text-ink" : "text-muted"
              }`}
              onClick={() => {
                emit(record.id);
                close();
              }}
            >
              {recordLabel(record)}
            </button>
          ))}
        </span>
      )}
      {error === null && records !== null && truncated ? (
        <span className="text-[11px] text-muted">
          The list shows only the first {records.length} records. Search to narrow it.
        </span>
      ) : null}
      {!field.many && error === null && records !== null && selected.length > 0 ? (
        <button
          type="button"
          className="rounded px-1 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-panel-2 hover:text-ink"
          onClick={() => {
            emit(null);
            close();
          }}
        >
          Clear
        </button>
      ) : null}
    </span>
  );
}

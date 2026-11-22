import { useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import type {
  CollectionQueryCursor,
  CollectionRecord,
  CollectionValue,
  RelationFieldDefinition,
} from "@dohc/workspace-contracts";
import type { CollectionQueryExecutor } from "../store";
import { useAcknowledgedSelection } from "../useAcknowledgedSelection";
import { recordLabel } from "../recordLabel";
import { PickerFrame, type CellClose } from "../table/pickers";

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
  acknowledgedWriteId: number;
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  emit: (value: CollectionValue, previousValues?: readonly CollectionValue[]) => number;
  close: CellClose;
}

export function RelationPicker({
  field,
  value,
  executor,
  acknowledgedWriteId,
  subscribeToDiscardedWrites,
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

  const ids =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
  const { selected, select } = useAcknowledgedSelection({
    value,
    ids,
    acknowledgedWriteId,
    subscribeToDiscardedWrites,
    emit,
  });
  const shown = useMemo(() => {
    if (records === null) return [];
    const needle = search.trim().toLowerCase();
    if (needle === "") return records;
    return records.filter((record) => recordLabel(record).toLowerCase().includes(needle));
  }, [records, search]);

  return (
    <PickerFrame close={close} className="dohc-pop-in">
      <input
        autoFocus
        type="text"
        aria-label="Search records"
        placeholder="Search records"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
      />
      {error !== null ? (
        <span className="px-2 py-1 text-[12px] text-danger">
          dohc could not read the related collection's records. {error}
        </span>
      ) : records === null ? (
        <span className="dohc-reveal-if-slow px-2 py-1 text-[12px] text-subtle">
          Loading records...
        </span>
      ) : shown.length === 0 ? (
        <span className="px-2 py-1 text-[12px] text-muted">
          {search.trim() === ""
            ? "No records in the related collection yet."
            : `No records match "${search.trim()}".`}
        </span>
      ) : field.many ? (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={`Records in ${field.collection}`}
          className="flex max-h-64 flex-col overflow-y-auto"
        >
          {shown.map((record) => (
            <label
              key={record.id}
              className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-ink transition-colors duration-75 hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={selected.includes(record.id)}
                className="size-3.5 shrink-0 accent-accent"
                onChange={() => {
                  const next = selected.includes(record.id)
                    ? selected.filter((id) => id !== record.id)
                    : [...selected, record.id];
                  select(next);
                }}
              />
              <span className="min-w-0 flex-1 truncate">{recordLabel(record)}</span>
            </label>
          ))}
        </div>
      ) : (
        <div
          role="listbox"
          aria-label={`Records in ${field.collection}`}
          className="flex max-h-64 flex-col overflow-y-auto"
        >
          {shown.map((record) => {
            const isSelected = selected.includes(record.id);
            return (
              <button
                key={record.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75 ${
                  isSelected ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink"
                }`}
                onClick={() => {
                  emit(record.id);
                  close();
                }}
              >
                <span className="min-w-0 flex-1 truncate">{recordLabel(record)}</span>
                {isSelected ? (
                  <Check
                    size={14}
                    strokeWidth={1.9}
                    aria-hidden
                    className="ml-auto shrink-0 text-ink"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {error === null && records !== null && truncated ? (
        <span className="px-2 py-1 text-[12px] text-muted">
          The list shows only the first {records.length} records.
        </span>
      ) : null}
      {!field.many && error === null && records !== null && selected.length > 0 ? (
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
          onClick={() => {
            emit(null);
            close();
          }}
        >
          <X size={14} strokeWidth={1.9} aria-hidden className="shrink-0" />
          Clear
        </button>
      ) : null}
    </PickerFrame>
  );
}

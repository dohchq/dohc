import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "./icons";
import { namedRequest } from "./namedRecipient";

export type Collection = { datasetId: string; name: string };
type Field = {
  fieldId: string;
  name: string;
  type: string;
  options?: string[];
  editable: boolean;
  reversible: boolean;
};
type Described = {
  revision: number;
  revisionSha256: string;
  tables: { tableId: string; name: string; fields: Field[] }[];
};
type Row = { id: string; version: number; values: Record<string, unknown> };
type Answer = {
  saved?: { version: number; priorValue?: unknown };
  refused?: { code: string; message: string };
  rulesChanged?: true;
};
type Saved = { rowId: string; field: Field; version: number; undo?: { value: unknown } };
type Editing = {
  rowId: string;
  fieldId: string;
  version: number;
  draft: string | boolean;
  saving?: boolean;
  notice?: "uncertain" | "stale" | "gone" | string;
  attempt?: { value: unknown };
};
const EDITORS = new Set(["text", "url", "number", "checkbox", "date", "select"]);
const NOTICES: Record<string, string> = {
  uncertain: "dohc could not confirm the save. Try again to send the same change.",
  stale: "This row changed since it loaded.",
  gone: "This row is gone. Copy your value to keep it.",
};
const REFUSALS: Record<string, string> = { stale_record: "stale", not_found: "gone" };

async function call(
  grantId: string,
  operation: string,
  args: object,
  signal = new AbortController().signal,
) {
  const value = (await namedRequest("/api/named/collections", signal, {
    grantId,
    operation,
    args,
  })) as { ok?: unknown; result?: unknown } | null;
  if (value?.ok !== true || !value.result || typeof value.result !== "object")
    throw Error("Unavailable");
  return value.result as Record<string, unknown>;
}

function shown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function toDraft(field: Field, value: unknown): string | boolean {
  return field.type === "checkbox" ? value === true : shown(value);
}

function fromDraft(field: Field, draft: string | boolean): unknown {
  if (typeof draft === "boolean") return draft;
  if (draft.trim() === "") return null;
  return field.type === "number" ? Number(draft) : field.type === "url" ? draft.trim() : draft;
}

/** The Collections an invitation reaches, as a group of the page's list. */
export function CollectionList(props: {
  grantId: string;
  selected: string | null;
  disabled: boolean;
  onOpen(collection: Collection): void;
}) {
  const [collections, setCollections] = useState<Collection[] | null>(null),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void (async () => {
      const all: Collection[] = [];
      for (let cursor: unknown; ;) {
        const page = await call(
          props.grantId,
          "collections",
          cursor ? { cursor } : {},
          controller.signal,
        );
        all.push(...(page.collections as Collection[]));
        if (!(cursor = page.nextCursor)) return setCollections(all);
      }
    })().catch(() => !controller.signal.aborted && setFailed(true));
    return () => controller.abort();
  }, [props.grantId, attempt]);
  if (failed)
    return (
      <p role="alert">
        dohc could not load Collections.{" "}
        <button className="named-link" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </p>
    );
  if (!collections?.length) return null;
  return (
    <>
      <p className="section-label">Collections</p>
      {collections.map((collection) => (
        <button
          className="handoff-button secondary named-file"
          key={collection.datasetId}
          disabled={props.disabled}
          aria-current={props.selected === collection.datasetId ? "page" : undefined}
          onClick={() => props.onOpen(collection)}
        >
          <Icon name="grid" size={15} />
          <span>{collection.name}</span>
        </button>
      ))}
    </>
  );
}

/** One Collection's records: read 50 at a time, and change one field at a time where the owner allows it. */
export function CollectionTable(props: {
  grantId: string;
  collection: Collection;
  onDirty(dirty: boolean): void;
}) {
  const { grantId, collection } = props;
  const [described, setDescribed] = useState<Described | null>(null),
    [tableId, setTableId] = useState<string | null>(null),
    [rows, setRows] = useState<Row[] | null>(null),
    [next, setNext] = useState<string | null>(null),
    [state, setState] = useState<"loading" | "slow" | "failed" | "no-read" | "ready">("loading"),
    [editing, setEditing] = useState<Editing | null>(null),
    [saved, setSaved] = useState<Saved | null>(null);
  const reads = useRef<AbortController | null>(null),
    cells = useRef(new Map<string, HTMLButtonElement>()),
    refocus = useRef<string | null>(null);
  const table = described?.tables.find((table) => table.tableId === tableId);
  const load = async (after?: string, chosen = tableId) => {
    reads.current?.abort();
    const controller = (reads.current = new AbortController()),
      slow = setTimeout(() => setState((state) => (state === "loading" ? "slow" : state)), 150);
    if (!after) setState("loading");
    try {
      const rules = (await call(
        grantId,
        "collection",
        { datasetId: collection.datasetId },
        controller.signal,
      )) as unknown as Described;
      const table = rules.tables.find((table) => table.tableId === chosen) ?? rules.tables[0];
      if (!table) throw Error("Unavailable");
      const page = await call(
        grantId,
        "collectionRecords",
        { datasetId: collection.datasetId, tableId: table.tableId, ...(after ? { after } : {}) },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDescribed(rules);
      setTableId(table.tableId);
      if (page.status !== "ready") return setState("no-read");
      setRows((rows) => [...(after ? (rows ?? []) : []), ...(page.rows as Row[])]);
      setNext((page.nextCursor as string | null) ?? null);
      setState("ready");
    } catch {
      if (!controller.signal.aborted) setState("failed");
    } finally {
      clearTimeout(slow);
    }
  };
  useEffect(() => {
    void load();
    return () => reads.current?.abort();
  }, [collection.datasetId]);
  const editField = table?.fields.find((field) => field.fieldId === editing?.fieldId),
    editRow = rows?.find((row) => row.id === editing?.rowId);
  const dirty =
    !!editing &&
    !!editField &&
    !!editRow &&
    (editing.saving === true ||
      editing.notice !== undefined ||
      toDraft(editField, editRow.values[editField.fieldId]) !== editing.draft);
  useEffect(() => {
    props.onDirty(dirty);
    return () => props.onDirty(false);
  }, [dirty]);
  useEffect(() => {
    if (editing || !refocus.current) return;
    cells.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [editing]);
  const close = () => {
    if (editing) refocus.current = `${editing.rowId}:${editing.fieldId}`;
    setEditing(null);
  };
  const save = async (edit: Editing, field: Field, value = fromDraft(field, edit.draft)) => {
    if (!described || !table) return;
    if (field.type === "number" && typeof value === "number" && !Number.isFinite(value))
      return setEditing({ ...edit, notice: "Enter a number" });
    const attempt =
      edit.attempt && JSON.stringify(edit.attempt.value) === JSON.stringify(value)
        ? edit.attempt
        : {
            datasetId: collection.datasetId,
            tableId: table.tableId,
            recordId: edit.rowId,
            fieldId: field.fieldId,
            value,
            expectedVersion: edit.version,
            revision: described.revision,
            revisionSha256: described.revisionSha256,
            idempotencyKey: crypto.randomUUID(),
          };
    const sending: Editing = { ...edit, saving: true, attempt };
    setEditing(sending);
    let answer: Answer;
    try {
      answer = (await call(grantId, "collectionEdit", attempt)) as Answer;
    } catch {
      return setEditing({ ...sending, saving: false, notice: "uncertain" });
    }
    if (answer.saved) {
      const { version, priorValue } = answer.saved;
      setRows(
        (rows) =>
          rows?.map((each) =>
            each.id === edit.rowId && version >= each.version
              ? { ...each, version, values: { ...each.values, [field.fieldId]: attempt.value } }
              : each,
          ) ?? null,
      );
      setSaved({
        rowId: edit.rowId,
        field,
        version,
        ...(field.reversible && answer.saved.priorValue !== undefined
          ? { undo: { value: priorValue ?? null } }
          : {}),
      });
      refocus.current = `${edit.rowId}:${field.fieldId}`;
      return setEditing(null);
    }
    if (answer.rulesChanged) {
      setEditing({
        ...sending,
        saving: false,
        attempt: undefined,
        notice: "The Collection's rules changed. Check the value and save again.",
      });
      return void load();
    }
    const refused = answer.refused;
    setEditing({
      ...sending,
      saving: false,
      notice: (refused && REFUSALS[refused.code]) ?? refused?.message ?? "uncertain",
    });
  };
  const reloadRow = async (edit: Editing) => {
    if (!table) return;
    try {
      const page = await call(grantId, "collectionRecords", {
        datasetId: collection.datasetId,
        tableId: table.tableId,
        recordId: edit.rowId,
      });
      const current = (page.rows as Row[] | undefined)?.[0];
      if (!current) return setEditing({ ...edit, notice: "gone" });
      setRows((rows) => rows?.map((row) => (row.id === current.id ? current : row)) ?? null);
      setEditing((open) =>
        open?.rowId === edit.rowId && open.fieldId === edit.fieldId
          ? { ...open, version: current.version, attempt: undefined, notice: undefined }
          : open,
      );
    } catch {
      setEditing({ ...edit, notice: "dohc could not load the current row. Try again." });
    }
  };
  if (state === "loading" || state === "slow")
    return (
      <section className="content named-collection">
        {state === "slow" && <p role="status">Loading records…</p>}
      </section>
    );
  if (state === "failed")
    return (
      <section className="content named-collection">
        <p role="alert">
          dohc could not load {collection.name}.{" "}
          <button className="named-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </section>
    );
  const editor = (field: Field, row: Row, edit: Editing) => {
    const set = (draft: string | boolean) =>
      !edit.saving && setEditing({ ...edit, draft, notice: undefined });
    const keys = (event: KeyboardEvent<HTMLFormElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!edit.saving) close();
      } else if (
        event.key === "Enter" &&
        (event.target instanceof HTMLSelectElement ||
          (event.target instanceof HTMLInputElement && event.target.type === "checkbox"))
      ) {
        event.currentTarget.requestSubmit();
        event.preventDefault();
      }
    };
    const submit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!edit.saving)
        void save(edit, field, edit.notice === "uncertain" ? edit.attempt?.value : undefined);
    };
    const label = `${field.name}, ${shown(row.values[table!.fields[0]?.fieldId ?? ""]) || "this row"}`;
    const notice = edit.notice && (NOTICES[edit.notice] ?? edit.notice);
    return (
      <form className="named-cell-editor" onSubmit={submit} onKeyDown={keys}>
        {field.type === "checkbox" ? (
          <input
            type="checkbox"
            aria-label={label}
            autoFocus
            checked={edit.draft === true}
            onChange={(event) => set(event.target.checked)}
          />
        ) : field.type === "select" ? (
          <select
            aria-label={label}
            autoFocus
            value={String(edit.draft)}
            onChange={(event) => set(event.target.value)}
          >
            <option value="" />
            {field.options?.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : field.type === "text" ? (
          <textarea
            aria-label={label}
            autoFocus
            rows={2}
            value={String(edit.draft)}
            onChange={(event) => set(event.target.value)}
          />
        ) : (
          <input
            aria-label={label}
            autoFocus
            type={field.type}
            step="any"
            value={String(edit.draft)}
            onChange={(event) => set(event.target.value)}
          />
        )}
        <button type="submit" className="handoff-button" disabled={edit.saving}>
          {edit.saving ? "Saving…" : edit.notice === "uncertain" ? "Try again" : "Save"}
        </button>
        <button
          type="button"
          className="handoff-button secondary"
          disabled={edit.saving}
          onClick={close}
        >
          Cancel
        </button>
        {notice && (
          <p role="alert">
            {notice}
            {edit.notice === "stale" && (
              <button type="button" className="named-link" onClick={() => void reloadRow(edit)}>
                Load current row
              </button>
            )}
          </p>
        )}
      </form>
    );
  };
  return (
    <section className="content named-collection" aria-label={collection.name}>
      <div className="named-collection-header">
        <h2>{collection.name}</h2>
        {described && described.tables.length > 1 && (
          <select
            aria-label="Table"
            value={tableId ?? ""}
            disabled={dirty}
            onChange={(event) => {
              setSaved(null);
              void load(undefined, event.target.value);
            }}
          >
            {described.tables.map((table) => (
              <option key={table.tableId} value={table.tableId}>
                {table.name}
              </option>
            ))}
          </select>
        )}
        <button className="handoff-button secondary" disabled={dirty} onClick={() => void load()}>
          <Icon name="refresh" size={15} />
          Refresh
        </button>
      </div>
      {saved && (
        <p role="status" className="named-collection-saved">
          Saved
          {saved.undo && (
            <button
              className="named-link"
              onClick={() => {
                const { rowId, field, version, undo } = saved;
                setSaved(null);
                void save(
                  { rowId, fieldId: field.fieldId, version, draft: toDraft(field, undo!.value) },
                  field,
                  undo!.value,
                );
              }}
            >
              Undo
            </button>
          )}
        </p>
      )}
      {state === "no-read" || !table ? (
        <p>The owner has not shared this table's records with you.</p>
      ) : !rows?.length ? (
        <p>No records yet</p>
      ) : (
        <div className="named-collection-scroll">
          <table>
            <thead>
              <tr>
                {table.fields.map((field) => (
                  <th key={field.fieldId} scope="col">
                    {field.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {table.fields.map((field) => {
                    const at = `${row.id}:${field.fieldId}`,
                      text = shown(row.values[field.fieldId]);
                    return (
                      <td key={field.fieldId}>
                        {editing?.rowId === row.id && editing.fieldId === field.fieldId ? (
                          editor(field, row, editing)
                        ) : field.editable && EDITORS.has(field.type) ? (
                          <button
                            ref={(cell) =>
                              void (cell ? cells.current.set(at, cell) : cells.current.delete(at))
                            }
                            className="named-cell"
                            aria-label={`Edit ${field.name}: ${text || "empty"}`}
                            disabled={dirty}
                            onClick={() => {
                              setSaved(null);
                              setEditing({
                                rowId: row.id,
                                fieldId: field.fieldId,
                                version: row.version,
                                draft: toDraft(field, row.values[field.fieldId]),
                              });
                            }}
                          >
                            {text}
                          </button>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {next && (
            <button className="handoff-button secondary" onClick={() => void load(next)}>
              Load more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

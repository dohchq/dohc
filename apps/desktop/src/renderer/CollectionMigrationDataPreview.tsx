import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Info, Minus, Pencil, Plus, TriangleAlert } from "lucide-react";
import {
  datasetColumnFields,
  type DatasetDefinition,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import { DatasetMigrationPreviewPage, type DatasetMigrationCandidate } from "@dohc/cli/dataset";
import { SecondaryButton } from "./ui/controls";

export type MigrationPreviewPage = DatasetMigrationPreviewPage;
type MigrationPreviewValue = DatasetMigrationPreviewPage["changes"][number]["key"][string];
export interface MigrationDataPreviewProps {
  workspaceId: string;
  preparationId: string;
  previousRevision: DatasetRevision;
  revision: DatasetRevision;
  preview: DatasetMigrationCandidate["preview"];
  onLoad(
    input: { workspaceId: string; preparationId: string; after?: string; limit: number },
    signal: AbortSignal,
  ): Promise<MigrationPreviewPage>;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}

const RESERVED_VALUE_LABELS = new Set([
  "true",
  "false",
  "null",
  "Empty",
  "Field absent",
  "Binary value",
]);
const NUMERIC_STRING = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SPECIAL_CHAR =
  /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
const SPECIAL_CHAR_GLOBAL =
  /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;

function ownValue(
  record: Record<string, MigrationPreviewValue> | null,
  column: string,
): MigrationPreviewValue | undefined {
  return record && Object.hasOwn(record, column) ? record[column] : undefined;
}

function needsQuotes(value: string): boolean {
  if (value === "" || value !== value.trim()) return true;
  if (value.startsWith('"') || value.endsWith('"')) return true;
  if (SPECIAL_CHAR.test(value)) return true;
  if (RESERVED_VALUE_LABELS.has(value)) return true;
  return NUMERIC_STRING.test(value);
}

function formatQuotedString(value: string): string {
  return JSON.stringify(value).replace(SPECIAL_CHAR_GLOBAL, (char) => {
    const code = char.codePointAt(0)!;
    return code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : `\\u{${code.toString(16)}}`;
  });
}

function formatReal(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const text = String(value);
  return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

export function recordCount(count: number): string {
  return `${count} ${count === 1 ? "record" : "records"}`;
}

export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function migrationTableLabel(
  previousRevision: DatasetRevision,
  revision: DatasetRevision,
  sqlName: string,
): string {
  return (
    revision.definition.tables.find((table) => table.sqlName === sqlName)?.name ??
    previousRevision.definition.tables.find((table) => table.sqlName === sqlName)?.name ??
    sqlName
  );
}

export interface MigrationClearedColumn {
  table: string;
  column: string;
  count: number;
  renamedTo: string | null;
  atLeast?: boolean;
}

export interface MigrationUnmatchedTable {
  table: string;
  beforeRows: number;
  afterRows: number;
  reason: "key-changed" | "table-renamed";
}

export interface MigrationPreviewTotals {
  beforeRows: number;
  afterRows: number;
  changedRows: number;
  addedRows: number;
  updatedRows: number;
  deletedRows: number;
  unmatchedTables: MigrationUnmatchedTable[];
  unmatchedSqlNames: Set<string>;
  renamedOldSqlNames: Set<string>;
  renamedNewSqlNames: Set<string>;
  clearedValues: number;
  clearedValuesAtLeast: boolean;
  renamedColumnValues: number;
  clearedColumns: MigrationClearedColumn[];
}

function renamedColumnOf(
  beforeDef: DatasetDefinition["tables"][number] | undefined,
  afterDef: DatasetDefinition["tables"][number] | undefined,
  column: string,
): string | null {
  if (!beforeDef || !afterDef) return null;
  const prior = datasetColumnFields(beforeDef).find((field) => field.sqlColumn === column);
  if (!prior) return null;
  const next = datasetColumnFields(afterDef).find((field) => field.fieldId === prior.fieldId);
  return next && next.sqlColumn !== column ? next.sqlColumn : null;
}

export function summarizeMigrationPreview(
  tables: DatasetMigrationCandidate["preview"]["tables"],
  previousRevision: DatasetRevision,
  revision: DatasetRevision,
): MigrationPreviewTotals {
  let beforeRows = 0;
  let afterRows = 0;
  let changedRows = 0;
  let addedRows = 0;
  let updatedRows = 0;
  let deletedRows = 0;
  let clearedValues = 0;
  let clearedValuesAtLeast = false;
  let renamedColumnValues = 0;
  const unmatchedTables: MigrationUnmatchedTable[] = [];
  const unmatchedSqlNames = new Set<string>();
  const renamedOldSqlNames = new Set<string>();
  const renamedNewSqlNames = new Set<string>();
  const clearedColumns: MigrationClearedColumn[] = [];

  const beforeTablesBySql = new Map(
    previousRevision.definition.tables.map((table) => [table.sqlName, table]),
  );
  const afterTablesBySql = new Map(
    revision.definition.tables.map((table) => [table.sqlName, table]),
  );
  const afterTablesById = new Map(
    revision.definition.tables.map((table) => [table.tableId, table]),
  );
  const summaryBySql = new Map(tables.map((table) => [table.table, table]));

  for (const oldTable of previousRevision.definition.tables) {
    const nextTable = afterTablesById.get(oldTable.tableId);
    if (
      nextTable &&
      nextTable.sqlName !== oldTable.sqlName &&
      !afterTablesBySql.has(oldTable.sqlName) &&
      !beforeTablesBySql.has(nextTable.sqlName) &&
      summaryBySql.has(oldTable.sqlName)
    ) {
      renamedOldSqlNames.add(oldTable.sqlName);
      renamedNewSqlNames.add(nextTable.sqlName);
    }
  }

  for (const table of tables) {
    beforeRows += table.beforeRows;
    afterRows += table.afterRows;
    changedRows += table.changedRows;

    if (renamedOldSqlNames.has(table.table)) {
      const oldDef = beforeTablesBySql.get(table.table);
      const nextDef = oldDef ? afterTablesById.get(oldDef.tableId) : undefined;
      const nextSummary = nextDef ? summaryBySql.get(nextDef.sqlName) : undefined;
      const nextAfterRows = nextSummary?.afterRows ?? 0;
      if (table.beforeRows > 0) {
        unmatchedTables.push({
          table: nextDef?.sqlName ?? table.table,
          beforeRows: table.beforeRows,
          afterRows: nextAfterRows,
          reason: "table-renamed",
        });
      } else if (nextAfterRows > 0) {
        addedRows += nextAfterRows;
      }
      continue;
    }
    if (renamedNewSqlNames.has(table.table)) {
      continue;
    }

    const beforeKeys = Object.keys(table.beforeValues);
    const afterKeys = Object.keys(table.afterValues);
    const clearedKeys = Object.keys(table.clearedValues);
    const beforeDef = beforeTablesBySql.get(table.table);
    const afterDef = afterTablesBySql.get(table.table);
    const unmatchedBySchema =
      beforeKeys.length > 0 && afterKeys.length > 0 && clearedKeys.length === 0;

    if (unmatchedBySchema && table.beforeRows > 0) {
      unmatchedSqlNames.add(table.table);
      unmatchedTables.push({
        table: table.table,
        beforeRows: table.beforeRows,
        afterRows: table.afterRows,
        reason: "key-changed",
      });
      continue;
    }

    const added = Math.max(0, table.afterRows - table.beforeRows + table.deletedRows);
    const updated = Math.max(0, table.changedRows - table.deletedRows - added);
    addedRows += added;
    updatedRows += updated;
    deletedRows += table.deletedRows;

    for (const [column, count] of Object.entries(table.clearedValues)) {
      if (count <= 0) continue;
      if (Object.hasOwn(table.afterValues, column)) {
        clearedColumns.push({ table: table.table, column, count, renamedTo: null });
        clearedValues += count;
        continue;
      }
      const renamedTo = renamedColumnOf(beforeDef, afterDef, column);
      if (!renamedTo) {
        clearedColumns.push({ table: table.table, column, count, renamedTo: null });
        clearedValues += count;
        continue;
      }
      const afterRenamedCount = Object.hasOwn(table.afterValues, renamedTo)
        ? (table.afterValues[renamedTo] ?? 0)
        : 0;
      const shortfall = Math.max(0, count - afterRenamedCount);
      const unverified = count - shortfall;
      if (shortfall > 0) {
        clearedColumns.push({
          table: table.table,
          column,
          count: shortfall,
          renamedTo: null,
          atLeast: true,
        });
        clearedValues += shortfall;
        clearedValuesAtLeast = true;
      }
      if (unverified > 0) {
        clearedColumns.push({ table: table.table, column, count: unverified, renamedTo });
        renamedColumnValues += unverified;
      }
    }
  }
  return {
    beforeRows,
    afterRows,
    changedRows,
    addedRows,
    updatedRows,
    deletedRows,
    unmatchedTables,
    unmatchedSqlNames,
    renamedOldSqlNames,
    renamedNewSqlNames,
    clearedValues,
    clearedValuesAtLeast,
    renamedColumnValues,
    clearedColumns,
  };
}

function summarySentence(
  totals: MigrationPreviewTotals,
  tableLabel: (sqlName: string) => string,
): string {
  if (totals.changedRows === 0) {
    if (totals.beforeRows === 0 && totals.afterRows === 0) {
      return "No records in this Collection yet.";
    }
    if (totals.beforeRows === 1) {
      return "The 1 record stays unchanged.";
    }
    return `All ${recordCount(totals.beforeRows)} stay unchanged.`;
  }
  const parts: string[] = [];
  if (totals.updatedRows > 0) parts.push(`${recordCount(totals.updatedRows)} updated`);
  if (totals.addedRows > 0) parts.push(`${recordCount(totals.addedRows)} added`);
  if (totals.deletedRows > 0) parts.push(`${recordCount(totals.deletedRows)} removed`);
  if (parts.length === 0 && totals.unmatchedTables.length === 1) {
    const unmatched = totals.unmatchedTables[0]!;
    const why =
      unmatched.reason === "table-renamed"
        ? "table renamed; records were not matched by key"
        : "dohc could not match them by key";
    return `Replaces ${recordCount(unmatched.beforeRows)} in ${tableLabel(unmatched.table)} with ${recordCount(unmatched.afterRows)} (${why}).`;
  }
  if (totals.unmatchedTables.length > 0) {
    for (const unmatched of totals.unmatchedTables) {
      const why =
        unmatched.reason === "table-renamed"
          ? "after a table rename without a key match"
          : "without a key match";
      parts.push(
        `${recordCount(unmatched.beforeRows)} in ${tableLabel(unmatched.table)} replaced with ${recordCount(unmatched.afterRows)} ${why}`,
      );
    }
    const headline = joinList(parts);
    const capitalized = headline.charAt(0).toUpperCase() + headline.slice(1);
    return `${capitalized}. ${recordCount(totals.beforeRows)} before, ${recordCount(totals.afterRows)} after.`;
  }
  const headline =
    parts.length > 0 ? joinList(parts) : `${recordCount(totals.changedRows)} changed`;
  return `${headline} (${recordCount(totals.beforeRows)} before, ${recordCount(totals.afterRows)} after).`;
}

function Value({
  value,
  mono = false,
}: {
  value: MigrationPreviewValue | undefined;
  mono?: boolean;
}) {
  if (value === undefined) return <span className="text-muted">Field absent</span>;
  if (value === null) return <span className="text-muted">Empty</span>;
  if (typeof value === "object" && value.type === "blob")
    return (
      <details>
        <summary className="cursor-pointer text-muted">Binary value</summary>
        <pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
          {value.base64}
        </pre>
      </details>
    );
  if (typeof value === "object") {
    return <span className="whitespace-pre-wrap break-all font-mono">{value.value}</span>;
  }
  if (typeof value === "number") {
    return <span className="font-mono tabular-nums">{formatReal(value)}</span>;
  }
  if (needsQuotes(value)) {
    return (
      <span
        className={`whitespace-pre-wrap break-all font-mono ${value === "" ? "text-muted" : ""}`}
      >
        {formatQuotedString(value)}
      </span>
    );
  }
  return (
    <span className={`whitespace-pre-wrap break-words ${mono ? "font-mono" : ""}`}>{value}</span>
  );
}

export function CollectionMigrationDataPreview(props: MigrationDataPreviewProps) {
  return <ScopedPreview key={`${props.workspaceId}:${props.preparationId}`} {...props} />;
}
function ScopedPreview(props: MigrationDataPreviewProps) {
  const [page, setPage] = useState(props.preview.firstPage),
    [history, setHistory] = useState<Array<string | undefined>>([]);
  const [cursor, setCursor] = useState<string | undefined>(),
    [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null),
    alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  async function load(after: string | undefined, nextHistory: Array<string | undefined>) {
    if (!alive.current || busy) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = DatasetMigrationPreviewPage.parse(
        after === undefined
          ? props.preview.firstPage
          : await props.onLoad(
              {
                workspaceId: props.workspaceId,
                preparationId: props.preparationId,
                after,
                limit: 50,
              },
              controller.signal,
            ),
      );
      if (controller.signal.aborted || !alive.current) return;
      if (
        (result.nextCursor &&
          (result.nextCursor === after || nextHistory.includes(result.nextCursor))) ||
        (result.changes.length === 0 && result.nextCursor)
      )
        throw Error("The Collection returned an invalid change page. Prepare this review again.");
      setPage(result);
      setCursor(after);
      setHistory(nextHistory);
    } catch (error) {
      if (alive.current && !controller.signal.aborted)
        props.onError("dohc could not load these record changes.", error, () => {
          void load(after, nextHistory);
        });
    } finally {
      if (alive.current && !controller.signal.aborted) setBusy(false);
    }
  }
  function tableLabel(sqlName: string) {
    return migrationTableLabel(props.previousRevision, props.revision, sqlName);
  }
  function fieldLabel(tableName: string, column: string) {
    const named = (definition: DatasetDefinition) => {
      const table = definition.tables.find((table) => table.sqlName === tableName);
      return table && datasetColumnFields(table).find((field) => field.sqlColumn === column)?.name;
    };
    return named(props.revision.definition) ?? named(props.previousRevision.definition) ?? column;
  }

  const totals = summarizeMigrationPreview(
    props.preview.tables,
    props.previousRevision,
    props.revision,
  );
  const multiTable = props.preview.tables.length > 1;
  const formatClearedItem = (table: string, column: string, count: number, atLeast?: boolean) =>
    `${multiTable ? `${tableLabel(table)} · ` : ""}${fieldLabel(table, column)} (${atLeast ? `at least ${count}` : count})`;
  const confirmedClearedLabels = totals.clearedColumns
    .filter((item) => item.renamedTo === null)
    .map((item) => formatClearedItem(item.table, item.column, item.count, item.atLeast));
  const renamedColumnItems = totals.clearedColumns.filter((item) => item.renamedTo !== null);
  const hasCaution =
    totals.deletedRows > 0 ||
    totals.clearedValues > 0 ||
    totals.renamedColumnValues > 0 ||
    totals.unmatchedTables.length > 0;
  const showPaging = busy || history.length > 0 || page.nextCursor !== null;

  return (
    <section
      aria-label="Record changes"
      className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3"
      aria-busy={busy}
    >
      <h3 className="m-0 text-[12px] font-semibold text-ink">Record changes</h3>
      <div
        data-testid="migration-preview-summary"
        className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${
          hasCaution ? "border-warning/40 bg-panel-2 text-ink" : "border-line bg-panel-2 text-ink"
        }`}
      >
        {hasCaution ? (
          <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        ) : (
          <Info size={14} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
        )}
        <div className="min-w-0 space-y-0.5">
          <p className="m-0 font-medium">{summarySentence(totals, tableLabel)}</p>
          {confirmedClearedLabels.length > 0 ? (
            <p className="m-0 text-muted">
              Clears existing values in {joinList(confirmedClearedLabels)}.
            </p>
          ) : null}
          {renamedColumnItems.map((item) => (
            <p key={`${item.table}:${item.column}:${item.renamedTo}`} className="m-0 text-muted">
              {multiTable ? `${tableLabel(item.table)} · ` : ""}
              {fieldLabel(item.table, item.column)} renames column{" "}
              <code className="font-mono text-ink">{item.column}</code> to{" "}
              <code className="font-mono text-ink">{item.renamedTo}</code> ({item.count} unverified{" "}
              {item.count === 1 ? "value" : "values"}). Check the records below to confirm none were
              cleared or overwritten.
            </p>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-panel-2 text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Records in
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Before
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                After
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Changed
              </th>
            </tr>
          </thead>
          <tbody>
            {props.preview.tables.map((table) => {
              const unmatched = totals.unmatchedSqlNames.has(table.table);
              const renamed =
                totals.renamedOldSqlNames.has(table.table) ||
                totals.renamedNewSqlNames.has(table.table);
              const changedText = unmatched
                ? `${table.changedRows} ${table.changedRows === 1 ? "entry" : "entries"}`
                : recordCount(table.changedRows);
              return (
                <tr key={table.table} className="border-t border-line">
                  <th scope="row" className="px-3 py-2 font-medium text-ink">
                    {tableLabel(table.table)}
                  </th>
                  <td className="px-3 py-2 tabular-nums text-muted">
                    {recordCount(table.beforeRows)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-ink">
                    {recordCount(table.afterRows)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    <span
                      className={
                        table.changedRows
                          ? "rounded bg-panel-2 px-1.5 py-0.5 text-ink"
                          : "text-muted"
                      }
                    >
                      {changedText}
                    </span>
                    {unmatched ? (
                      <span className="ml-1.5 text-warning">(not matched by key)</span>
                    ) : renamed ? (
                      <span className="ml-1.5 text-warning">(table renamed)</span>
                    ) : table.deletedRows > 0 ? (
                      <span className="ml-1.5 text-danger">({table.deletedRows} removed)</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {page.changes.length === 0 ? (
        <p className="m-0 text-[12px] text-muted">
          No records change. Review the fields and actions before approving.
        </p>
      ) : (
        page.changes.map((change, index) => {
          const columns = [
            ...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})]),
          ];
          const unchanged = columns.filter(
            (column) =>
              JSON.stringify(ownValue(change.before, column)) ===
              JSON.stringify(ownValue(change.after, column)),
          );
          const unmatchedKey = totals.unmatchedSqlNames.has(change.table);
          const renamedTable =
            totals.renamedOldSqlNames.has(change.table) ||
            totals.renamedNewSqlNames.has(change.table);
          const ChangeIcon =
            change.kind === "delete" ? Minus : change.kind === "insert" ? Plus : Pencil;
          const badgeTone =
            unmatchedKey || renamedTable
              ? change.kind === "delete"
                ? "text-warning"
                : "text-muted"
              : change.kind === "delete"
                ? "text-danger"
                : change.kind === "insert"
                  ? "text-success"
                  : "text-muted";
          const badgeLabel =
            unmatchedKey || renamedTable
              ? change.kind === "delete"
                ? `Previous record (${renamedTable ? "table renamed" : "not matched by key"})`
                : change.kind === "insert"
                  ? `New record (${renamedTable ? "table renamed" : "not matched by key"})`
                  : "Record changed"
              : change.kind === "delete"
                ? "Record removed"
                : change.kind === "insert"
                  ? "Record added"
                  : "Record changed";
          return (
            <div key={`${history.length}:${index}`} className="border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <strong className="text-ink">{tableLabel(change.table)}</strong>
                <span
                  className={`inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 ${badgeTone}`}
                >
                  <ChangeIcon size={12} strokeWidth={1.9} aria-hidden />
                  {badgeLabel}
                </span>
              </div>
              <dl className="my-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                {Object.entries(change.key).map(([key, value]) => (
                  <div key={key} className="flex gap-1">
                    <dt>{fieldLabel(change.table, key)}:</dt>
                    <dd className="m-0">
                      <Value value={value} mono />
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-left text-[12px]">
                  <thead className="text-muted">
                    <tr>
                      <th scope="col" className="w-1/4 py-2 font-medium">
                        Field
                      </th>
                      <th scope="col" className="px-2 font-medium">
                        Before
                      </th>
                      <th scope="col" className="px-2 font-medium">
                        <span className="flex items-center gap-1.5">
                          <ArrowRight size={12} strokeWidth={1.9} aria-hidden />
                          After
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns
                      .filter((column) => !unchanged.includes(column))
                      .map((column) => {
                        return (
                          <tr key={column} className="border-t border-line bg-bg">
                            <th scope="row" className="py-2 pr-2 align-top font-medium text-ink">
                              {fieldLabel(change.table, column)}
                            </th>
                            <td className="p-2 align-top text-muted">
                              <Value value={ownValue(change.before, column)} />
                            </td>
                            <td className="p-2 align-top text-ink">
                              <Value value={ownValue(change.after, column)} />
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              {unchanged.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12px] text-muted">
                    {unchanged.length} unchanged {unchanged.length === 1 ? "field" : "fields"}
                  </summary>
                  <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 text-[12px] text-muted">
                    {unchanged.map((column) => (
                      <div key={column} className="contents">
                        <dt>{fieldLabel(change.table, column)}</dt>
                        <dd className="m-0">
                          <Value value={ownValue(change.before, column)} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          );
        })
      )}
      {showPaging ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            {busy ? "Loading changes…" : `Page ${history.length + 1}`}
          </span>
          <div className="flex gap-2">
            <SecondaryButton
              disabled={busy || history.length === 0}
              onClick={() => void load(history.at(-1), history.slice(0, -1))}
            >
              Previous changes
            </SecondaryButton>
            <SecondaryButton
              disabled={busy || !page.nextCursor}
              onClick={() => {
                if (page.nextCursor) void load(page.nextCursor, [...history, cursor]);
              }}
            >
              More changes
            </SecondaryButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

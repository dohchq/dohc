import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DatasetDescribedField, DatasetDescription } from "@dohc/security-contract/dataset";
import type { FieldDefinition } from "@dohc/workspace-contracts";
import type { FindDatasetCollectionResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import {
  automationCount,
  AutomationsButton,
  AutomationsNote,
  AutomationsPanel,
  useCollectionAutomations,
} from "./AutomationsPanel";
import type { AutomationTable } from "./automationDraft";
import type { Automation } from "./automationSentence";
import { useDatasetFieldMarks, type FieldMarks } from "./collectionFieldMarks";

// The ⚡ button, panel, and field marks of one dataset table, which is a
// Collection. A dataset keeps one automations.yaml in its folder for all its
// tables, so main first names that folder, then the panel works on it as it
// does for a document Collection and lists the automations of this table.

type ErrorReport = (fallback: string, error: unknown, retry?: (() => void) | null) => void;

const FIND_FAILED = "dohc could not read this Collection's automations.";

/**
 * A dataset table's fields as the builder offers them. A file needs an
 * upload, so it is not offered. A button stays for the button trigger. A
 * relation holds the related record's key, which the builder takes as text.
 */
export function builderFields(fields: readonly DatasetDescribedField[]): FieldDefinition[] {
  return fields.flatMap((field): FieldDefinition[] => {
    switch (field.type) {
      case "button":
        return [{ name: field.name, type: "button" }];
      case "attachment":
        return [];
      case "select":
      case "multi-select":
        return [{ name: field.name, type: field.type, options: field.options ?? [] }];
      case "relation":
        return [{ name: field.name, type: "text" }];
      default:
        return [{ name: field.name, type: field.type }];
    }
  });
}

export function useDatasetAutomations(props: {
  workspaceId: string;
  datasetId: string;
  tableId: string;
  /** The dataset as its host describes it, once the page has read it. */
  dataset: DatasetDescription | null;
  /** Rises when the page reads its records again, as after a run a press started. */
  refreshKey: number;
  /** A run's Undo changed records, so the page reads them again. */
  onRecordsChanged: () => void;
  onError: ErrorReport;
  onNotice: (message: string, undo?: () => void) => void;
  onOpenFile: (path: string) => void;
  onOpenScheduleSettings: () => void;
  /** Opens the dialog that adds fields, such as a Button field; undefined where this person cannot. */
  onOpenFields?: () => void;
}): {
  button: ReactNode;
  panel: ReactNode;
  fieldMarks: FieldMarks;
  /** Opens the panel's builder on a new automation, such as one a button starts. */
  start: (automation: Automation) => void;
  // The folder that holds the dataset's automations.yaml, once dohc finds it.
  collectionPath: string | null;
} {
  const { workspaceId, datasetId, tableId, dataset, onError } = props;
  const described = dataset?.tables.find((candidate) => candidate.tableId === tableId);
  const table = useMemo((): AutomationTable | undefined => described && {
    name: described.name,
    operations: new Set(dataset?.operations.flatMap((operation) => (operation.tableId === tableId ? [operation.name] : []))),
    tables: new Map(dataset?.tables.map((candidate) => [candidate.name, builderFields(candidate.fields)])),
    actions: (dataset?.operations ?? []).flatMap((operation) => operation.kind === "action"
      ? [{ name: operation.name, label: operation.label, table: dataset?.tables.find((candidate) => candidate.tableId === operation.tableId)?.name ?? "", reversible: operation.reversedBy !== undefined }]
      : []),
  }, [dataset, tableId]);
  const tableName = table?.name;
  // What main answered, or "failed" when dohc could not ask it; null while it asks.
  const [found, setFound] = useState<FindDatasetCollectionResult | "failed" | null>(null);
  const request = useRequestSequence([workspaceId, datasetId]);
  const find = useCallback(async () => {
    const token = request.next();
    try {
      const result = await bridge().findDatasetCollection({ workspaceId, datasetId });
      if (request.isCurrent(token)) setFound(result);
    } catch (error) {
      if (!request.isCurrent(token)) return;
      setFound((current) => (current !== null && current !== "failed" && current.status === "found" ? current : "failed"));
      onError(FIND_FAILED, error, () => void find());
    }
  }, [workspaceId, datasetId, onError]);
  useEffect(() => {
    void find();
  }, [find]);
  const collectionPath = found !== null && found !== "failed" && found.status === "found" ? found.collectionPath : null;
  const automations = useCollectionAutomations(workspaceId, collectionPath, onError);
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<{ automation: Automation; seq: number } | null>(null);
  const starts = useRef(0);
  const startWith = useCallback((automation: Automation) => {
    starts.current += 1;
    setStart({ automation, seq: starts.current });
    setOpen(true);
  }, []);
  const started = useCallback(() => setStart(null), []);
  const [closeAsk, setCloseAsk] = useState(0);
  const { reload } = automations;
  // Opening the panel, or a run changing records while it is open, reads
  // the list again for its last-run marks.
  useEffect(() => {
    if (open) void reload();
  }, [open, props.refreshKey]);
  // A save, a hand edit, or approved rules change what main read: the count
  // follows, and a dataset whose rules were approved or archived since has
  // its folder named again. A new folder reads its list on its own.
  useEffect(() => bridge().onCollectionAutomationsChanged((event) => {
    if (event.workspaceId !== workspaceId) return;
    void find();
    void reload();
  }), [workspaceId, find, reload]);
  const close = useCallback(() => {
    setOpen(false);
    setStart(null);
  }, []);
  const fields = useMemo(() => builderFields(described?.fields ?? []), [described]);
  const full = collectionPath !== null && table !== undefined;
  // The full panel may hold a draft, so the header's button asks it to close.
  const button = (
    <AutomationsButton
      open={open}
      count={automationCount(automations.file, table)}
      onClick={() => (!open ? setOpen(true) : full ? setCloseAsk((ask) => ask + 1) : close())}
    />
  );
  const panel = !open ? null : full ? (
    <AutomationsPanel
      workspaceId={workspaceId}
      collectionPath={collectionPath}
      table={table}
      automations={automations}
      fields={fields}
      focus={null}
      start={start}
      onStarted={started}
      closeAsk={closeAsk}
      onClose={close}
      onOpenFile={props.onOpenFile}
      onOpenScheduleSettings={props.onOpenScheduleSettings}
      onOpenFields={props.onOpenFields}
      onError={onError}
      onNotice={props.onNotice}
      onRunUndone={props.onRecordsChanged}
    />
  ) : (
    <AutomationsNote onClose={close}>
      {found === null ? undefined : found === "failed" ? (
        <>
          <p className="m-0">{FIND_FAILED}</p>
          <SecondaryButton size="compact" className="mt-2" onClick={() => {
            setFound(null);
            void find();
          }}>Try again</SecondaryButton>
        </>
      ) : found.status === "unavailable" ? (
        "This Collection's automations run on its owner's computer."
      ) : found.status === "cannot-run" ? found.reason : undefined}
    </AutomationsNote>
  );
  return { button, panel, fieldMarks: useDatasetFieldMarks(datasetId, tableName ?? null), start: startWith, collectionPath };
}

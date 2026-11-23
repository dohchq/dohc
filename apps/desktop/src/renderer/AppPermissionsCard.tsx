import { useEffect, useId, useRef } from "react";
import {
  Eye,
  Globe,
  Info,
  Link as LinkIcon,
  Lock,
  Pencil,
  ShieldCheck,
  Table2,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { AppDatasetCapability, DatasetRevision } from "@dohc/security-contract/dataset";
import { hasGeneratedDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { AppCollectionCapability } from "@dohc/security-contract/app-publication";
import { collectionsRefusalError } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { Pill, RetryRow } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

export type AppCapability = AppDatasetCapability | AppCollectionCapability;
export type ReportPermissionError = (
  fallback: string,
  error: unknown,
  retry: (() => void) | null,
) => void;

type Reach = { text: string; added: boolean };
type Line = { key: string; prefix?: string; items: Reach[] };
type Access = { key: string; name: string; path?: string; reads: Line[]; changes: Line[] };

const addsRecords = "Adds records with ";

function operationWords({ display }: AppDatasetCapability["operations"][number]): string {
  if (!display) return "Records";
  const fields = display.fields.join(", ");
  switch (display.kind) {
    case "read":
      return fields || "Records";
    case "create":
      return fields ? `${addsRecords}${fields}` : "Adds records";
    case "edit":
      return fields ? `Edits ${fields}` : "Edits records";
    case "delete":
      return "Deletes records";
    case "action":
      return `Runs "${display.label}"`;
  }
}

function actionSummary(operation: AppDatasetCapability["operations"][number]): string {
  if (!operation.display) return "";
  if (operation.display.kind === "read") {
    const fields = operation.display.fields.join(", ");
    return fields ? `Reads ${fields}` : "Reads records";
  }
  return operationWords(operation);
}

function createFieldsWidened(
  capability: AppDatasetCapability,
  approved: AppDatasetCapability,
  operationId: string,
): boolean {
  const prior = approved.createFields?.find((entry) => entry.operationId === operationId);
  if (!prior) return false;
  const next = capability.createFields?.find((entry) => entry.operationId === operationId);
  if (!next) return true;
  return next.fieldIds.some((fieldId) => !prior.fieldIds.includes(fieldId));
}

function prefixForFieldKind(kind: "read" | "create" | "edit"): string | undefined {
  if (kind === "create") return addsRecords;
  if (kind === "edit") return "Edits ";
  return undefined;
}

function operationLine(
  operation: AppDatasetCapability["operations"][number],
  capability: AppDatasetCapability,
  same: AppDatasetCapability | undefined,
  comparing: boolean,
): { group: string; line: Line } {
  const text = operationWords(operation);
  const prior = same?.operations.find((entry) => entry.operationId === operation.operationId);
  if (comparing && same && prior) {
    const widened = createFieldsWidened(capability, same, operation.operationId);
    const nextDisplay = operation.display;
    const priorDisplay = prior.display;
    if (
      nextDisplay &&
      priorDisplay &&
      nextDisplay.kind === priorDisplay.kind &&
      (nextDisplay.kind === "read" ||
        nextDisplay.kind === "create" ||
        nextDisplay.kind === "edit") &&
      nextDisplay.fields.length > 0 &&
      priorDisplay.fields.length > 0
    ) {
      const hasAddedField = nextDisplay.fields.some(
        (field) => !priorDisplay.fields.includes(field),
      );
      if (hasAddedField) {
        const prefix = prefixForFieldKind(nextDisplay.kind);
        return {
          group: `fields ${operation.operationId}`,
          line: {
            key: operation.operationId,
            ...(prefix ? { prefix } : {}),
            items: nextDisplay.fields.map((field) => ({
              text: field,
              added: !priorDisplay.fields.includes(field),
            })),
          },
        };
      }
    }
    const expanded =
      widened ||
      (nextDisplay !== undefined &&
        priorDisplay !== undefined &&
        (nextDisplay.kind !== priorDisplay.kind ||
          nextDisplay.label !== priorDisplay.label ||
          nextDisplay.fields.some((field) => !priorDisplay.fields.includes(field))));
    return {
      group: nextDisplay?.kind === "action" ? `action ${operation.operationId}` : `words ${text}`,
      line: { key: operation.operationId, items: [{ text, added: expanded }] },
    };
  }
  const added = comparing && !same?.operationIds.includes(operation.operationId);
  return {
    group:
      operation.display?.kind === "action" ? `action ${operation.operationId}` : `words ${text}`,
    line: { key: operation.operationId, items: [{ text, added }] },
  };
}

function accessOf(capability: AppCapability, approved: readonly AppCapability[] | null): Access {
  if (capability.kind === "dataset") {
    const same = approved?.find(
      (value): value is AppDatasetCapability =>
        value.kind === "dataset" && value.datasetId === capability.datasetId,
    );
    const lines = (operations: AppDatasetCapability["operations"]) => {
      const byGroup = new Map<string, Line>();
      for (const operation of operations) {
        const { group, line } = operationLine(operation, capability, same, approved !== null);
        const seen = byGroup.get(group);
        if (seen && seen.items.length === 1 && line.items.length === 1) {
          seen.items[0]!.added ||= line.items[0]!.added;
        } else {
          byGroup.set(seen ? `${group}:${operation.operationId}` : group, line);
        }
      }
      return [...byGroup.values()];
    };
    return {
      key: capability.datasetId,
      name: capability.name,
      reads: lines(capability.operations.filter((operation) => operation.readOnly)),
      changes: lines(capability.operations.filter((operation) => !operation.readOnly)),
    };
  }
  const same = approved?.find(
    (value): value is AppCollectionCapability =>
      value.kind !== "dataset" && value.collectionPath === capability.collectionPath,
  );
  const items = (fields: readonly string[], allowed: readonly string[] | undefined) =>
    fields.map((field) => ({ text: field, added: approved !== null && !allowed?.includes(field) }));
  return {
    key: capability.collectionPath,
    name: capability.collectionPath.split("/").pop() || capability.collectionPath,
    path: capability.collectionPath,
    reads: capability.readFields.length
      ? [{ key: "fields", items: items(capability.readFields, same?.readFields) }]
      : [],
    changes: capability.allowedFields.length
      ? [
          {
            key: "fields",
            prefix: addsRecords,
            items: items(capability.allowedFields, same?.allowedFields),
          },
        ]
      : [],
  };
}

function boundaryLineFor(capabilities: readonly AppCapability[]): string {
  const capability = capabilities[0];
  if (!capability) {
    return "Cannot read or change workspace files or Collections.";
  }
  if (capability.kind === "dataset") {
    return "Uses only this Collection's approved actions. It cannot read other workspace files.";
  }
  return "Cannot change or delete existing records, or read other workspace files.";
}

function Reaches({ lines }: { lines: Line[] }) {
  return (
    <dd className="m-0 min-w-0 break-words text-ink">
      {lines.map((line) => (
        <div key={line.key}>
          {line.prefix}
          {line.items.map((item, index) => (
            <span key={`${index}:${item.text}`}>
              {index ? ", " : ""}
              {item.text}
              {item.added ? (
                <span className="ml-1 inline-block">
                  <Pill tone="warning">New</Pill>
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ))}
    </dd>
  );
}

function AccessRows({ access }: { access: Access }) {
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2 px-3">
      <Table2 size={14} aria-hidden className="text-muted" />
      <span className="truncate text-[13px] font-medium text-ink" title={access.path}>
        {access.name}
      </span>
      <dl className="col-start-2 m-0 mt-2 grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[13px]">
        {access.reads.length ? (
          <>
            <dt className="flex items-center gap-2 self-start text-muted">
              <Eye size={12} aria-hidden />
              Reads
            </dt>
            <Reaches lines={access.reads} />
          </>
        ) : null}
        {access.changes.length ? (
          <>
            <dt className="flex items-center gap-2 self-start text-muted">
              <Pencil size={12} aria-hidden />
              Changes
            </dt>
            <Reaches lines={access.changes} />
          </>
        ) : null}
      </dl>
    </div>
  );
}

export function AppAccessSummary({
  capabilities,
  approved,
  failed,
  onRetry,
}: {
  capabilities: readonly AppCapability[] | null;
  approved: readonly AppCapability[] | null;
  failed: boolean;
  onRetry(): void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="m-0 mb-2 text-[13px] font-medium text-ink">
        What it can reach
      </h3>
      <div data-testid="app-access" className="rounded-lg border border-line bg-bg">
        {capabilities ? (
          <>
            <div className="flex flex-col gap-3 py-3">
              {capabilities.length ? (
                capabilities.map((capability) => {
                  const access = accessOf(capability, approved);
                  return <AccessRows key={access.key} access={access} />;
                })
              ) : (
                <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2 px-3">
                  <Table2 size={14} aria-hidden className="text-muted" />
                  <span className="text-[13px] text-muted">No workspace data</span>
                </div>
              )}
            </div>
            <p
              data-testid="app-access-boundary"
              className="m-0 flex items-start gap-2 border-t border-line px-3 py-2 text-[12px] text-muted"
            >
              <ShieldCheck size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              <span className="min-w-0">{boundaryLineFor(capabilities)}</span>
            </p>
            <p className="m-0 flex items-start gap-2 border-t border-line px-3 py-2 text-[12px] text-muted">
              <Globe size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              <span className="min-w-0">It can send what it receives to other websites.</span>
            </p>
          </>
        ) : failed ? (
          <RetryRow testId="app-access-retry" onRetry={onRetry} />
        ) : (
          <SkeletonRows rows={3} label="Loading what this app can reach…" className="p-3" />
        )}
      </div>
    </section>
  );
}

function OperationNames({ operations }: { operations: AppDatasetCapability["operations"] }) {
  if (operations.length === 0) return <span className="text-muted">None</span>;
  return (
    <>
      {operations.map((operation, index) => {
        const needsMutability = !operation.display || operation.display.kind === "action";
        return (
          <span key={operation.operationId}>
            {index ? ", " : ""}
            {operation.display ? (
              <>
                <span className="text-ink">{actionSummary(operation)}</span>
                {" · "}
              </>
            ) : null}
            <span className="font-mono text-ink">{operation.name}</span>
            {needsMutability ? (
              <>
                {" "}
                <span className="text-muted">
                  ({operation.readOnly ? "reads only" : "changes data"})
                </span>
              </>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

type DatasetAddress = {
  path: string | null;
  status: "missing" | "ambiguous" | "unreadable" | "failed" | "available";
};

function deriveOperationDisplays(
  capability: AppDatasetCapability,
  revision: DatasetRevision,
  operationSource: string,
  generatedSources: boolean | undefined,
): AppDatasetCapability["operations"] | null {
  if (
    revision.datasetId !== capability.datasetId ||
    revision.revision !== capability.revision ||
    revision.revisionSha256 !== capability.revisionSha256
  ) {
    return null;
  }
  const generated =
    generatedSources === true &&
    hasGeneratedDatasetOperations(operationSource, revision.definition);
  const operations: AppDatasetCapability["operations"] = [];
  for (const operation of capability.operations) {
    if (operation.display) {
      operations.push(operation);
      continue;
    }
    const declared = revision.definition.operations.find(
      (candidate) => candidate.operationId === operation.operationId,
    );
    const table = revision.definition.tables.find(
      (candidate) => candidate.tableId === declared?.tableId,
    );
    if (!declared || !table) return null;
    if (!generated) {
      operations.push({
        ...operation,
        display: { kind: "action", label: declared.label, fields: [] },
      });
      continue;
    }
    const fieldIds =
      capability.createFields?.find((entry) => entry.operationId === operation.operationId)
        ?.fieldIds ?? declared.fieldIds;
    operations.push({
      ...operation,
      display: {
        kind: declared.kind,
        label: declared.label,
        fields: table.fields
          .filter((field) => fieldIds.includes(field.fieldId))
          .map((field) => field.name),
      },
    });
  }
  return operations;
}

export function DatasetPermissionCard({
  capability,
  workspaceId,
  reportError,
  draftLinkReads = false,
  loadDisplay = false,
}: {
  capability: AppDatasetCapability;
  workspaceId: string;
  reportError: ReportPermissionError;
  draftLinkReads?: boolean;
  loadDisplay?: boolean;
}) {
  const { datasetId } = capability;
  const session = useWorkspaceSession();
  const { value, error, retry } = useWorkspaceQuery(session, {
    key: JSON.stringify([workspaceId, datasetId]),
    load: async (signal): Promise<DatasetAddress> => {
      let after: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await bridge().dataset({
          action: "list",
          workspaceId,
          after,
          includeArchived: true,
        });
        signal.throwIfAborted();
        if (page.kind === "collections-refused") throw collectionsRefusalError(page.refusal);
        if (page.kind !== "list") throw Error("dohc could not find this Collection.");
        const dataset = page.datasets.find((entry) => entry.datasetId === datasetId);
        if (dataset)
          return {
            path: dataset.datasetPath,
            status: dataset.datasetAddressStatus ?? (dataset.datasetPath ? "available" : "missing"),
          };
        after = page.nextCursor ?? undefined;
        if (after && seen.has(after)) throw Error("The Collection list changed. Try again.");
        if (after) seen.add(after);
      } while (after);
      return { path: null, status: "missing" };
    },
  });
  const report = useRef(reportError);
  report.current = reportError;
  const newestError = useRef<unknown>(null);
  useEffect(() => {
    newestError.current = error;
    if (error === null) return;
    report.current("dohc could not find this Collection.", error, () => {
      if (newestError.current !== error) return;
      newestError.current = null;
      void retry();
    });
  }, [error, retry]);
  const found: DatasetAddress | null =
    error !== null ? { path: null, status: "failed" } : (value ?? null);
  const needsDisplay = loadDisplay && capability.operations.some((operation) => !operation.display);
  const datasetPath = found?.path ?? null;
  const displayQuery = useWorkspaceQuery(session, {
    key: JSON.stringify([
      workspaceId,
      datasetId,
      capability.revisionSha256,
      capability.operationIds,
      capability.createFields ?? null,
      datasetPath ?? "",
      needsDisplay,
    ]),
    manual: !needsDisplay || !datasetPath,
    load: async (signal): Promise<AppDatasetCapability["operations"] | null> => {
      if (!datasetPath || !needsDisplay) return null;
      try {
        const result = await bridge().dataset({
          action: "historyRevision",
          workspaceId,
          datasetPath,
          revisionSha256: capability.revisionSha256,
        });
        signal.throwIfAborted();
        if (result.kind !== "history-revision") return null;
        return deriveOperationDisplays(
          capability,
          result.revision,
          result.operationSource,
          result.generatedSources,
        );
      } catch {
        return null;
      }
    },
  });
  const operations = displayQuery.value ?? capability.operations;
  const addressWarning =
    found !== null &&
    found.path === null &&
    (found.status === "ambiguous" || found.status === "unreadable" || found.status === "missing");

  const linkOps = operations.filter(
    (operation) =>
      operation.access === "link" ||
      capability.linkReads?.some((read) => read.operationId === operation.operationId),
  );
  const helperOps = operations.filter((operation) => operation.access === "helper");
  const ownerOps = operations.filter((operation) => operation.access === "owner");

  return (
    <div
      data-testid="app-publication-capability"
      className="overflow-hidden rounded-lg border border-line bg-bg"
    >
      <div className="flex items-start gap-2 border-b border-line bg-panel-2 px-3 py-2">
        <Table2 size={14} aria-hidden className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-[13px] font-medium text-ink">{capability.name}</p>
          <p
            className={`m-0 flex items-start gap-1.5 break-all text-[12px] ${addressWarning ? "text-warning" : "text-muted"}`}
          >
            {addressWarning ? (
              <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />
            ) : null}
            <span className="min-w-0">
              {!found
                ? "Finding Collection…"
                : (found.path ??
                  (found.status === "ambiguous"
                    ? "Multiple dataset.json files name this Collection. Remove the duplicate file."
                    : found.status === "unreadable"
                      ? "dohc can't read this Collection's dataset.json. Fix the file, or restore it from History."
                      : found.status === "missing"
                        ? "Collection source missing. Restore its dataset.json file."
                        : "Collection path unavailable"))}
            </span>
          </p>
        </div>
      </div>
      <div className="space-y-2.5 p-3 text-[12px]">
        <dl className="m-0 space-y-1.5">
          <div>
            <dt className="inline-flex items-center gap-1.5 font-medium text-ink">
              <LinkIcon size={12} aria-hidden className="shrink-0 text-subtle" />
              Link actions:
            </dt>{" "}
            <dd className="m-0 inline">
              <OperationNames operations={linkOps} />
            </dd>
          </div>
          <div>
            <dt className="inline-flex items-center gap-1.5 font-medium text-ink">
              <Users size={12} aria-hidden className="shrink-0 text-subtle" />
              Helper actions:
            </dt>{" "}
            <dd className="m-0 inline">
              <OperationNames operations={helperOps} />
            </dd>
          </div>
          <div>
            <dt className="inline-flex items-center gap-1.5 font-medium text-ink">
              <Lock size={12} aria-hidden className="shrink-0 text-subtle" />
              Owner actions:
            </dt>{" "}
            <dd className="m-0 inline">
              <OperationNames operations={ownerOps} />
            </dd>
          </div>
        </dl>
        {capability.linkReads?.length ? (
          <p className="m-0 rounded-md bg-panel-2 px-2.5 py-1.5 text-[12px] text-muted">
            {draftLinkReads ? "Selected link reads: " : "Approved link reads: "}
            {operations
              .filter((operation) =>
                capability.linkReads!.some((read) => read.operationId === operation.operationId),
              )
              .map((operation) => {
                const fieldNames =
                  operation.fields?.map((field) => field.name) ?? operation.display?.fields;
                return fieldNames?.length
                  ? `${operation.name} (${fieldNames.join(", ")})`
                  : operation.name;
              })
              .join("; ")}
            .{" "}
            {draftLinkReads
              ? "People with the link can use these once published."
              : "Unpublish to withdraw access."}
          </p>
        ) : null}
      </div>
      <p className="m-0 flex items-start gap-2 border-t border-line px-3 py-2 text-[12px] text-muted">
        <ShieldCheck size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
        <span className="min-w-0">
          This app uses only this Collection's approved actions. Its responses appear in the same
          Collection, and approving this app does not change the Collection's rules.
        </span>
      </p>
      <details className="border-t border-line px-3 py-2 text-[12px] text-muted">
        <summary className="cursor-pointer">Collection revision</summary>
        <p className="mb-1 mt-1.5 break-all font-mono">Revision {capability.revision}</p>
        <p className="m-0 break-all font-mono">{capability.revisionSha256}</p>
      </details>
    </div>
  );
}

export function CollectionPermissionCard({
  capability,
  compact = false,
}: {
  capability: AppCollectionCapability;
  compact?: boolean;
}) {
  return (
    <div
      data-testid="app-publication-capability"
      className="overflow-hidden rounded-lg border border-line bg-bg"
    >
      <div className="flex items-start gap-2 border-b border-line bg-panel-2 px-3 py-2">
        <Table2 size={14} aria-hidden className="mt-0.5 shrink-0 text-muted" />
        <p className="m-0 min-w-0 text-[13px] font-medium text-ink">
          Creates records only in <span className="break-all">{capability.collectionPath}</span>.
        </p>
      </div>
      {compact ? (
        <div className="space-y-1 p-3 text-[12px] text-ink">
          <p className="m-0 break-words">Create: {capability.allowedFields.join(", ")}</p>
          <p className="m-0 break-words">
            Required: {capability.requiredFields.join(", ") || "None"}
          </p>
          <p className="m-0 break-words">
            Shown in the app: {capability.readFields.join(", ") || "None"}
          </p>
        </div>
      ) : (
        <dl className="m-0 space-y-1.5 p-3 text-[12px]">
          <div>
            <dt className="inline font-medium text-ink">Fields it can create: </dt>
            <dd className="m-0 inline break-words text-ink">
              {capability.allowedFields.join(", ")}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-ink">Required fields: </dt>
            <dd className="m-0 inline break-words text-ink">
              {capability.requiredFields.join(", ") || "None"}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-ink">Fields shown in the app: </dt>
            <dd className="m-0 inline break-words text-ink">
              {capability.readFields.join(", ") || "None"}
            </dd>
          </div>
        </dl>
      )}
      <div className="space-y-1.5 border-t border-line px-3 py-2 text-[12px] text-muted">
        <p className="m-0 flex items-start gap-2">
          <Info size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
          <span className="min-w-0">
            People with this share can read every response file and all its fields.
          </span>
        </p>
        <p className="m-0 flex items-start gap-2">
          <ShieldCheck size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
          <span className="min-w-0">The app cannot change or delete existing records.</span>
        </p>
      </div>
      {!compact ? (
        <details className="border-t border-line px-3 py-2 text-[12px] text-muted">
          <summary className="cursor-pointer">Collection schema revision</summary>
          <p className="mb-0 mt-1.5 break-all font-mono">{capability.schemaSha256}</p>
        </details>
      ) : null}
    </div>
  );
}

export function ExternalNetworkCard({
  sharedCollectionFiles = false,
}: {
  sharedCollectionFiles?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
      <Globe size={14} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
      <div className="min-w-0 space-y-1">
        <p className="m-0">The app can use external services and send them data it receives.</p>
        <p className="m-0">
          {sharedCollectionFiles
            ? "Unpublishing stops new access through this app. The share link still opens its response files. Copies sent elsewhere stay."
            : "Unpublishing stops new access through this app. It cannot remove copies sent elsewhere."}
        </p>
      </div>
    </div>
  );
}

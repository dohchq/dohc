import { useEffect, useId, useRef } from "react";
import {
  Check,
  Eye,
  Globe,
  Info,
  Link as LinkIcon,
  Lock,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Table2,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { AppDatasetCapability, DatasetRevision } from "@dohc/security-contract/dataset";
import { hasGeneratedDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { AppCollectionCapability } from "@dohc/security-contract/app-publication";
import { collectionsRefusalError } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { Pill, RetryRow, SectionLabel } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

export type AppCapability = AppDatasetCapability | AppCollectionCapability;
export type ReportPermissionError = (
  fallback: string,
  error: unknown,
  retry: (() => void) | null,
) => void;

type Operation = AppDatasetCapability["operations"][number];
type Kind = NonNullable<Operation["display"]>["kind"];
type Mark = { text: string; added: boolean };
type Row = {
  key: string;
  kind: Kind | null;
  label: string;
  fields: Mark[];
  added: boolean;
  name?: string;
};
type Access = {
  key: string;
  name: string;
  alias?: string;
  path?: string;
  reads: Row[];
  changes: Row[];
};

const kindIcons = { read: Eye, create: Plus, edit: Pencil, delete: Trash2, action: Play } as const;

function labelOf({ display }: Operation): string {
  if (!display) return "Records";
  const prefix = display.table ? `${display.table}: ` : "";
  switch (display.kind) {
    case "read":
      return `${prefix}Reads records`;
    case "create":
      return `${prefix}Adds records`;
    case "edit":
      return `${prefix}Edits records`;
    case "delete":
      return `${prefix}Deletes records`;
    case "action":
      return `${prefix}Runs "${display.label}"`;
  }
}

const unmarked = (fields: readonly string[]): Mark[] =>
  fields.map((text) => ({ text, added: false }));

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

function operationRow(
  operation: Operation,
  capability: AppDatasetCapability,
  same: AppDatasetCapability | undefined,
): Row {
  const display = operation.display;
  const fields = display?.fields ?? [];
  const base = {
    key: operation.operationId,
    kind: display?.kind ?? null,
    label: labelOf(operation),
  };
  const prior = same?.operations.find((entry) => entry.operationId === operation.operationId);
  if (!same || !prior) {
    return {
      ...base,
      fields: unmarked(fields),
      added: !!same && !same.operationIds.includes(operation.operationId),
    };
  }
  const priorDisplay = prior.display;
  const isNew = (field: string) => !!priorDisplay && !priorDisplay.fields.includes(field);
  if (
    display &&
    priorDisplay &&
    display.kind === priorDisplay.kind &&
    (display.kind === "read" || display.kind === "create" || display.kind === "edit") &&
    fields.length > 0 &&
    priorDisplay.fields.length > 0 &&
    fields.some(isNew)
  ) {
    return { ...base, fields: fields.map((text) => ({ text, added: isNew(text) })), added: false };
  }
  const expanded =
    createFieldsWidened(capability, same, operation.operationId) ||
    (display !== undefined &&
      priorDisplay !== undefined &&
      (display.kind !== priorDisplay.kind ||
        display.label !== priorDisplay.label ||
        fields.some(isNew)));
  return { ...base, fields: unmarked(fields), added: expanded };
}

function mergedRows(rows: Row[]): Row[] {
  const byGroup = new Map<string, Row>();
  for (const row of rows) {
    const group =
      row.kind === "action"
        ? `action ${row.key}`
        : `${row.label}|${row.fields.map((field) => field.text).join(",")}`;
    const seen = byGroup.get(group);
    if (!seen) {
      byGroup.set(group, { ...row, fields: row.fields.map((field) => ({ ...field })) });
      continue;
    }
    seen.added ||= row.added;
    row.fields.forEach((field, index) => {
      seen.fields[index]!.added ||= field.added;
    });
  }
  return [...byGroup.values()];
}

function collectionRows(
  capability: AppCollectionCapability,
  marks: (fields: readonly string[], kind: "read" | "create") => Mark[],
): Pick<Access, "reads" | "changes"> {
  const row = (kind: "read" | "create", fields: readonly string[]): Row[] =>
    fields.length
      ? [
          {
            key: kind,
            kind,
            label: kind === "read" ? "Reads records" : "Adds records",
            fields: marks(fields, kind),
            added: false,
          },
        ]
      : [];
  return {
    reads: row("read", capability.readFields),
    changes: row("create", capability.allowedFields),
  };
}

function accessOf(capability: AppCapability, approved: readonly AppCapability[] | null): Access {
  if (capability.kind === "dataset") {
    const same = approved?.find(
      (value): value is AppDatasetCapability =>
        value.kind === "dataset" && value.datasetId === capability.datasetId,
    );
    const rows = (operations: Operation[]) =>
      mergedRows(
        operations.map((operation) => {
          const row = operationRow(operation, capability, same);
          return approved !== null && !same ? { ...row, added: true } : row;
        }),
      );
    return {
      key: capability.datasetId,
      name: capability.name,
      ...(capability.alias ? { alias: capability.alias } : {}),
      reads: rows(capability.operations.filter((operation) => operation.readOnly)),
      changes: rows(capability.operations.filter((operation) => !operation.readOnly)),
    };
  }
  const same = approved?.find(
    (value): value is AppCollectionCapability =>
      value.kind !== "dataset" && value.collectionPath === capability.collectionPath,
  );
  return {
    key: capability.collectionPath,
    name: capability.collectionPath.split("/").pop() || capability.collectionPath,
    path: capability.collectionPath,
    ...collectionRows(capability, (fields, kind) =>
      fields.map((text) => ({
        text,
        added:
          approved !== null &&
          !(kind === "read" ? same?.readFields : same?.allowedFields)?.includes(text),
      })),
    ),
  };
}

function boundaryLineFor(capabilities: readonly AppCapability[]): string {
  const capability = capabilities[0];
  if (!capability) {
    return "Cannot read or change workspace files or Collections.";
  }
  if (capability.kind === "dataset") {
    return capabilities.length > 1
      ? "Uses only these Collections' approved actions. It cannot read other workspace files."
      : "Uses only this Collection's approved actions. It cannot read other workspace files.";
  }
  return "Cannot change or delete existing records, or read other workspace files.";
}

function NewMark() {
  return (
    <span className="ml-1 inline-block">
      <Pill tone="warning">New</Pill>
    </span>
  );
}

function ActionCell({ row, changes }: { row: Row; changes: boolean }) {
  const Icon = row.kind ? kindIcons[row.kind] : Table2;
  return (
    <div className="flex min-w-0 items-start gap-2 text-[13px]">
      <span
        title={changes ? "Changes data" : "Reads only"}
        className={`grid size-5 shrink-0 place-items-center rounded ${changes ? "bg-selected text-ink" : "border border-line text-muted"}`}
      >
        <Icon size={12} aria-hidden />
      </span>
      <div className="min-w-0 break-words">
        <span className="text-ink">{row.label}</span>
        {row.added ? <NewMark /> : null}
        {row.fields.length || row.name ? (
          <p className="m-0 text-[12px] text-muted">
            {row.fields.map((field, index) => (
              <span key={`${index}:${field.text}`}>
                {index ? ", " : ""}
                {field.text}
                {field.added ? <NewMark /> : null}
              </span>
            ))}
            {row.name ? (
              <>
                {row.fields.length ? " · " : ""}
                <span className="font-mono text-[11px]">{row.name}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function groupsOf<T>(changes: T[], reads: T[]) {
  return [
    { label: "Changes data", items: changes, changes: true },
    { label: "Reads only", items: reads, changes: false },
  ].filter((group) => group.items.length);
}

function RowGroups({ changes, reads }: { changes: Row[]; reads: Row[] }) {
  return (
    <div className="flex flex-col gap-3">
      {groupsOf(changes, reads).map((group) => (
        <div key={group.label} className="flex flex-col gap-2">
          <SectionLabel as="p" className="m-0">
            {group.label}
          </SectionLabel>
          {group.items.map((row) => (
            <ActionCell key={row.key} row={row} changes={group.changes} />
          ))}
        </div>
      ))}
    </div>
  );
}

function AccessRows({ access }: { access: Access }) {
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2 px-3">
      <Table2 size={14} aria-hidden className="text-muted" />
      <span className="truncate text-[13px] font-medium text-ink" title={access.path}>
        {access.name}
        {access.alias ? (
          <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">
            {access.alias}
          </span>
        ) : null}
      </span>
      <div className="col-start-2 mt-2">
        <RowGroups changes={access.changes} reads={access.reads} />
      </div>
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
            <div className="flex flex-col gap-4 py-3">
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
  const multiTable = revision.definition.tables.length > 1;
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
    const tableDisplay = multiTable ? { table: table.name } : {};
    if (!generated) {
      operations.push({
        ...operation,
        display: { kind: "action", label: declared.label, fields: [], ...tableDisplay },
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
        ...tableDisplay,
      },
    });
  }
  return operations;
}

export type LinkReadChoice = {
  selected: ReadonlySet<string>;
  shared: ReadonlySet<string>;
  disabled: boolean;
  onChange(operation: Operation, checked: boolean): void;
};

const audiences = [
  { label: "Link", title: "Anyone with the link", Icon: LinkIcon },
  { label: "Helpers", title: "People you gave access to this Collection", Icon: Users },
  { label: "You", title: "Only you", Icon: Lock },
] as const;

function Allowed({ yes }: { yes: boolean }) {
  return yes ? (
    <>
      <Check size={14} aria-hidden className="inline-block text-ink" />
      <span className="sr-only">Yes</span>
    </>
  ) : (
    <>
      <span aria-hidden className="inline-block size-1 rounded-full bg-subtle align-middle" />
      <span className="sr-only">No</span>
    </>
  );
}

function AudienceTable({
  operations,
  approvedReads,
  choice,
  narrow,
}: {
  operations: Operation[];
  approvedReads: ReadonlySet<string>;
  choice: LinkReadChoice | undefined;
  narrow: boolean;
}) {
  const items = operations.map((operation) => {
    const id = operation.operationId;
    const choosable = !!choice && operation.access === "helper" && operation.fields !== undefined;
    const exactFields =
      (choosable || approvedReads.has(id)) && operation.fields
        ? operation.fields.map((field) => field.name)
        : (operation.display?.fields ?? []);
    const row: Row = {
      key: id,
      kind: operation.display?.kind ?? null,
      label: operation.display ? labelOf(operation) : operation.name,
      fields: unmarked(exactFields),
      added: false,
      ...(operation.display ? { name: operation.name } : {}),
    };
    return {
      operation,
      row,
      choosable,
      onLink: operation.access === "link" || approvedReads.has(id),
    };
  });
  const choosable = items.filter((item) => item.choosable);
  const blocked = choosable.filter((item) => choice!.shared.has(item.operation.operationId));
  const cell = `${narrow ? "w-8" : "w-14"} py-2 text-center align-top`;
  return (
    <>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="p-0">
              <span className="sr-only">Action</span>
            </th>
            {audiences.map(({ label, title, Icon }) => (
              <th
                key={label}
                scope="col"
                title={title}
                className={`${narrow ? "w-8" : "w-14"} py-2 align-bottom text-[12px] font-normal text-muted`}
              >
                <span className="flex flex-col items-center gap-1">
                  <Icon size={14} aria-hidden />
                  <span className={narrow ? "sr-only" : undefined}>{label}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {groupsOf(
          items.filter((item) => !item.operation.readOnly),
          items.filter((item) => item.operation.readOnly),
        ).map((group) => (
          <tbody key={group.label}>
            <tr>
              <th scope="colgroup" colSpan={4} className="px-3 pb-1 pt-3 text-left font-normal">
                <SectionLabel>{group.label}</SectionLabel>
              </th>
            </tr>
            {group.items.map(({ operation, row, choosable: canChoose, onLink }) => (
              <tr key={row.key}>
                <th scope="row" className="py-2 pl-3 pr-2 text-left align-top font-normal">
                  <ActionCell row={row} changes={group.changes} />
                </th>
                <td className={cell}>
                  {canChoose ? (
                    <input
                      type="checkbox"
                      aria-label={`Let anyone with the link use ${operation.name}`}
                      title={`Let anyone with the link use ${operation.name}`}
                      checked={choice!.selected.has(operation.operationId)}
                      disabled={choice!.disabled || choice!.shared.has(operation.operationId)}
                      onChange={(event) => choice!.onChange(operation, event.target.checked)}
                    />
                  ) : (
                    <Allowed yes={onLink} />
                  )}
                </td>
                <td className={cell}>
                  <Allowed yes={operation.access !== "owner"} />
                </td>
                <td className={cell}>
                  <Allowed yes />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {choosable.length > blocked.length ? (
        <p className="m-0 px-3 py-2 text-[12px] text-muted">
          Ticked reads show anyone with the link current records and later changes. Unpublish to
          withdraw access.
        </p>
      ) : null}
      {blocked.map(({ operation }) => (
        <p key={operation.operationId} className="m-0 px-3 py-2 text-[12px] text-muted">
          dohc can't open {operation.name} to the link, because another of this app's Collections
          has an action with the same name.
        </p>
      ))}
    </>
  );
}

export function DatasetPermissionCard({
  capability,
  workspaceId,
  reportError,
  linkReadChoice,
  narrow = false,
  loadDisplay = false,
}: {
  capability: AppDatasetCapability;
  workspaceId: string;
  reportError: ReportPermissionError;
  linkReadChoice?: LinkReadChoice;
  narrow?: boolean;
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
      <div className="pb-1">
        <AudienceTable
          operations={operations}
          approvedReads={new Set(capability.linkReads?.map((read) => read.operationId))}
          choice={linkReadChoice}
          narrow={narrow}
        />
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
  const required = new Set(capability.requiredFields);
  const rows = collectionRows(capability, (fields, kind) =>
    unmarked(
      kind === "create"
        ? fields.map((field) => (required.has(field) ? `${field} (required)` : field))
        : fields,
    ),
  );
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
      <div className="p-3">
        <RowGroups {...rows} />
      </div>
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

import { AppWindow, Database, TriangleAlert, Zap } from "lucide-react";
import type { AddressedDatasetDescription } from "@dohc/cli/dataset";
import { bridge } from "./bridge";
import { boundAppStatusLabel } from "./CollectionMigrationReviewDialog";
import { Overlay } from "./Overlay";
import { readCollectionConnections, type CollectionConnections } from "./collectionConnections";
import { EmptyState, RetryRow, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

export interface CollectionConnectionsDialogProps {
  workspaceId: string;
  datasets: readonly AddressedDatasetDescription[];
  documentFolders: ReadonlySet<string>;
  /** Whether this viewer owns the workspace, and so can see which apps use its Collections. */
  owner: boolean;
  /** Home has more Collections than it has listed. */
  more: boolean;
  onClose(): void;
}

/** Which apps and automations use each Collection this viewer can open. */
export function CollectionConnectionsDialog(props: CollectionConnectionsDialogProps) {
  const { workspaceId, datasets, owner } = props;
  const documentFolders = [...props.documentFolders].sort();
  const session = useWorkspaceSession();
  const query = useWorkspaceQuery(session, {
    key: JSON.stringify([
      workspaceId,
      owner,
      datasets.map((dataset) => [dataset.datasetId, dataset.datasetPath]),
      documentFolders,
    ]),
    load: (signal) =>
      readCollectionConnections(
        datasets,
        documentFolders,
        {
          ...(owner
            ? {
                apps: async (datasetPath, expectedDatasetId) => {
                  const result = await bridge().dataset({
                    action: "permissions",
                    workspaceId,
                    datasetPath,
                    expectedDatasetId,
                    limit: 100,
                  });
                  if (result.kind !== "permissions") throw Error("dohc could not read access.");
                  return result;
                },
              }
            : {}),
          automations: (collectionPath) =>
            bridge().listCollectionAutomations({ workspaceId, collectionPath }),
        },
        signal,
      ),
  });
  const groups = query.value;
  const failed = groups?.filter((group) => group.failed).length ?? 0;
  return (
    <Overlay
      onClose={props.onClose}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-label": "Collection connections",
        className:
          "dohc-elevated dohc-pop-in flex max-h-[85vh] w-[min(640px,92vw)] flex-col gap-4 rounded-xl border border-line bg-panel p-5 text-ink",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-base font-semibold">Connections</h2>
        <SecondaryButton onClick={props.onClose}>Close</SecondaryButton>
      </div>
      {query.error !== null && !groups ? (
        <RetryRow testId="connections-failed" onRetry={() => void query.retry()}>
          dohc could not read which apps and automations use your Collections.
        </RetryRow>
      ) : !groups ? (
        <SkeletonRows label="Loading connections…" />
      ) : groups.length === 0 ? (
        <EmptyState icon={Database} title="No Collections yet." />
      ) : (
        <div className="flex min-h-0 flex-col gap-5 overflow-auto" data-testid="connections">
          {failed > 0 && (
            <RetryRow
              testId="connections-partial"
              disabled={query.pending}
              onRetry={() => void query.retry()}
            >
              dohc could not check {failed === 1 ? "1 Collection" : `${failed} Collections`}.
            </RetryRow>
          )}
          {groups.map((group) => (
            <Group key={group.key} group={group} />
          ))}
          {props.more && (
            <p className="m-0 text-[12px] text-muted">
              Shows the Collections Home has loaded. Load more on Home to see others.
            </p>
          )}
        </div>
      )}
    </Overlay>
  );
}

function Group({ group }: { group: CollectionConnections }) {
  const apps = group.apps ?? [];
  const nothing =
    !group.failed && apps.length === 0 && group.automations.length === 0 && !group.incomplete;
  return (
    <section aria-label={group.name} className="flex flex-col gap-1">
      <h3 className="m-0 flex min-w-0 items-center gap-2 text-[13px] font-semibold">
        <Database size={14} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />
        <span className="truncate">{group.name}</span>
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-6 text-[12px]">
        {apps.map((app) => {
          const status = boundAppStatusLabel(app.status);
          return (
            <li key={app.publicationId} className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <AppWindow size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
                <span className="sr-only">App </span>
                <span className="truncate font-medium">
                  {app.appRoot.slice(app.appRoot.lastIndexOf("/") + 1)}
                </span>
                {app.access && <span className="shrink-0 text-muted">{app.access}</span>}
              </span>
              {status && (
                <span className="flex items-center gap-1 pl-[18px] text-warning">
                  <TriangleAlert size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
                  {status}
                  {app.reasons.length > 0 && (
                    <span className="truncate text-muted">{app.reasons.join(" ")}</span>
                  )}
                </span>
              )}
              {app.also.length > 0 && (
                <span className="truncate pl-[18px] text-muted">
                  Also uses {app.also.join(", ")}
                </span>
              )}
            </li>
          );
        })}
        {group.automations.map((automation) => (
          <li key={automation.key} className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
              <span className="sr-only">Automation </span>
              <span className="truncate font-medium">{automation.name}</span>
              {automation.trigger && (
                <span className="truncate text-muted">{automation.trigger}</span>
              )}
              {!automation.enabled && <span className="shrink-0 text-muted">Off</span>}
            </span>
            {automation.cannotRun && (
              <span className="flex items-center gap-1 pl-[18px] text-warning">
                <TriangleAlert size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
                <span className="truncate">{automation.cannotRun}</span>
              </span>
            )}
          </li>
        ))}
        {group.incomplete && (
          <li className="text-muted">dohc could not check everything that uses this Collection.</li>
        )}
        {nothing && (
          <li className="text-muted">
            {group.apps === null ? "No automations." : "No apps or automations."}
          </li>
        )}
      </ul>
    </section>
  );
}

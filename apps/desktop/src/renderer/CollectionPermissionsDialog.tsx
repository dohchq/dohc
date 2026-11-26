import { useContext, useEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { DatasetBoundApp, DatasetPermissionsPage, DatasetPlace } from "@dohc/cli/dataset";
import type { RelayShareGrantedRow } from "../ipc/bridgeContract";
import {
  namingCollectionMove,
  readError,
  UNKNOWN_ERROR_WORDS,
  withErrorWords,
} from "../ipc/errorWords";
import { bridge } from "./bridge";
import { BOUND_APP_SCOPE_LABEL, boundAppStatusLabel } from "./CollectionMigrationReviewDialog";
import { Overlay } from "./Overlay";
import { inputClass } from "./collections/FieldForm";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { ShellErrorReporter, type ReportShellFailure } from "./shell/useShellError";

interface Props {
  workspaceId: string;
  datasetPath: string;
  dataset: DatasetDescription;
  onClose(): void;
  onError(fallback: string, cause: unknown, retry?: (() => void) | null): void;
  /** Removes the row in Notices a report with this identity left. */
  onSettled?(identity: string): void;
}
type Target = { workspaceId: string; datasetPath: string; expectedDatasetId: string };
type Levels = { view: string[]; comment: string[]; edit: string[] };
type Rules = NonNullable<DatasetPermissionsPage["rules"]>;
const LEVELS = [
  ["view", "View"],
  ["comment", "Comment"],
  ["edit", "Edit"],
] as const;
type Change =
  | { principalKey: string }
  | { principalKey?: undefined; defaults: Levels & { revision: number; revisionSha256: string } }
  | {
      principalKey?: undefined;
      defaults?: undefined;
      grantId: string;
      person: string;
      operationIds: string[];
    };
type Failure = { principalKey?: string; defaults?: true; words: string };
const levelsOf = (page: DatasetPermissionsPage): Levels => {
  const known = (id: string) => !!page.rules?.actions.some((action) => action.operationId === id);
  return {
    view: page.defaults?.view.filter(known).sort() ?? [],
    comment: page.defaults?.comment.filter(known).sort() ?? [],
    edit: page.defaults?.edit.filter(known).sort() ?? [],
  };
};
// One row in Notices for this Collection's failed access change, which the next change that succeeds removes,
// so an older Try again never undoes newer access. A save names a person by grant and a removal by key, so the row can't be per person.
const changeIdentity = (datasetId: string) => `collection-access:${datasetId}`;
async function changeAccess(target: Target, dataset: DatasetDescription, change: Change) {
  const result = await bridge().dataset(
    change.principalKey !== undefined
      ? { ...target, action: "removeGrant", principalKey: change.principalKey }
      : change.defaults
        ? { ...target, action: "setDefaults", defaults: change.defaults }
        : {
            ...target,
            action: "setGrant",
            grantId: change.grantId,
            grant: {
              revision: dataset.revision,
              revisionSha256: dataset.revisionSha256,
              operationIds: change.operationIds,
              discover: true,
            },
          },
  );
  if (result.kind !== "grant-updated") throw Error("dohc could not confirm Collection access.");
}
// A change that answered after its dialog closed takes a toast and a row, whose Try again runs it again.
function reportClosed(
  report: ReportShellFailure,
  run: () => Promise<void>,
  change: Change,
  dataset: DatasetDescription,
  cause: unknown,
) {
  report({
    title:
      change.principalKey !== undefined
        ? "dohc could not remove access"
        : change.defaults
          ? "dohc could not save access for workspace members"
          : `dohc could not save access for ${change.person}`,
    message: readError(namingCollectionMove(cause, dataset.name)).words ?? UNKNOWN_ERROR_WORDS,
    cause,
    identity: changeIdentity(dataset.datasetId),
    retry: () => {
      void run().catch((error: unknown) => reportClosed(report, run, change, dataset, error));
    },
  });
}
export function CollectionPermissionsDialog(props: Props) {
  // New rules remount the form below while the dialog stays open, so whether
  // it is open, and the failure it shows in place, live here.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const [failure, setFailure] = useState<Failure | null>(null);
  return (
    <Permissions
      key={`${props.workspaceId}:${props.dataset.datasetId}:${props.dataset.revisionSha256}`}
      {...props}
      open={open}
      failure={failure}
      onFailure={setFailure}
    />
  );
}
function Permissions({
  workspaceId,
  datasetPath,
  dataset,
  onClose,
  onError,
  onSettled,
  open,
  failure,
  onFailure,
}: Props & {
  open: { readonly current: boolean };
  failure: Failure | null;
  onFailure(failure: Failure | null): void;
}) {
  const [page, setPage] = useState<DatasetPermissionsPage | null>(null);
  const [place, setPlace] = useState<DatasetPlace | null>(null);
  const [boundApps, setBoundApps] = useState<DatasetBoundApp[]>([]);
  const [boundAppsIncomplete, setBoundAppsIncomplete] = useState(false);
  const [recipients, setRecipients] = useState<RelayShareGrantedRow[]>([]);
  const [grantId, setGrantId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [rules, setRules] = useState<Rules | null>(null);
  const [saved, setSaved] = useState<Levels | null>(null);
  const [levels, setLevels] = useState<Levels | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const report = useContext(ShellErrorReporter);
  const alive = useRef(true),
    request = useRef(0),
    locked = useRef(false);
  const target: Target = { workspaceId, datasetPath, expectedDatasetId: dataset.datasetId };
  const actions = dataset.operations.filter((operation) => operation.access !== "owner");
  async function load(after?: string) {
    if (!alive.current || locked.current) return;
    const token = ++request.current;
    setBusy(true);
    try {
      const [permissions, shares] = await Promise.all([
        bridge().dataset({
          ...target,
          action: "permissions",
          ...(after ? { after } : {}),
          limit: 50,
        }),
        bridge().listRelayShares(),
      ]);
      if (!alive.current || token !== request.current) return;
      if (permissions.kind !== "permissions") throw Error("dohc could not read Collection access.");
      setPage({ permissions: permissions.permissions, nextCursor: permissions.nextCursor });
      setPlace(permissions.place ?? null);
      if (!after) {
        setRules(permissions.rules ?? null);
        setSaved(levelsOf(permissions));
        setLevels(levelsOf(permissions));
        setStale(
          !!permissions.defaults &&
            permissions.defaults.revisionSha256 !== permissions.rules?.revisionSha256,
        );
        setBoundApps(permissions.boundApps ?? []);
        setBoundAppsIncomplete(Boolean(permissions.boundAppsIncomplete));
      }
      setRecipients(
        shares.granted.filter(
          (row) =>
            row.workspaceId === workspaceId && row.revokedAtMs === null && row.recipientUserId,
        ),
      );
    } catch (cause) {
      if (alive.current && token === request.current)
        onError("dohc could not load Collection access.", cause, () => {
          void load(after);
        });
    } finally {
      if (alive.current && token === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      request.current++;
    };
  }, []);
  async function change(principalKey?: string, defaults?: Levels) {
    if (!alive.current || locked.current) return;
    const recipient = recipients.find((row) => row.grantId === grantId);
    const asked: Change = principalKey
      ? { principalKey }
      : defaults && rules
        ? {
            defaults: {
              ...defaults,
              revision: rules.revision,
              revisionSha256: rules.revisionSha256,
            },
          }
        : {
            grantId,
            person: recipient?.recipientEmail ?? recipient?.recipientUserId ?? grantId,
            operationIds: selected,
          };
    const run = () => changeAccess(target, dataset, asked);
    locked.current = true;
    const token = ++request.current;
    setBusy(true);
    onFailure(null);
    try {
      await run();
      onSettled?.(changeIdentity(dataset.datasetId));
      if (!alive.current || token !== request.current) return;
      if (!defaults) {
        setGrantId("");
        setSelected([]);
      }
      locked.current = false;
      await load();
    } catch (cause) {
      // While the dialog is open, it says in place why its own save or removal failed.
      if (open.current)
        onFailure({
          ...(principalKey ? { principalKey } : {}),
          ...(defaults ? { defaults: true as const } : {}),
          words: withErrorWords(
            principalKey ? "dohc could not remove access." : "dohc could not save access.",
            cause,
          ),
        });
      else if (report) reportClosed(report, run, asked, dataset, cause);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Overlay onClose={busy ? undefined : onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-access-title"
        className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-140 max-w-[90vw] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5"
      >
        <h2 id="collection-access-title" className="m-0 text-base font-semibold text-ink">
          Collection access
        </h2>
        <p className="m-0 text-[13px] text-muted">
          Choose who can use this Collection and which actions they can run.
        </p>
        {place?.kind === "server" ? (
          <p className="m-0 text-[12px] text-muted">This Collection is on {place.host}.</p>
        ) : null}
        {rules && levels ? (
          <form
            aria-labelledby="collection-defaults-title"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void change(undefined, levels);
            }}
          >
            <h3 id="collection-defaults-title" className="m-0 text-sm font-semibold text-ink">
              Workspace members
            </h3>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-[12px] text-muted">
                  <th scope="col" className="py-1 text-left font-normal">
                    Action
                  </th>
                  {LEVELS.map(([level, label]) => (
                    <th key={level} scope="col" className="w-20 py-1 text-center font-normal">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rules.actions.map((action) => {
                  const name =
                    dataset.operations.find(
                      (operation) => operation.operationId === action.operationId,
                    )?.label ?? action.name;
                  return (
                    <tr key={action.operationId} className="border-t border-line">
                      <th scope="row" className="py-1.5 text-left font-normal text-ink">
                        {name}
                      </th>
                      {LEVELS.map(([level, label], at) => {
                        const lower = LEVELS.slice(0, at).find(([below]) =>
                          levels[below].includes(action.operationId),
                        );
                        return (
                          <td key={level} className="text-center">
                            <input
                              type="checkbox"
                              aria-label={`${name} for members with ${label}`}
                              title={lower ? `Included with ${lower[1]}` : undefined}
                              disabled={busy || !!lower || (!action.readOnly && level !== "edit")}
                              className="disabled:opacity-40"
                              checked={!!lower || levels[level].includes(action.operationId)}
                              onChange={(event) =>
                                setLevels({
                                  ...levels,
                                  [level]: event.target.checked
                                    ? [...levels[level], action.operationId].sort()
                                    : levels[level].filter((id) => id !== action.operationId),
                                })
                              }
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="m-0 text-[12px] text-muted">
              Members get these by their folder access. View and Comment get only reads.
              {stale ? " These were chosen under earlier rules. Save to keep them." : null}
            </p>
            <div>
              <p
                role="status"
                aria-live="polite"
                className="m-0 mb-2 text-[12px] text-danger empty:mb-0"
              >
                {failure?.defaults ? failure.words : null}
              </p>
              <PrimaryButton
                type="submit"
                disabled={!stale && JSON.stringify(levels) === JSON.stringify(saved)}
                aria-disabled={busy || undefined}
                className="aria-disabled:cursor-wait aria-disabled:opacity-50"
              >
                Save for members
              </PrimaryButton>
            </div>
          </form>
        ) : null}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void change();
          }}
        >
          <label className="text-[12px] text-muted">
            Person
            <select
              aria-label="Collection access person"
              value={grantId}
              disabled={busy}
              onChange={(event) => setGrantId(event.target.value)}
              className={`${inputClass} mt-1`}
            >
              <option value="">Choose a workspace recipient</option>
              {recipients.map((row) => (
                <option key={row.grantId} value={row.grantId}>
                  {row.recipientEmail ?? row.recipientUserId} · {row.grantId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          {!recipients.length && !busy ? (
            <p className="m-0 text-[12px] text-muted">
              Share a workspace file or folder with a person first. They must accept the invitation.
            </p>
          ) : null}
          <fieldset disabled={busy} className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-[12px] text-muted">Allowed actions</legend>
            {actions.map((operation) => (
              <label
                key={operation.operationId}
                className="flex items-center gap-2 text-[13px] text-ink"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(operation.operationId)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, operation.operationId]
                        : previous.filter((id) => id !== operation.operationId),
                    )
                  }
                />
                {operation.label}
                <span className="text-[12px] text-muted">
                  {operation.readOnly ? "Read" : "Change records"}
                </span>
              </label>
            ))}
            {!actions.length ? (
              <p className="m-0 text-[12px] text-muted">
                This Collection has no shareable actions. Add one in the Collection source.
              </p>
            ) : null}
          </fieldset>
          <p className="m-0 text-[12px] text-muted">
            Saving replaces this person's allowed actions for this Collection. Source permissions
            remain separate.
          </p>
          {/* aria-disabled, not disabled, while busy, so the pressed button keeps focus and can retry. */}
          <div>
            <p
              role="status"
              aria-live="polite"
              className="m-0 mb-2 text-[12px] text-danger empty:mb-0"
            >
              {failure && !failure.principalKey && !failure.defaults ? failure.words : null}
            </p>
            <PrimaryButton
              type="submit"
              disabled={!grantId || !selected.length}
              aria-disabled={busy || undefined}
              className="aria-disabled:cursor-wait aria-disabled:opacity-50"
            >
              Save access
            </PrimaryButton>
          </div>
        </form>
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold text-ink">People and apps with access</h3>
          {boundAppsIncomplete ? (
            <p className="m-0 text-[12px] text-muted">
              Some connected apps could not be checked right now.
            </p>
          ) : null}
          {!page ? (
            busy ? (
              <SkeletonRows rows={2} label="Loading access…" />
            ) : (
              <p className="m-0 text-[12px] text-muted">Refresh to see who has access.</p>
            )
          ) : !page.permissions.length ? (
            <p className="m-0 text-[12px] text-muted">Only you have access.</p>
          ) : (
            page.permissions.map((permission) => {
              const app =
                permission.kind === "app"
                  ? boundApps.find((entry) => entry.publicationId === permission.principal)
                  : undefined;
              const label = app
                ? boundAppStatusLabel(app.status)
                : permission.current
                  ? ""
                  : "Rules changed";
              const statusText = label ? ` · ${label}` : "";
              return (
                <div
                  key={`${permission.kind}:${permission.principal}`}
                  className="border-b border-line py-2"
                >
                  {permission.kind === "data" ? (
                    <p
                      role="status"
                      aria-live="polite"
                      className="m-0 mb-1 text-[12px] text-danger empty:mb-0"
                    >
                      {failure?.principalKey === permission.principal ? failure.words : null}
                    </p>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 text-[12px] text-ink">
                      <span>
                        {permission.kind === "app"
                          ? app
                            ? `App · ${BOUND_APP_SCOPE_LABEL[app.scope]}`
                            : "App"
                          : "Person"}
                        {statusText}
                      </span>
                      <div className="truncate font-mono text-muted" title={permission.principal}>
                        {app
                          ? app.alias
                            ? `${app.appRoot} (${app.alias})`
                            : app.appRoot
                          : permission.principal}
                      </div>
                      <div className="text-muted">
                        {permission.metadata.operationIds.length} allowed{" "}
                        {permission.metadata.operationIds.length === 1 ? "action" : "actions"}
                      </div>
                      {app?.reasons?.length ? (
                        <ul className="m-0 mt-1 list-disc pl-4 text-[11px] text-muted">
                          {app.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    {permission.kind === "data" ? (
                      <SecondaryButton
                        aria-disabled={busy || undefined}
                        className="aria-disabled:cursor-wait aria-disabled:opacity-50"
                        onClick={() => {
                          if (!busy) void change(permission.principal);
                        }}
                      >
                        Remove access
                      </SecondaryButton>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
          <div className="flex gap-2">
            <SecondaryButton disabled={busy} onClick={() => void load()}>
              Refresh
            </SecondaryButton>
            {page?.nextCursor ? (
              <SecondaryButton disabled={busy} onClick={() => void load(page.nextCursor!)}>
                Next
              </SecondaryButton>
            ) : null}
          </div>
        </div>
        <div className="flex justify-end">
          <SecondaryButton disabled={busy} onClick={onClose}>
            Close
          </SecondaryButton>
        </div>
      </section>
    </Overlay>
  );
}

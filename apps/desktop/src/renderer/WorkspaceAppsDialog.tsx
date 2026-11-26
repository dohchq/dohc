import { useEffect, useId, useRef, useState } from "react";
import { AppWindow, X } from "lucide-react";
import type {
  MemberAppInspectResult,
  WorkspaceAppRow,
} from "@dohc/workspace-contracts/member-apps";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import {
  DangerButton,
  EmptyState,
  FieldError,
  IconButton,
  Pill,
  PrimaryButton,
  RetryRow,
  SecondaryButton,
} from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

type Review = { row: WorkspaceAppRow; app: MemberAppInspectResult };

/** Apps members open in this workspace: official apps first, then apps members shared. */
export function WorkspaceAppsDialog(props: {
  workspaceId: string;
  canCopy: boolean;
  onClose(): void;
  reportError(fallback: string, error: unknown, retry?: () => void): void;
}) {
  const { workspaceId } = props;
  const api = useRef(bridge()).current;
  const session = useWorkspaceSession();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [withdrawing, setWithdrawing] = useState<WorkspaceAppRow | null>(null);
  const [copyName, setCopyName] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const titleId = useId(),
    errorId = useId(),
    copyId = useId();
  const listed = useWorkspaceQuery(session, {
    key: JSON.stringify([workspaceId, reload]),
    load: async (signal) => {
      const apps: WorkspaceAppRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.memberAppsList({ workspaceId, ...(cursor ? { cursor } : {}) });
        signal.throwIfAborted();
        apps.push(...page.apps);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return apps;
    },
  });

  const { error: loadError, retry } = listed;
  useEffect(() => {
    if (loadError) props.reportError("dohc could not load workspace apps.", loadError, retry);
  }, [loadError]);

  const run = async (key: string, fallback: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(ipcErrorMessage(cause, fallback));
      props.reportError(fallback, cause, () => void run(key, fallback, work));
    } finally {
      setBusy(null);
    }
  };
  const open = (url: string) =>
    void api
      .openExternalUrl({ url })
      .catch((cause: unknown) =>
        props.reportError("dohc could not open your browser.", cause, () => open(url)),
      );

  return (
    <Overlay
      onClose={busy ? undefined : props.onClose}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": titleId,
        "data-testid": "workspace-apps",
      }}
    >
      <div className="dohc-elevated flex max-h-[85vh] w-140 max-w-[90vw] flex-col gap-4 rounded-xl border border-line bg-panel p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="m-0 truncate text-base font-semibold text-ink">
            {review ? `Review ${review.app.name}` : "Workspace apps"}
          </h2>
          <IconButton
            aria-label="Close"
            title="Close"
            disabled={busy !== null}
            onClick={props.onClose}
          >
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        {review ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto text-[13px] text-ink">
            <p className="m-0 text-muted">
              Shared by {review.app.authorName ?? "a member"}. It can do only what both you and its
              author can do. You allow it in your browser.
            </p>
            {review.app.collections.map((collection) => (
              <section key={collection.name} className="flex flex-col gap-1">
                <h3 className="m-0 text-[13px] font-semibold">
                  {collection.name}{" "}
                  <span className="font-normal text-muted">({collection.access})</span>
                </h3>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {collection.operations.map((operation) => (
                    <li key={operation.name} className="flex items-center gap-2">
                      {operation.name}
                      {operation.readOnly ? null : <Pill tone="warning">Changes data</Pill>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {review.app.collections.length === 0 ? (
              <p className="m-0 text-muted">It uses no Collections.</p>
            ) : null}
            <section className="flex flex-col gap-1">
              <h3 className="m-0 text-[13px] font-semibold">Source files</h3>
              <ul
                data-testid="workspace-app-source"
                className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-[12px] text-muted"
              >
                {review.app.source.map((file) => (
                  <li key={file.path} className="truncate">
                    {file.path}
                  </li>
                ))}
              </ul>
            </section>
            {props.canCopy ? (
              <div className="flex items-end gap-2">
                <label htmlFor={copyId} className="flex flex-1 flex-col gap-1 text-muted">
                  Copy to your Personal apps as
                  <input
                    id={copyId}
                    data-testid="workspace-app-copy-name"
                    className="rounded-md border border-line bg-bg px-2 py-1 text-ink"
                    value={copyName}
                    onChange={(event) => setCopyName(event.target.value)}
                  />
                </label>
                <SecondaryButton
                  disabled={busy !== null || !copyName.trim()}
                  onClick={() =>
                    void run("copy", "dohc could not copy this app.", async () => {
                      const result = await api.memberAppFork({
                        workspaceId,
                        publicationId: review.row.publicationId,
                        personalApp: copyName.trim(),
                      });
                      setCopied(result.personalApp);
                    })
                  }
                >
                  {busy === "copy" ? "Copying…" : "Copy"}
                </SecondaryButton>
              </div>
            ) : null}
            {copied ? (
              <p role="status" className="m-0 text-success">
                Copied to {copied} in your Personal apps.
              </p>
            ) : null}
          </div>
        ) : listed.error && !listed.value ? (
          <RetryRow testId="workspace-apps-retry" onRetry={listed.retry} />
        ) : !listed.value ? (
          <SkeletonRows rows={2} label="Loading workspace apps…" />
        ) : listed.value.length ? (
          <ul className="m-0 flex min-h-0 list-none flex-col overflow-y-auto p-0">
            {listed.value.map((row) => (
              <li
                key={row.publicationId}
                data-testid="workspace-app-row"
                className="flex items-center gap-2 py-1.5"
              >
                <AppWindow size={14} aria-hidden className="shrink-0 text-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-ink">{row.name}</span>
                  <span className="truncate text-[12px] text-muted">
                    {row.kind === "workspace"
                      ? "Official app"
                      : `Shared by ${row.authorName ?? "a member"}`}
                  </span>
                </span>
                {row.consent === "changed" ? <Pill tone="warning">Changed</Pill> : null}
                {row.canWithdraw ? (
                  <SecondaryButton
                    size="compact"
                    disabled={busy !== null}
                    onClick={() => setWithdrawing(row)}
                  >
                    Withdraw
                  </SecondaryButton>
                ) : null}
                {row.kind === "member" ? (
                  <SecondaryButton
                    size="compact"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(row.publicationId, `dohc could not load ${row.name}.`, async () => {
                        const app = await api.memberAppInspect({
                          workspaceId,
                          publicationId: row.publicationId,
                        });
                        setCopyName(`${row.name}-copy`);
                        setCopied(null);
                        setReview({ row, app });
                      })
                    }
                  >
                    {busy === row.publicationId ? "Loading…" : "Review"}
                  </SecondaryButton>
                ) : row.url ? (
                  <PrimaryButton size="compact" onClick={() => open(row.url!)}>
                    Open in browser
                  </PrimaryButton>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={AppWindow} title="No apps are shared in this workspace yet." />
        )}
        {withdrawing ? (
          <div
            role="alertdialog"
            aria-label={`Withdraw ${withdrawing.name}`}
            className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3 text-[13px] text-ink"
          >
            <p className="m-0">
              Withdraw {withdrawing.name}? Members can no longer open it. Only its author can share
              it again.
            </p>
            <div className="flex justify-end gap-2">
              <SecondaryButton disabled={busy !== null} onClick={() => setWithdrawing(null)}>
                Cancel
              </SecondaryButton>
              <DangerButton
                disabled={busy !== null}
                onClick={() =>
                  void run("withdraw", `dohc could not withdraw ${withdrawing.name}.`, async () => {
                    await api.memberAppWithdraw({
                      workspaceId,
                      publicationId: withdrawing.publicationId,
                    });
                    setWithdrawing(null);
                    setReload((value) => value + 1);
                  })
                }
              >
                {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </DangerButton>
            </div>
          </div>
        ) : null}
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        {review ? (
          <div className="flex justify-end gap-2">
            <SecondaryButton disabled={busy !== null} onClick={() => setReview(null)}>
              Back
            </SecondaryButton>
            <PrimaryButton
              disabled={!review.row.url}
              title={review.row.url ? undefined : "Your server has no web viewer for apps."}
              onClick={() => review.row.url && open(review.row.url)}
            >
              Continue in browser
            </PrimaryButton>
          </div>
        ) : null}
      </div>
    </Overlay>
  );
}

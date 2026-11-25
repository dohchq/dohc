import { useEffect, useId, useRef, useState } from "react";
import { AppWindow, FolderOpen, X } from "lucide-react";
import type { OwnerAppPublicationResult } from "../ipc/ownerAppPublicationContract";
import { AppAccessSummary } from "./AppPermissionsCard";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import { openLocalApp } from "./OwnerAppPublication";
import { CopyButton } from "./ui/CopyButton";
import {
  EmptyState,
  FieldError,
  IconButton,
  PrimaryButton,
  RetryRow,
  SecondaryButton,
} from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";

type Prepared = Extract<OwnerAppPublicationResult, { kind: "prepared" }>;
type Row = {
  appRoot: string;
  approved: { publicationId: string; authorityRevision: number } | null;
};

/** A joined workspace member's own apps: they stay on this computer and run with the member's access. */
export function PersonalAppsDialog(props: {
  workspaceId: string;
  onClose(): void;
  reportError(fallback: string, error: unknown, retry?: () => void): void;
}) {
  const { workspaceId } = props;
  const api = useRef(bridge()).current;
  const [folder, setFolder] = useState<{ path: string; rows: Row[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Prepared | null>(null);
  const reviewing = useRef<Prepared | null>(null);
  const alive = useRef(true);
  const titleId = useId(),
    errorId = useId();
  reviewing.current = review;

  const cancel = (prepared: Prepared | null) => {
    if (prepared)
      void api
        .publishOwnerApp({ action: "cancel", workspaceId, approvalId: prepared.approvalId })
        .catch(() => undefined);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancel(reviewing.current);
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoadFailed(false);
    void (async () => {
      const listed = await api.publishOwnerApp({ action: "personalFolder", workspaceId });
      if (listed.kind !== "personalFolder") throw new Error("dohc could not read the folder.");
      const rows = await Promise.all(
        listed.apps.map(async ({ appRoot }) => {
          const local = await api.publishOwnerApp({ action: "listLocal", workspaceId, appRoot });
          const active =
            local.kind === "localListed" ? local.publications.find((row) => row.active) : undefined;
          return { appRoot, approved: active ?? null };
        }),
      );
      if (current) setFolder({ path: listed.path, rows });
    })().catch((cause: unknown) => {
      if (!current) return;
      setLoadFailed(true);
      props.reportError("dohc could not read your Personal apps.", cause, () =>
        setReload((value) => value + 1),
      );
    });
    return () => {
      current = false;
    };
  }, [api, workspaceId, reload]);

  const run = async (key: string, fallback: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (cause) {
      if (alive.current) setError(ipcErrorMessage(cause, fallback));
      else props.reportError(fallback, cause);
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const changed = () => setReload((value) => value + 1);
  const close = () => {
    cancel(review);
    setReview(null);
    props.onClose();
  };

  return (
    <Overlay
      onClose={busy === "approve" ? undefined : close}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": titleId,
        "data-testid": "personal-apps",
      }}
    >
      <div className="dohc-elevated flex w-130 max-w-[90vw] flex-col gap-4 rounded-xl border border-line bg-panel p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="m-0 truncate text-base font-semibold text-ink">
            {review ? `Approve ${review.appRoot}` : "Personal apps"}
          </h2>
          <IconButton
            aria-label="Close"
            title="Close"
            disabled={busy === "approve"}
            onClick={close}
          >
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        {review ? (
          <AppAccessSummary
            capabilities={review.capabilities}
            approved={null}
            failed={false}
            onRetry={() => undefined}
          />
        ) : (
          <>
            <div className="flex items-center gap-1 rounded-lg bg-bg py-1 pr-1 pl-3">
              <span
                data-testid="personal-apps-path"
                title={folder?.path}
                className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted"
              >
                {folder?.path ?? "…"}
              </span>
              <CopyButton iconOnly label="Copy path" getText={() => folder?.path ?? null} />
              <IconButton
                aria-label="Open folder"
                title="Open folder"
                disabled={busy === "folder"}
                onClick={() =>
                  void run("folder", "dohc could not open your Personal app folder.", async () => {
                    await api.publishOwnerApp({
                      action: "personalFolder",
                      workspaceId,
                      open: true,
                    });
                  })
                }
              >
                <FolderOpen size={14} aria-hidden />
              </IconButton>
            </div>
            {loadFailed ? (
              <RetryRow testId="personal-apps-retry" onRetry={changed} />
            ) : !folder ? (
              <SkeletonRows rows={2} label="Loading your Personal apps…" />
            ) : folder.rows.length ? (
              <ul className="m-0 flex list-none flex-col p-0">
                {folder.rows.map((row) => (
                  <li key={row.appRoot} className="flex items-center gap-2 py-1.5">
                    <AppWindow size={14} aria-hidden className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                      {row.appRoot}
                    </span>
                    {row.approved ? (
                      <>
                        <SecondaryButton
                          size="compact"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              row.appRoot,
                              `dohc could not remove ${row.appRoot}'s approval.`,
                              async () => {
                                await api.publishOwnerApp({
                                  action: "withdraw",
                                  workspaceId,
                                  publicationId: row.approved!.publicationId,
                                  expectedAuthorityRevision: row.approved!.authorityRevision,
                                });
                                changed();
                              },
                            )
                          }
                        >
                          Remove approval
                        </SecondaryButton>
                        <PrimaryButton
                          size="compact"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              row.appRoot,
                              `dohc could not open ${row.appRoot}.`,
                              async () => {
                                await openLocalApp(
                                  api,
                                  workspaceId,
                                  row.approved!.publicationId,
                                  () => alive.current,
                                );
                              },
                            )
                          }
                        >
                          Open
                        </PrimaryButton>
                      </>
                    ) : (
                      <SecondaryButton
                        size="compact"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            row.appRoot,
                            `dohc could not prepare ${row.appRoot}.`,
                            async () => {
                              const prepared = await api.publishOwnerApp({
                                action: "prepareLocal",
                                workspaceId,
                                appRoot: row.appRoot,
                              });
                              if (prepared.kind !== "prepared")
                                throw new Error("dohc could not read what this app can reach.");
                              if (alive.current) setReview(prepared);
                              else cancel(prepared);
                            },
                          )
                        }
                      >
                        {busy === row.appRoot ? "Preparing…" : "Review"}
                      </SecondaryButton>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={AppWindow} title="Add a folder here for each app you build." />
            )}
          </>
        )}
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        {review ? (
          <div className="flex justify-end gap-2">
            <SecondaryButton
              disabled={busy === "approve"}
              onClick={() => {
                cancel(review);
                setReview(null);
                setError(null);
              }}
            >
              Cancel
            </SecondaryButton>
            <PrimaryButton
              disabled={busy === "approve"}
              onClick={() =>
                void run("approve", `dohc could not approve ${review.appRoot}.`, async () => {
                  await api.publishOwnerApp({
                    action: "approve",
                    workspaceId,
                    approvalId: review.approvalId,
                    candidateDigest: review.candidateDigest,
                  });
                  setReview(null);
                  changed();
                })
              }
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </PrimaryButton>
          </div>
        ) : null}
      </div>
    </Overlay>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { AppWindow, FileCode, FileX, Undo2, X } from "lucide-react";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import {
  MEMBER_APP_SOURCE_MAX_BYTES,
  type MemberAppInspectResult,
  type WorkspaceAppRow,
} from "@dohc/workspace-contracts/member-apps";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import {
  EmptyState,
  FieldError,
  IconButton,
  Pill,
  PrimaryButton,
  RetryRow,
  SecondaryButton,
  SectionLabel,
} from "./ui/controls";
import { CopyButton } from "./ui/CopyButton";
import { PathLine } from "./ui/PathLine";
import { SkeletonRows } from "./ui/SkeletonRows";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

type Review = { row: WorkspaceAppRow; app: MemberAppInspectResult };
type Failure = { at: string; message: string };

const FIELD =
  "w-full rounded-md border bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle";

export function freeAppFolder(name: string, taken: (path: string) => boolean): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";
  for (let n = 1; ; n += 1) {
    const folder = `apps/${n === 1 ? slug : `${slug}-${n}`}`;
    if (!taken(folder)) return folder;
  }
}

function folderProblem(folder: string, taken: (path: string) => boolean): string | null {
  if (!folder) return "Enter a folder for the app.";
  if (!isShareablePath(folder)) return `dohc can't put an app in ${folder}. Choose another folder.`;
  if (taken(folder)) return `The workspace already has ${folder}. Choose another folder.`;
  return null;
}

/** Apps members open in this workspace: official apps first, then apps members shared. */
export function WorkspaceAppsDialog(props: {
  workspaceId: string;
  canCopy: boolean;
  canPromote: boolean;
  pathTaken(path: string): boolean;
  onPromoted(folder: string): void;
  onClose(): void;
  reportError(fallback: string, error: unknown, retry?: () => void): void;
}) {
  const { workspaceId } = props;
  const api = useRef(bridge()).current;
  const session = useWorkspaceSession();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [withdrawing, setWithdrawing] = useState<WorkspaceAppRow | null>(null);
  const [copyName, setCopyName] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [folderChecked, setFolderChecked] = useState(false);
  const alive = useRef(true);
  const titleId = useId(),
    errorId = useId(),
    copyId = useId(),
    folderId = useId(),
    formId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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

  const run = async (at: string, fallback: string, work: () => Promise<unknown>) => {
    setBusy(at);
    setFailure(null);
    try {
      await work();
    } catch (cause) {
      if (alive.current) setFailure({ at, message: ipcErrorMessage(cause, fallback) });
      else props.reportError(fallback, cause, () => void run(at, fallback, work));
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const failed = (at: string) =>
    failure?.at === at ? (
      <FieldError id={errorId} testId="workspace-apps-error">
        {failure.message}
      </FieldError>
    ) : null;
  const open = (url: string) =>
    void api
      .openExternalUrl({ url })
      .catch((cause: unknown) =>
        props.reportError("dohc could not open your browser.", cause, () => open(url)),
      );
  const startReview = (row: WorkspaceAppRow) =>
    void run(row.publicationId, `dohc could not load ${row.name}.`, async () => {
      const app = await api.memberAppInspect({ workspaceId, publicationId: row.publicationId });
      setCopyName(`${row.name}-copy`);
      setCopied(null);
      setFolder(freeAppFolder(row.name, props.pathTaken));
      setFolderChecked(false);
      setReview({ row, app });
    });
  const target = folder.trim().replace(/\/+$/, "");
  const problem = folderChecked ? folderProblem(target, props.pathTaken) : null;
  const promote = () => {
    setFolderChecked(true);
    if (!review || folderProblem(target, props.pathTaken)) return;
    void run("promote", `dohc could not promote ${review.app.name}.`, async () => {
      const result = await api.memberAppPromote({
        workspaceId,
        publicationId: review.row.publicationId,
        folder: target,
      });
      props.onPromoted(result.folder);
    });
  };
  const official = listed.value?.filter((row) => row.kind === "workspace") ?? [];
  const shared = listed.value?.filter((row) => row.kind === "member") ?? [];

  const row = (app: WorkspaceAppRow) => (
    <li
      key={app.publicationId}
      data-testid="workspace-app-row"
      className="flex flex-col gap-1 py-1.5"
    >
      <span className="flex items-center gap-2">
        <AppWindow size={14} aria-hidden className="shrink-0 text-muted" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] text-ink">{app.name}</span>
          {app.kind === "member" ? (
            <span className="truncate text-[12px] text-muted">
              Shared by {app.authorName ?? "a member"}
            </span>
          ) : null}
        </span>
        {app.consent === "changed" ? <Pill tone="warning">Changed</Pill> : null}
        {app.canWithdraw ? (
          <SecondaryButton
            size="compact"
            disabled={busy !== null}
            onClick={() => {
              setFailure(null);
              setWithdrawing(app);
            }}
          >
            Withdraw
          </SecondaryButton>
        ) : null}
        {app.kind === "member" ? (
          <SecondaryButton size="compact" disabled={busy !== null} onClick={() => startReview(app)}>
            {busy === app.publicationId ? "Loading…" : "Review"}
          </SecondaryButton>
        ) : app.url ? (
          <PrimaryButton size="compact" onClick={() => open(app.url!)}>
            Open in browser
          </PrimaryButton>
        ) : null}
      </span>
      {failed(app.publicationId)}
    </li>
  );
  const section = (label: string, apps: WorkspaceAppRow[]) =>
    apps.length ? (
      <section aria-label={label} className="flex flex-col">
        <SectionLabel as="h3" className="m-0">
          {label}
        </SectionLabel>
        <ul className="m-0 flex list-none flex-col p-0">{apps.map(row)}</ul>
      </section>
    ) : null;

  return (
    <>
      <Overlay
        onClose={busy ? undefined : props.onClose}
        panelProps={{
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": titleId,
          "data-testid": "workspace-apps",
        }}
      >
        <div
          className={`dohc-elevated flex max-h-[85vh] max-w-[90vw] flex-col gap-4 rounded-xl border border-line bg-panel p-5 ${review ? "w-200" : "w-140"}`}
        >
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
            <form
              id={formId}
              noValidate
              className="flex min-h-0 flex-col gap-4 overflow-y-auto text-[13px] text-ink"
              onSubmit={(event) => {
                event.preventDefault();
                if (props.canPromote) promote();
              }}
            >
              <p className="m-0 text-muted">
                Shared by {review.app.authorName ?? "a member"}. It can do only what both you and
                its author can do. You allow it in your browser.
              </p>
              <section className="flex flex-col gap-1.5">
                <SectionLabel as="h3" className="m-0">
                  Collections
                </SectionLabel>
                {review.app.collections.length === 0 ? (
                  <p className="m-0 text-muted">It uses no Collections.</p>
                ) : (
                  review.app.collections.map((collection) => (
                    <div key={collection.name} className="flex flex-col gap-0.5">
                      <span className="font-medium">
                        {collection.name}{" "}
                        <span className="font-normal text-muted">({collection.access})</span>
                      </span>
                      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-muted">
                        {collection.operations.map((operation) => (
                          <li key={operation.name} className="flex items-center gap-2">
                            {operation.name}
                            {operation.readOnly ? null : <Pill tone="warning">Changes data</Pill>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </section>
              <SourceBrowser
                workspaceId={workspaceId}
                publicationId={review.row.publicationId}
                files={review.app.source}
              />
              {props.canCopy ? (
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-end gap-2">
                    <label htmlFor={copyId} className="flex flex-1 flex-col gap-1 text-muted">
                      Copy to your Personal apps as
                      <input
                        id={copyId}
                        data-testid="workspace-app-copy-name"
                        className={`${FIELD} border-line focus:border-ink`}
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
                  {failed("copy")}
                  {copied ? (
                    <p role="status" className="m-0 text-success">
                      Copied to {copied} in your Personal apps.
                    </p>
                  ) : null}
                </section>
              ) : null}
              {props.canPromote ? (
                <section className="flex flex-col gap-1.5" aria-labelledby={`${folderId}-title`}>
                  <SectionLabel as="h3" id={`${folderId}-title`} className="m-0">
                    Promote to official app
                  </SectionLabel>
                  <p className="m-0 text-muted">
                    dohc copies its files into this workspace. Members can open it once you review
                    and publish it.
                  </p>
                  <label htmlFor={folderId} className="w-fit text-[12px] text-muted">
                    Workspace folder
                  </label>
                  <input
                    id={folderId}
                    data-testid="workspace-app-promote-folder"
                    spellCheck={false}
                    readOnly={busy === "promote"}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem || failure?.at === "promote" ? errorId : undefined}
                    className={`${FIELD} font-mono ${problem ? "border-danger focus:border-danger!" : "border-line focus:border-ink"}`}
                    value={folder}
                    onChange={(event) => {
                      setFolder(event.target.value);
                      setFolderChecked(false);
                      if (failure?.at === "promote") setFailure(null);
                    }}
                    onBlur={() => setFolderChecked(true)}
                  />
                  {problem ? (
                    <FieldError id={errorId} testId="workspace-app-promote-problem">
                      {problem}
                    </FieldError>
                  ) : (
                    failed("promote")
                  )}
                </section>
              ) : null}
            </form>
          ) : listed.error && !listed.value ? (
            <RetryRow testId="workspace-apps-retry" onRetry={listed.retry}>
              {ipcErrorMessage(listed.error, "dohc could not load workspace apps.")}
            </RetryRow>
          ) : !listed.value ? (
            <SkeletonRows rows={2} label="Loading workspace apps…" />
          ) : listed.value.length ? (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              {section("Official apps", official)}
              {section("Shared by members", shared)}
            </div>
          ) : (
            <EmptyState icon={AppWindow} title="No apps are shared in this workspace yet." />
          )}
          {review ? (
            <div className="flex justify-end gap-2">
              <SecondaryButton
                disabled={busy !== null}
                onClick={() => {
                  setFailure(null);
                  setReview(null);
                }}
              >
                Back
              </SecondaryButton>
              <ContinueButton
                primary={!props.canPromote}
                url={review.row.url}
                onOpen={(url) => open(url)}
              />
              {props.canPromote ? (
                <PrimaryButton
                  type="submit"
                  form={formId}
                  data-testid="workspace-app-promote"
                  disabled={busy !== null}
                >
                  {busy === "promote" ? "Promoting…" : "Promote app"}
                </PrimaryButton>
              ) : null}
            </div>
          ) : null}
        </div>
      </Overlay>
      {withdrawing ? (
        <ConfirmDialog
          intent="danger"
          icon={Undo2}
          testId="workspace-app-withdraw-confirm"
          cancelTestId="workspace-app-withdraw-cancel"
          confirmTestId="workspace-app-withdraw-action"
          title={`Withdraw ${withdrawing.name}?`}
          confirmLabel={busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
          confirmDisabled={busy !== null}
          details={failed("withdraw")}
          onCancel={() => {
            if (busy) return;
            setFailure(null);
            setWithdrawing(null);
          }}
          onConfirm={() =>
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
          <p>Members can no longer open it. Only its author can share it again.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function ContinueButton(props: {
  primary: boolean;
  url: string | null;
  onOpen(url: string): void;
}) {
  const Button = props.primary ? PrimaryButton : SecondaryButton;
  return (
    <Button
      disabled={!props.url}
      title={props.url ? undefined : "Your server has no web viewer for apps."}
      onClick={() => props.url && props.onOpen(props.url)}
    >
      Continue in browser
    </Button>
  );
}

function SourceBrowser(props: {
  workspaceId: string;
  publicationId: string;
  files: MemberAppInspectResult["source"];
}) {
  const [selected, setSelected] = useState(props.files[0]?.path ?? null);
  const top = props.files[0]?.path.split("/")[0];
  const shared =
    top && props.files.every((file) => file.path.startsWith(`${top}/`)) ? top.length + 1 : 0;
  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel as="h3" className="m-0">
        Source files
      </SectionLabel>
      <div className="flex h-80 min-h-0 overflow-hidden rounded-lg border border-line">
        <ul
          data-testid="workspace-app-source"
          aria-label="Source files"
          className="m-0 flex w-56 shrink-0 list-none flex-col overflow-y-auto border-r border-line p-1"
        >
          {props.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                aria-current={file.path === selected ? "true" : undefined}
                onClick={() => setSelected(file.path)}
                className={`dohc-focus-row flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[12px] ${file.path === selected ? "bg-selected text-ink" : "text-muted hover:bg-panel-2 hover:text-ink"}`}
              >
                <FileCode size={12} aria-hidden className="shrink-0" />
                <PathLine path={file.path.slice(shared)} className="min-w-0 flex-1" />
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <SourceView
            key={selected}
            workspaceId={props.workspaceId}
            publicationId={props.publicationId}
            path={selected}
          />
        ) : (
          <SourceEmpty title="This app has no source files." />
        )}
      </div>
    </section>
  );
}

function SourceView(props: { workspaceId: string; publicationId: string; path: string }) {
  const api = useRef(bridge()).current;
  const session = useWorkspaceSession();
  const source = useWorkspaceQuery(session, {
    key: JSON.stringify([props.workspaceId, props.publicationId, props.path]),
    load: () =>
      api.memberAppSource({
        workspaceId: props.workspaceId,
        publicationId: props.publicationId,
        path: props.path,
      }),
  });
  const file = source.value;
  const lines = file?.text?.split("\n") ?? [];
  return (
    <div data-testid="workspace-app-source-view" className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line py-1 pl-3 pr-1">
        <PathLine path={props.path} className="min-w-0 flex-1 font-mono text-[12px] text-muted" />
        <CopyButton iconOnly label="Copy file contents" getText={() => file?.text ?? null} />
      </div>
      {source.error && !file ? (
        <div className="p-2">
          <RetryRow testId="workspace-app-source-retry" onRetry={() => void source.retry()}>
            {ipcErrorMessage(source.error, `dohc could not load ${props.path}.`)}
          </RetryRow>
        </div>
      ) : !file ? (
        <SkeletonRows rows={8} label={`Loading ${props.path}…`} className="p-3" />
      ) : file.text === null ? (
        <SourceEmpty
          title={
            file.byteLength > MEMBER_APP_SOURCE_MAX_BYTES
              ? "This file is too large to show here."
              : "This file isn't text."
          }
        />
      ) : file.text === "" ? (
        <SourceEmpty title="This file is empty." />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-bg">
          <div className="flex min-w-fit font-mono text-[12px] leading-5">
            <pre
              aria-hidden
              className="sticky left-0 m-0 select-none border-r border-line bg-bg py-2 pl-3 pr-2 text-right text-subtle"
            >
              {lines.map((_, index) => index + 1).join("\n")}
            </pre>
            <pre
              data-testid="workspace-app-source-text"
              className="m-0 flex-1 py-2 pl-3 pr-4 text-ink"
            >
              {file.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceEmpty(props: { title: string }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState icon={FileX} title={props.title} />
    </div>
  );
}

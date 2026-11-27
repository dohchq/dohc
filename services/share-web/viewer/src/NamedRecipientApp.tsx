import { useCallback, useEffect, useRef, useState } from "react";
import {
  createNamedLiveBrowserTransport,
  type NamedLiveBrowserState,
  type NamedLiveSelection,
} from "@dohc/ydoc-projection/named-live-browser-transport";
import { fetchShareWeb } from "./apiVersion";
import {
  accountUser,
  namedFiles,
  namedRequest,
  ShareAccessRemovedError,
  type NamedRecipientFiles,
} from "./namedRecipient";
import {
  draftNeedsReview,
  DraftReview,
  NamedDocumentEditor,
  type NamedDocumentSession,
} from "./NamedDocumentEditor";
import { DiscardDraft } from "./DiscardDraft";
import { DohcMark, Icon, fileIcon } from "./icons";
import { NamedSignIn, signInErrorMessage } from "./NamedSignIn";
import { CollectionList, CollectionTable, type Collection } from "./NamedCollections";

type Account = { id: string; name: string };
type Selection = { session: NamedDocumentSession; path: string; objectId: string };
const NARROW_MEDIA = "(max-width: 720px), (pointer: coarse) and (max-height: 500px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_MEDIA).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_MEDIA);
    if (!query) return;
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export default function NamedRecipientApp({ grantId }: { grantId: string | null }) {
  const narrow = useNarrow();
  const [account, setAccount] = useState<Account | null>(null),
    [files, setFiles] = useState<NamedRecipientFiles | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null),
    [sessionState, setSessionState] = useState<NamedLiveBrowserState | null>(null),
    [synced, setSynced] = useState<Selection | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [collection, setCollection] = useState<Collection | null>(null);
  const tableDirty = useRef(false);
  const chosen = selection ?? collection;
  const request = useRef<AbortController | null>(null),
    transport = useRef<ReturnType<
      typeof createNamedLiveBrowserTransport<NamedLiveSelection>
    > | null>(null);
  const currentSelection = useRef<Selection | null>(null);
  const hadAccount = useRef(false);
  const filesToggleRef = useRef<HTMLButtonElement | null>(null);
  const focusFilesToggle = useRef(false);
  const receiveState = useCallback((state: NamedLiveBrowserState) => {
    setSessionState(state);
    if (state.status === "live") setSynced(currentSelection.current);
  }, []);
  const clearSelection = () => {
    transport.current?.close();
    transport.current = null;
    currentSelection.current = null;
    setSelection(null);
    setSessionState(null);
    setCollection(null);
    setFilesOpen(true);
  };
  const start = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    return controller;
  };
  const load = async (controller: AbortController) => {
    if (!grantId) throw Error("Invalid invitation");
    const user = accountUser(await namedRequest("/api/account/session", controller.signal));
    if (controller.signal.aborted || request.current !== controller) return;
    if (!user && hadAccount.current) {
      hadAccount.current = false;
      setError("Your session ended. Sign in again.");
    } else if (user) {
      hadAccount.current = true;
    }
    setAccount(user);
    setFiles(null);
    if (!user) return;
    const result = namedFiles(
      await namedRequest("/api/live/named-documents", controller.signal, { grantId }),
      user.id,
      grantId,
    );
    if (controller.signal.aborted || request.current !== controller) return;
    setFiles(result);
  };
  const refresh = () => {
    clearSelection();
    setFiles(null);
    const controller = start();
    void load(controller)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof ShareAccessRemovedError
              ? cause.message
              : "dohc could not open this invitation. Retry or sign in with the invited account.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  };
  useEffect(() => {
    refresh();
    return () => {
      request.current?.abort();
      transport.current?.close();
      transport.current = null;
      currentSelection.current = null;
    };
  }, [grantId]);
  useEffect(() => {
    if (collection) {
      document.title = `${collection.name} · dohc`;
    } else if (selection) {
      const name =
        selection.path
          .split("/")
          .at(-1)
          ?.replace(/\.(md|markdown)$/i, "") || selection.path;
      document.title = `${name} · dohc`;
    } else if (files?.subjectName) {
      document.title = `${files.subjectName} · dohc`;
    } else {
      document.title = "Shared with dohc";
    }
  }, [selection, collection, files?.subjectName]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = currentSelection.current?.session.state();
      if (
        tableDirty.current ||
        (state && (state.pendingUpdates > 0 || state.status === "quarantined"))
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const leave = (action: () => void) => {
    const state = currentSelection.current?.session.state();
    if (
      tableDirty.current ||
      (state && (state.pendingUpdates > 0 || state.status === "quarantined"))
    )
      setLeaving(() => action);
    else action();
  };
  const open = (objectId: string, path: string) => {
    if (!files || !account) return;
    leave(() => {
      transport.current ??= createNamedLiveBrowserTransport({
        publicOrigin: location.origin,
        limits: files.limits,
        fetch: fetchShareWeb,
        reopenOnLineage: true,
        recordingContext: (selection) => ({ kind: "account", accountId: selection.accountId }),
      });
      const session = transport.current.select({
        accountId: account.id,
        workspaceId: files.workspaceId,
        grantId: files.grantId,
        objectId,
      });
      const value = { session, path, objectId };
      setCollection(null);
      currentSelection.current = value;
      setSelection(value);
      setSessionState(session.state());
      if (narrow) focusFilesToggle.current = true;
      setFilesOpen(false);
      void session.reconnect();
    });
  };
  const openCollection = (value: Collection) =>
    leave(() => {
      clearSelection();
      setCollection(value);
      if (narrow) focusFilesToggle.current = true;
      setFilesOpen(false);
    });
  useEffect(() => {
    if (!focusFilesToggle.current || !narrow || !chosen || filesOpen) return;
    focusFilesToggle.current = false;
    filesToggleRef.current?.focus();
  }, [narrow, chosen, filesOpen]);
  const signIn = (credentials: { email: string; password: string }) => {
    const controller = start();
    void namedRequest("/api/account/sign-in", controller.signal, credentials)
      .then(
        () =>
          load(controller).catch((cause: unknown) => {
            if (!controller.signal.aborted)
              setError(
                cause instanceof ShareAccessRemovedError
                  ? cause.message
                  : "dohc could not open this invitation. Retry or sign in with the invited account.",
              );
          }),
        (reason: unknown) => {
          if (!controller.signal.aborted) setError(signInErrorMessage(reason));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  };
  const signOut = () =>
    leave(() => {
      clearSelection();
      const controller = start();
      void namedRequest("/api/account/sign-out", controller.signal, {})
        .then(() => {
          if (!controller.signal.aborted) {
            hadAccount.current = false;
            setAccount(null);
            setFiles(null);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("dohc could not sign you out. Retry sign-out.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    });
  return (
    <div className="viewer named-recipient">
      <header>
        <div>
          <div className="named-brand">
            <DohcMark size={18} />
            <p className="eyebrow">dohc</p>
          </div>
          <h1>{files?.subjectName ?? "Shared files"}</h1>
          {files && (
            <p>
              {files.sharerName ? `Shared by ${files.sharerName}` : "Shared with you"} · Edit access
            </p>
          )}
        </div>
        {account && (
          <div className="header-actions">
            <span>{account.name}</span>
            <button disabled={busy} className="handoff-button secondary" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </header>
      {!grantId ? (
        <main className="download-card">
          <p>This invitation is unavailable. Open the invitation the owner shared with you.</p>
        </main>
      ) : !account ? (
        <NamedSignIn title="Sign in to edit" busy={busy} error={error} onSignIn={signIn} />
      ) : (
        <main className="layout named-recipient-layout">
          <nav
            className={
              narrow && chosen && !filesOpen ? "named-file-list collapsed" : "named-file-list"
            }
            aria-label="Shared files"
          >
            {narrow && chosen ? (
              <button
                ref={filesToggleRef}
                type="button"
                className="handoff-button secondary named-files-toggle"
                aria-expanded={filesOpen}
                aria-controls="named-files-panel"
                onClick={() => setFilesOpen((open) => !open)}
              >
                <span>Files ({files?.files.length ?? 0})</span>
                <Icon name={filesOpen ? "chevron-down" : "chevron-right"} size={15} />
              </button>
            ) : (
              <p className="section-label">Files</p>
            )}
            <div id="named-files-panel" hidden={narrow && chosen !== null && !filesOpen}>
              {files?.files.map((file) => (
                <button
                  className="handoff-button secondary named-file"
                  key={file.objectId}
                  disabled={busy}
                  aria-current={selection?.objectId === file.objectId ? "page" : undefined}
                  onClick={() => open(file.objectId, file.path)}
                >
                  <Icon name={fileIcon(file.path)} size={15} />
                  <span>{file.path}</span>
                </button>
              ))}
              {files && !files.files.length && (
                <p>No Markdown files are available. Refresh after the owner adds a file.</p>
              )}
              {files && (
                <CollectionList
                  grantId={files.grantId}
                  selected={collection?.datasetId ?? null}
                  disabled={busy}
                  onOpen={openCollection}
                />
              )}
              <button
                className="handoff-button secondary named-refresh"
                disabled={busy}
                onClick={() => leave(refresh)}
              >
                Refresh files
              </button>
            </div>
            {busy && <p role="status">Opening shared files…</p>}
            {error && <p role="alert">{error}</p>}
          </nav>
          {selection ? (
            <NamedDocumentEditor
              key={selection.session.id}
              session={selection.session}
              path={selection.path}
              bodyHidden={synced !== selection}
              onState={receiveState}
            />
          ) : collection && files ? (
            <CollectionTable
              key={collection.datasetId}
              grantId={files.grantId}
              collection={collection}
              onDirty={(dirty) => {
                tableDirty.current = dirty;
              }}
            />
          ) : (
            <section className="content">
              <p>Choose a Markdown file to open it.</p>
            </section>
          )}
          {selection && sessionState && draftNeedsReview(sessionState) ? (
            <DraftReview
              session={selection.session}
              className="comments-panel named-draft-recovery"
            >
              <button
                className="handoff-button secondary"
                onClick={() => open(selection.objectId, selection.path)}
              >
                Open current file
              </button>
            </DraftReview>
          ) : null}
        </main>
      )}
      {leaving && (
        <DiscardDraft
          cancel={() => setLeaving(null)}
          confirm={() => {
            const action = leaving;
            setLeaving(null);
            action();
          }}
        />
      )}
    </div>
  );
}

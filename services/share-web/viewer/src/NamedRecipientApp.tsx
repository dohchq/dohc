import {useCallback, useEffect, useRef, useState, type FormEvent} from "react";
import {createNamedLiveBrowserTransport, type NamedLiveBrowserState, type NamedLiveSelection} from "@dohc/ydoc-projection/named-live-browser-transport";
import {accountUser, namedFiles, namedRequest, type NamedRecipientFiles} from "./namedRecipient";
import {NamedDocumentEditor, type NamedDocumentSession} from "./NamedDocumentEditor";
import {DiscardDraft} from "./DiscardDraft";

type Account = {id: string; name: string};
type Selection = {session: NamedDocumentSession; path: string; objectId: string};
export default function NamedRecipientApp({grantId}: {grantId: string | null}) {
  const [account, setAccount] = useState<Account | null>(null), [files, setFiles] = useState<NamedRecipientFiles | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null), [sessionState, setSessionState] = useState<NamedLiveBrowserState | null>(null);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const request = useRef<AbortController | null>(null), transport = useRef<ReturnType<typeof createNamedLiveBrowserTransport<NamedLiveSelection>> | null>(null);
  const currentSelection = useRef<Selection | null>(null);
  const receiveState = useCallback((state: NamedLiveBrowserState) => setSessionState(state), []);
  const clearSelection = () => {transport.current?.close(); transport.current = null; currentSelection.current = null; setSelection(null); setSessionState(null);};
  const start = () => {request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true); setError(null); return controller;};
  const load = async (controller: AbortController) => {
    if (!grantId) throw Error("Invalid invitation");
    const user = accountUser(await namedRequest("/api/account/session", controller.signal));
    if (controller.signal.aborted || request.current !== controller) return;
    setAccount(user); setFiles(null);
    if (!user) return;
    const result = namedFiles(await namedRequest("/api/live/named-documents", controller.signal, {grantId}), user.id, grantId);
    if (controller.signal.aborted || request.current !== controller) return;
    setFiles(result);
  };
  const refresh = () => {
    clearSelection(); setFiles(null); const controller = start();
    void load(controller).catch(() => {if (!controller.signal.aborted) setError("dohc could not open this invitation. Retry or sign in with the invited account.");})
      .finally(() => {if (!controller.signal.aborted) setBusy(false);});
  };
  useEffect(() => {
    refresh();
    return () => {request.current?.abort(); transport.current?.close(); transport.current = null; currentSelection.current = null;};
  }, [grantId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = currentSelection.current?.session.state();
      if (state && (state.pendingUpdates > 0 || state.status === "quarantined")) {event.preventDefault(); event.returnValue = "";}
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const leave = (action: () => void) => {
    const state = currentSelection.current?.session.state();
    if (state && (state.pendingUpdates > 0 || state.status === "quarantined")) setLeaving(() => action);
    else action();
  };
  const open = (objectId: string, path: string) => {
    if (!files || !account) return;
    leave(() => {
      transport.current ??= createNamedLiveBrowserTransport({publicOrigin: location.origin, limits: files.limits});
      const session = transport.current.select({accountId: account.id, workspaceId: files.workspaceId, grantId: files.grantId, objectId});
      const value = {session, path, objectId}; currentSelection.current = value; setSelection(value); setSessionState(session.state());
      void session.reconnect();
    });
  };
  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form), controller = start();
    const email = String(values.get("email") ?? ""), password = String(values.get("password") ?? "");
    form.reset();
    void namedRequest("/api/account/sign-in", controller.signal, {email, password}).then(
      () => load(controller).catch(() => {if (!controller.signal.aborted) setError("dohc could not open this invitation. Retry or sign in with the invited account.");}),
      () => {if (!controller.signal.aborted) setError("dohc could not sign you in. Check your email and password, then retry.");},
    )
      .finally(() => {if (!controller.signal.aborted) setBusy(false);});
  };
  const signOut = () => leave(() => {
    clearSelection(); const controller = start();
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(() => {
      if (!controller.signal.aborted) {setAccount(null); setFiles(null);}
    }).catch(() => {if (!controller.signal.aborted) setError("dohc could not sign you out. Retry sign-out.");})
      .finally(() => {if (!controller.signal.aborted) setBusy(false);});
  });
  return <div className="viewer named-recipient">
    <header><div><p className="eyebrow">dohc</p><h1>{files?.subjectName ?? "Shared files"}</h1>{files && <p>{files.sharerName ? `Shared by ${files.sharerName}` : "Shared with you"} · Edit access</p>}</div>
      {account && <div className="header-actions"><span>{account.name}</span><button disabled={busy} className="handoff-button secondary" onClick={signOut}>Sign out</button></div>}
    </header>
    {!grantId ? <main className="download-card"><p>This invitation is unavailable. Open the invitation the owner shared with you.</p></main> :
      !account ? <main className="download-card"><h2>Sign in to edit</h2><p>Use the account the owner invited.</p>
        <form className="comment-composer" onSubmit={signIn}><label>Email<input name="email" type="email" autoComplete="username" required disabled={busy}/></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={busy}/></label>
          <button className="handoff-button primary" disabled={busy}>Sign in</button></form>
        {busy && <p role="status">Checking your account…</p>}{error && <p role="alert">{error}</p>}
      </main> : <main className="layout named-recipient-layout">
        <nav className="named-file-list" aria-label="Shared Markdown files"><p className="section-label">Files</p>
          {files?.files.map(file => <button className="handoff-button secondary named-file" key={file.objectId} disabled={busy}
            aria-current={selection?.objectId === file.objectId ? "page" : undefined} onClick={() => open(file.objectId, file.path)}>{file.path}</button>)}
          {files && !files.files.length && <p>No Markdown files are available. Refresh after the owner adds a file.</p>}
          <button className="handoff-button secondary named-refresh" disabled={busy} onClick={() => leave(refresh)}>Refresh files</button>
          {busy && <p role="status">Opening shared files…</p>}{error && <p role="alert">{error}</p>}
        </nav>
        {selection ? <NamedDocumentEditor key={selection.session.doc.guid} session={selection.session} path={selection.path} onState={receiveState}/> :
          <section className="content"><p>Choose a Markdown file to open it.</p></section>}
        {selection && (sessionState?.pendingUpdates || sessionState?.status === "quarantined") ? <aside className="comments-panel named-draft-recovery" aria-label="Draft recovery">
          <h2>Review your draft</h2><p>Your unsynced changes exist only in this tab. Closing or reloading loses them.</p>
          <p>Copy the changes you want to keep from the editor. Open the current file, then paste and review them.</p>
          <button className="handoff-button secondary" onClick={() => open(selection.objectId, selection.path)}>Open current file</button>
        </aside> : null}
      </main>}
    {leaving && <DiscardDraft cancel={() => setLeaving(null)} confirm={() => {const action = leaving; setLeaving(null); action();}}/>}
  </div>;
}

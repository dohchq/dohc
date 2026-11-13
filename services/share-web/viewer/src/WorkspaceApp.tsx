import {lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent} from "react";
import type {Ended} from "./ChatChannel";
import {DohcMark, Icon, fileIcon} from "./icons";
import {MemberChats} from "./MemberChats";
import {memberSession} from "./memberWorkspace";
import {filesFromAccumulator, isMarkdown, type FileAccumulator, type SharedFile, type ViewMeta} from "./model";
import {accountUser, namedRequest} from "./namedRecipient";
import {NamedSignIn, signInErrorMessage} from "./NamedSignIn";
import {RETRY_INITIAL_MS, RETRY_MAX_MS} from "./retry";
import {
  EpochFloorChangedError, FileView, Folder, fileTitle, fileTree, loadCurrentState, loadLog, loadMeta, MAX_LOG_PAGES, Opening, StatePage,
  useNarrow, VersionMismatchError, VIEW_LOG_HOLD_MS, ViewResponseError, waitForRetry,
} from "./viewFiles";
import "./workspace.css";

// The live editor loads only once a page opens for editing.
const MemberLivePage = lazy(() => import("./MemberLivePage"));

type Account = {id: string; name: string};
type Files = {meta: ViewMeta; fileAccumulator: FileAccumulator; files: SharedFile[]; nextCursor: number; epochLogFloor: number};
type View = {status: "loading"} | {status: "ready"; files: Files} | {status: "refused" | "ended" | "load-failed" | "version-mismatch"};
type Tab = "files" | "page" | "chats";
const TABS: {id: Tab; label: string; panel: string}[] = [
  {id: "files", label: "Files", panel: "workspace-files"}, {id: "page", label: "Page", panel: "workspace-main"}, {id: "chats", label: "Chats", panel: "workspace-chats"},
];
const BADGE = {view: "View only", comment: "Can comment", edit: "Can edit"} as const;
const SESSION_ENDED = "Your session ended. Sign in again to keep reading.";
const CHECK_FAILED = "dohc could not open this workspace. Check your connection, then try again.";
const SIGN_OUT_FAILED = "dohc could not sign you out. Retry sign-out.";
const refusedStatus = (error: unknown) => error instanceof ViewResponseError && [401, 403, 404].includes(error.status);

/** A workspace member's page: its files, a page, and its Groups, at the member's level. */
export default function WorkspaceApp({grantId}: {grantId: string | null}) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [pending, setPending] = useState<"account" | "sign-in" | "sign-out" | null>(grantId ? "account" : null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const start = (work: "account" | "sign-in" | "sign-out") => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setPending(work); setError(null); return controller;
  };
  const current = (controller: AbortController) => !controller.signal.aborted && request.current === controller;
  const check = (controller = start("account")) => {
    void namedRequest("/api/account/session", controller.signal).then(value => {
      if (current(controller)) {setAccount(accountUser(value)); setPending(null);}
    }).catch(() => {if (current(controller)) {setAccount(null); setPending(null); setError(CHECK_FAILED);}});
  };
  useEffect(() => {
    if (grantId) check();
    return () => request.current?.abort();
  }, [grantId]);
  const signIn = (credentials: {email: string; password: string}) => {
    const controller = start("sign-in");
    void namedRequest("/api/account/sign-in", controller.signal, credentials).then(() => check(controller),
      (reason: unknown) => {if (current(controller)) {setPending(null); setError(signInErrorMessage(reason));}});
  };
  const signOut = () => {
    const controller = start("sign-out");
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(() => {if (current(controller)) {setAccount(null); setPending(null);}},
      () => {if (current(controller)) {setPending(null); setError(SIGN_OUT_FAILED);}});
  };
  const sessionEnded = useCallback(() => {request.current?.abort(); setAccount(null); setPending(null); setError(SESSION_ENDED);}, []);

  if (!grantId) return <StatePage icon="unlink" title="This workspace link isn't valid.">
    <p>Open the workspace again from your invitation.</p>
  </StatePage>;
  if (account === undefined) return <Opening/>;
  if (!account) return <div className="viewer named-recipient workspace-sign-in">
    <header><div><p className="eyebrow">dohc</p><h1>Shared workspace</h1></div></header>
    <NamedSignIn title="Sign in to open this workspace" busy={pending !== null} error={error} onSignIn={signIn}>
      {error === CHECK_FAILED && <button className="handoff-button secondary" onClick={() => check()}>Try again</button>}
    </NamedSignIn>
  </div>;
  return <MemberWorkspace key={`${account.id}\n${grantId}`} grantId={grantId} account={account} signingOut={pending === "sign-out"}
    signOutError={error === SIGN_OUT_FAILED ? error : null} onSignOut={signOut} onSessionEnded={sessionEnded}/>;
}

/** The workspace's files from the view routes, kept current by one held log read at a time. */
function useMemberFiles(session: string, attempt: number) {
  const [view, setView] = useState<View>({status: "loading"});
  useEffect(() => {
    const controller = new AbortController(), {signal} = controller;
    const ready = (loaded: Omit<Files, "files">): Files => ({...loaded, files: filesFromAccumulator(loaded.fileAccumulator)});
    setView({status: "loading"});
    void (async () => {
      let files: Files;
      try {files = ready(await loadCurrentState(session, signal));}
      catch (error) {
        if (signal.aborted) return;
        setView({status: error instanceof VersionMismatchError ? "version-mismatch" : refusedStatus(error) ? "refused" : "load-failed"});
        return;
      }
      if (signal.aborted) return;
      setView({status: "ready", files});
      let delay = RETRY_INITIAL_MS;
      while (!signal.aborted) {
        const started = Date.now(), previous = files.nextCursor;
        try {
          const log = await loadLog(session, files.nextCursor, new Map(files.fileAccumulator), MAX_LOG_PAGES, signal, files.epochLogFloor,
            VIEW_LOG_HOLD_MS, files.meta.access !== "edit");
          const meta = await loadMeta(session, signal);
          if (signal.aborted) return;
          files = ready({...log, meta}); setView({status: "ready", files}); delay = RETRY_INITIAL_MS;
          const elapsed = Date.now() - started;
          if (log.nextCursor === previous && elapsed < VIEW_LOG_HOLD_MS) await waitForRetry(VIEW_LOG_HOLD_MS - elapsed, signal);
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof VersionMismatchError) {setView({status: "version-mismatch"}); return;}
          // A new epoch, or a level that no longer reads the whole log, starts again from the current files.
          if (error instanceof EpochFloorChangedError || (refusedStatus(error) && files.meta.access === "edit")) {
            try {files = ready(await loadCurrentState(session, signal)); setView({status: "ready", files}); continue;}
            catch (reload) {error = reload;}
          }
          if (signal.aborted) return;
          if (refusedStatus(error)) {setView({status: "ended"}); return;}
          await waitForRetry(delay, signal).catch(() => {}); delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    })();
    return () => controller.abort();
  }, [session, attempt]);
  return view;
}

function MemberWorkspace({grantId, account, signingOut, signOutError, onSignOut, onSessionEnded}: {
  grantId: string; account: Account; signingOut: boolean; signOutError: string | null; onSignOut(): void; onSessionEnded(): void;
}) {
  const session = memberSession(grantId);
  const [attempt, setAttempt] = useState(0);
  const view = useMemberFiles(session, attempt);
  const [ended, setEnded] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [tab, setTab] = useState<Tab>("page"), [unread, setUnread] = useState(0);
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null), [toastSlot, setToastSlot] = useState<HTMLElement | null>(null);
  const leave = useRef<((action: () => void) => void) | null>(null), tabs = useRef(new Map<Tab, HTMLButtonElement>());
  const narrow = useNarrow();
  const files = view.status === "ready" ? view.files : null;
  const name = files?.meta.subjectName ?? "Shared workspace";
  useEffect(() => {document.title = files ? `${name} · dohc` : "Shared with dohc";}, [files !== null, name]);
  useEffect(() => {
    if (!files) return;
    setSelectedPath(path => files.files.some(file => file.path === path) ? path : files.files[0]?.path ?? "");
  }, [files]);
  const groupsEnded = useCallback((reason: Ended) => {if (reason === "signed-out") onSessionEnded(); else setEnded(true);}, [onSessionEnded]);
  const signOut = () => (leave.current ?? (action => action()))(onSignOut);
  // A file whose text is gone has changed. The follow brings its new text; this says whether to wait for it.
  const refreshStale = useCallback(async (path: string, blobSha256: string) => {
    try {
      const file = filesFromAccumulator((await loadCurrentState(session)).fileAccumulator).find(item => item.path === path);
      return file === undefined || file.blobSha256 !== blobSha256;
    } catch {return false;}
  }, [session]);

  if (ended || view.status === "ended") return <StatePage icon="unlink" title="Your membership ended.">
    <p>This browser keeps no copy of the workspace. Ask the owner to invite you again.</p>
  </StatePage>;
  if (view.status === "refused") return <StatePage icon="unlink" title="dohc could not open this workspace with this account.">
    <p>Sign in with the account the owner invited.</p>
    <button className="handoff-button secondary" type="button" disabled={signingOut} onClick={onSignOut}>Sign out</button>
  </StatePage>;
  if (view.status === "load-failed") return <StatePage icon="alert" failed title="dohc couldn't open this workspace.">
    <p>Check your connection, then choose Try again.</p>
    <button className="handoff-button secondary" type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
  </StatePage>;
  if (view.status === "version-mismatch") return <StatePage icon="refresh" title="This page does not match its server.">
    <p>Reload it to get the version the server expects.</p>
    <button className="handoff-button secondary" type="button" onClick={() => location.reload()}>Reload</button>
  </StatePage>;
  if (!files) return <Opening/>;

  const access = files.meta.access;
  const selected = files.files.find(file => file.path === selectedPath) ?? files.files[0];
  const tree = fileTree(files.files);
  const segments = selected?.path.split("/") ?? [];
  const live = access === "edit" && selected !== undefined && selected.contentKind === "text" && isMarkdown(selected.path);
  const choose = (path: string) => {
    const go = () => {setSelectedPath(path); if (narrow) setTab("page");};
    if (path === selected?.path) go(); else (leave.current ?? (action => action()))(go);
  };
  const readView = selected ? <FileView key={`${selected.path}\n${selected.blobSha256}`} session={session} file={selected} files={files.files}
    onSelect={choose} onStaleBlob={refreshStale}/> : null;
  const shownTab = narrow ? tab : null;
  const panel = (id: Tab) => narrow ? {role: "tabpanel", "aria-labelledby": `workspace-tab-${id}`, inert: tab !== id, "data-shown": tab === id} : {};
  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex(item => item.id === tab);
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length :
      event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); setTab(TABS[next]!.id); tabs.current.get(TABS[next]!.id)?.focus();
  };

  return <div className="viewer link-page workspace-page" data-tab={shownTab ?? undefined}>
    <nav id="workspace-files" aria-label="Workspace files" {...panel("files")}>
      <div className="workspace-title"><span className="bar-mark"><DohcMark/></span><h1 className="workspace-name">{name}</h1></div>
      {files.files.length ? <ul className="tree">
        {tree.folders.map(folder => <Folder key={folder.path} node={folder} selected={selected?.path ?? ""} onSelect={file => choose(file.path)}/>)}
        {tree.files.map(file => <li key={file.path}>
          <button className={selected?.path === file.path ? "file selected" : "file"} type="button" aria-current={selected?.path === file.path ? "page" : undefined}
            onClick={() => choose(file.path)}><Icon name={fileIcon(file.path)}/><span>{file.path}</span></button>
        </li>)}
      </ul> : <p className="workspace-empty">No files in this workspace yet.</p>}
      <div className="workspace-account">
        <span title={account.name}>{account.name}</span>
        <button className="handoff-button secondary" type="button" disabled={signingOut} onClick={signOut}>{signingOut ? "Signing out…" : "Sign out"}</button>
        {signOutError && <p role="alert">{signOutError}</p>}
      </div>
    </nav>
    <div className="page" id="workspace-main" {...panel("page")}>
      <header>
        <div className="bar-left">
          <span className="bar-mark narrow-mark"><DohcMark/></span>
          {selected && <div className="crumbs">
            {segments.slice(0, -1).map((folder, index) => <span key={index}>{folder}</span>)}
            <b>{segments.at(-1)}</b>
          </div>}
        </div>
        <div className="header-actions">
          <div className="workspace-status" ref={setStatusSlot}/>
          {!live && <span className="badge">{BADGE[access]}</span>}
        </div>
      </header>
      <div className="layout">
        <div className="scroller">
          <div className="column">
            {selected ? <>
              <h1 className="page-title">{fileTitle(selected.path)}</h1>
              <main className="content">
                {live ? <Suspense fallback={readView}>
                  <MemberLivePage key={selected.path} grantId={grantId} accountId={account.id} path={selected.path} readView={readView}
                    statusSlot={statusSlot} toastSlot={toastSlot} leave={leave}/>
                </Suspense> : readView}
              </main>
            </> : <div className="empty-state"><p>No files in this workspace yet. This page shows them as soon as they arrive.</p></div>}
          </div>
        </div>
      </div>
      <div className="toast-slot" ref={setToastSlot}/>
    </div>
    <div className="side-panel workspace-chats" id="workspace-chats" {...panel("chats")}>
      <MemberChats grantId={grantId} accountId={account.id} shown={!narrow || tab === "chats"} onEnded={groupsEnded} onUnread={setUnread}/>
    </div>
    {narrow && <div className="workspace-tabs" role="tablist" aria-label="Workspace" onKeyDown={moveTab}>
      {TABS.map(item => <button key={item.id} ref={node => {if (node) tabs.current.set(item.id, node);}} id={`workspace-tab-${item.id}`} role="tab" type="button"
        aria-selected={tab === item.id} aria-controls={item.panel} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>
        {item.label}{item.id === "chats" && unread > 0 && <span className="unread-count">{unread}<span className="sr-only"> unread</span></span>}
      </button>)}
    </div>}
  </div>;
}

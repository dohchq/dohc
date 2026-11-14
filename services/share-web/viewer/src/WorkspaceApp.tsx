import {lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode} from "react";
import type {Ended} from "./ChatChannel";
import {createPortal} from "react-dom";
import {DohcMark, Icon} from "./icons";
import {MemberChats, MemberComments, useMemberListing, LISTING_FAILED} from "./MemberChats";
import {Toast} from "./Toast";
import {CopyWork} from "./CopyWork";
import {readDraft, writeDraft} from "./drafts";
import {memberSession} from "./memberWorkspace";
import {filesFromAccumulator, isMarkdown, type FileAccumulator, type ShareAccess, type SharedFile, type ViewMeta} from "./model";
import {accountUser, namedRequest} from "./namedRecipient";
import {SignInForm, signInErrorMessage} from "./NamedSignIn";
import {RETRY_INITIAL_MS, RETRY_MAX_MS} from "./retry";
import {
  EpochFloorChangedError, FileTree, FileView, fileTitle, fileTree, loadCurrentState, loadLog, loadMeta, MAX_LOG_PAGES, StatePage,
  useNarrow, VersionMismatchError, VIEW_LOG_HOLD_MS, ViewResponseError, waitForRetry,
} from "./viewFiles";
import "./join.css";
import "./workspace.css";

// The live editor loads only once a page opens for editing.
const MemberLivePage = lazy(() => import("./MemberLivePage"));

type Account = {id: string; name: string};
type Files = {meta: ViewMeta; fileAccumulator: FileAccumulator; files: SharedFile[]; nextCursor: number; epochLogFloor: number};
type View = {status: "loading"} | {status: "ready"; files: Files} | {status: "refused" | "ended" | "load-failed" | "version-mismatch"};
type Tab = "files" | "page" | "comments" | "chats";
type Side = "comments" | "chats";
const TABS: {id: Tab; label: string; panel: string}[] = [
  {id: "files", label: "Files", panel: "workspace-files"}, {id: "page", label: "Page", panel: "workspace-main"},
  {id: "comments", label: "Comments", panel: "workspace-comments"}, {id: "chats", label: "Chats", panel: "workspace-chats"},
];
// Beside the page on a wide screen, the open file's Comments or the Groups.
const SIDES = TABS.filter((item): item is typeof item & {id: Side} => item.id === "comments" || item.id === "chats");
const BADGE = {view: "View only", comment: "Can comment", edit: "Can edit"} as const;
const LEVEL_RANK = {view: 0, comment: 1, edit: 2} as const;
// The desktop's words for a members' level change (`levelChangedWords` in its membershipWords.ts).
function levelChangedWords(access: ShareAccess, by: string | null | undefined): string {
  const what = access === "view" ? "view only" : access;
  return by ? `${by} now lets members ${what}.` : `Members can now ${what}.`;
}
const SESSION_ENDED = "Your session ended. Sign in again to keep reading.";
const CHECK_FAILED = "dohc could not open this workspace. Check your connection.";
const SIGN_OUT_FAILED = "dohc could not sign you out. Retry sign-out.";
const CHECK_CONNECTION = "Check your connection.";
// While the held read of the files fails, what shows is the last version that arrived. The desktop's words for an old list.
const DATED = "May be out of date", DATED_TITLE = "These are the last files dohc received.";
const FILES_BEHIND = "dohc could not update this workspace's files";
// As on the phone, a read that fails this many times in a row raises a toast, so the files never go out of date without a sign.
const BEHIND_REPORT_FAILURES = 3;
const refusedStatus = (error: unknown) => error instanceof ViewResponseError && [401, 403, 404].includes(error.status);

/**
 * Live text that never reached the workspace, from a page that closed while the person could not keep editing it.
 * Each item names the account that wrote it, so another account signed in on the same tab never sees it.
 */
type Unsent = {id: number; accountId: string; path: string; text: string; discarded?: true};
const UNSENT_KEY = "unsent-edits";

// The tab's session storage keeps the text through a reload, as it keeps drafts. A discarded item stays only for its Undo.
function readUnsent(): Unsent[] {
  try {
    const stored: unknown = JSON.parse(readDraft(UNSENT_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((item): item is Unsent => typeof item?.id === "number" &&
      typeof item.accountId === "string" && typeof item.path === "string" && typeof item.text === "string") : [];
  } catch {return [];}
}
function writeUnsent(list: readonly Unsent[]): void {
  const kept = list.filter(item => !item.discarded).map(({id, accountId, path, text}) => ({id, accountId, path, text}));
  writeDraft(UNSENT_KEY, kept.length ? JSON.stringify(kept) : "");
}

/** The file's name, or where another kept file has the same name, the fewest folders before it that tell the two apart. */
function shownPath(path: string, all: readonly Unsent[]): string {
  const parts = path.split("/"), others = all.map(item => item.path.split("/")).filter(other => other.join("/") !== path);
  for (let count = 1; count < parts.length; count++) {
    const tail = parts.slice(-count).join("/");
    if (!others.some(other => other.slice(-count).join("/") === tail)) return tail;
  }
  return path;
}

/**
 * One row per page in the page's flow, under its band, or on the page shown next, so it outlasts a lower level,
 * an ended membership or an ended session. A row opens in place to the text, with Copy, Download and Discard.
 */
function UnsentEdits({unsent, onDiscard, onUndo, onForget}: {unsent: readonly Unsent[]; onDiscard(id: number): void; onUndo(id: number): void; onForget(id: number): void}) {
  return <div className="workspace-kept">{unsent.map(item => {
    const name = shownPath(item.path, unsent), base = item.path.slice(item.path.lastIndexOf("/") + 1), dot = base.lastIndexOf(".");
    const file = dot > 0 ? `${base.slice(0, dot)} (unsent edits)${base.slice(dot)}` : `${base} (unsent edits)`;
    if (item.discarded) return <aside key={item.id} className="unsent-discarded" aria-label="Discarded edits">
      <p>Discarded your unsent edits to {name}.</p>
      <button type="button" className="handoff-button secondary" onClick={() => onUndo(item.id)}>Undo</button>
      <button className="icon-button" type="button" aria-label="Dismiss" title="Dismiss" onClick={() => onForget(item.id)}><Icon name="x"/></button>
    </aside>;
    return <details key={item.id} className="unsent-edits" aria-label="Unsent edits">
      <summary><Icon name="triangle-alert" size={14}/><span className="unsent-name">Unsent edits to {name}</span><Icon name="chevron-down" size={14}/></summary>
      <p>Only this tab has them. Copy or download them before you close it.</p>
      <textarea readOnly value={item.text} aria-label={`Unsent edits to ${name}`}/>
      <div className="unsent-actions">
        <CopyWork text={item.text} label="Copy unsent edits" failure="dohc could not copy the edits. Download them instead."/>
        <a className="handoff-button secondary" download={file} href={`data:text/markdown;charset=utf-8,${encodeURIComponent(item.text)}`}>Download</a>
        <button type="button" className="handoff-button secondary" onClick={() => onDiscard(item.id)}>Discard</button>
      </div>
    </details>;
  })}</div>;
}

const COMPOSERS = ".chat-composer, .chat-read-only, .comment-composer";

/**
 * On a phone, toasts sit above the tab bar, and a warning stays until it is dismissed.
 * While a Group or Comments tab shows its composer, the corner rises above it, so it never covers what
 * the person writes or a kept draft's Copy and Discard.
 */
function useCornerAboveComposer(sidePanel: HTMLElement | null, corner: HTMLElement | null) {
  useEffect(() => {
    if (!sidePanel || !corner) return;
    let frame = 0, watched: Element | null = null;
    const sizes = new ResizeObserver(() => place());
    const measure = () => {
      frame = 0;
      // A tab out of view keeps its composer, hidden by `data-shown="false"` on it or an ancestor.
      const composer = [...sidePanel.querySelectorAll(COMPOSERS)].find(node => !node.closest('[data-shown="false"]')) ?? null;
      if (composer !== watched) {
        if (watched) sizes.unobserve(watched);
        if (composer) sizes.observe(composer);
        watched = composer;
      }
      if (composer) corner.style.bottom = `${document.documentElement.clientHeight - composer.getBoundingClientRect().top + 8}px`;
      else corner.style.removeProperty("bottom");
    };
    const place = () => {if (!frame) frame = requestAnimationFrame(measure);};
    // A Group that opens or closes adds or removes its composer, and a tab change moves `data-shown`.
    const changes = new MutationObserver(place);
    changes.observe(sidePanel, {subtree: true, childList: true, attributes: true, attributeFilter: ["data-shown"]});
    window.addEventListener("resize", place);
    place();
    return () => {
      cancelAnimationFrame(frame); changes.disconnect(); sizes.disconnect(); window.removeEventListener("resize", place);
      corner.style.removeProperty("bottom");
    };
  }, [sidePanel, corner]);
}

/** A workspace member's page: its files, a page, and its Groups, at the member's level. */
export default function WorkspaceApp({grantId}: {grantId: string | null}) {
  const [unsent, setUnsent] = useState<Unsent[]>(readUnsent);
  const unsentId = useRef(Math.max(0, ...unsent.map(item => item.id)));
  const [toastSlot, setToastSlot] = useState<HTMLElement | null>(null);
  // The account last signed in on this page. Signed out, its kept edits still show, so an ended session keeps them in view.
  // Before any account signs in, as after a reload, none show: the tab may hold another person's text.
  const [lastAccount, setLastAccount] = useState<string | null>(null);
  const keep = useCallback((accountId: string, path: string, text: string) =>
    setUnsent(list => [...list, {id: ++unsentId.current, accountId, path, text}]), []);
  const discarded = (id: number, value: boolean) => setUnsent(list => list.map(item => item.id !== id ? item
    : value ? {...item, discarded: true} : {id: item.id, accountId: item.accountId, path: item.path, text: item.text}));
  const shown = unsent.filter(item => item.accountId === lastAccount);
  useEffect(() => writeUnsent(unsent), [unsent]);
  // Closing the tab loses the kept text, so the browser asks first while any remains.
  const holding = unsent.some(item => !item.discarded);
  useEffect(() => {
    if (!holding) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = "";};
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [holding]);
  const kept = shown.length ? <UnsentEdits unsent={shown} onDiscard={id => discarded(id, true)} onUndo={id => discarded(id, false)}
    onForget={id => setUnsent(list => list.filter(item => item.id !== id))}/> : null;
  return <>
    <MemberEntry grantId={grantId} onUnsent={keep} onAccount={setLastAccount} toastSlot={toastSlot} kept={kept}/>
    {/* Toasts land at the window's bottom right. */}
    <div className="workspace-corner"><div className="toast-slot" ref={setToastSlot}/></div>
  </>;
}

/** Signs the member in, then opens the workspace. */
function MemberEntry({grantId, onUnsent, onAccount, toastSlot, kept}: {
  grantId: string | null; onUnsent(accountId: string, path: string, text: string): void; onAccount(id: string): void;
  toastSlot: HTMLElement | null; kept: ReactNode;
}) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  useEffect(() => {if (account) onAccount(account.id);}, [account, onAccount]);
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
    <p>Open the workspace again from your invitation.</p>{kept}
  </StatePage>;
  if (account === undefined) return <WorkspaceOpening/>;
  if (!account) return <div className="state-page join-page">
    <span className="bar-mark"><DohcMark/></span>
    <main className="state">
      <div className="state-message">
        <span className="tile"><Icon name="users" size={20}/></span>
        <h1>Sign in to open this workspace</h1>
        <p>{error === SESSION_ENDED ? SESSION_ENDED : "Use the account the owner invited."}</p>
        <SignInForm busy={pending !== null} error={error === SESSION_ENDED || error === CHECK_FAILED ? null : error} onSignIn={signIn}/>
        {error === CHECK_FAILED && <p className="join-error" role="alert">{CHECK_FAILED}{" "}
          <button className="join-link" type="button" disabled={pending !== null} onClick={() => check()}>Try again</button></p>}
        {kept}
      </div>
    </main>
  </div>;
  return <MemberWorkspace key={`${account.id}\n${grantId}`} grantId={grantId} account={account} signingOut={pending === "sign-out"}
    signOutError={error === SIGN_OUT_FAILED ? error : null} onSignOut={signOut} onSessionEnded={sessionEnded}
    onUnsent={(path, text) => onUnsent(account.id, path, text)} toastSlot={toastSlot} kept={kept}/>;
}

/**
 * The workspace's files from the view routes, kept current by one held log read at a time.
 * `failures` counts the reads in a row that failed since the files last caught up, and `retry` reads again at once.
 */
function useMemberFiles(session: string, attempt: number) {
  const [view, setView] = useState<View>({status: "loading"});
  const [failures, setFailures] = useState(0);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController(), {signal} = controller;
    const ready = (loaded: Omit<Files, "files">): Files => ({...loaded, files: filesFromAccumulator(loaded.fileAccumulator)});
    setView({status: "loading"}); setFailures(0);
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
          files = ready({...log, meta}); setView({status: "ready", files}); setFailures(0); delay = RETRY_INITIAL_MS;
          const elapsed = Date.now() - started;
          if (log.nextCursor === previous && elapsed < VIEW_LOG_HOLD_MS) await waitForRetry(VIEW_LOG_HOLD_MS - elapsed, signal);
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof VersionMismatchError) {setView({status: "version-mismatch"}); return;}
          // A new epoch, or a level that no longer reads the whole log, starts again from the current files.
          if (error instanceof EpochFloorChangedError || (refusedStatus(error) && files.meta.access === "edit")) {
            try {files = ready(await loadCurrentState(session, signal)); setView({status: "ready", files}); setFailures(0); continue;}
            catch (reload) {error = reload;}
          }
          if (signal.aborted) return;
          if (refusedStatus(error)) {setView({status: "ended"}); return;}
          setFailures(count => count + 1);
          // Try again ends the wait at once.
          const pause = new AbortController(), stop = () => pause.abort();
          signal.addEventListener("abort", stop, {once: true}); wake.current = stop;
          await waitForRetry(delay, pause.signal).catch(() => {});
          signal.removeEventListener("abort", stop); if (wake.current === stop) wake.current = null;
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    })();
    return () => controller.abort();
  }, [session, attempt]);
  return {view, failures, retry: useCallback(() => wake.current?.(), [])};
}

// The workspace's shape while it loads: its files, the page and the side panel, or on a phone the page's header, the page and the tabs.
function WorkspaceOpening() {
  return <div className="viewer link-page workspace-page workspace-opening" aria-busy="true">
    <div className="workspace-opening-files" aria-hidden="true"><span className="bar-mark"><DohcMark/></span><i/><i/><i/><i/><i/></div>
    <div className="workspace-opening-page" aria-hidden="true">
      <div className="workspace-opening-head"><span className="bar-mark"><DohcMark/></span><i/></div>
      <div className="skeleton"><i/><i/><i/><i/><i/><i/><i/></div>
    </div>
    <div className="workspace-opening-side" aria-hidden="true"><i/><i/><i/><i/></div>
    <div className="workspace-opening-tabs" aria-hidden="true"><i/><i/><i/><i/></div>
    <p className="sr-only">Opening the workspace</p>
  </div>;
}

function MemberWorkspace({grantId, account, signingOut, signOutError, onSignOut, onSessionEnded, onUnsent, toastSlot, kept}: {
  grantId: string; account: Account; signingOut: boolean; signOutError: string | null; onSignOut(): void; onSessionEnded(): void;
  onUnsent(path: string, text: string): void; toastSlot: HTMLElement | null; kept: ReactNode;
}) {
  const session = memberSession(grantId);
  const [attempt, setAttempt] = useState(0);
  const {view, failures, retry: retryFiles} = useMemberFiles(session, attempt);
  // A toast closed while the reads still fail stays closed until the files catch up.
  const [behindDismissed, setBehindDismissed] = useState(false);
  useEffect(() => {if (failures === 0) setBehindDismissed(false);}, [failures]);
  const [ended, setEnded] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [tab, setTab] = useState<Tab>("page"), [side, setSide] = useState<Side>("chats"), [unread, setUnread] = useState(0);
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  const [bandSlot, setBandSlot] = useState<HTMLElement | null>(null);
  const leave = useRef<((action: () => void) => void) | null>(null), tabs = useRef(new Map<Tab, HTMLButtonElement>());
  const narrow = useNarrow();
  const [sideNode, setSideNode] = useState<HTMLDivElement | null>(null);
  useCornerAboveComposer(narrow ? sideNode : null, toastSlot?.parentElement ?? null);
  const files = view.status === "ready" ? view.files : null;
  const name = files?.meta.subjectName ?? "Shared workspace";
  // An ended membership reads nothing more, so its page names the workspace as it was last read.
  const lastName = useRef<string | null>(null);
  if (files?.meta.subjectName) lastName.current = files.meta.subjectName;
  useEffect(() => {document.title = files ? `${name} · dohc` : "Shared with dohc";}, [files !== null, name]);
  useEffect(() => {
    if (!files) return;
    setSelectedPath(path => files.files.some(file => file.path === path) ? path : files.files[0]?.path ?? "");
  }, [files]);
  const groupsEnded = useCallback((reason: Ended) => {if (reason === "signed-out") onSessionEnded(); else setEnded(true);}, [onSessionEnded]);
  const listing = useMemberListing(view.status === "ready" ? grantId : null, account.id, groupsEnded), {refresh: refreshListing} = listing;
  // The held read of the files returns at least once per hold. Each return reads the Groups again once they are that old,
  // so a new Group appears even when the workspace had none, or the new one has no messages yet.
  useEffect(() => {if (view.status === "ready") refreshListing(VIEW_LOG_HOLD_MS);}, [view, refreshListing]);
  // Groups and Comments share one read, so one toast reports it. Each failure raises it again.
  const [listingDismissed, setListingDismissed] = useState(false);
  useEffect(() => {if (listing.found === "failed") setListingDismissed(false);}, [listing.found]);
  const signOut = () => (leave.current ?? (action => action()))(onSignOut);
  // A file whose text is gone has changed. The follow brings its new text; this says whether to wait for it.
  const refreshStale = useCallback(async (path: string, blobSha256: string) => {
    try {
      const file = filesFromAccumulator((await loadCurrentState(session)).fileAccumulator).find(item => item.path === path);
      return file === undefined || file.blobSha256 !== blobSha256;
    } catch {return false;}
  }, [session]);
  // A level the owner or an admin changes while the page is open says so in a toast. The page has no Notices list to keep it.
  const access = files?.meta.access, changedBy = useRef(files?.meta.levelChangedBy);
  changedBy.current = files?.meta.levelChangedBy;
  const shownAccess = useRef(access);
  const [levelNote, setLevelNote] = useState<{words: string; lower: boolean} | null>(null);
  useEffect(() => {
    const before = shownAccess.current; shownAccess.current = access;
    if (!access || !before || before === access) return;
    setLevelNote({words: levelChangedWords(access, changedBy.current), lower: LEVEL_RANK[access] < LEVEL_RANK[before]});
  }, [access]);

  if (ended || view.status === "ended") return <StatePage icon="unlink"
    title={lastName.current ? `Your membership in ${lastName.current} ended.` : "Your membership ended."}>
    <p>Ask the owner to invite you again to keep working in it.</p>{kept}
  </StatePage>;
  if (view.status === "refused") return <StatePage icon="unlink" title="dohc could not open this workspace with this account.">
    <p>This browser is signed in as {account.name}, not the account the owner invited.</p>
    <button className="handoff-button secondary" type="button" disabled={signingOut} onClick={onSignOut}>Switch account</button>{kept}
  </StatePage>;
  if (view.status === "load-failed") return <StatePage icon="alert" failed title="dohc couldn't open this workspace.">
    <p>Check your connection, then choose Try again.</p>
    <button className="handoff-button secondary" type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>{kept}
  </StatePage>;
  if (view.status === "version-mismatch") return <StatePage icon="refresh" title="This page does not match its server.">
    <p>Reload it to get the version the server expects.</p>
    <button className="handoff-button secondary" type="button" onClick={() => location.reload()}>Reload</button>{kept}
  </StatePage>;
  if (!files) return <WorkspaceOpening/>;

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
  // What shows beside the page: on a phone, the tab when it is Comments or Chats.
  const showing: Side | null = narrow ? (tab === "comments" || tab === "chats" ? tab : null) : side;
  const sidePanel = (id: Side) => ({role: "tabpanel", "aria-labelledby": narrow ? `workspace-tab-${id}` : `side-tab-${id}`,
    inert: showing !== id, "data-shown": showing === id});
  const moveTab = <T extends Tab>(list: {id: T}[], current: T, choose: (id: T) => void) => (event: KeyboardEvent<HTMLDivElement>) => {
    const index = list.findIndex(item => item.id === current);
    const next = event.key === "ArrowRight" ? (index + 1) % list.length : event.key === "ArrowLeft" ? (index + list.length - 1) % list.length :
      event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); choose(list[next]!.id); tabs.current.get(list[next]!.id)?.focus();
  };
  const tabLabel = (item: {id: Tab; label: string}) => <>
    {item.label}{item.id === "chats" && unread > 0 && <span className="unread-count">{unread}<span className="sr-only"> unread</span></span>}
  </>;

  return <div className="viewer link-page workspace-page" data-tab={shownTab ?? undefined}>
    <nav id="workspace-files" aria-label="Workspace files" {...panel("files")}>
      <div className="workspace-title"><span className="bar-mark"><DohcMark/></span><h1 className="workspace-name">{name}</h1></div>
      {files.files.length ? <FileTree tree={tree} label="Workspace files" selected={selected?.path ?? ""} onSelect={file => choose(file.path)}/>
        : <p className="workspace-empty">No files in this workspace yet.</p>}
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
          {failures > 0 && <span className="workspace-dated" title={DATED_TITLE}><Icon name="clock" size={12}/>{DATED}</span>}
          <span className="badge">{BADGE[files.meta.access]}</span>
        </div>
      </header>
      <div className="page-band" ref={setBandSlot}/>
      {kept}
      <div className="layout">
        <div className="scroller">
          <div className="column">
            {selected ? <>
              <h1 className="page-title">{fileTitle(selected.path)}</h1>
              <main className="content">
                {live ? <Suspense fallback={readView}>
                  <MemberLivePage key={selected.path} grantId={grantId} accountId={account.id} path={selected.path} readView={readView}
                    statusSlot={statusSlot} bandSlot={bandSlot} toastSlot={toastSlot} leave={leave}
                    onUnsent={text => onUnsent(selected.path, text)}/>
                </Suspense> : readView}
              </main>
            </> : <div className="empty-state"><p>No files in this workspace yet. This page shows them as soon as they arrive.</p></div>}
          </div>
        </div>
      </div>
    </div>
    <div className="side-panel workspace-side" ref={setSideNode} {...(narrow ? {inert: showing === null, "data-shown": showing !== null} : {})}>
      {!narrow && <div className="side-tabs" role="tablist" aria-label="Beside the page" onKeyDown={moveTab(SIDES, side, setSide)}>
        {SIDES.map(item => <button key={item.id} ref={node => {if (node) tabs.current.set(item.id, node);}} id={`side-tab-${item.id}`} role="tab" type="button"
          aria-selected={side === item.id} aria-controls={item.panel} tabIndex={side === item.id ? 0 : -1} onClick={() => setSide(item.id)}>{tabLabel(item)}</button>)}
      </div>}
      <div className="side-stack">
        <div id="workspace-comments" {...sidePanel("comments")}>
          {showing === "comments" && (selected ? <MemberComments found={listing.found} onRetry={listing.retry} path={selected.path}
            access={access === "view" ? "read-only" : "read-write"} onEnded={groupsEnded}/> : <p className="chat-state">No files in this workspace yet.</p>)}
        </div>
        <div className="workspace-chats" id="workspace-chats" {...sidePanel("chats")}>
          <MemberChats found={listing.found} onRetry={listing.retry} onUnlisted={refreshListing} access={access === "view" ? "read-only" : "read-write"} shown={showing === "chats"} onEnded={groupsEnded} onUnread={setUnread}/>
        </div>
      </div>
    </div>
    {narrow && <div className="workspace-tabs" role="tablist" aria-label="Workspace" onKeyDown={moveTab(TABS, tab, setTab)}>
      {TABS.map(item => <button key={item.id} ref={node => {if (node) tabs.current.set(item.id, node);}} id={`workspace-tab-${item.id}`} role="tab" type="button"
        aria-selected={tab === item.id} aria-controls={item.panel} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>{tabLabel(item)}</button>)}
    </div>}
    {listing.found === "failed" && !listingDismissed && toastSlot && createPortal(<Toast title={LISTING_FAILED} body={CHECK_CONNECTION}
      onRetry={listing.retry} onDismiss={() => setListingDismissed(true)}/>, toastSlot)}
    {failures >= BEHIND_REPORT_FAILURES && !behindDismissed && toastSlot && createPortal(<Toast title={FILES_BEHIND} body={CHECK_CONNECTION}
      onRetry={retryFiles} onDismiss={() => setBehindDismissed(true)}/>, toastSlot)}
    {levelNote && toastSlot && createPortal(<Toast title={levelNote.words} tone={levelNote.lower ? "warning" : "success"}
      onDismiss={() => setLevelNote(null)}/>, toastSlot)}
  </div>;
}

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Ended } from "./ChatChannel";
import { createPortal } from "react-dom";
import { DohcMark, Icon } from "./icons";
import { MemberChats, MemberComments, useMemberListing, LISTING_FAILED } from "./MemberChats";
import { Toast } from "./Toast";
import { UnsentEditsRow } from "./UnsentEdits";
import { LaunchFailure } from "./OpenSharedApp";
import { readDraft, writeDraft } from "./drafts";
import {
  filesFromAccumulator,
  isMarkdown,
  type FileAccumulator,
  type ShareAccess,
  type SharedFile,
  type ViewMeta,
} from "./model";
import { accountUser, namedRequest } from "./namedRecipient";
import { SignInForm, signInErrorMessage } from "./NamedSignIn";
import { WORKSPACES_PATH } from "./pages";
import { RETRY_INITIAL_MS, RETRY_MAX_MS } from "./retry";
import {
  EpochFloorChangedError,
  FileTree,
  FileView,
  fileTitle,
  fileTree,
  loadCurrentState,
  loadLog,
  loadMeta,
  MAX_LOG_PAGES,
  StatePage,
  TooManyFilesError,
  useNarrow,
  VersionMismatchError,
  VIEW_LOG_HOLD_MS,
  ViewResponseError,
  waitForRetry,
} from "./viewFiles";
import { viewSession, type WorkspaceTarget } from "./workspaceTarget";
import { WorkspaceList, WorkspacesOpening } from "./WorkspaceList";
import "./join.css";
import "./workspace.css";

// The live editor loads only once a page opens for editing.
const MemberLivePage = lazy(() => import("./MemberLivePage"));

type Account = { id: string; name: string };
type Files = {
  meta: ViewMeta;
  fileAccumulator: FileAccumulator;
  files: SharedFile[];
  nextCursor: number;
  epochLogFloor: number;
  // The member's level on each file, from the last read of the current files. A folder rule can change it.
  levels: ReadonlyMap<string, ShareAccess>;
};
type View =
  | { status: "loading" }
  | { status: "ready"; files: Files }
  // Another account signed in on this browser, as in another tab.
  | { status: "other-account"; name: string }
  | { status: "refused" | "ended" | "too-large" | "load-failed" | "version-mismatch" };
// What the grant's own read and the account's session say after a refusal of the files.
// An open grant answers with its reach, which says whether the level changed.
type Confirmed = { open: ViewMeta } | "ended" | "signed-out" | "failed" | { other: string };
type Tab = "files" | "page" | "comments" | "chats";
type Side = "comments" | "chats";
const TABS: { id: Tab; label: string; panel: string }[] = [
  { id: "files", label: "Files", panel: "workspace-files" },
  { id: "page", label: "Page", panel: "workspace-main" },
  { id: "comments", label: "Comments", panel: "workspace-comments" },
  { id: "chats", label: "Chats", panel: "workspace-chats" },
];
// Beside the page on a wide screen, the open file's Comments or the Groups.
const SIDES = TABS.filter(
  (item): item is typeof item & { id: Side } => item.id === "comments" || item.id === "chats",
);
const BADGE = { view: "View only", comment: "Can comment", edit: "Can edit" } as const;
const LEVEL_RANK = { view: 0, comment: 1, edit: 2 } as const;
// The desktop's words for a members' level change (`levelChangedWords` in its membershipWords.ts).
function levelChangedWords(access: ShareAccess, by: string | null | undefined): string {
  const what = access === "view" ? "view only" : access;
  return by ? `${by} now lets members ${what}.` : `Members can now ${what}.`;
}
const SESSION_ENDED = "Your session ended. Sign in again to keep reading.";
const CHECK_FAILED = "dohc could not open this workspace. Check your connection.";
const SIGN_OUT_FAILED = "dohc could not sign you out. Retry sign-out.";
const SIGN_UP = `/account/sign-up?next=${encodeURIComponent(WORKSPACES_PATH)}`;
// On the page for another account, the control that signs out is Switch account.
const SWITCH_FAILED = "dohc could not sign you out. Choose Switch account to try again.";
const CHECK_CONNECTION = "Check your connection.";
// While the held read of the files fails, what shows is the last version that arrived. The desktop's words for an old list.
const DATED = "May be out of date",
  DATED_TITLE = "These are the last files dohc received.";
const FILES_BEHIND = "dohc could not update this workspace's files";
// As on the phone, a read that fails this many times in a row raises a toast, so the files never go out of date without a sign.
const BEHIND_REPORT_FAILURES = 3;
const refusedStatus = (error: unknown) =>
  error instanceof ViewResponseError && [401, 403, 404].includes(error.status);

/**
 * Live text that never reached the workspace, from a page that closed while the person could not keep editing it.
 * Each item names the account that wrote it, so another account signed in on the same tab never sees it.
 */
type Unsent = { id: number; accountId: string; path: string; text: string; discarded?: true };
const UNSENT_KEY = "unsent-edits";

// The tab's session storage keeps the text through a reload, as it keeps drafts. A discarded item stays only for its Undo.
function readUnsent(): Unsent[] {
  try {
    const stored: unknown = JSON.parse(readDraft(UNSENT_KEY) || "[]");
    return Array.isArray(stored)
      ? stored.filter(
          (item): item is Unsent =>
            typeof item?.id === "number" &&
            typeof item.accountId === "string" &&
            typeof item.path === "string" &&
            typeof item.text === "string",
        )
      : [];
  } catch {
    return [];
  }
}
function writeUnsent(list: readonly Unsent[]): void {
  const kept = list
    .filter((item) => !item.discarded)
    .map(({ id, accountId, path, text }) => ({ id, accountId, path, text }));
  writeDraft(UNSENT_KEY, kept.length ? JSON.stringify(kept) : "");
}

/** The file's name, or where another kept file has the same name, the fewest folders before it that tell the two apart. */
function shownPath(path: string, all: readonly { path: string }[]): string {
  const parts = path.split("/"),
    others = all.map((item) => item.path.split("/")).filter((other) => other.join("/") !== path);
  for (let count = 1; count < parts.length; count++) {
    const tail = parts.slice(-count).join("/");
    if (!others.some((other) => other.slice(-count).join("/") === tail)) return tail;
  }
  return path;
}

/**
 * One row per page in the page's flow, under its band, or on the page shown next, so it outlasts a lower level,
 * an ended membership or an ended session. A row opens in place to the text, with Copy, Download and Discard.
 */
function UnsentEdits({
  unsent,
  onDiscard,
  onUndo,
  onForget,
}: {
  unsent: readonly Unsent[];
  onDiscard(id: number): void;
  onUndo(id: number): void;
  onForget(id: number): void;
}) {
  return (
    <div className="workspace-kept">
      {unsent.map((item) => {
        const name = shownPath(item.path, unsent);
        if (item.discarded)
          return (
            <aside key={item.id} className="unsent-discarded" aria-label="Discarded edits">
              <p>Discarded your unsent edits to {name}.</p>
              <button
                type="button"
                className="handoff-button secondary"
                onClick={() => onUndo(item.id)}
              >
                Undo
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Dismiss"
                title="Dismiss"
                onClick={() => onForget(item.id)}
              >
                <Icon name="x" />
              </button>
            </aside>
          );
        return (
          <UnsentEditsRow
            key={item.id}
            name={name}
            path={item.path}
            text={item.text}
            onDiscard={() => onDiscard(item.id)}
          />
        );
      })}
    </div>
  );
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
    let frame = 0,
      watched: Element | null = null;
    const sizes = new ResizeObserver(() => place());
    const measure = () => {
      frame = 0;
      // A tab out of view keeps its composer, hidden by `data-shown="false"` on it or an ancestor.
      const composer =
        [...sidePanel.querySelectorAll(COMPOSERS)].find(
          (node) => !node.closest('[data-shown="false"]'),
        ) ?? null;
      if (composer !== watched) {
        if (watched) sizes.unobserve(watched);
        if (composer) sizes.observe(composer);
        watched = composer;
      }
      if (composer)
        corner.style.bottom = `${document.documentElement.clientHeight - composer.getBoundingClientRect().top + 8}px`;
      else corner.style.removeProperty("bottom");
    };
    const place = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // A Group that opens or closes adds or removes its composer, and a tab change moves `data-shown`.
    const changes = new MutationObserver(place);
    changes.observe(sidePanel, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-shown"],
    });
    window.addEventListener("resize", place);
    place();
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      sizes.disconnect();
      window.removeEventListener("resize", place);
      corner.style.removeProperty("bottom");
    };
  }, [sidePanel, corner]);
}

/**
 * A workspace member's page: its files, a page, and its Groups, at the member's level.
 * Its owner's page has the same. The list page links to both.
 */
export default function WorkspaceApp({ target }: { target: WorkspaceTarget | null }) {
  const [unsent, setUnsent] = useState<Unsent[]>(readUnsent);
  const unsentId = useRef(Math.max(0, ...unsent.map((item) => item.id)));
  const [toastSlot, setToastSlot] = useState<HTMLElement | null>(null);
  // The account confirmed signed in on this page. Kept edits show only while their own account is, so nobody at the
  // sign-in form or after a switch of account sees them. The tab keeps them until that account signs in again.
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const keep = useCallback(
    (accountId: string, path: string, text: string, discarded?: boolean) =>
      setUnsent((list) => [
        ...list,
        {
          id: ++unsentId.current,
          accountId,
          path,
          text,
          ...(discarded ? { discarded: true as const } : {}),
        },
      ]),
    [],
  );
  const discarded = (id: number, value: boolean) =>
    setUnsent((list) =>
      list.map((item) =>
        item.id !== id
          ? item
          : value
            ? { ...item, discarded: true }
            : { id: item.id, accountId: item.accountId, path: item.path, text: item.text },
      ),
    );
  const shown = unsent.filter((item) => item.accountId === signedIn);
  useEffect(() => writeUnsent(unsent), [unsent]);
  // Closing the tab loses the kept text, so the browser asks first while any remains.
  const holding = unsent.some((item) => !item.discarded);
  useEffect(() => {
    if (!holding) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [holding]);
  const kept = shown.length ? (
    <UnsentEdits
      unsent={shown}
      onDiscard={(id) => discarded(id, true)}
      onUndo={(id) => discarded(id, false)}
      onForget={(id) => setUnsent((list) => list.filter((item) => item.id !== id))}
    />
  ) : null;
  return (
    <>
      <MemberEntry
        target={target}
        onUnsent={keep}
        onAccount={setSignedIn}
        toastSlot={toastSlot}
        kept={kept}
        nameFor={(path) => shownPath(path, shown)}
      />
      {/* Toasts land at the window's bottom right. */}
      <div className="workspace-corner">
        <div className="toast-slot" ref={setToastSlot} />
      </div>
    </>
  );
}

/** Signs the person in, then opens the workspace or the list of workspaces. */
function MemberEntry({
  target,
  onUnsent,
  onAccount,
  toastSlot,
  kept,
  nameFor,
}: {
  target: WorkspaceTarget | null;
  onUnsent(accountId: string, path: string, text: string, discarded?: boolean): void;
  onAccount(id: string | null): void;
  toastSlot: HTMLElement | null;
  kept: ReactNode;
  nameFor(path: string): string;
}) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  useEffect(() => {
    if (account !== undefined) onAccount(account?.id ?? null);
  }, [account, onAccount]);
  const [pending, setPending] = useState<"account" | "sign-in" | "sign-out" | null>(
    target ? "account" : null,
  );
  const targetKey = target && JSON.stringify(target);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const start = (work: "account" | "sign-in" | "sign-out") => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(work);
    setError(null);
    return controller;
  };
  const current = (controller: AbortController) =>
    !controller.signal.aborted && request.current === controller;
  const check = (controller = start("account")) => {
    void namedRequest("/api/account/session", controller.signal)
      .then((value) => {
        if (current(controller)) {
          setAccount(accountUser(value));
          setPending(null);
        }
      })
      .catch(() => {
        if (current(controller)) {
          setAccount(null);
          setPending(null);
          setError(CHECK_FAILED);
        }
      });
  };
  useEffect(() => {
    if (targetKey) check();
    return () => request.current?.abort();
  }, [targetKey]);
  const signIn = (credentials: { email: string; password: string }) => {
    const controller = start("sign-in");
    void namedRequest("/api/account/sign-in", controller.signal, credentials).then(
      () => check(controller),
      (reason: unknown) => {
        if (current(controller)) {
          setPending(null);
          setError(signInErrorMessage(reason));
        }
      },
    );
  };
  const signOut = () => {
    const controller = start("sign-out");
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(
      () => {
        if (current(controller)) {
          setAccount(null);
          setPending(null);
        }
      },
      () => {
        if (current(controller)) {
          setPending(null);
          setError(SIGN_OUT_FAILED);
        }
      },
    );
  };
  const sessionEnded = useCallback(() => {
    request.current?.abort();
    setAccount(null);
    setPending(null);
    setError(SESSION_ENDED);
  }, []);

  if (!target)
    return (
      <StatePage icon="unlink" title="This workspace link isn't valid.">
        <p>
          Open it again from your invitation or <a href={WORKSPACES_PATH}>your workspaces</a>.
        </p>
      </StatePage>
    );
  if (account === undefined)
    return target.kind === "list" ? <WorkspacesOpening /> : <WorkspaceOpening />;
  const hint =
    error === SESSION_ENDED
      ? SESSION_ENDED
      : target.kind === "member"
        ? "Use the account the owner invited."
        : target.kind === "owner"
          ? "Use the account that owns this workspace."
          : null;
  if (!account)
    return (
      <div className="state-page join-page">
        <span className="bar-mark">
          <DohcMark />
        </span>
        <main className="state">
          <div className="state-message">
            <span className="tile">
              <Icon name="users" size={20} />
            </span>
            <h1>
              {target.kind === "list"
                ? "Sign in to see your workspaces"
                : "Sign in to open this workspace"}
            </h1>
            {hint && <p>{hint}</p>}
            <SignInForm
              busy={pending !== null}
              error={error === SESSION_ENDED || error === CHECK_FAILED ? null : error}
              onSignIn={signIn}
            />
            {target.kind === "list" && (
              <p className="join-aside">
                New to dohc? <a href={SIGN_UP}>Create an account</a>
              </p>
            )}
            {error === CHECK_FAILED && (
              <p className="join-error" role="alert">
                {CHECK_FAILED}{" "}
                <button
                  className="join-link"
                  type="button"
                  disabled={pending !== null}
                  onClick={() => check()}
                >
                  Try again
                </button>
              </p>
            )}
          </div>
        </main>
      </div>
    );
  if (target.kind === "list")
    return (
      <WorkspaceList
        account={account}
        signingOut={pending === "sign-out"}
        signOutError={error === SIGN_OUT_FAILED ? error : null}
        onSignOut={signOut}
        onSessionEnded={sessionEnded}
      />
    );
  return (
    <MemberWorkspace
      key={`${account.id}\n${targetKey}`}
      target={target}
      account={account}
      signingOut={pending === "sign-out"}
      signOutError={error === SIGN_OUT_FAILED ? error : null}
      onSignOut={signOut}
      onSessionEnded={sessionEnded}
      onUnsent={(path, text, discarded) => onUnsent(account.id, path, text, discarded)}
      toastSlot={toastSlot}
      kept={kept}
      nameFor={nameFor}
    />
  );
}

/**
 * The workspace's files from the view routes, kept current by one held log read at a time.
 * `failures` counts the reads in a row that failed since the files last caught up, and `retry` reads again at once.
 * `recheck` reads the current files again at once, as when a file or Group the page shows has gone.
 * A refused read of the files ends the membership only once the grant's own read is refused too,
 * and the account's session still names `accountId`.
 */
function useMemberFiles(
  session: string,
  accountId: string,
  attempt: number,
  onSignedOut: () => void,
) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [failures, setFailures] = useState(0);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;
  // Ends the current read or wait. With `reload`, the next step reads the current files.
  const interrupt = useRef<((reload: boolean) => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController(),
      { signal } = controller;
    const current = async (step: AbortSignal): Promise<Files> => {
      const loaded = await loadCurrentState(session, step);
      return { ...loaded, files: filesFromAccumulator(loaded.fileAccumulator) };
    };
    // The file list can fail while the grant still opens, as when a rule change lands between two reads.
    // A refused grant may only mean that the account signed out, or that another account signed in.
    const confirm = async (): Promise<Confirmed> => {
      try {
        return { open: await loadMeta(session, signal) };
      } catch (error) {
        if (!refusedStatus(error)) return "failed";
      }
      try {
        const user = accountUser(await namedRequest("/api/account/session", signal));
        if (user === null) return "signed-out";
        return user.id === accountId ? "ended" : { other: user.name };
      } catch {
        return "failed";
      }
    };
    // Shows what a confirmed refusal says, and returns false when the files may still open.
    const refused = (confirmed: Confirmed, status: "refused" | "ended") => {
      if (confirmed === "failed" || (typeof confirmed === "object" && "open" in confirmed))
        return false;
      if (confirmed === "signed-out") signedOut.current();
      else if (confirmed === "ended") setView({ status });
      else setView({ status: "other-account", name: confirmed.other });
      return true;
    };
    setView({ status: "loading" });
    setFailures(0);
    void (async () => {
      let files: Files;
      try {
        files = await current(signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof TooManyFilesError) setView({ status: "too-large" });
        else if (error instanceof VersionMismatchError) setView({ status: "version-mismatch" });
        else if (!refusedStatus(error)) setView({ status: "load-failed" });
        else {
          const confirmed = await confirm();
          if (!signal.aborted && !refused(confirmed, "refused")) setView({ status: "load-failed" });
        }
        return;
      }
      if (signal.aborted) return;
      setView({ status: "ready", files });
      let delay = RETRY_INITIAL_MS,
        reload = false,
        // The level or a rule changed, so the files shown carry levels the member no longer has.
        stale = false,
        // After a failure the server answers at once, so the files show they caught up as soon as they do.
        held = true;
      while (!signal.aborted) {
        const step = new AbortController(),
          stepSignal = AbortSignal.any([signal, step.signal]);
        const stop = (again: boolean) => {
          reload ||= again;
          step.abort();
        };
        interrupt.current = stop;
        const reading: boolean = reload;
        reload = false;
        const started = Date.now(),
          previous = files.nextCursor;
        try {
          if (reading) files = await current(stepSignal);
          else {
            const log = await loadLog(
              session,
              files.nextCursor,
              new Map(files.fileAccumulator),
              MAX_LOG_PAGES,
              stepSignal,
              files.epochLogFloor,
              held ? VIEW_LOG_HOLD_MS : undefined,
              files.meta.access !== "edit",
            );
            const meta = await loadMeta(session, stepSignal);
            const next = {
              ...files,
              ...log,
              meta,
              files: filesFromAccumulator(log.fileAccumulator),
            };
            // A rule changed since the files were read, so the log's cursor may skip files that just became visible.
            // A file at a new path has no level yet. Either way the current files say.
            stale ||= meta.reach !== files.meta.reach;
            if (stale || next.files.some((file) => !files.levels.has(file.path))) {
              reload = true;
              continue;
            }
            files = next;
          }
          setView({ status: "ready", files });
          stale = false;
          setFailures(0);
          delay = RETRY_INITIAL_MS;
          const elapsed = Date.now() - started,
            waited = held;
          held = true;
          if (!reading && waited && files.nextCursor === previous && elapsed < VIEW_LOG_HOLD_MS)
            await waitForRetry(VIEW_LOG_HOLD_MS - elapsed, stepSignal).catch(() => {});
        } catch (error) {
          if (signal.aborted) return;
          // Try again ends a read of the current files only to start another.
          if (step.signal.aborted) {
            reload ||= reading;
            continue;
          }
          if (error instanceof VersionMismatchError) {
            setView({ status: "version-mismatch" });
            return;
          }
          if (error instanceof TooManyFilesError) {
            setView({ status: "too-large" });
            return;
          }
          let granted: ViewMeta | undefined;
          if (reading && refusedStatus(error)) {
            const confirmed = await confirm();
            if (signal.aborted || refused(confirmed, "ended")) return;
            if (typeof confirmed === "object" && "open" in confirmed) granted = confirmed.open;
          }
          // Any failed read may hide a level change. The grant says, when it answers.
          if (!stale) {
            granted ??= await loadMeta(session, stepSignal).catch(() => undefined);
            if (signal.aborted) return;
            stale = granted !== undefined && granted.reach !== files.meta.reach;
          }
          // A new epoch starts again from the current files. So do a refusal and a level change: a rule change
          // refuses a held read as a lost membership does, and only a refused read of the current files ends the membership.
          if (
            !reading &&
            (stale || error instanceof EpochFloorChangedError || refusedStatus(error))
          ) {
            reload = true;
            continue;
          }
          // The current files could not load at the new level.
          if (stale) {
            setView({ status: "load-failed" });
            return;
          }
          reload = reading;
          setFailures((count) => count + 1);
          held = false;
          // Try again ends the wait at once.
          await waitForRetry(delay, stepSignal).catch(() => {});
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        } finally {
          if (interrupt.current === stop) interrupt.current = null;
        }
      }
    })();
    return () => controller.abort();
  }, [session, accountId, attempt]);
  return {
    view,
    failures,
    retry: useCallback(() => interrupt.current?.(false), []),
    recheck: useCallback(() => interrupt.current?.(true), []),
  };
}

// The workspace's shape while it loads: its files, the page and the side panel, or on a phone the page's header, the page and the tabs.
function WorkspaceOpening() {
  return (
    <div className="viewer link-page workspace-page workspace-opening" aria-busy="true">
      <div className="workspace-opening-files" aria-hidden="true">
        <span className="bar-mark">
          <DohcMark />
        </span>
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="workspace-opening-page" aria-hidden="true">
        <div className="workspace-opening-head">
          <span className="bar-mark">
            <DohcMark />
          </span>
          <i />
        </div>
        <div className="skeleton">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="workspace-opening-side" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="workspace-opening-tabs" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <p className="sr-only">Opening the workspace</p>
    </div>
  );
}

function MemberWorkspace({
  target,
  account,
  signingOut,
  signOutError,
  onSignOut,
  onSessionEnded,
  onUnsent,
  toastSlot,
  kept,
  nameFor,
}: {
  target: Exclude<WorkspaceTarget, { kind: "list" }>;
  account: Account;
  signingOut: boolean;
  signOutError: string | null;
  onSignOut(): void;
  onSessionEnded(): void;
  onUnsent(path: string, text: string, discarded?: boolean): void;
  toastSlot: HTMLElement | null;
  kept: ReactNode;
  // The open page's row is named as the kept rows name theirs, so two of the same name read apart.
  nameFor(path: string): string;
}) {
  const session = viewSession(target);
  // The owner's page reads, posts and edits as a member's does. The owner edits every page.
  const owner = target.kind === "owner",
    grantId = target.kind === "member" ? target.grantId : null;
  const place = String(
    new URLSearchParams(owner ? { workspaceId: target.workspaceId } : { grantId: grantId ?? "" }),
  );
  const [attempt, setAttempt] = useState(0);
  const {
    view,
    failures,
    retry: retryFiles,
    recheck: recheckFiles,
  } = useMemberFiles(session, account.id, attempt, onSessionEnded);
  // A toast closed while the reads still fail stays closed until the files catch up.
  const [behindDismissed, setBehindDismissed] = useState(false);
  useEffect(() => {
    if (failures === 0) setBehindDismissed(false);
  }, [failures]);
  const [selectedPath, setSelectedPath] = useState("");
  const [tab, setTab] = useState<Tab>("page"),
    [side, setSide] = useState<Side>("chats"),
    [unread, setUnread] = useState(0);
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  const [bandSlot, setBandSlot] = useState<HTMLElement | null>(null);
  // The open page's unsent edits, while dohc cannot send them, sit under the kept ones, just above the page.
  const [draftSlot, setDraftSlot] = useState<HTMLElement | null>(null);
  const leave = useRef<((action: () => void) => void) | null>(null),
    tabs = useRef(new Map<Tab, HTMLButtonElement>());
  const narrow = useNarrow();
  const [sideNode, setSideNode] = useState<HTMLDivElement | null>(null);
  useCornerAboveComposer(narrow ? sideNode : null, toastSlot?.parentElement ?? null);
  const files = view.status === "ready" ? view.files : null;
  const name = files?.meta.subjectName ?? (owner ? "Unnamed workspace" : "Shared workspace");
  // An ended membership reads nothing more, so its page names the workspace as it was last read.
  const lastName = useRef<string | null>(null);
  if (files?.meta.subjectName) lastName.current = files.meta.subjectName;
  useEffect(() => {
    document.title = files ? `${name} · dohc` : "Shared with dohc";
  }, [files !== null, name]);
  useEffect(() => {
    if (!files) return;
    setSelectedPath((path) =>
      files.files.some((file) => file.path === path) ? path : (files.files[0]?.path ?? ""),
    );
  }, [files]);
  const listing = useMemberListing(view.status === "ready" ? place : null, account.id, (reason) =>
      placeGone(reason),
    ),
    { refresh: refreshListing } = listing;
  // The relay answers 404 for one file or Group the member no longer reaches, as for a lost membership.
  // Reading the files and Groups again tells the two apart: only a refused read of the files ends the membership.
  const placeGone = (reason: Ended) => {
    if (reason === "signed-out") return onSessionEnded();
    recheckFiles();
    refreshListing();
  };
  // A file's Comments that went away open again once the files read again still list the file.
  const commentsGone = useRef(false),
    [commentsRead, setCommentsRead] = useState(0);
  useEffect(() => {
    if (!files || !commentsGone.current) return;
    commentsGone.current = false;
    setCommentsRead((count) => count + 1);
  }, [files]);
  // A changed reach can change a Group's level or hide it, so it reads the Groups again at once.
  // The first reach that arrives needs no second read: the Groups' first read starts with it.
  const reach = files?.meta.reach,
    readReach = useRef(reach);
  useEffect(() => {
    const before = readReach.current;
    readReach.current = reach;
    if (before !== undefined && reach !== undefined && before !== reach) refreshListing();
  }, [reach, refreshListing]);
  // Groups and Comments share one read, so one toast reports it. Each failure raises it again.
  const [listingDismissed, setListingDismissed] = useState(false);
  useEffect(() => {
    if (listing.found === "failed") setListingDismissed(false);
  }, [listing.found]);
  const signOut = () => (leave.current ?? ((action) => action()))(onSignOut);
  // A file whose text is gone has changed. The follow brings its new text; this says whether to wait for it.
  const refreshStale = useCallback(
    async (path: string, blobSha256: string) => {
      try {
        const file = filesFromAccumulator((await loadCurrentState(session)).fileAccumulator).find(
          (item) => item.path === path,
        );
        return file === undefined || file.blobSha256 !== blobSha256;
      } catch {
        return false;
      }
    },
    [session],
  );
  // A level the owner or an admin changes while the page is open says so in a toast. The page has no Notices list to keep it.
  const access = files?.meta.access,
    changedBy = useRef(files?.meta.levelChangedBy);
  changedBy.current = files?.meta.levelChangedBy;
  const shownAccess = useRef(access);
  const [levelNote, setLevelNote] = useState<{ words: string; lower: boolean } | null>(null);
  useEffect(() => {
    const before = shownAccess.current;
    shownAccess.current = access;
    if (!access || !before || before === access) return;
    setLevelNote({
      words: levelChangedWords(access, changedBy.current),
      lower: LEVEL_RANK[access] < LEVEL_RANK[before],
    });
  }, [access]);

  // An owner's workspace does not end as a membership does. Its refusal says which account owns it.
  if (view.status === "ended" && !owner)
    return (
      <StatePage
        icon="unlink"
        title={
          lastName.current
            ? `Your membership in ${lastName.current} ended.`
            : "Your membership ended."
        }
      >
        <p>Ask the owner to invite you again to keep working in it.</p>
        {/* The one step a browser can take here: another account the owner invited. */}
        <p className="join-aside">
          Signed in as <span className="join-name">{account.name}</span> ·{" "}
          <button className="join-link" type="button" disabled={signingOut} onClick={onSignOut}>
            Sign out
          </button>
        </p>
        {signOutError && <LaunchFailure role="alert" message={signOutError} />}
        {kept}
      </StatePage>
    );
  if (view.status === "other-account")
    return (
      <StatePage icon="users" title={`This browser is now signed in as ${view.name}.`}>
        <p>
          Sign in as {account.name} to keep working in {lastName.current ?? "this workspace"}.
        </p>
        <button
          className="handoff-button secondary"
          type="button"
          disabled={signingOut}
          onClick={onSignOut}
        >
          {signingOut ? "Signing out…" : "Switch account"}
        </button>
        {/* The browser now names another account, so it shows none of this one's kept edits. */}
        {signOutError && <LaunchFailure role="alert" message={SWITCH_FAILED} />}
      </StatePage>
    );
  if (view.status === "too-large")
    return (
      <StatePage icon="info" title="This workspace is too large to open in a browser.">
        <p>Open it in the dohc desktop app.</p>
        {kept}
      </StatePage>
    );
  if (view.status === "refused" || view.status === "ended")
    return (
      <StatePage icon="unlink" title="dohc could not open this workspace with this account.">
        <p>
          This browser is signed in as {account.name}.{" "}
          {owner
            ? "Switch to the account that owns this workspace."
            : "Ask the owner to invite this account, or switch to another."}
        </p>
        <button
          className="handoff-button secondary"
          type="button"
          disabled={signingOut}
          onClick={onSignOut}
        >
          {signingOut ? "Signing out…" : "Switch account"}
        </button>
        {signOutError && <LaunchFailure role="alert" message={SWITCH_FAILED} />}
        {kept}
      </StatePage>
    );
  if (view.status === "load-failed")
    return (
      <StatePage icon="alert" failed title="dohc could not open this workspace.">
        <p>Check your connection, then choose Try again.</p>
        <button
          className="handoff-button secondary"
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
        {kept}
      </StatePage>
    );
  if (view.status === "version-mismatch")
    return (
      <StatePage icon="refresh" title="This page does not match its server.">
        <p>Reload it to get the version the server expects.</p>
        <button
          className="handoff-button secondary"
          type="button"
          onClick={() => location.reload()}
        >
          Reload
        </button>
        {kept}
      </StatePage>
    );
  if (!files) return <WorkspaceOpening />;

  const selected = files.files.find((file) => file.path === selectedPath) ?? files.files[0];
  const tree = fileTree(files.files);
  const segments = selected?.path.split("/") ?? [];
  // The open file's own level. A file whose level hasn't arrived offers nothing the relay might refuse.
  const level = selected ? (files.levels.get(selected.path) ?? "view") : files.meta.access;
  const live =
    (owner || level === "edit") &&
    selected !== undefined &&
    selected.contentKind === "text" &&
    isMarkdown(selected.path);
  const choose = (path: string) => {
    const go = () => {
      setSelectedPath(path);
      if (narrow) setTab("page");
    };
    if (path === selected?.path) go();
    else (leave.current ?? ((action) => action()))(go);
  };
  const readView = selected ? (
    <FileView
      key={`${selected.path}\n${selected.blobSha256}`}
      session={session}
      file={selected}
      files={files.files}
      onSelect={choose}
      onStaleBlob={refreshStale}
    />
  ) : null;
  const shownTab = narrow ? tab : null;
  const panel = (id: Tab) =>
    narrow
      ? {
          role: "tabpanel",
          "aria-labelledby": `workspace-tab-${id}`,
          inert: tab !== id,
          "data-shown": tab === id,
        }
      : {};
  // What shows beside the page: on a phone, the tab when it is Comments or Chats.
  const showing: Side | null = narrow ? (tab === "comments" || tab === "chats" ? tab : null) : side;
  const sidePanel = (id: Side) => ({
    role: "tabpanel",
    "aria-labelledby": narrow ? `workspace-tab-${id}` : `side-tab-${id}`,
    inert: showing !== id,
    "data-shown": showing === id,
  });
  const moveTab =
    <T extends Tab>(list: { id: T }[], current: T, choose: (id: T) => void) =>
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = list.findIndex((item) => item.id === current);
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % list.length
          : event.key === "ArrowLeft"
            ? (index + list.length - 1) % list.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? list.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      choose(list[next]!.id);
      tabs.current.get(list[next]!.id)?.focus();
    };
  const tabLabel = (item: { id: Tab; label: string }) => (
    <>
      {item.label}
      {item.id === "chats" && unread > 0 && (
        <span className="unread-count">
          {unread}
          <span className="sr-only"> unread</span>
        </span>
      )}
    </>
  );

  return (
    <div className="viewer link-page workspace-page" data-tab={shownTab ?? undefined}>
      <nav id="workspace-files" aria-label="Workspace files" {...panel("files")}>
        <div className="workspace-title">
          <span className="bar-mark">
            <DohcMark />
          </span>
          <h1 className="workspace-name">{name}</h1>
          <a
            className="icon-button workspace-all"
            href={WORKSPACES_PATH}
            aria-label="All workspaces"
            title="All workspaces"
          >
            <Icon name="grid" size={16} />
          </a>
        </div>
        {files.files.length ? (
          <FileTree
            tree={tree}
            label="Workspace files"
            selected={selected?.path ?? ""}
            onSelect={(file) => choose(file.path)}
          />
        ) : (
          <p className="workspace-empty">No files in this workspace yet.</p>
        )}
        <div className="workspace-account">
          <span title={account.name}>{account.name}</span>
          <button
            className="handoff-button secondary"
            type="button"
            disabled={signingOut}
            onClick={signOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutError && <p role="alert">{signOutError}</p>}
        </div>
      </nav>
      <div className="page" id="workspace-main" {...panel("page")}>
        <header>
          <div className="bar-left">
            <span className="bar-mark narrow-mark">
              <DohcMark />
            </span>
            {selected && (
              <div className="crumbs">
                {segments.slice(0, -1).map((folder, index) => (
                  <span key={index}>{folder}</span>
                ))}
                <b>{segments.at(-1)}</b>
              </div>
            )}
          </div>
          <div className="header-actions">
            <div className="workspace-status" ref={setStatusSlot} />
            {failures > 0 && (
              <span className="workspace-dated" title={DATED_TITLE}>
                <Icon name="clock" size={12} />
                {DATED}
              </span>
            )}
            <span className="badge">{owner ? "Owner" : BADGE[level]}</span>
          </div>
        </header>
        <div className="page-band" ref={setBandSlot} />
        {kept}
        <div className="workspace-kept" ref={setDraftSlot} />
        <div className="layout">
          <div className="scroller">
            <div className="column">
              {selected ? (
                <>
                  <h1 className="page-title">{fileTitle(selected.path)}</h1>
                  <main className="content">
                    {live ? (
                      <Suspense fallback={readView}>
                        <MemberLivePage
                          key={selected.path}
                          target={
                            owner ? { workspaceId: target.workspaceId } : { grantId: grantId! }
                          }
                          accountId={account.id}
                          path={selected.path}
                          draftName={nameFor(selected.path)}
                          readView={readView}
                          statusSlot={statusSlot}
                          bandSlot={bandSlot}
                          draftSlot={draftSlot}
                          toastSlot={toastSlot}
                          leave={leave}
                          onUnsent={(text, discarded) => onUnsent(selected.path, text, discarded)}
                        />
                      </Suspense>
                    ) : (
                      readView
                    )}
                  </main>
                </>
              ) : (
                <div className="empty-state">
                  <p>
                    No files in this workspace yet. This page shows them as soon as they arrive.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div
        className="side-panel workspace-side"
        ref={setSideNode}
        {...(narrow ? { inert: showing === null, "data-shown": showing !== null } : {})}
      >
        {!narrow && (
          <div
            className="side-tabs"
            role="tablist"
            aria-label="Beside the page"
            onKeyDown={moveTab(SIDES, side, setSide)}
          >
            {SIDES.map((item) => (
              <button
                key={item.id}
                ref={(node) => {
                  if (node) tabs.current.set(item.id, node);
                }}
                id={`side-tab-${item.id}`}
                role="tab"
                type="button"
                aria-selected={side === item.id}
                aria-controls={item.panel}
                tabIndex={side === item.id ? 0 : -1}
                onClick={() => setSide(item.id)}
              >
                {tabLabel(item)}
              </button>
            ))}
          </div>
        )}
        <div className="side-stack">
          <div id="workspace-comments" {...sidePanel("comments")}>
            {showing === "comments" &&
              (selected ? (
                <MemberComments
                  key={commentsRead}
                  found={listing.found}
                  onRetry={listing.retry}
                  path={selected.path}
                  objectId={selected.objectId ?? ""}
                  access={level === "view" ? "read-only" : "read-write"}
                  onEnded={(reason) => {
                    commentsGone.current = true;
                    placeGone(reason);
                  }}
                />
              ) : (
                <p className="chat-state">No files in this workspace yet.</p>
              ))}
          </div>
          <div className="workspace-chats" id="workspace-chats" {...sidePanel("chats")}>
            <MemberChats
              found={listing.found}
              reads={listing.reads}
              onRetry={listing.retry}
              onChanged={refreshListing}
              since={files.nextCursor}
              shown={showing === "chats"}
              onEnded={placeGone}
              onUnread={setUnread}
              memberLevel={files.meta.access}
            />
          </div>
        </div>
      </div>
      {narrow && (
        <div
          className="workspace-tabs"
          role="tablist"
          aria-label="Workspace"
          onKeyDown={moveTab(TABS, tab, setTab)}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              ref={(node) => {
                if (node) tabs.current.set(item.id, node);
              }}
              id={`workspace-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={tab === item.id}
              aria-controls={item.panel}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
            >
              {tabLabel(item)}
            </button>
          ))}
        </div>
      )}
      {listing.found === "failed" &&
        !listingDismissed &&
        toastSlot &&
        createPortal(
          <Toast
            title={LISTING_FAILED}
            body={CHECK_CONNECTION}
            onRetry={listing.retry}
            onDismiss={() => setListingDismissed(true)}
          />,
          toastSlot,
        )}
      {failures >= BEHIND_REPORT_FAILURES &&
        !behindDismissed &&
        toastSlot &&
        createPortal(
          <Toast
            title={FILES_BEHIND}
            body={CHECK_CONNECTION}
            onRetry={retryFiles}
            onDismiss={() => setBehindDismissed(true)}
          />,
          toastSlot,
        )}
      {levelNote &&
        toastSlot &&
        createPortal(
          <Toast
            title={levelNote.words}
            tone={levelNote.lower ? "warning" : "success"}
            onDismiss={() => setLevelNote(null)}
          />,
          toastSlot,
        )}
    </div>
  );
}

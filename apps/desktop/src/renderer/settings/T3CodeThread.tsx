import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, Search } from "lucide-react";
import type { T3CodeConnectionState, T3CodeThreadPage } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { cornerTime } from "../relativeTime";
import { FieldError, GhostButton, PrimaryButton, RetryRow, SecondaryButton } from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

export const T3_CODE = "T3 Code";
export const T3_CODE_CANNOT_KEEP =
  "This computer cannot encrypt dohc's sign-in to T3 Code, so dohc cannot connect to T3 Code.";
const ALLOW = "Allow dohc in T3 Code";
// How long typing rests before dohc asks T3 Code for the threads it names.
const SEARCH_REST_MS = 250;

/** Whether dohc holds a sign-in to T3 Code that has not run out. */
export const t3CodeAllowed = (state: T3CodeConnectionState) =>
  state.signedInUntilMs !== null && state.signedInUntilMs > Date.now();

/** The day dohc's sign-in to T3 Code runs out, such as "Dec 13, 2026". */
export const t3CodeAllowedUntil = (untilMs: number) =>
  new Date(untilMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export type T3CodeAccess = {
  // Undefined while dohc reads it.
  state: T3CodeConnectionState | undefined;
  // Why dohc could not read it, or null.
  readError: unknown;
  retryRead: () => Promise<void>;
  // T3 Code's page is open and has not answered.
  waiting: boolean;
  // Why the last ask ended without a sign-in, when no `onFailure` took it.
  allowError: string | null;
  allow: () => Promise<void>;
  cancel: () => void;
};

/**
 * dohc's sign-in to T3 Code, and the ask that gets one on T3 Code's own page.
 * Leaving while that page waits ends the wait. A failed ask goes to
 * `onFailure` when given, else it stays in `allowError` for a dialog to show.
 */
export function useT3CodeAccess(
  onFailure?: (message: string, cause: unknown, retry: () => Promise<void>) => void,
): T3CodeAccess {
  const read = useWorkspaceQuery(useWorkspaceSession(), {
    key: "t3-code-connection",
    load: () => bridge().readT3CodeConnection({}),
  });
  const [answered, setAnswered] = useState<T3CodeConnectionState | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [allowError, setAllowError] = useState<string | null>(null);
  // An answer for a wait the person cancelled, or left, changes nothing.
  const asks = useRequestSequence();
  const open = useRef(false);
  const failed = useRef(onFailure);
  failed.current = onFailure;
  const endWait = () =>
    void bridge()
      .cancelAllowDohcInT3Code({})
      .catch(() => undefined);
  useEffect(
    () => () => {
      if (open.current) endWait();
    },
    [],
  );
  const allow = async (): Promise<void> => {
    const token = asks.next();
    open.current = true;
    setWaiting(true);
    setAllowError(null);
    try {
      const state = await bridge().allowDohcInT3Code({});
      if (!asks.isCurrent(token)) return;
      setAnswered(state);
    } catch (cause) {
      if (!asks.isCurrent(token)) return;
      const message = ipcErrorMessage(cause, "dohc could not ask T3 Code to allow it.");
      if (failed.current) failed.current(message, cause, allow);
      else setAllowError(message);
    }
    open.current = false;
    setWaiting(false);
  };
  const cancel = () => {
    if (!open.current) return;
    open.current = false;
    asks.next();
    setWaiting(false);
    endWait();
  };
  return {
    state: answered ?? read.value,
    readError: answered ? null : read.error,
    retryRead: read.retry,
    waiting,
    allowError,
    allow,
    cancel,
  };
}

/** What allowing dohc in T3 Code takes, and the button that opens T3 Code's page. */
export function T3CodeAllow(props: { access: T3CodeAccess; size?: "row" }) {
  const { access } = props;
  const errorId = useId();
  return (
    <div data-testid="t3-code-allow" className="flex flex-col gap-2 text-[12px] text-muted">
      <p className="m-0 text-[13px] text-ink">
        T3 Code asks in your browser what dohc may do there.
      </p>
      <p className="m-0">
        dohc can then message any of your threads in T3 Code that run with the mode you pick, or
        less. A thread with full access needs Full access. dohc messages only the threads you
        connect to agents.
      </p>
      <p className="m-0">If the page asks for a sign-in code:</p>
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-4">
        <li>In T3 Code, open Settings, then Sharing &amp; access, then Authorized clients.</li>
        <li>Choose Create link, then Share, then Copy code only.</li>
        <li>Paste the code on T3 Code's page.</li>
      </ol>
      {access.allowError ? (
        <FieldError id={errorId} testId="t3-code-allow-error">
          {access.allowError}
        </FieldError>
      ) : null}
      <div className="mt-1 flex min-h-8 items-center gap-2">
        {access.waiting ? (
          <>
            <span role="status" className="inline-flex items-center gap-1.5">
              <LoaderCircle size={12} aria-hidden className="animate-spin" />
              Waiting for T3 Code
            </span>
            <SecondaryButton
              size="row"
              data-testid="t3-code-allow-cancel"
              aria-label="Cancel waiting for T3 Code"
              onClick={access.cancel}
            >
              Cancel
            </SecondaryButton>
          </>
        ) : props.size === "row" ? (
          <SecondaryButton
            size="row"
            data-testid="t3-code-allow-start"
            aria-describedby={access.allowError ? errorId : undefined}
            onClick={() => void access.allow()}
          >
            {ALLOW}
          </SecondaryButton>
        ) : (
          <PrimaryButton
            data-testid="t3-code-allow-start"
            aria-describedby={access.allowError ? errorId : undefined}
            onClick={() => void access.allow()}
          >
            {ALLOW}
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

/**
 * The ask again, for a thread that runs with more than dohc was given. T3
 * Code's page takes the mode, so allowing again is how a person changes it.
 */
export function T3CodeAllowAgain(props: { access: T3CodeAccess }) {
  const { access } = props;
  const errorId = useId();
  return (
    <div data-testid="t3-code-allow-again" className="flex flex-col gap-1 text-[12px] text-muted">
      <div className="flex min-h-8 items-center gap-2">
        {access.waiting ? (
          <>
            <span role="status" className="mr-auto inline-flex items-center gap-1.5">
              <LoaderCircle size={12} aria-hidden className="animate-spin" />
              Waiting for T3 Code
            </span>
            <SecondaryButton
              size="row"
              data-testid="t3-code-allow-cancel"
              aria-label="Cancel waiting for T3 Code"
              onClick={access.cancel}
            >
              Cancel
            </SecondaryButton>
          </>
        ) : (
          <>
            <span className="mr-auto">To change what dohc may do in T3 Code, allow it again.</span>
            <SecondaryButton
              size="row"
              data-testid="t3-code-allow-again-start"
              aria-describedby={access.allowError ? errorId : undefined}
              onClick={() => void access.allow()}
            >
              Allow again
            </SecondaryButton>
          </>
        )}
      </div>
      {access.allowError ? (
        <FieldError id={errorId} testId="t3-code-allow-error">
          {access.allowError}
        </FieldError>
      ) : null}
    </div>
  );
}

export type T3CodeThreadChoice = { id: string; title: string };

const THREAD_ROW =
  "dohc-focus-row flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75";

// One page of a project's threads, newest first. Each page owns its read, so
// an answer for an older project, search or page never reaches the list.
function ThreadPage(props: {
  projectId: string;
  query: string;
  cursor: number | null;
  // The first page says when the list is empty, and holds the tab stop until a thread is picked.
  first: boolean;
  last: boolean;
  picked: string | null;
  onPick: (thread: T3CodeThreadChoice) => void;
  onMore: (cursor: number) => void;
}) {
  const { projectId, query, cursor } = props;
  const read = useWorkspaceQuery<T3CodeThreadPage>(useWorkspaceSession(), {
    key: JSON.stringify([projectId, query, cursor]),
    load: () =>
      bridge().listT3CodeThreads({
        projectId,
        ...(query ? { titleContains: query } : {}),
        ...(cursor === null ? {} : { cursor }),
      }),
  });
  if (read.error !== null)
    return (
      <RetryRow testId="t3-code-threads-retry" onRetry={() => void read.retry()}>
        {ipcErrorMessage(read.error, "dohc could not list this project's threads.")}
      </RetryRow>
    );
  if (read.value === undefined)
    return (
      <SkeletonRows
        testId="t3-code-threads-loading"
        label={props.first ? "Loading threads" : "Loading more threads"}
        rows={props.first ? 3 : 1}
        className="px-2 py-2"
      />
    );
  const { threads, nextCursor } = read.value;
  if (props.first && threads.length === 0)
    return (
      <p data-testid="t3-code-threads-empty" className="m-0 px-2 py-2 text-[13px] text-muted">
        {query ? `No threads match "${query}".` : "This project has no threads yet."}
      </p>
    );
  return (
    <>
      {threads.map((thread, index) => {
        const checked = props.picked === thread.id;
        const updated = Date.parse(thread.updatedAt);
        return (
          <button
            key={thread.id}
            type="button"
            role="radio"
            aria-checked={checked}
            data-testid="t3-code-thread"
            data-thread-id={thread.id}
            tabIndex={checked || (props.picked === null && props.first && index === 0) ? 0 : -1}
            onClick={() => props.onPick({ id: thread.id, title: thread.title })}
            className={`${THREAD_ROW} ${
              checked
                ? "bg-selected font-medium text-ink"
                : "text-muted hover:bg-hover hover:text-ink"
            }`}
          >
            <span className="min-w-0 flex-1 truncate" title={thread.title}>
              {thread.title}
            </span>
            {thread.status ? (
              <span className="shrink-0 text-[12px] font-normal text-muted">{thread.status}</span>
            ) : null}
            {Number.isNaN(updated) ? null : (
              <time
                dateTime={thread.updatedAt}
                className="shrink-0 text-[12px] font-normal text-subtle"
              >
                {cornerTime(updated)}
              </time>
            )}
          </button>
        );
      })}
      {props.last && nextCursor !== null ? (
        <GhostButton
          data-testid="t3-code-threads-more"
          className="mx-2 my-1 shrink-0 self-start"
          onClick={() => props.onMore(nextCursor)}
        >
          Show more
        </GhostButton>
      ) : null}
    </>
  );
}

/**
 * A T3 Code thread, chosen from one project's threads. A person can have
 * thousands, so the list holds a page at a time and the field finds threads
 * by title. Changing the project or the search clears the choice, so the
 * chosen thread is always one the list shows.
 */
export function T3CodeThreadPicker(props: {
  picked: string | null;
  onPick: (thread: T3CodeThreadChoice | null) => void;
  // Shown under the list, such as when Add was pressed with no thread chosen.
  error: string | null;
  searchId: string;
}) {
  const projects = useWorkspaceQuery(useWorkspaceSession(), {
    key: "t3-code-projects",
    load: () => bridge().listT3CodeProjects({}),
  });
  const [chosenProject, setChosenProject] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  // The pages loaded past the first, for the list they belong to.
  const [more, setMore] = useState<{ list: string; cursors: number[] }>({ list: "", cursors: [] });
  const projectLabel = useId();
  const threadLabel = useId();
  const errorId = useId();
  const list = useRef<HTMLDivElement>(null);
  const { onPick } = props;
  // A picker that goes away takes its choice with it. One that comes back
  // starts on the first project, where the old choice may not be listed.
  useEffect(() => () => onPick(null), [onPick]);
  useEffect(() => {
    const next = typed.trim();
    if (next === query) return;
    const timer = window.setTimeout(() => {
      setQuery(next);
      onPick(null);
    }, SEARCH_REST_MS);
    return () => window.clearTimeout(timer);
  }, [typed, query, onPick]);

  if (projects.error !== null)
    return (
      <RetryRow testId="t3-code-projects-retry" onRetry={() => void projects.retry()}>
        {ipcErrorMessage(projects.error, "dohc could not list your T3 Code projects.")}
      </RetryRow>
    );
  if (projects.value === undefined)
    return (
      <SkeletonRows
        testId="t3-code-projects-loading"
        label="Loading your T3 Code projects"
        rows={3}
      />
    );
  const all = projects.value.projects;
  const projectId = all.find((project) => project.id === chosenProject)?.id ?? all[0]?.id;
  if (projectId === undefined)
    return (
      <p data-testid="t3-code-projects-empty" className="m-0 text-[13px] text-muted">
        T3 Code has no projects yet.
      </p>
    );
  const listKey = JSON.stringify([projectId, query]);
  const cursors = more.list === listKey ? more.cursors : [];
  const pages: Array<number | null> = [null, ...cursors];

  // The arrows move the choice and the focus together, as in any radiogroup.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const at = rows.indexOf(event.target as HTMLButtonElement);
    // The arrows on Show more or Try again are not the list's.
    if (at < 0) return;
    event.preventDefault();
    const next = rows[(at + step + rows.length) % rows.length]!;
    next.click();
    next.focus();
  };

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={projectLabel} className="text-[12px] text-muted">
          Project
        </label>
        <select
          id={projectLabel}
          data-testid="t3-code-project"
          value={projectId}
          onChange={(event) => {
            setChosenProject(event.currentTarget.value);
            onPick(null);
          }}
          className="h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink focus:border-ink"
        >
          {all.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <span id={threadLabel} className="text-[12px] text-muted">
          Thread
        </span>
        <div className="relative">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"
          />
          <input
            id={props.searchId}
            type="search"
            data-testid="t3-code-thread-search"
            aria-label="Find a thread by title"
            aria-invalid={props.error ? true : undefined}
            aria-describedby={props.error ? errorId : undefined}
            value={typed}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.currentTarget.value)}
            // Enter here finds threads. It does not add the agent.
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            className="h-8 w-full rounded-md border border-line bg-bg pl-8 pr-2.5 text-[13px] text-ink focus:border-ink"
          />
        </div>
        <div
          ref={list}
          role="radiogroup"
          aria-labelledby={threadLabel}
          data-testid="t3-code-threads"
          onKeyDown={onKeyDown}
          className="flex max-h-44 flex-col overflow-y-auto rounded-lg border border-line bg-bg p-1"
        >
          {pages.map((cursor, index) => (
            <ThreadPage
              key={`${listKey}:${cursor}`}
              projectId={projectId}
              query={query}
              cursor={cursor}
              first={index === 0}
              last={index === pages.length - 1}
              picked={props.picked}
              onPick={onPick}
              onMore={(next) => setMore({ list: listKey, cursors: [...cursors, next] })}
            />
          ))}
        </div>
        {props.error ? <FieldError id={errorId}>{props.error}</FieldError> : null}
      </div>
    </>
  );
}

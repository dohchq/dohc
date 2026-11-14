import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ExternalLink, LoaderCircle, Search } from "lucide-react";
import type {
  T3CodeAccess as T3CodeMode,
  T3CodeConnectionState,
  T3CodeThreadPage,
} from "../../ipc/bridgeContract";
import { isT3CodeCannotAllowHere } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { cornerTime } from "../relativeTime";
import { FieldError, GhostButton, PrimaryButton, RetryRow, SecondaryButton } from "../ui/controls";
import { useRadioGroup } from "../ui/SegmentedControl";
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

// T3 Code's own name and words for each mode a thread runs with, from the one
// that asks the person most to the one that never asks. A person knows them
// from choosing a thread's mode in T3 Code, so dohc does not reword them.
const MODE_WORDS: Record<T3CodeMode, { name: string; line: string }> = {
  "approval-required": { name: "Supervised", line: "Ask before commands and file changes." },
  "auto-accept-edits": {
    name: "Auto-accept edits",
    line: "Auto-approve edits, ask before other actions.",
  },
  auto: {
    name: "Auto",
    line: "Supported providers approve routine actions; others still ask.",
  },
  "full-access": { name: "Full access", line: "Allow commands and edits without prompts." },
};
const MODES = (Object.keys(MODE_WORDS) as T3CodeMode[]).map((value) => ({
  value,
  label: MODE_WORDS[value].name,
  line: MODE_WORDS[value].line,
}));
// The one mode the Tab key reaches: the picked one, or the first.
const TABBABLE_MODE = '[role="radio"][tabindex="0"]';

/** T3 Code's name for a mode, such as "Full access". */
export const t3CodeModeName = (mode: T3CodeMode) => MODE_WORDS[mode].name;

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
  // The ask that has not answered: dohc making its own sign-in here, or T3
  // Code's page, open in the browser.
  asking: "here" | "page" | null;
  // Why the last ask ended without a sign-in, when no `onFailure` took it.
  allowError: string | null;
  // dohc's own sign-in code failed here, so T3 Code's page is the other way.
  failedHere: boolean;
  // Asks with a mode, which dohc signs in with here, or with null on T3
  // Code's page. Resolves true once dohc is allowed.
  allow: (mode: T3CodeMode | null) => Promise<boolean>;
  cancel: () => void;
};

/**
 * dohc's sign-in to T3 Code, and the ask that gets one: in dohc, with the mode
 * the person picked, or on T3 Code's own page. Leaving while an ask waits ends
 * it. A failed ask in dohc stays in `allowError`, beside the choice it was
 * made with. A failed ask on T3 Code's page goes to `onFailure` when given,
 * else it stays in `allowError` for a dialog to show.
 */
export function useT3CodeAccess(
  onFailure?: (message: string, cause: unknown, retry: () => Promise<void>) => void,
): T3CodeAccess {
  const session = useWorkspaceSession();
  // How many answers T3 Code has given this one's asks.
  const answers = useRef(0);
  const read = useWorkspaceQuery(session, {
    key: "t3-code-connection",
    // Each read says how many answers there were when it began.
    load: async () => {
      const after = answers.current;
      return { state: await bridge().readT3CodeConnection({}), after };
    },
  });
  // T3 Code's latest answer to an ask made here, which answer it was, and
  // the workspace the window showed then.
  const [answered, setAnswered] = useState<{
    state: T3CodeConnectionState;
    nth: number;
    session: typeof session;
  } | null>(null);
  // The answer stands over every read that began before it, however late that
  // read comes in. A read that began after it is newer, and replaces it: the
  // sign-in may have changed elsewhere, as in the Change thread dialog. In one
  // workspace a later read never began earlier, so a replaced answer stays
  // replaced. Another workspace's reads start over, so the answer ends with
  // the workspace it was given in.
  const held =
    answered !== null &&
    answered.session === session &&
    (read.value === undefined || read.value.after < answered.nth)
      ? answered.state
      : null;
  const [asking, setAsking] = useState<"here" | "page" | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  const [failedHere, setFailedHere] = useState(false);
  // An answer for a wait the person cancelled, or left, changes nothing.
  // Leaving is going away or the window showing another workspace.
  const asks = useRequestSequence([session]);
  const open = useRef(false);
  const failed = useRef(onFailure);
  failed.current = onFailure;
  const endWait = () =>
    void bridge()
      .cancelAllowDohcInT3Code({})
      .catch(() => undefined);
  useEffect(
    () => () => {
      if (!open.current) return;
      open.current = false;
      setAsking(null);
      endWait();
    },
    [session],
  );
  const allow = async (mode: T3CodeMode | null): Promise<boolean> => {
    // One ask at a time: a second press before the first answers asks nothing.
    if (open.current) return false;
    const token = asks.next();
    open.current = true;
    setAsking(mode === null ? "page" : "here");
    setAllowError(null);
    let allowed = false;
    try {
      const state = await bridge().allowDohcInT3Code({ access: mode });
      if (!asks.isCurrent(token)) return false;
      answers.current += 1;
      setAnswered({ state, nth: answers.current, session });
      setFailedHere(false);
      allowed = true;
    } catch (cause) {
      if (!asks.isCurrent(token)) return false;
      if (mode !== null) {
        // The page can do what dohc could not only when dohc's own sign-in code
        // failed. It cannot help while T3 Code is not running.
        setFailedHere(isT3CodeCannotAllowHere(cause));
        setAllowError(ipcErrorMessage(cause, "dohc could not create its sign-in in T3 Code."));
      } else {
        const message = ipcErrorMessage(cause, "dohc could not ask T3 Code to allow it.");
        const again = async () => void (await allow(null));
        if (failed.current) failed.current(message, cause, again);
        else setAllowError(message);
      }
    }
    open.current = false;
    setAsking(null);
    return allowed;
  };
  const cancel = () => {
    if (!open.current) return;
    open.current = false;
    asks.next();
    setAsking(null);
    endWait();
  };
  return {
    state: held ?? read.value?.state,
    readError: held ? null : read.error,
    retryRead: read.retry,
    asking,
    allowError,
    failedHere,
    allow,
    cancel,
  };
}

// T3 Code's page is open in the browser and has not answered.
function WaitingForT3Code(props: { onCancel: () => void; spread?: boolean }) {
  return (
    <>
      <span
        role="status"
        className={`${props.spread ? "mr-auto " : ""}inline-flex items-center gap-1.5`}
      >
        <LoaderCircle size={12} aria-hidden className="animate-spin" />
        Waiting for T3 Code
      </span>
      <SecondaryButton
        size="row"
        data-testid="t3-code-allow-cancel"
        aria-label="Cancel waiting for T3 Code"
        onClick={props.onCancel}
      >
        Cancel
      </SecondaryButton>
    </>
  );
}

// What T3 Code's page asks for when it wants a sign-in code, and where the
// person makes one in T3 Code.
function SignInCodeSteps() {
  return (
    <>
      <p className="m-0">If the page asks for a sign-in code:</p>
      <ol data-testid="t3-code-allow-steps" className="m-0 flex list-decimal flex-col gap-1 pl-4">
        <li>In T3 Code, open Settings, then Sharing &amp; access, then Authorized clients.</li>
        <li>Choose Create link, then Share, then Copy code only.</li>
        <li>Paste the code on T3 Code's page.</li>
      </ol>
    </>
  );
}

/**
 * Allowing dohc from inside dohc: the mode of the threads dohc may message,
 * and the one button that signs dohc in with it. Nothing is picked until the
 * person picks, unless dohc knows what they allowed before. A failure stays
 * here with the pick, and offers T3 Code's page as the other way.
 */
function T3CodeAllowHere(props: {
  access: T3CodeAccess;
  size?: "row" | undefined;
  // Starts keyboard focus on the choice, for a choice the person just opened.
  focus?: boolean;
  onAllowed?: () => void;
  // Leaves without asking, where the choice was opened from a button.
  onClose?: () => void;
}) {
  const { access } = props;
  const { asking } = access;
  const [picked, setPicked] = useState<T3CodeMode | null>(access.state?.access ?? null);
  // Allow was pressed with no mode picked.
  const [missing, setMissing] = useState(false);
  // T3 Code's page was opened from here, so what it asks for stays in view.
  const [usedPage, setUsedPage] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const group = useRadioGroup<T3CodeMode | "">({
    value: picked ?? "",
    options: MODES,
    onChange: (mode) => {
      if (mode === "") return;
      setPicked(mode);
      setMissing(false);
    },
  });
  const focusChoice = () => root.current?.querySelector<HTMLElement>(TABBABLE_MODE)?.focus();
  const focusAtFirst = useRef(props.focus === true);
  useLayoutEffect(() => {
    if (focusAtFirst.current) root.current?.querySelector<HTMLElement>(TABBABLE_MODE)?.focus();
  }, []);
  // A failure leaves focus on the button that asks again, unless the person
  // moved it elsewhere while dohc asked.
  const shownError = useRef(access.allowError);
  useLayoutEffect(() => {
    if (access.allowError === shownError.current) return;
    shownError.current = access.allowError;
    if (access.allowError === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body || root.current?.contains(active))
      start.current?.focus();
  }, [access.allowError]);

  const allowHere = async () => {
    if (picked === null) {
      setMissing(true);
      focusChoice();
      return;
    }
    if (await access.allow(picked)) props.onAllowed?.();
  };
  const allowOnPage = async () => {
    setUsedPage(true);
    if (await access.allow(null)) props.onAllowed?.();
  };

  const errorId = `${id}-error`;
  const missingId = `${id}-missing`;
  const startProps = {
    ref: start,
    "data-testid": "t3-code-allow-start",
    "aria-describedby": access.allowError ? errorId : undefined,
    disabled: asking !== null,
    onClick: () => void allowHere(),
    children:
      asking === "here"
        ? "Allowing…"
        : picked === null
          ? ALLOW
          : `Allow with ${t3CodeModeName(picked)}`,
  };
  return (
    <div ref={root} data-testid="t3-code-allow-here" className="flex flex-col gap-3">
      {props.onClose ? (
        // T3 Code gives dohc no way to end a sign-in, so allowing again leaves the old one there.
        <p data-testid="t3-code-allow-earlier" className="m-0">
          The sign-in dohc has now stays in T3 Code's Authorized clients until it runs out. You can
          revoke it there.
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <p id={`${id}-label`} className="m-0">
          Pick the mode of the thread you want to connect, or more.
        </p>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-describedby={missing ? missingId : undefined}
          aria-invalid={missing ? true : undefined}
          data-testid="t3-code-allow-modes"
          // The choice holds still while dohc asks with it.
          inert={asking !== null}
          onKeyDown={group.onKeyDown}
          className="-mx-2 flex flex-col gap-0.5"
        >
          {MODES.map((mode, index) => {
            const checked = picked === mode.value;
            return (
              <button
                key={mode.value}
                {...group.radio(index)}
                data-testid={`t3-code-allow-mode-${mode.value}`}
                aria-labelledby={`${id}-${mode.value}`}
                aria-describedby={`${id}-${mode.value}-line`}
                className={`grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-75 ${
                  checked ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink"
                }`}
              >
                <span
                  aria-hidden
                  className={`grid size-3.5 place-items-center rounded-full border-[1.5px] ${
                    checked ? "border-accent" : "border-subtle"
                  }`}
                >
                  {checked ? <span className="size-1.5 rounded-full bg-accent" /> : null}
                </span>
                <span id={`${id}-${mode.value}`}>{mode.label}</span>
                <span
                  id={`${id}-${mode.value}-line`}
                  className="col-start-2 text-[12px] text-muted"
                >
                  {mode.line}
                </span>
              </button>
            );
          })}
        </div>
        {picked === "full-access" ? (
          <p data-testid="t3-code-allow-full-access" className="m-0">
            With Full access, the sign-in can also change T3 Code's settings and write to source
            control.
          </p>
        ) : null}
        {missing ? (
          <FieldError id={missingId} testId="t3-code-allow-mode-missing">
            Pick a mode.
          </FieldError>
        ) : null}
      </div>
      {usedPage ? (
        <div className="flex flex-col gap-2">
          <p className="m-0">T3 Code asks in your browser what dohc may do there.</p>
          <SignInCodeSteps />
        </div>
      ) : null}
      {access.allowError ? (
        <FieldError id={errorId} testId="t3-code-allow-error">
          {access.allowError}
        </FieldError>
      ) : null}
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        {asking === "page" ? (
          <WaitingForT3Code onCancel={access.cancel} />
        ) : (
          <>
            {props.size === "row" ? (
              <SecondaryButton size="row" {...startProps} />
            ) : (
              <PrimaryButton {...startProps} />
            )}
            {access.failedHere ? (
              <SecondaryButton
                size={props.size === "row" ? "row" : "default"}
                data-testid="t3-code-allow-on-page"
                disabled={asking !== null}
                onClick={() => void allowOnPage()}
                className="inline-flex items-center gap-1"
              >
                <ExternalLink size={12} aria-hidden />
                Allow on T3 Code's page
              </SecondaryButton>
            ) : null}
            {props.onClose ? (
              <SecondaryButton
                size="row"
                data-testid="t3-code-allow-close"
                disabled={asking !== null}
                onClick={props.onClose}
              >
                Cancel
              </SecondaryButton>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What allowing dohc in T3 Code takes. Where dohc can make its own sign-in,
 * the person picks a mode and allows it here. Elsewhere the button opens T3
 * Code's page, and the steps say what that page asks for.
 */
export function T3CodeAllow(props: { access: T3CodeAccess; size?: "row" }) {
  const { access } = props;
  const errorId = useId();
  if (access.state?.canAllowHere)
    return (
      <div data-testid="t3-code-allow" className="flex flex-col gap-3 text-[12px] text-muted">
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[13px] text-ink">dohc creates its own sign-in in T3 Code.</p>
          <p className="m-0">
            With it, dohc can read and message any of your threads there that run with the mode you
            pick, or less. dohc lists your threads so you can pick one. It reads and messages only
            the threads you connect to agents.
          </p>
        </div>
        <T3CodeAllowHere access={access} size={props.size} />
      </div>
    );
  return (
    <div data-testid="t3-code-allow" className="flex flex-col gap-2 text-[12px] text-muted">
      <p className="m-0 text-[13px] text-ink">
        T3 Code asks in your browser what dohc may do there.
      </p>
      <p className="m-0">
        dohc can then read and message any of your threads in T3 Code that run with the mode you
        pick, or less. A thread with full access needs Full access. dohc lists your threads so you
        can pick one. It reads and messages only the threads you connect to agents.
      </p>
      <SignInCodeSteps />
      {access.allowError ? (
        <FieldError id={errorId} testId="t3-code-allow-error">
          {access.allowError}
        </FieldError>
      ) : null}
      <div className="mt-1 flex min-h-8 items-center gap-2">
        {access.asking === "page" ? (
          <WaitingForT3Code onCancel={access.cancel} />
        ) : props.size === "row" ? (
          <SecondaryButton
            size="row"
            data-testid="t3-code-allow-start"
            aria-describedby={access.allowError ? errorId : undefined}
            onClick={() => void access.allow(null)}
          >
            {ALLOW}
          </SecondaryButton>
        ) : (
          <PrimaryButton
            data-testid="t3-code-allow-start"
            aria-describedby={access.allowError ? errorId : undefined}
            onClick={() => void access.allow(null)}
          >
            {ALLOW}
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

/**
 * The ask again, which changes what dohc may do in T3 Code, such as for a
 * thread that runs with more than dohc was given. Where dohc can make its own
 * sign-in, the button opens the choice of mode in place, on the mode dohc has
 * now. Elsewhere it opens T3 Code's page, which takes the mode.
 */
export function T3CodeAllowAgain(props: { access: T3CodeAccess }) {
  const { access } = props;
  const errorId = useId();
  const here = access.state?.canAllowHere === true;
  const [choosing, setChoosing] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  // Closing the choice returns focus to the button that opened it.
  const closed = useRef(false);
  useLayoutEffect(() => {
    if (choosing || !closed.current) return;
    closed.current = false;
    opener.current?.focus();
  }, [choosing]);
  const close = () => {
    closed.current = true;
    setChoosing(false);
  };
  if (here && choosing)
    return (
      <div data-testid="t3-code-allow-again" className="py-1.5 text-[12px] text-muted">
        <T3CodeAllowHere access={access} size="row" focus onAllowed={close} onClose={close} />
      </div>
    );
  return (
    <div data-testid="t3-code-allow-again" className="flex flex-col gap-1 text-[12px] text-muted">
      <div className="flex min-h-8 items-center gap-2">
        {access.asking === "page" ? (
          <WaitingForT3Code spread onCancel={access.cancel} />
        ) : (
          <>
            <span className="mr-auto">To change what dohc may do in T3 Code, allow it again.</span>
            <SecondaryButton
              ref={opener}
              size="row"
              data-testid="t3-code-allow-again-start"
              aria-describedby={access.allowError ? errorId : undefined}
              onClick={() => (here ? setChoosing(true) : void access.allow(null))}
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
          // The list is about to be replaced by what the field now says. A
          // thread picked from it in that moment would be dropped with it.
          inert={typed.trim() !== query}
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

/**
 * The step that chooses a T3 Code thread: why dohc cannot connect to T3 Code,
 * the ask that allows dohc there, or the thread picker. `onReady` says when a
 * thread can be chosen.
 */
export function T3CodeChoice(props: {
  picked: string | null;
  onPick: (thread: T3CodeThreadChoice | null) => void;
  error: string | null;
  searchId: string;
  onReady: (ready: boolean) => void;
}) {
  const access = useT3CodeAccess();
  const { state } = access;
  const ready = state !== undefined && state.canKeep && t3CodeAllowed(state);
  const { onReady } = props;
  useEffect(() => {
    onReady(ready);
    return () => onReady(false);
  }, [onReady, ready]);
  if (access.readError !== null)
    return (
      <RetryRow testId="t3-code-access-retry" onRetry={() => void access.retryRead()}>
        {ipcErrorMessage(access.readError, "dohc could not check whether T3 Code allows it.")}
      </RetryRow>
    );
  if (state === undefined)
    return <SkeletonRows testId="t3-code-access-loading" label="Checking T3 Code" rows={2} />;
  if (!state.canKeep)
    return (
      <p data-testid="t3-code-cannot-keep" className="m-0 text-[13px] text-danger">
        {T3_CODE_CANNOT_KEEP}
      </p>
    );
  if (!ready)
    return (
      // Marked so a dialog can start its focus on the ask.
      <div data-t3-code-allow-step className="rounded-lg border border-line bg-bg px-3 py-3">
        <T3CodeAllow access={access} />
      </div>
    );
  return (
    <>
      <T3CodeThreadPicker
        picked={props.picked}
        onPick={props.onPick}
        error={props.error}
        searchId={props.searchId}
      />
      <T3CodeAllowAgain access={access} />
    </>
  );
}

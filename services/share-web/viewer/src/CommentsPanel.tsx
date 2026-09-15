import {
  normalizeShareDiscussionBody,
  normalizeShareDiscussionDisplayName,
} from "@dohc/security-contract/share-discussion";
import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  mergeDiscussionMessages,
  mergeDiscussionWindowMessages,
  parseDiscussionAppendResult,
  parseDiscussionActivity,
  parseDiscussionPage,
  parseDiscussionWriteState,
  type DeletedDiscussionMessage,
  type PublicDiscussionMessage,
  type PublicDiscussionPage,
  type ShareAccess,
} from "./model";
import {
  RETRY_BUDGET_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
} from "./retry";

const SESSION_HEADER = "x-dohc-link-session";
const DISCUSSION_ACTIVITY_HOLD_MS = 30_000;
const DISCUSSION_ACTIVITY_LIMIT = 100;
const SUBMIT_STATUS_ID = "comment-submit-status";
const NAME_HELP_ID = "comment-name-help";

type ComposerState = "syncing" | "available" | "blocked" | "paused" | "limit-reached";
type InitialLoadState = "loading" | "failed" | "ready";
type FollowerPhase = "live" | "stopped" | "recovering";
type ActivityFollowerResult = "cancelled" | "stopped";

interface SubmitIntent {
  body: string;
  claimedName?: string;
  idempotencyKey: string;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let timeoutId = 0;
    const cancel = () => {
      window.clearTimeout(timeoutId);
      reject(new Error("cancelled"));
    };
    timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function boundedRequest(
  request: () => Promise<Response>,
  shouldRetry: (response: Response) => boolean,
  retryThrownFailures: boolean,
  signal: AbortSignal,
): Promise<Response> {
  let delayMs = RETRY_INITIAL_MS;
  let waitedMs = 0;
  while (true) {
    if (signal.aborted) throw new Error("cancelled");
    try {
      const response = await request();
      if (!shouldRetry(response)) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error: unknown) {
      if (!retryThrownFailures || signal.aborted) throw error;
    }
    if (waitedMs + delayMs > RETRY_BUDGET_MS) throw new Error("refused");
    await waitForRetry(delayMs, signal);
    waitedMs += delayMs;
    delayMs = Math.min(delayMs * 2, RETRY_MAX_MS);
  }
}

function discussionRequest(
  session: string,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      [SESSION_HEADER]: session,
      ...Object.fromEntries(new Headers(init.headers)),
    },
    signal,
  });
}

async function loadDiscussionPage(
  session: string,
  cursor: string | null,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<PublicDiscussionPage> {
  const search = new URLSearchParams({ direction: "newest-first" });
  if (cursor !== null) search.set("cursor", cursor);
  const response = await boundedRequest(
    () => discussionRequest(session, `/api/view/discussion?${search}`, {}, signal),
    (candidate) => candidate.status === 429,
    false,
    signal,
  );
  if (!isCurrent()) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("cancelled");
  }
  if (!response.ok) throw new Error("refused");
  const body: unknown = await response.json();
  if (!isCurrent()) throw new Error("cancelled");
  const page = parseDiscussionPage(body, "newest-first");
  if (!page) throw new Error("refused");
  return page;
}

async function followDiscussionActivity(
  session: string,
  baselineRevision: number,
  signal: AbortSignal,
  isCurrent: () => boolean,
  apply: (activity: NonNullable<ReturnType<typeof parseDiscussionActivity>>) => boolean,
): Promise<ActivityFollowerResult> {
  let since = baselineRevision;
  let holdMs = 0;
  let retryDelayMs = RETRY_INITIAL_MS;
  while (isCurrent() && !signal.aborted) {
    const search = new URLSearchParams({
      since: String(since),
      hold: String(holdMs),
      limit: String(DISCUSSION_ACTIVITY_LIMIT),
    });
    let response: Response;
    try {
      response = await discussionRequest(
        session,
        `/api/view/discussion/activity?${search}`,
        {},
        signal,
      );
    } catch {
      if (!isCurrent() || signal.aborted) return "cancelled";
      await waitForRetry(retryDelayMs, signal).catch(() => undefined);
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
      continue;
    }
    if (!isCurrent()) {
      await response.body?.cancel().catch(() => undefined);
      return "cancelled";
    }
    if (response.status === 409 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      await waitForRetry(retryDelayMs, signal).catch(() => undefined);
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return "stopped";
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      if (!isCurrent() || signal.aborted) return "cancelled";
      if (error instanceof SyntaxError) return "stopped";
      await waitForRetry(retryDelayMs, signal).catch(() => undefined);
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
      continue;
    }
    if (!isCurrent()) return "cancelled";
    const activity = parseDiscussionActivity(body);
    if (
      !activity ||
      activity.cursorRevision < since ||
      (activity.hasMore && activity.cursorRevision === since) ||
      !apply(activity)
    ) {
      return "stopped";
    }
    since = activity.cursorRevision;
    holdMs = activity.hasMore ? 0 : DISCUSSION_ACTIVITY_HOLD_MS;
    retryDelayMs = RETRY_INITIAL_MS;
  }
  return "cancelled";
}

function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactIntent(
  previous: SubmitIntent | null,
  body: string,
  claimedName: string,
): SubmitIntent {
  const nextClaimedName = claimedName.length === 0 ? undefined : claimedName;
  if (
    previous &&
    previous.body === body &&
    previous.claimedName === nextClaimedName
  ) {
    return previous;
  }
  return {
    body,
    ...(nextClaimedName === undefined ? {} : { claimedName: nextClaimedName }),
    idempotencyKey: newIdempotencyKey(),
  };
}

function CommentRow({ message }: { message: PublicDiscussionMessage }) {
  if (message.deleted) {
    return <li className="comment-row comment-deleted">Comment deleted by the owner</li>;
  }
  return (
    <li className="comment-row">
      <p className="comment-author">
        <span>{message.author.displayName}</span>
        {message.author.kind === "link" ? <span className="unverified">Unverified</span> : null}
      </p>
      <p className="comment-body">{message.body}</p>
    </li>
  );
}

export function CommentsPanel(props: {
  access: ShareAccess;
  session: string;
  onAccessChange?: (session: string, access: ShareAccess) => void;
}) {
  const [messages, setMessages] = useState<PublicDiscussionMessage[] | null>(null);
  const [loadState, setLoadState] = useState<InitialLoadState>("loading");
  const [loadStateSession, setLoadStateSession] = useState(props.session);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [earlierCursor, setEarlierCursor] = useState<string | null>(null);
  const [earlierPending, setEarlierPending] = useState(false);
  const [earlierError, setEarlierError] = useState(false);
  const [body, setBody] = useState("");
  const [claimedName, setClaimedName] = useState("");
  const [nameLocked, setNameLocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [composerState, setComposerState] = useState<ComposerState>("syncing");
  const [submitError, setSubmitError] = useState(false);
  const [followerPhase, setFollowerPhase] = useState<FollowerPhase>("live");
  const sessionRef = useRef(props.session);
  const messagesRef = useRef<PublicDiscussionMessage[] | null>(null);
  const pageTokenRef = useRef<symbol | null>(null);
  const pageControllerRef = useRef<AbortController | null>(null);
  const earlierPendingRef = useRef(false);
  const hasEarlierHistoryRef = useRef(false);
  const seenEarlierCursorsRef = useRef(new Set<string>());
  const withheldTombstonesRef = useRef(
    new Map<string, DeletedDiscussionMessage>(),
  );
  const submitTokenRef = useRef<symbol | null>(null);
  const submitControllerRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const intentRef = useRef<SubmitIntent | null>(null);
  const composerRevisionRef = useRef(0);
  const followerPhaseRef = useRef<FollowerPhase>("live");
  const onAccessChangeRef = useRef(props.onAccessChange);
  const normalizedBody = normalizeShareDiscussionBody(body);
  const bodyInvalid = body.length > 0 && normalizedBody === null;
  const normalizedName = claimedName.length === 0
    ? null
    : normalizeShareDiscussionDisplayName(claimedName);
  const nameInvalid = normalizedName?.ok === false ? normalizedName.reason : null;
  sessionRef.current = props.session;
  onAccessChangeRef.current = props.onAccessChange;

  const adoptProfileName = (profileName: string | null) => {
    if (profileName === null) return;
    setClaimedName(profileName);
    setNameLocked(true);
  };

  const enterFollowerPhase = (phase: FollowerPhase) => {
    followerPhaseRef.current = phase;
    setFollowerPhase(phase);
  };

  const applyActivity = (
    session: string,
    activity: NonNullable<ReturnType<typeof parseDiscussionActivity>>,
    recovering: boolean,
  ): boolean => {
    if (!messagesRef.current) return false;
    let merged: PublicDiscussionMessage[] | null;
    if (hasEarlierHistoryRef.current) {
      const windowMerge = mergeDiscussionWindowMessages(
        messagesRef.current,
        activity.messages,
      );
      if (!windowMerge) return false;
      const retained = mergeDiscussionMessages(
        [...withheldTombstonesRef.current.values()],
        windowMerge.withheldTombstones,
      );
      if (!retained) return false;
      const retainedTombstones: DeletedDiscussionMessage[] = [];
      for (const message of retained) {
        if (!message.deleted) return false;
        retainedTombstones.push(message);
      }
      withheldTombstonesRef.current = new Map(
        retainedTombstones.map((message) => [message.messageId, message]),
      );
      merged = windowMerge.messages;
    } else {
      merged = mergeDiscussionMessages(messagesRef.current, activity.messages);
    }
    if (!merged) return false;
    onAccessChangeRef.current?.(session, activity.access);
    messagesRef.current = merged;
    setMessages(merged);
    const priorComposerRevision = composerRevisionRef.current;
    composerRevisionRef.current = Math.max(
      priorComposerRevision,
      activity.latestRevision,
    );
    adoptProfileName(activity.profileName);
    setComposerState((current) => {
      if (current === "limit-reached") return current;
      if (activity.latestRevision < priorComposerRevision) return current;
      return activity.composerState;
    });
    if (recovering) enterFollowerPhase("live");
    return true;
  };

  const startFollower = (
    session: string,
    baselineRevision: number,
    controller: AbortController,
    isCurrent: () => boolean,
    recovering: boolean,
  ) => {
    void followDiscussionActivity(
      session,
      baselineRevision,
      controller.signal,
      isCurrent,
      (activity) => applyActivity(session, activity, recovering),
    ).then((result) => {
      if (result === "stopped" && isCurrent()) enterFollowerPhase("stopped");
    });
  };

  useEffect(() => {
    const token = Symbol("discussion-page");
    const controller = new AbortController();
    pageControllerRef.current?.abort();
    pageControllerRef.current = controller;
    pageTokenRef.current = token;
    submitTokenRef.current = null;
    submitControllerRef.current?.abort();
    submitControllerRef.current = null;
    pendingRef.current = false;
    intentRef.current = null;
    composerRevisionRef.current = 0;
    followerPhaseRef.current = "live";
    messagesRef.current = null;
    earlierPendingRef.current = false;
    hasEarlierHistoryRef.current = false;
    seenEarlierCursorsRef.current = new Set();
    withheldTombstonesRef.current = new Map();
    setMessages(null);
    setLoadState("loading");
    setLoadStateSession(props.session);
    setEarlierCursor(null);
    setEarlierPending(false);
    setEarlierError(false);
    setBody("");
    setClaimedName("");
    setNameLocked(false);
    setPending(false);
    setComposerState("syncing");
    setSubmitError(false);
    setFollowerPhase("live");
    const isCurrent = () =>
      pageTokenRef.current === token && sessionRef.current === props.session;
    void loadDiscussionPage(props.session, null, controller.signal, isCurrent)
      .then((loaded) => {
        if (!isCurrent()) return;
        messagesRef.current = loaded.messages;
        hasEarlierHistoryRef.current = loaded.nextCursor !== null;
        setMessages(loaded.messages);
        setEarlierCursor(loaded.nextCursor);
        if (loaded.nextCursor !== null) {
          seenEarlierCursorsRef.current.add(loaded.nextCursor);
        }
        composerRevisionRef.current = loaded.activityRevision;
        setClaimedName(loaded.profileName ?? "");
        setNameLocked(loaded.profileName !== null);
        setLoadState("ready");
        startFollower(
          props.session,
          loaded.activityRevision,
          controller,
          isCurrent,
          false,
        );
      })
      .catch(() => {
        if (isCurrent() && !controller.signal.aborted) setLoadState("failed");
      });
    return () => {
      pageTokenRef.current = null;
      pageControllerRef.current?.abort();
      pageControllerRef.current = null;
      earlierPendingRef.current = false;
      submitTokenRef.current = null;
      submitControllerRef.current?.abort();
      submitControllerRef.current = null;
      pendingRef.current = false;
    };
  }, [loadAttempt, props.session]);

  const loadEarlierComments = async () => {
    const cursor = earlierCursor;
    const token = pageTokenRef.current;
    const controller = pageControllerRef.current;
    const session = props.session;
    if (
      cursor === null ||
      token === null ||
      controller === null ||
      followerPhaseRef.current !== "live" ||
      earlierPendingRef.current
    ) {
      return;
    }
    const isCurrent = () =>
      pageTokenRef.current === token &&
      sessionRef.current === session &&
      !controller.signal.aborted;
    earlierPendingRef.current = true;
    setEarlierPending(true);
    setEarlierError(false);
    try {
      const page = await loadDiscussionPage(
        session,
        cursor,
        controller.signal,
        isCurrent,
      );
      if (
        !isCurrent() ||
        followerPhaseRef.current !== "live" ||
        !messagesRef.current
      ) {
        return;
      }
      if (
        page.nextCursor !== null &&
        seenEarlierCursorsRef.current.has(page.nextCursor)
      ) {
        throw new Error("refused");
      }
      const pageIds = new Set(page.messages.map((message) => message.messageId));
      const retained = [...withheldTombstonesRef.current.values()].filter(
        (message) => pageIds.has(message.messageId),
      );
      const merged = mergeDiscussionMessages(
        page.messages,
        [...messagesRef.current, ...retained],
      );
      if (!merged) throw new Error("refused");
      if (page.nextCursor !== null) {
        seenEarlierCursorsRef.current.add(page.nextCursor);
      }
      messagesRef.current = merged;
      for (const message of retained) {
        withheldTombstonesRef.current.delete(message.messageId);
      }
      hasEarlierHistoryRef.current = page.nextCursor !== null;
      setMessages(merged);
      setEarlierCursor(page.nextCursor);
    } catch {
      if (isCurrent() && followerPhaseRef.current === "live") {
        setEarlierError(true);
      }
    } finally {
      if (isCurrent()) {
        earlierPendingRef.current = false;
        setEarlierPending(false);
      }
    }
  };

  const recoverDiscussion = () => {
    if (followerPhaseRef.current !== "stopped") return;
    const session = props.session;
    const token = Symbol("discussion-recovery");
    const controller = new AbortController();
    pageControllerRef.current?.abort();
    pageControllerRef.current = controller;
    pageTokenRef.current = token;
    enterFollowerPhase("recovering");
    const isCurrent = () =>
      pageTokenRef.current === token &&
      sessionRef.current === session &&
      !controller.signal.aborted;
    void loadDiscussionPage(session, null, controller.signal, isCurrent)
      .then((loaded) => {
        if (!isCurrent()) return;
        messagesRef.current = loaded.messages;
        hasEarlierHistoryRef.current = loaded.nextCursor !== null;
        seenEarlierCursorsRef.current = new Set(
          loaded.nextCursor === null ? [] : [loaded.nextCursor],
        );
        withheldTombstonesRef.current = new Map();
        earlierPendingRef.current = false;
        setMessages(loaded.messages);
        setEarlierCursor(loaded.nextCursor);
        setEarlierPending(false);
        setEarlierError(false);
        composerRevisionRef.current = Math.max(
          composerRevisionRef.current,
          loaded.activityRevision,
        );
        adoptProfileName(loaded.profileName);
        startFollower(
          session,
          loaded.activityRevision,
          controller,
          isCurrent,
          true,
        );
      })
      .catch(() => {
        if (isCurrent()) enterFollowerPhase("stopped");
      });
  };

  const editDraft = (field: "body" | "name", value: string) => {
    intentRef.current = null;
    setSubmitError(false);
    if (field === "body") setBody(value);
    else setClaimedName(value);
  };

  const submitComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      props.access === "view" ||
      followerPhaseRef.current !== "live" ||
      composerState !== "available" ||
      normalizedBody === null ||
      nameInvalid !== null ||
      pendingRef.current
    ) {
      return;
    }
    const intent = exactIntent(
      intentRef.current,
      normalizedBody,
      normalizedName?.ok === true ? normalizedName.value : "",
    );
    intentRef.current = intent;
    const token = Symbol("discussion-submit");
    const session = props.session;
    const controller = new AbortController();
    submitTokenRef.current = token;
    submitControllerRef.current?.abort();
    submitControllerRef.current = controller;
    pendingRef.current = true;
    setPending(true);

    const isCurrent = () =>
      submitTokenRef.current === token && sessionRef.current === session;
    try {
      const serialized = JSON.stringify({
        body: intent.body,
        idempotencyKey: intent.idempotencyKey,
        ...(intent.claimedName === undefined ? {} : { claimedName: intent.claimedName }),
      });
      const response = await boundedRequest(
        () => discussionRequest(
          session,
          "/api/view/discussion",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: serialized,
          },
          controller.signal,
        ),
        (candidate) => candidate.status === 429 || candidate.status >= 500,
        true,
        controller.signal,
      );
      if (!isCurrent()) return;
      if (response.status === 403 || response.status === 413) {
        const result = await response.json();
        if (!isCurrent()) return;
        const resultState = parseDiscussionWriteState(result);
        const recognizedState =
          (response.status === 403 &&
            resultState !== null &&
            (resultState.state === "blocked" || resultState.state === "paused")) ||
          (response.status === 413 && resultState?.state === "limit-reached");
        if (recognizedState && resultState) {
          if (resultState.state === "limit-reached") {
            intentRef.current = null;
            setSubmitError(false);
            setComposerState("limit-reached");
            return;
          }
          if (resultState.activityRevision >= composerRevisionRef.current) {
            composerRevisionRef.current = Math.max(
              composerRevisionRef.current,
              resultState.activityRevision,
            );
            intentRef.current = null;
            setSubmitError(false);
            setComposerState((current) => {
              if (current === "limit-reached") return current;
              return resultState.state;
            });
          } else {
            setSubmitError(true);
          }
          return;
        }
      } else if (response.ok) {
        const result = await response.json();
        if (!isCurrent()) return;
        const acknowledgement = parseDiscussionAppendResult(result);
        const merged = acknowledgement && messagesRef.current
          ? mergeDiscussionMessages(messagesRef.current, [acknowledgement.message])
          : null;
        if (acknowledgement && merged) {
          messagesRef.current = merged;
          setMessages(merged);
          if (intent.claimedName !== undefined && acknowledgement.kind === "live") {
            setClaimedName(acknowledgement.message.author.displayName);
            setNameLocked(true);
          }
          intentRef.current = null;
          setBody("");
          setSubmitError(false);
          return;
        }
      }
      setSubmitError(true);
    } catch {
      if (isCurrent()) setSubmitError(true);
    } finally {
      if (isCurrent()) {
        submitTokenRef.current = null;
        submitControllerRef.current = null;
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  const currentLoadState = loadStateSession === props.session ? loadState : "loading";
  const disabled = pending || composerState !== "available" || followerPhase !== "live";
  const stateCopy = composerState === "blocked"
    ? "The owner turned off comments for this browser."
    : composerState === "paused"
      ? "The owner paused comments. You can still read everything."
      : composerState === "limit-reached"
        ? "You can't post more comments here. You can still read everything."
        : bodyInvalid
          ? "This comment is too long. Shorten it before posting."
          : nameInvalid === "too-long"
            ? "This name is too long. Use 40 characters or fewer."
            : nameInvalid === "empty"
              ? "This name has no visible characters. Type a name or clear the field."
              : submitError
                ? "The comment didn't post. Try again."
                : "";
  return (
    <aside className="comments-panel" aria-labelledby="comments-title">
      <h2 id="comments-title">Comments</h2>
      <p className="comments-helper">
        {props.access !== "view"
          ? "Anyone with the link can also comment. Names they give are not verified."
          : "Anyone with the link can read what you selected."}
      </p>
      {currentLoadState === "ready" && earlierCursor !== null ? (
        <div>
          {earlierError ? (
            <p className="comments-empty" role="status">Earlier comments didn't load.</p>
          ) : null}
          <div className="comment-submit-row">
            <button
              type="button"
              disabled={earlierPending || followerPhase !== "live"}
              onClick={() => void loadEarlierComments()}
            >
              Load earlier comments
            </button>
          </div>
        </div>
      ) : null}
      {currentLoadState === "loading" ? (
        <p className="comments-empty">Loading comments…</p>
      ) : currentLoadState === "failed" ? (
        <div>
          <p className="comments-empty">Comments didn't load.</p>
          <div className="comment-submit-row">
            <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              Try again
            </button>
          </div>
        </div>
      ) : messages?.length === 0 ? (
        <p className="comments-empty">No comments yet.</p>
      ) : (
        <ol className="comment-list">
          {messages?.map((message) => (
            <CommentRow key={message.messageId} message={message} />
          ))}
        </ol>
      )}
      {currentLoadState === "ready" && followerPhase !== "live" ? (
        <div>
          <p className="comment-submit-status" role="status">
            Comments stopped updating.
          </p>
          <div className="comment-submit-row">
            <button
              type="button"
              disabled={followerPhase === "recovering"}
              onClick={recoverDiscussion}
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {currentLoadState === "ready" && props.access !== "view" ? (
        <form
          className="comment-composer"
          aria-describedby={`${NAME_HELP_ID} ${SUBMIT_STATUS_ID}`}
          onSubmit={(event) => void submitComment(event)}
        >
          <label htmlFor="comment-name">Name (optional)</label>
          <input
            id="comment-name"
            name="claimedName"
            value={claimedName}
            disabled={disabled || nameLocked}
            aria-describedby={`${NAME_HELP_ID} ${SUBMIT_STATUS_ID}`}
            onChange={(event) => editDraft("name", event.currentTarget.value)}
          />
          <p id={NAME_HELP_ID} className="comments-field-help">
            Shown with your comments, marked unverified. It can't be changed later.
          </p>
          <label htmlFor="comment-body">Comment</label>
          <textarea
            id="comment-body"
            name="body"
            value={body}
            disabled={disabled}
            aria-describedby={SUBMIT_STATUS_ID}
            onChange={(event) =>
              editDraft("body", event.currentTarget.value.replaceAll("\u0000", ""))
            }
          />
          <div className="comment-submit-row">
            <button
              type="submit"
              disabled={disabled || normalizedBody === null || nameInvalid !== null}
            >
              Post comment
            </button>
          </div>
          <p id={SUBMIT_STATUS_ID} className="comment-submit-status" role="status" aria-atomic="true">
            {stateCopy}
          </p>
        </form>
      ) : null}
    </aside>
  );
}

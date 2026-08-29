import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  mergeDiscussionMessages,
  parseDiscussionAppendResult,
  parseDiscussionPage,
  parseDiscussionWriteState,
  type PublicDiscussionMessage,
  type ShareAccess,
} from "./model";
import {
  RETRY_BUDGET_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
} from "./retry";

const SESSION_HEADER = "x-dohc-link-session";
const MAX_DISCUSSION_PAGES = 100;
const SUBMIT_STATUS_ID = "comment-submit-status";
const NAME_HELP_ID = "comment-name-help";

type ComposerState = "available" | "blocked" | "paused";

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

async function loadDiscussion(
  session: string,
  signal: AbortSignal,
): Promise<PublicDiscussionMessage[]> {
  let messages: PublicDiscussionMessage[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_DISCUSSION_PAGES; pageNumber += 1) {
    const search = new URLSearchParams();
    if (cursor !== null) search.set("cursor", cursor);
    const path = `/api/view/discussion${search.size > 0 ? `?${search}` : ""}`;
    const response = await boundedRequest(
      () => discussionRequest(session, path, {}, signal),
      (candidate) => candidate.status === 429,
      false,
      signal,
    );
    if (!response.ok) throw new Error("refused");
    const page = parseDiscussionPage(await response.json());
    if (!page) throw new Error("refused");
    const merged = mergeDiscussionMessages(messages, page.messages);
    if (!merged) throw new Error("refused");
    messages = merged;
    if (page.nextCursor === null) return messages;
    if (seenCursors.has(page.nextCursor)) throw new Error("refused");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("refused");
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

export function CommentsPanel(props: { access: ShareAccess; session: string }) {
  const [messages, setMessages] = useState<PublicDiscussionMessage[] | null>(null);
  const [body, setBody] = useState("");
  const [claimedName, setClaimedName] = useState("");
  const [nameLocked, setNameLocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [composerState, setComposerState] = useState<ComposerState>("available");
  const [submitError, setSubmitError] = useState(false);
  const sessionRef = useRef(props.session);
  const messagesRef = useRef<PublicDiscussionMessage[] | null>(null);
  const pageTokenRef = useRef<symbol | null>(null);
  const submitTokenRef = useRef<symbol | null>(null);
  const submitControllerRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const intentRef = useRef<SubmitIntent | null>(null);
  sessionRef.current = props.session;

  useEffect(() => {
    const token = Symbol("discussion-page");
    const controller = new AbortController();
    pageTokenRef.current = token;
    submitTokenRef.current = null;
    submitControllerRef.current?.abort();
    submitControllerRef.current = null;
    pendingRef.current = false;
    intentRef.current = null;
    messagesRef.current = null;
    setMessages(null);
    setBody("");
    setClaimedName("");
    setNameLocked(false);
    setPending(false);
    setComposerState("available");
    setSubmitError(false);
    void loadDiscussion(props.session, controller.signal)
      .then((loaded) => {
        if (
          pageTokenRef.current !== token ||
          sessionRef.current !== props.session
        ) {
          return;
        }
        messagesRef.current = loaded;
        setMessages(loaded);
      })
      .catch(() => undefined);
    return () => {
      if (pageTokenRef.current === token) pageTokenRef.current = null;
      controller.abort();
      submitTokenRef.current = null;
      submitControllerRef.current?.abort();
      submitControllerRef.current = null;
      pendingRef.current = false;
    };
  }, [props.session]);

  const editDraft = (field: "body" | "name", value: string) => {
    intentRef.current = null;
    setSubmitError(false);
    if (field === "body") setBody(value);
    else setClaimedName(value);
  };

  const submitComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      props.access !== "comment" ||
      composerState !== "available" ||
      body.length === 0 ||
      pendingRef.current
    ) {
      return;
    }
    const intent = exactIntent(intentRef.current, body, claimedName);
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
      if (response.status === 403) {
        const result = await response.json();
        if (!isCurrent()) return;
        const state = parseDiscussionWriteState(result);
        if (state) {
          intentRef.current = null;
          setSubmitError(false);
          setComposerState(state);
          return;
        }
      } else if (response.ok) {
        const result = await response.json();
        if (!isCurrent()) return;
        const message = parseDiscussionAppendResult(result);
        const merged = message && messagesRef.current
          ? mergeDiscussionMessages(messagesRef.current, [message])
          : null;
        if (message && merged) {
          messagesRef.current = merged;
          setMessages(merged);
          if (intent.claimedName !== undefined && message.deleted === false) {
            setClaimedName(message.author.displayName);
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

  if (messages === null) return null;
  const disabled = pending || composerState !== "available";
  const stateCopy = composerState === "blocked"
    ? "The owner turned off comments for this browser."
    : composerState === "paused"
      ? "The owner paused comments. You can still read everything."
      : submitError
        ? "The comment didn't post. Try again."
        : "";
  return (
    <aside className="comments-panel" aria-labelledby="comments-title">
      <h2 id="comments-title">Comments</h2>
      <p className="comments-helper">
        {props.access === "comment"
          ? "Anyone with the link can also comment. Names they give are not verified."
          : "Anyone with the link can read what you selected."}
      </p>
      {messages.length === 0
        ? <p className="comments-empty">No comments yet.</p>
        : (
          <ol className="comment-list">
            {messages.map((message) => (
              <CommentRow key={message.messageId} message={message} />
            ))}
          </ol>
        )}
      {props.access === "comment" ? (
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
            onChange={(event) => editDraft("body", event.currentTarget.value)}
          />
          <div className="comment-submit-row">
            <button type="submit" disabled={disabled || body.length === 0}>
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

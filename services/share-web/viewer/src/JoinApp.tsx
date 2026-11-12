import {useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject} from "react";
import {MAX_WORKSPACE_MEMBERS, parseWorkspaceJoinPreview, parseWorkspaceJoinResult, type WorkspaceJoinPreview} from "@dohc/security-contract/workspace-members";
import {fetchShareWeb} from "./apiVersion";
import {DohcMark, Icon, type IconName} from "./icons";
import {isJoinToken, JOIN_API, type JoinRefusal} from "./joinWire";
import {accountUser, namedRequest} from "./namedRecipient";
import {signInErrorMessage} from "./NamedSignIn";
import {RETRY_BUDGET_MS} from "./retry";

const TOKEN_KEY = "dohc.join.token";
const SIGN_UP = `/account/sign-up?next=${encodeURIComponent("/join")}`;
const UNREACHABLE = "dohc could not reach the server. Check your connection.";
const SIGN_OUT_FAILED = "dohc could not sign you out.";

type Account = {id: string; name: string};
type Refusal = Exclude<JoinRefusal, "signed_out" | "unavailable">;
type Stage =
  | {kind: "checking"}
  | {kind: "no-link"}
  | {kind: "signed-out"; ended: boolean}
  | {kind: "preview"; account: Account; preview: WorkspaceJoinPreview}
  | {kind: "joined"; account: Account; workspaceName: string}
  | {kind: "refused"; account: Account | null; code: Refusal}
  | {kind: "unreachable"; account: Account | null};
/** What failed, and the action that runs it again. A failed sign-in has none: the form is its retry. */
type Failure = {message: string; retry: (() => void) | null};

/**
 * The invite link's token, read once. The address bar loses it at once, so a
 * copied address or a screenshot never carries it; the tab keeps it through
 * sign-up and refusals until the person joins.
 */
export function takeJoinToken(): string | null {
  const fromLink = location.hash.slice(1);
  if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
  try {
    if (isJoinToken(fromLink)) {
      sessionStorage.setItem(TOKEN_KEY, fromLink);
      return fromLink;
    }
    const kept = sessionStorage.getItem(TOKEN_KEY);
    return isJoinToken(kept) ? kept : null;
  } catch {
    return isJoinToken(fromLink) ? fromLink : null;
  }
}

function forgetJoinToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* Nothing kept. */ }
}

class JoinRefused extends Error {
  constructor(readonly code: JoinRefusal) { super(code); }
}

async function joinRequest(path: string, token: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchShareWeb(path, {method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(RETRY_BUDGET_MS)]),
      headers: {accept: "application/json", "content-type": "application/json"}, body: JSON.stringify({token})});
  } catch (cause) {
    signal.throwIfAborted();
    throw cause instanceof JoinRefused ? cause : new JoinRefused("unavailable");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body;
  const code = body && typeof body === "object" && "code" in body ? body.code : null;
  throw new JoinRefused(code === "signed_out" || code === "link_off" || code === "removed" || code === "full" ? code : "unavailable");
}

// Each can change once an owner or admin acts, so the page keeps the link and
// offers Try again.
const REFUSED: Record<Refusal, {icon: IconName; title: string; body: string}> = {
  link_off: {icon: "unlink", title: "This invite link no longer works",
    body: "The owner or an admin turned it off or reset it. Ask them to turn it on, then choose Try again. Or ask for the current link."},
  removed: {icon: "x", title: "You were removed from this workspace",
    body: "An owner or admin removed this account. Ask them to let you back in, then choose Try again."},
  full: {icon: "users", title: "This workspace is full",
    body: `It already has ${MAX_WORKSPACE_MEMBERS.toLocaleString("en-US")} people. Ask the owner or an admin to make room, then choose Try again.`},
};

export default function JoinApp(props: {token: string | null}) {
  const {token} = props;
  const [stage, setStage] = useState<Stage>(token ? {kind: "checking"} : {kind: "no-link"});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const request = useRef<AbortController | null>(null);
  // The signed-in account, once the page knows it, so a refusal still says who is signed in.
  const known = useRef<Account | null>(null);
  const page = useFocusOnStage(stage);

  // Each action replaces the one before; an answer for an older one is dropped.
  const begin = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null);
    return controller;
  };
  const settle = (controller: AbortController, next: Stage | null, failure: Failure | null = null) => {
    if (request.current !== controller) return;
    if (next) setStage(next);
    setError(failure); setBusy(false);
  };
  // `retry` runs the action that failed again; a failure while previewing
  // leaves the page it started from.
  const failed = (controller: AbortController, cause: unknown, retry: () => void, previewing: boolean) => {
    if (controller.signal.aborted) return;
    const code = cause instanceof JoinRefused ? cause.code : "unavailable";
    if (code === "signed_out") {
      known.current = null;
      return settle(controller, {kind: "signed-out", ended: true});
    }
    if (code === "unavailable") {
      return settle(controller, previewing ? {kind: "unreachable", account: known.current} : null, {message: UNREACHABLE, retry});
    }
    settle(controller, {kind: "refused", account: known.current, code});
  };

  const preview = async (controller: AbortController) => {
    if (!token) return;
    const account = accountUser(await namedRequest("/api/account/session", controller.signal));
    if (request.current !== controller) return;
    known.current = account;
    if (!account) return settle(controller, {kind: "signed-out", ended: false});
    const value = parseWorkspaceJoinPreview(await joinRequest(JOIN_API.preview, token, controller.signal));
    if (!value) throw new JoinRefused("unavailable");
    settle(controller, {kind: "preview", account, preview: value});
  };
  const load = () => {
    const controller = begin();
    void preview(controller).catch(cause => failed(controller, cause, load, true));
  };
  useEffect(() => {
    if (token) load();
    return () => request.current?.abort();
  }, [token]);

  const signIn = (credentials: {email: string; password: string}) => {
    const controller = begin();
    void namedRequest("/api/account/sign-in", controller.signal, credentials).then(
      () => preview(controller).catch(cause => failed(controller, cause, load, true)),
      (cause: unknown) => { if (!controller.signal.aborted) settle(controller, null, {message: signInErrorMessage(cause), retry: null}); },
    );
  };
  const signOut = () => {
    const controller = begin();
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(
      () => {
        if (request.current === controller) known.current = null;
        settle(controller, {kind: "signed-out", ended: false});
      },
      () => { if (!controller.signal.aborted) settle(controller, null, {message: SIGN_OUT_FAILED, retry: signOut}); },
    );
  };
  const join = (account: Account) => {
    if (!token) return;
    const controller = begin();
    void joinRequest(JOIN_API.join, token, controller.signal).then((value) => {
      const result = parseWorkspaceJoinResult(value);
      if (!result) throw new JoinRefused("unavailable");
      forgetJoinToken();
      settle(controller, {kind: "joined", account, workspaceName: result.workspaceName});
    }).catch(cause => failed(controller, cause, () => join(account), false));
  };

  const failure = error?.retry ? <ErrorLine failure={error} busy={busy} /> : null;
  const signedIn = (account: Account | null) => account
    ? <AccountLine account={account} busy={busy} onSignOut={signOut} />
    : null;

  switch (stage.kind) {
    case "checking":
      return <Page pageRef={page} busy announce="Checking the invite link">
        <div className="join-skeleton" aria-hidden="true"><i /><i /><i /><i /><i /></div></Page>;
    case "no-link":
      return <Page pageRef={page} icon="unlink" failed title="This invite link is incomplete">
        <p>Open the whole link you were sent. If it still doesn't work, ask for it again.</p>
      </Page>;
    case "signed-out": {
      const words = stage.ended ? "Your sign-in ended. Sign in again to join." : "Sign in to see which workspace this link is for.";
      return <Page pageRef={page} icon="users" title="Join a workspace on dohc" announce={words}>
        <p>{words}</p>
        <SignInForm busy={busy} error={error?.message ?? null} onSignIn={signIn} />
        <p className="join-aside">New to dohc? <a href={SIGN_UP}>Create an account</a></p>
      </Page>;
    }
    case "preview": {
      const {account, preview: shown} = stage;
      return <Page pageRef={page} icon="users" title={shown.alreadyMember ? `You're already in ${shown.workspaceName}` : `Join ${shown.workspaceName}`}>
        {shown.ownerName ? <p data-testid="join-owner">{shown.ownerName} owns this workspace.</p> : null}
        {shown.alreadyMember ? <JoinedLimit joined /> : <>
          <p>People in it will see your name. The owner and admins will also see your email.</p>
          <JoinedLimit joined={false} />
          <button className="handoff-button primary join-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => join(account)}>
            {busy ? "Joining…" : "Join workspace"}
          </button>
        </>}
        {failure}
        {signedIn(account)}
      </Page>;
    }
    case "joined":
      return <Page pageRef={page} icon="check" title={`You joined ${stage.workspaceName}`}>
        <JoinedLimit joined />
        {failure}
        {signedIn(stage.account)}
      </Page>;
    case "refused": {
      const {icon, title, body} = REFUSED[stage.code];
      return <Page pageRef={page} icon={icon} failed title={title}>
        <p>{body}</p>
        <button className="handoff-button secondary" disabled={busy} aria-busy={busy || undefined} onClick={load}>Try again</button>
        {failure}
        {signedIn(stage.account)}
      </Page>;
    }
    case "unreachable":
      return <Page pageRef={page} icon="alert" failed title="dohc could not check this invite link">
        <ErrorLine failure={error ?? {message: UNREACHABLE, retry: load}} busy={busy} />
        {signedIn(stage.account)}
      </Page>;
  }
}

/**
 * dohc lists a workspace someone joined but cannot open it yet. Every
 * statement of that limit on this page comes from here, so the change that
 * opens joined workspaces edits this one place.
 */
function JoinedLimit(props: {joined: boolean}) {
  return <p data-testid="join-limit">{props.joined
    ? "Find it in the dohc app, in Sharing under Shared with me. It opens there once dohc can open joined workspaces."
    : "This version of dohc can't open a joined workspace yet. Once you join, it's listed in the dohc app, in Sharing under Shared with me."}</p>;
}

// Moves focus to each new stage's heading, or to the sign-in form's first
// field, so a keyboard or screen reader lands where the page changed.
function useFocusOnStage(stage: Stage): RefObject<HTMLDivElement | null> {
  const page = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const root = page.current;
    const target = stage.kind === "signed-out" ? root?.querySelector("input") : root?.querySelector("h1");
    target?.focus();
  }, [stage]);
  return page;
}

function Page(props: {
  pageRef: RefObject<HTMLDivElement | null>;
  icon?: IconName;
  failed?: boolean;
  title?: string;
  // What a screen reader hears when the page changes to this stage. Default: the title.
  announce?: string;
  busy?: boolean;
  children?: ReactNode;
}) {
  return <div ref={props.pageRef} className="state-page join-page">
    {/* One polite region for every stage, so each change is read once it lands. */}
    <p className="sr-only" role="status" aria-live="polite">{props.announce ?? props.title}</p>
    <span className="bar-mark"><DohcMark /></span>
    <main className="state" aria-busy={props.busy || undefined}>
      <div className="state-message">
        {props.icon ? <span className={props.failed ? "tile bad" : "tile"}><Icon name={props.icon} size={20} /></span> : null}
        {props.title ? <h1 tabIndex={-1}>{props.title}</h1> : null}
        {props.children}
      </div>
    </main>
  </div>;
}

function AccountLine(props: {account: Account; busy: boolean; onSignOut(): void}) {
  return <p className="join-aside">Signed in as <span className="join-name">{props.account.name}</span> ·{" "}
    <button className="join-link" disabled={props.busy} onClick={props.onSignOut}>Sign out</button></p>;
}

function ErrorLine(props: {failure: Failure; busy: boolean}) {
  const {retry} = props.failure;
  return <p className="join-error" role="alert">{props.failure.message}{" "}
    {retry ? <button className="join-link" disabled={props.busy} onClick={retry}>Try again</button> : null}</p>;
}

function SignInForm(props: {busy: boolean; error: string | null; onSignIn(credentials: {email: string; password: string}): void}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    props.onSignIn({email: String(values.get("email") ?? ""), password: String(values.get("password") ?? "")});
  };
  return <form className="join-form" onSubmit={submit} aria-describedby={props.error ? "join-sign-in-error" : undefined}>
    <label>Email<input name="email" type="email" autoComplete="username" required disabled={props.busy} /></label>
    <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={props.busy} /></label>
    <button className="handoff-button primary join-primary" disabled={props.busy} aria-busy={props.busy || undefined}>
      {props.busy ? "Signing in…" : "Sign in"}
    </button>
    {props.error ? <p id="join-sign-in-error" className="join-error" role="alert">{props.error}</p> : null}
    <a className="join-forgot" href="/account/forgot-password">Forgot your password?</a>
  </form>;
}

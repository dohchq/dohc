import {useEffect, useRef, useState, type FormEvent, type ReactNode} from "react";
import {parseWorkspaceJoinPreview, parseWorkspaceJoinResult, type WorkspaceJoinPreview} from "@dohc/security-contract/workspace-members";
import {fetchShareWeb} from "./apiVersion";
import {DohcMark, Icon, type IconName} from "./icons";
import {isJoinToken, JOIN_API, type JoinRefusal} from "./joinWire";
import {accountUser, namedRequest} from "./namedRecipient";
import {signInErrorMessage} from "./NamedSignIn";
import {RETRY_BUDGET_MS} from "./retry";

const TOKEN_KEY = "dohc.join.token";
const SIGN_UP = `/account/sign-up?next=${encodeURIComponent("/join")}`;
const UNREACHABLE = "dohc could not reach the server. Check your connection.";
const NEXT_STEPS = "In the dohc app, it is listed in Sharing, under Shared with me. This version of dohc cannot open it yet.";

type Account = {id: string; name: string};
type Stage =
  | {kind: "checking"}
  | {kind: "no-link"}
  | {kind: "signed-out"; ended: boolean}
  | {kind: "preview"; account: Account; preview: WorkspaceJoinPreview}
  | {kind: "joined"; account: Account; workspaceName: string}
  | {kind: "refused"; code: Exclude<JoinRefusal, "signed_out" | "unavailable">}
  | {kind: "unreachable"};

/**
 * The invite link's token, read once. The address bar loses it at once, so a
 * copied address or a screenshot never carries it; the tab keeps it through
 * sign-up until the person joins.
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

const REFUSED: Record<Exclude<JoinRefusal, "signed_out" | "unavailable">, {title: string; body: string}> = {
  link_off: {title: "This invite link no longer works",
    body: "The owner or an admin turned it off or reset it. Ask them for the current link, or for an invite by email."},
  removed: {title: "You were removed from this workspace",
    body: "An owner or admin removed this account. To come back, ask them to let you back in."},
  full: {title: "This workspace is full",
    body: "It already has 1,000 people. Ask the owner or an admin to make room."},
};

export default function JoinApp(props: {token: string | null}) {
  const {token} = props;
  const [stage, setStage] = useState<Stage>(token ? {kind: "checking"} : {kind: "no-link"});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  // Each action replaces the one before; an answer for an older one is dropped.
  const begin = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null);
    return controller;
  };
  const settle = (controller: AbortController, next: Stage | null, message: string | null = null) => {
    if (request.current !== controller) return;
    if (next) setStage(next);
    setError(message); setBusy(false);
  };
  const failed = (controller: AbortController, cause: unknown, fallback: Stage) => {
    if (controller.signal.aborted) return;
    const code = cause instanceof JoinRefused ? cause.code : "unavailable";
    if (code === "signed_out") return settle(controller, {kind: "signed-out", ended: true});
    if (code === "unavailable") return settle(controller, fallback.kind === "checking" ? {kind: "unreachable"} : fallback, UNREACHABLE);
    forgetJoinToken();
    settle(controller, {kind: "refused", code});
  };

  const preview = async (controller: AbortController, known?: Account) => {
    if (!token) return;
    const account = known ?? accountUser(await namedRequest("/api/account/session", controller.signal));
    if (request.current !== controller) return;
    if (!account) return settle(controller, {kind: "signed-out", ended: false});
    const value = parseWorkspaceJoinPreview(await joinRequest(JOIN_API.preview, token, controller.signal));
    if (!value) throw new JoinRefused("unavailable");
    settle(controller, {kind: "preview", account, preview: value});
  };
  const load = () => {
    const controller = begin();
    void preview(controller).catch(cause => failed(controller, cause, {kind: "checking"}));
  };
  useEffect(() => {
    if (token) load();
    return () => request.current?.abort();
  }, [token]);

  const signIn = (credentials: {email: string; password: string}) => {
    const controller = begin();
    void namedRequest("/api/account/sign-in", controller.signal, credentials).then(
      () => preview(controller).catch(cause => failed(controller, cause, {kind: "checking"})),
      (cause: unknown) => { if (!controller.signal.aborted) settle(controller, null, signInErrorMessage(cause)); },
    );
  };
  const signOut = () => {
    const controller = begin();
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(
      () => settle(controller, {kind: "signed-out", ended: false}),
      () => { if (!controller.signal.aborted) settle(controller, null, "dohc could not sign you out. Try again."); },
    );
  };
  const join = (account: Account, shown: WorkspaceJoinPreview) => {
    if (!token) return;
    const controller = begin();
    void joinRequest(JOIN_API.join, token, controller.signal).then((value) => {
      const result = parseWorkspaceJoinResult(value);
      if (!result) throw new JoinRefused("unavailable");
      forgetJoinToken();
      settle(controller, {kind: "joined", account, workspaceName: result.workspaceName});
    }).catch(cause => failed(controller, cause, {kind: "preview", account, preview: shown}));
  };

  switch (stage.kind) {
    case "checking":
      return <Page busy><p className="sr-only" role="status">Checking the invite link</p>
        <div className="join-skeleton" aria-hidden="true"><i /><i /><i /><i /></div></Page>;
    case "no-link":
      return <Page icon="unlink" failed title="This invite link is incomplete">
        <p>Open the whole link you were sent. If it still doesn't work, ask for it again.</p>
      </Page>;
    case "signed-out":
      return <Page icon="users" title="Join a workspace on dohc">
        <p>{stage.ended ? "Your sign-in ended. Sign in again to join." : "Sign in to see which workspace this link is for."}</p>
        <SignInForm busy={busy} error={error} onSignIn={signIn} />
        <p className="join-aside">New to dohc? <a href={SIGN_UP}>Create an account</a></p>
      </Page>;
    case "preview": {
      const {account, preview: shown} = stage;
      return <Page icon="users" title={shown.alreadyMember ? `You're already in ${shown.workspaceName}` : `Join ${shown.workspaceName}`}>
        {shown.ownerName ? <p data-testid="join-owner">{shown.ownerName} owns this workspace.</p> : null}
        {shown.alreadyMember ? <p>{NEXT_STEPS}</p> : <>
          <p>People in it will see your name. The owner and admins will also see your email.</p>
          <button className="handoff-button primary join-primary" disabled={busy} onClick={() => join(account, shown)}>
            {busy ? "Joining…" : "Join workspace"}
          </button>
        </>}
        {error ? <ErrorLine message={error} onRetry={() => join(account, shown)} busy={busy} /> : null}
        <p className="join-aside">Signed in as <span className="join-name">{account.name}</span>.{" "}
          <button className="join-link" disabled={busy} onClick={signOut}>Sign out</button></p>
      </Page>;
    }
    case "joined":
      return <Page icon="check" title={`You joined ${stage.workspaceName}`}>
        <p>{NEXT_STEPS}</p>
        <p className="join-aside">Signed in as <span className="join-name">{stage.account.name}</span>.</p>
      </Page>;
    case "refused":
      return <Page icon="unlink" failed title={REFUSED[stage.code].title}><p>{REFUSED[stage.code].body}</p></Page>;
    case "unreachable":
      return <Page icon="alert" failed title="dohc could not check this invite link">
        <ErrorLine message={error ?? UNREACHABLE} onRetry={load} busy={busy} />
      </Page>;
  }
}

function Page(props: {icon?: IconName; failed?: boolean; title?: string; busy?: boolean; children?: ReactNode}) {
  return <div className="state-page join-page">
    <span className="bar-mark"><DohcMark /></span>
    <main className="state" aria-busy={props.busy || undefined}>
      <div className="state-message">
        {props.icon ? <span className={props.failed ? "tile bad" : "tile"}><Icon name={props.icon} size={20} /></span> : null}
        {props.title ? <h1>{props.title}</h1> : null}
        {props.children}
      </div>
    </main>
  </div>;
}

function ErrorLine(props: {message: string; onRetry(): void; busy: boolean}) {
  return <p className="join-error" role="alert">{props.message}{" "}
    <button className="join-link" disabled={props.busy} onClick={props.onRetry}>Try again</button></p>;
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
    <button className="handoff-button primary join-primary" disabled={props.busy}>{props.busy ? "Signing in…" : "Sign in"}</button>
    {props.error ? <p id="join-sign-in-error" className="join-error" role="alert">{props.error}</p> : null}
    <a className="join-forgot" href="/account/forgot-password">Forgot your password?</a>
  </form>;
}

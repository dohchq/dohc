import {useEffect, useRef, useState, type FormEvent} from "react";
import {accountUser, namedRequest} from "./namedRecipient";
import {AppLaunchError, launchSharedApp} from "./OpenSharedApp";
import type {NamedAppTarget} from "./namedAppRoute";
import "./namedRecipient.css";

type Account = {id: string; name: string};
type Pending = "account" | "sign-in" | "sign-out" | "open" | null;
const CHECK_FAILED = "dohc could not check your account. Try again.";
const SIGN_IN_FAILED = "dohc could not sign you in. Check your email and password, then retry.";
const SIGN_OUT_FAILED = "dohc could not sign you out. Retry sign-out.";
const LAUNCH_REFUSED = "dohc could not open this app with this account. Ask the owner to share it with you.";
const LAUNCH_UNAVAILABLE = "dohc could not reach the app. Check your connection, then try again.";

export default function NamedApp({target}: {target: NamedAppTarget | null}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [pending, setPending] = useState<Pending>(target ? "account" : null), [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const start = (work: Exclude<Pending, null>) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setPending(work); setError(null); return controller;
  };
  const finish = (controller: AbortController, message: string | null) => {
    if (controller.signal.aborted || request.current !== controller) return;
    setPending(null); if (message) setError(message);
  };
  const load = async (controller: AbortController) => {
    const user = accountUser(await namedRequest("/api/account/session", controller.signal));
    if (!controller.signal.aborted && request.current === controller) setAccount(user);
  };
  const check = () => {const controller = start("account"); void load(controller).then(() => finish(controller, null), () => finish(controller, CHECK_FAILED));};
  useEffect(() => {
    if (!target) return;
    check();
    return () => request.current?.abort();
  }, [target?.workspaceId, target?.publicationId]);
  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form), controller = start("sign-in");
    const email = String(values.get("email") ?? ""), password = String(values.get("password") ?? "");
    form.reset();
    void namedRequest("/api/account/sign-in", controller.signal, {email, password}).then(
      () => load(controller).then(() => finish(controller, null), () => finish(controller, CHECK_FAILED)),
      () => finish(controller, SIGN_IN_FAILED));
  };
  const signOut = () => {
    const controller = start("sign-out");
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(
      () => {if (!controller.signal.aborted && request.current === controller) setAccount(null); finish(controller, null);},
      () => finish(controller, SIGN_OUT_FAILED));
  };
  const open = () => {
    if (!target) return;
    const controller = start("open");
    // A successful launch leaves the page through the submitted form, so only a failure settles.
    void launchSharedApp({workspaceId: target.workspaceId, publicationId: target.publicationId}, controller.signal)
      .catch((reason: unknown) => finish(controller, reason instanceof AppLaunchError && reason.status !== 503 ? LAUNCH_REFUSED : LAUNCH_UNAVAILABLE));
  };
  const busy = pending !== null;
  return <div className="viewer named-recipient">
    <header><div><p className="eyebrow">dohc</p><h1>Shared app</h1></div>
      {account && <div className="header-actions"><span>{account.name}</span><button disabled={pending === "sign-out"} className="handoff-button secondary" onClick={signOut}>Sign out</button></div>}
    </header>
    {!target ? <main className="download-card"><p>This app link is unavailable. Open the link the owner shared with you.</p></main> :
      !account ? <main className="download-card"><h2>Sign in to open this app</h2><p>Use the account the owner invited.</p>
        <form className="comment-composer" onSubmit={signIn}><label>Email<input name="email" type="email" autoComplete="username" required disabled={busy}/></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={busy}/></label>
          <button className="handoff-button primary" disabled={busy}>Sign in</button></form>
        {busy && <p role="status">Checking your account…</p>}{error && <p role="alert">{error}</p>}
        {error === CHECK_FAILED && <button className="handoff-button secondary" onClick={check}>Try again</button>}
      </main> : <main className="download-card" aria-label="Shared app"><h2>Open this app</h2>
        <p>This app can use external services. Its author decides where it sends data.</p>
        <p>It opens with the access the owner gave your account.</p>
        <button className="handoff-button primary" disabled={busy} onClick={open}>{pending === "open" ? "Opening app" : "Open app"}</button>
        {pending === "sign-out" && <p role="status">Signing out…</p>}{error && <p role="alert">{error}</p>}
      </main>}
  </div>;
}

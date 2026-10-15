import type {FormEvent, ReactNode} from "react";

export const SIGN_IN_FAILED = "dohc could not sign you in. Check your email and password, then retry.";

/** The one account sign-in form for named invitations. The caller sends the credentials and owns the result. */
export function NamedSignIn(props: {title: string; busy: boolean; error: string | null;
  onSignIn(credentials: {email: string; password: string}): void; children?: ReactNode}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
    const credentials = {email: String(values.get("email") ?? ""), password: String(values.get("password") ?? "")};
    form.reset(); props.onSignIn(credentials);
  };
  return <main className="download-card"><h2>{props.title}</h2><p>Use the account the owner invited.</p>
    <form className="comment-composer" onSubmit={submit}><label>Email<input name="email" type="email" autoComplete="username" required disabled={props.busy}/></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={props.busy}/></label>
      <button className="handoff-button primary" disabled={props.busy}>Sign in</button></form>
    {props.busy && <p role="status">Checking your account…</p>}{props.error && <p role="alert">{props.error}</p>}
    {props.children}
  </main>;
}

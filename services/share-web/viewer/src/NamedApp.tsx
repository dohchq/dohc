import { LINK_REFUSALS } from "@dohc/security-contract/link-refusal";
import { normalizeShareLabel, shareAccessLabel } from "@dohc/security-contract/share-labels";
import { useEffect, useRef, useState } from "react";
import { accountUser, namedRequest } from "./namedRecipient";
import { NamedSignIn, signInErrorMessage } from "./NamedSignIn";
import { AppLaunchError, LaunchFailure, launchSharedApp } from "./OpenSharedApp";
import type { NamedAppTarget } from "./namedAppRoute";
import "./namedRecipient.css";

type Account = { id: string; name: string };
type Pending = "account" | "sign-in" | "sign-out" | "open" | "source" | null;
type Review = {
  authorityRevision: number;
  consent: "none" | "changed" | "current";
  scopeDigest: string;
  collections: Array<{
    name: string;
    access: string;
    operations: Array<{ name: string; readOnly: boolean }>;
  }>;
  source: Array<{ path: string; sha256: string; byteLength: number }>;
};
const MAX_SOURCE_BYTES = 256 * 1024;
const CHANGED_AGAIN = "dohc could not save your choice. Review the app again, then try again.";
const SOURCE_FAILED = "dohc could not load this file. Try again.";
const CHECK_FAILED = "dohc could not check your account. Try again.";
const SIGN_OUT_FAILED = "dohc could not sign you out. Retry sign-out.";
const LAUNCH_REFUSED =
  "dohc could not open this app with this account. Ask the owner to share it with you.";
const LAUNCH_UNAVAILABLE = "dohc could not reach the app. Check your connection, then try again.";

export default function NamedApp({ target }: { target: NamedAppTarget | null }) {
  const [summary, setSummary] = useState<{
    subjectName: string | null;
    sharerName: string | null;
    access: string;
    review?: Review;
  } | null>(null);
  const [source, setSource] = useState<{ path: string; text: string } | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [pending, setPending] = useState<Pending>(target ? "account" : null),
    [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const start = (work: Exclude<Pending, null>) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(work);
    setError(null);
    return controller;
  };
  const finish = (controller: AbortController, message: string | null) => {
    if (controller.signal.aborted || request.current !== controller) return;
    setPending(null);
    if (message) setError(message);
  };
  const load = async (controller: AbortController) => {
    const user = accountUser(await namedRequest("/api/account/session", controller.signal));
    if (controller.signal.aborted || request.current !== controller) return;
    setAccount(user);
    setSummary(null);
    if (user && target) {
      const data = await namedRequest("/api/apps/summary", controller.signal, target).catch(
        () => null,
      );
      if (controller.signal.aborted || request.current !== controller) return;
      if (
        data &&
        typeof data === "object" &&
        "access" in data &&
        typeof data.access === "string" &&
        "subjectName" in data &&
        "sharerName" in data
      ) {
        const review =
          "review" in data && data.review && typeof data.review === "object"
            ? (data.review as Review)
            : undefined;
        setSummary({
          subjectName: normalizeShareLabel(data.subjectName),
          sharerName: normalizeShareLabel(data.sharerName, 320),
          access: data.access,
          ...(review ? { review } : {}),
        });
        return review;
      }
    }
  };
  const check = () => {
    const controller = start("account");
    void load(controller).then(
      () => finish(controller, null),
      () => finish(controller, CHECK_FAILED),
    );
  };
  useEffect(() => {
    if (!target) return;
    setSummary(null);
    check();
    return () => request.current?.abort();
  }, [target?.workspaceId, target?.publicationId]);
  const signIn = (credentials: { email: string; password: string }) => {
    const controller = start("sign-in");
    void namedRequest("/api/account/sign-in", controller.signal, credentials).then(
      () =>
        load(controller).then(
          () => finish(controller, null),
          () => finish(controller, CHECK_FAILED),
        ),
      (reason: unknown) => finish(controller, signInErrorMessage(reason)),
    );
  };
  const signOut = () => {
    const controller = start("sign-out");
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(
      () => {
        if (!controller.signal.aborted && request.current === controller) {
          setAccount(null);
          setSummary(null);
        }
        finish(controller, null);
      },
      () => finish(controller, SIGN_OUT_FAILED),
    );
  };
  const showSource = (file: Review["source"][number]) => {
    if (!target || !summary?.review) return;
    const controller = start("source");
    void namedRequest("/api/apps/source", controller.signal, {
      ...target,
      sha256: file.sha256,
      authorityRevision: summary.review.authorityRevision,
    }).then(
      (data) => {
        if (controller.signal.aborted || request.current !== controller) return;
        if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string")
          return finish(controller, SOURCE_FAILED);
        setSource({ path: file.path, text: data.text });
        finish(controller, null);
      },
      () => finish(controller, SOURCE_FAILED),
    );
  };
  const allowAndOpen = () => {
    const review = summary?.review;
    if (!target || !review) return;
    const controller = start("open");
    void namedRequest("/api/apps/consent", controller.signal, {
      ...target,
      scopeDigest: review.scopeDigest,
    }).then(
      () => {
        if (controller.signal.aborted || request.current !== controller) return;
        open();
      },
      () =>
        load(controller).then(
          () => finish(controller, CHANGED_AGAIN),
          () => finish(controller, CHECK_FAILED),
        ),
    );
  };
  const open = () => {
    if (!target) return;
    const controller = start("open");
    // A successful launch leaves the page through the submitted form, so only a failure settles.
    void launchSharedApp(
      { workspaceId: target.workspaceId, publicationId: target.publicationId },
      controller.signal,
    ).catch(async (reason: unknown) => {
      const message =
        !(reason instanceof AppLaunchError) || reason.status === 503
          ? LAUNCH_UNAVAILABLE
          : reason.status === 410
            ? LINK_REFUSALS.app_collection_missing.error
            : LAUNCH_REFUSED;
      if (!summary?.review) return finish(controller, message);
      const review = await load(controller).catch(() => undefined);
      finish(controller, review && review.consent !== "current" ? null : message);
    });
  };
  const busy = pending !== null;
  return (
    <div className="viewer named-recipient">
      <header>
        <div>
          <p className="eyebrow">dohc</p>
          <h1>{summary?.subjectName ?? "Shared app"}</h1>
          {summary &&
            (summary.review ? (
              <p>Made by {summary.sharerName ?? "a workspace member"}</p>
            ) : (
              <p>
                {summary.sharerName ? `Shared by ${summary.sharerName}` : "Shared with you"} ·{" "}
                {shareAccessLabel(summary.access)} access
              </p>
            ))}
        </div>
        {account && (
          <div className="header-actions">
            <span>{account.name}</span>
            <button
              disabled={pending === "sign-out"}
              className="handoff-button secondary"
              onClick={signOut}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {!target ? (
        <main className="download-card">
          <p>This app link is unavailable. Open the link the owner shared with you.</p>
        </main>
      ) : !account ? (
        <NamedSignIn title="Sign in to open this app" busy={busy} error={error} onSignIn={signIn}>
          {error === CHECK_FAILED && (
            <button className="handoff-button secondary" onClick={check}>
              Try again
            </button>
          )}
        </NamedSignIn>
      ) : summary?.review && summary.review.consent !== "current" ? (
        <main className="download-card member-review" aria-label="Review app">
          <h2>{summary.review.consent === "changed" ? "This app changed" : "Review this app"}</h2>
          <p>
            A workspace member made this app. It can only do what both of you can do, and only in
            these Collections.
          </p>
          {summary.review.collections.length === 0 ? (
            <p>It uses no Collections.</p>
          ) : (
            <ul>
              {summary.review.collections.map((collection) => (
                <li key={collection.name}>
                  <strong>{collection.name}</strong> · {shareAccessLabel(collection.access)} access
                  <ul>
                    {collection.operations.map((operation) => (
                      <li key={operation.name}>
                        {operation.name}
                        {operation.readOnly ? "" : " (changes data)"}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <details className="properties">
            <summary>Source files</summary>
            <ul>
              {summary.review.source.map((file) => (
                <li key={file.sha256 + file.path}>
                  {file.path}{" "}
                  {file.byteLength <= MAX_SOURCE_BYTES && (
                    <button
                      className="handoff-button secondary"
                      disabled={busy}
                      onClick={() => showSource(file)}
                    >
                      View
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {source && (
              <>
                <p>{source.path}</p>
                <pre>{source.text}</pre>
              </>
            )}
          </details>
          <button className="handoff-button primary" disabled={busy} onClick={allowAndOpen}>
            {pending === "open" ? "Opening app" : "Allow and open"}
          </button>
          {error && <LaunchFailure role="alert" message={error} />}
        </main>
      ) : (
        <main className="download-card" aria-label="Shared app">
          <h2>Open this app</h2>
          <p>This app can use external services. Its author decides where it sends data.</p>
          {summary && (
            <p>
              {summary.review
                ? "It can only do what both you and its author can do."
                : "It opens with the access the owner gave your account."}
            </p>
          )}
          <button className="handoff-button primary" disabled={busy} onClick={open}>
            {pending === "open" ? "Opening app" : "Open app"}
          </button>
          {pending === "sign-out" && <p role="status">Signing out…</p>}
          {error && <LaunchFailure role="alert" message={error} />}
        </main>
      )}
    </div>
  );
}

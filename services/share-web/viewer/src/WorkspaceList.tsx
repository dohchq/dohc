import { useEffect, useState } from "react";
import {
  type BrowserWorkspaceList,
  parseBrowserWorkspaceList,
} from "@dohc/security-contract/workspace-members";
import { DohcMark, Icon } from "./icons";
import { WORKSPACES_API } from "./joinWire";
import { accountUser, namedRequest } from "./namedRecipient";
import { LaunchFailure } from "./OpenSharedApp";
import { CopyMessage } from "./Toast";
import { memberPagePath, ownerPagePath } from "./workspaceTarget";

const LIST_FAILED = "dohc could not load your workspaces. Check your connection.";

function ListLoading() {
  return (
    <div className="workspaces-skeleton" aria-busy="true">
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <p className="sr-only">Loading your workspaces</p>
    </div>
  );
}

/** The list's shape while the page checks who is signed in. */
export function WorkspacesOpening() {
  return (
    <div className="state-page workspaces-page">
      <span className="bar-mark">
        <DohcMark />
      </span>
      <main className="workspaces">
        <ListLoading />
      </main>
    </div>
  );
}

/** The signed-in account's workspaces: those it owns and those it joined, each linking to its workspace page. */
export function WorkspaceList({
  account,
  signingOut,
  signOutError,
  onSignOut,
  onSessionEnded,
}: {
  account: { id: string; name: string };
  signingOut: boolean;
  signOutError: string | null;
  onSignOut(): void;
  onSessionEnded(): void;
}) {
  const [list, setList] = useState<BrowserWorkspaceList | "loading" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    document.title = "Workspaces · dohc";
  }, []);
  useEffect(() => {
    const controller = new AbortController(),
      { signal } = controller;
    setList("loading");
    void (async () => {
      try {
        const value = parseBrowserWorkspaceList(await namedRequest(WORKSPACES_API, signal));
        if (!value) throw Error("Invalid workspaces");
        if (!signal.aborted) setList(value);
        return;
      } catch {
        if (signal.aborted) return;
      }
      // A refused list may only mean the session ended.
      const user = await namedRequest("/api/account/session", signal)
        .then(accountUser)
        .catch(() => undefined);
      if (signal.aborted) return;
      if (user === null) onSessionEnded();
      else setList("failed");
    })();
    return () => controller.abort();
  }, [account.id, attempt, onSessionEnded]);

  return (
    <div className="state-page workspaces-page">
      <span className="bar-mark">
        <DohcMark />
      </span>
      <main className="workspaces">
        <h1>Workspaces</h1>
        {list === "loading" ? (
          <ListLoading />
        ) : list === "failed" ? (
          <div className="load-failed" role="alert">
            <p>{LIST_FAILED}</p>
            <CopyMessage text={LIST_FAILED} />
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : list.owned.length === 0 && list.joined.length === 0 ? (
          <p className="workspaces-empty">No workspaces on this account yet.</p>
        ) : (
          <>
            {list.owned.length > 0 && (
              <section aria-labelledby="workspaces-owned">
                <h2 id="workspaces-owned">Your workspaces</h2>
                <ul>
                  {list.owned.map((item) => (
                    <li key={item.workspaceId}>
                      <a className="workspace-row" href={ownerPagePath(item.workspaceId)}>
                        <Icon name="folder" size={16} />
                        <span className="workspace-row-name">
                          {item.name ?? "Unnamed workspace"}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {list.joined.length > 0 && (
              <section aria-labelledby="workspaces-joined">
                <h2 id="workspaces-joined">Joined</h2>
                <ul>
                  {list.joined.map((item) => (
                    <li key={item.grantId}>
                      <a className="workspace-row" href={memberPagePath(item.grantId)}>
                        <Icon name="folder" size={16} />
                        <span className="workspace-row-name">{item.name}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        <p className="workspaces-account">
          Signed in as <span className="join-name">{account.name}</span> ·{" "}
          <button className="join-link" type="button" disabled={signingOut} onClick={onSignOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </p>
        {signOutError && <LaunchFailure role="alert" message={signOutError} />}
      </main>
    </div>
  );
}

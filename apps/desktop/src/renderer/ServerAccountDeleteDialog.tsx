import { CloudOff, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatStoredBytes, type ServerAccountDeletionPreview } from "@dohc/cli/account";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import { DangerButton, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";

export interface ServerAccountDeleted {
  finished: boolean;
  email: string;
  server: string;
  // Why this computer could not disconnect from the deleted account, if so.
  disconnectError: string | null;
}

export interface ServerAccountDeleteDialogProps {
  // The account the panel shows. A different session gets a new dialog.
  email: string;
  server: string;
  onClose(): void;
  onDeleted(deleted: ServerAccountDeleted): void;
  // The owner raises the toast and the Notices row. Its Try again opens a
  // new review.
  onError(message: string, cause: unknown): void;
}

export function ServerAccountDeleteDialog(props: ServerAccountDeleteDialogProps) {
  return <Delete key={`${props.server}\n${props.email}`} {...props} />;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Delete(props: ServerAccountDeleteDialogProps) {
  const [preview, setPreview] = useState<ServerAccountDeletionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  // Inline only for what the person can act on in this dialog.
  const [passwordProblem, setPasswordProblem] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  // Every response checks that it answers the newest request of a dialog
  // still open, so a slow answer never repaints a later one.
  const alive = useRef(true), request = useRef(0);
  // A review belongs to the session that produced it, so a session change
  // ends it. A sent delete still answers: the answer names the account it
  // deleted, and that deletion's own disconnect changes the session.
  const sent = useRef(false), sessionChanged = useRef(false);

  async function load(changedReason?: string) {
    const token = ++request.current;
    sent.current = false;
    setBusy(true);
    setDeleting(false);
    setPreview(null);
    setPassword("");
    setPasswordProblem(null);
    setChanged(changedReason ?? null);
    try {
      const result = await bridge().previewServerAccountDeletion({});
      if (!alive.current || request.current !== token) return;
      setPreview(result);
    } catch (cause) {
      if (!alive.current || request.current !== token) return;
      props.onError(ipcErrorMessage(cause, "dohc could not list what deletion removes."), cause);
    } finally {
      if (alive.current && request.current === token) setBusy(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; request.current++; };
  }, []);

  useEffect(() => bridge().onCloudSessionChanged(() => {
    if (sent.current) {
      sessionChanged.current = true;
      return;
    }
    request.current++;
    props.onClose();
  }), []);

  async function deleteAccount() {
    if (!preview || busy || !password) return;
    const token = ++request.current;
    sent.current = true;
    sessionChanged.current = false;
    setBusy(true);
    setDeleting(true);
    setPasswordProblem(null);
    try {
      const result = await bridge().deleteServerAccount({ server: preview.server, previewToken: preview.previewToken, password });
      if (!alive.current || request.current !== token) return;
      if (result.ok) {
        props.onDeleted({ finished: result.finished, email: result.email, server: result.server, disconnectError: result.disconnectError });
        return;
      }
      if (sessionChanged.current) {
        props.onClose();
        return;
      }
      if (result.code === "preview-changed") {
        void load("What deletion removes changed, or the review expired. Check it again.");
        return;
      }
      if (result.code === "rate-limited") {
        props.onError(result.reason, new Error(result.reason));
        return;
      }
      setPassword("");
      setPasswordProblem("The password is incorrect.");
    } catch (cause) {
      if (!alive.current || request.current !== token) return;
      props.onError(ipcErrorMessage(cause, "dohc could not delete this account."), cause);
    } finally {
      if (alive.current && request.current === token) {
        sent.current = false;
        setBusy(false);
        setDeleting(false);
      }
    }
  }

  const server = preview?.server ?? props.server;
  return (
    <Overlay
      appearance="warning"
      onClose={deleting ? undefined : props.onClose}
      panelProps={{ role: "dialog", "aria-modal": true, "aria-labelledby": "delete-server-account-title" }}
    >
      <form
        data-testid="server-account-delete"
        className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-120 max-w-[90vw] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5 text-ink"
        onSubmit={(event) => {
          event.preventDefault();
          void deleteAccount();
        }}
      >
        <div>
          <h2 id="delete-server-account-title" className="m-0 text-base font-semibold">
            Delete {preview?.email ?? props.email} on this server?
          </h2>
          <p className="m-0 mt-1 font-mono text-[11px] text-subtle" data-testid="server-account-delete-server">{server}</p>
        </div>
        {changed ? (
          <p role="status" data-testid="server-account-delete-changed" className="m-0 text-[13px] text-warning">{changed}</p>
        ) : null}
        {!preview ? (
          <SkeletonRows rows={3} label="Listing what deletion removes…" />
        ) : (
          <>
            <section data-testid="server-account-delete-scope" className="flex flex-col gap-2 text-[13px]">
              <h3 className="m-0 text-[12px] font-semibold">The server deletes</h3>
              {preview.workspaces.length === 0 && preview.workspacesElsewhere === 0 ? (
                <p className="m-0 text-muted">The account and no workspaces</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Workspaces the server deletes">
                  {preview.workspaces.map((workspace) => (
                    <li key={workspace.workspaceId} className="flex items-center gap-1.5">
                      <Folder size={13} aria-hidden className="shrink-0 text-subtle" />
                      <span className="truncate" title={workspace.name}>{workspace.name}</span>
                    </li>
                  ))}
                  {preview.workspacesElsewhere > 0 ? (
                    <li data-testid="server-account-delete-elsewhere" className="flex items-center gap-1.5 text-muted">
                      <CloudOff size={13} aria-hidden className="shrink-0 text-subtle" />
                      {counted(preview.workspacesElsewhere, "workspace", "workspaces")} not on this computer
                    </li>
                  ) : null}
                </ul>
              )}
              <p className="m-0 text-muted" data-testid="server-account-delete-size">
                {formatStoredBytes(preview.storedBytes)} of files, data, apps, chats, and history
              </p>
              <p className="m-0 text-muted" data-testid="server-account-delete-shares">
                {counted(preview.ownedShareCount, "share", "shares")} you own end. People you shared with lose access and keep their copies.
              </p>
              <p className="m-0 text-muted" data-testid="server-account-delete-grants">
                Your access to shares others gave you ends.
              </p>
            </section>
            <p className="m-0 text-[13px] text-muted">Workspaces on this computer stay, with their files.</p>
            <p className="m-0 text-[13px] text-danger">
              This cannot be undone. If you create an account again later, this server will not accept your old copies of these workspaces.
            </p>
            <p className="m-0 text-[13px] text-muted">The server's backups keep this data until they expire.</p>
            <label className="block text-[11px] font-medium text-subtle">
              Server account password
              <input
                type="password"
                autoComplete="current-password"
                data-testid="server-account-delete-password"
                value={password}
                disabled={busy}
                aria-invalid={passwordProblem !== null}
                aria-describedby={passwordProblem !== null ? "server-account-delete-password-problem" : undefined}
                onChange={(event) => {
                  setPassword(event.currentTarget.value);
                  setPasswordProblem(null);
                }}
                className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
              />
            </label>
            {passwordProblem ? (
              <p id="server-account-delete-password-problem" role="alert" data-testid="server-account-delete-password-problem" className="m-0 -mt-2 text-xs text-danger">
                {passwordProblem}
              </p>
            ) : null}
          </>
        )}
        <div className="flex justify-end gap-2">
          <SecondaryButton disabled={deleting} onClick={props.onClose}>Cancel</SecondaryButton>
          <DangerButton type="submit" data-testid="server-account-delete-confirm" disabled={busy || !preview || !password}>
            {deleting ? "Deleting…" : "Delete account"}
          </DangerButton>
        </div>
      </form>
    </Overlay>
  );
}

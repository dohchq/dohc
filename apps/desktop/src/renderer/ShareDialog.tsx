import { MailPlus, Share2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceShareRow } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; shares: WorkspaceShareRow[] }
  | { status: "error"; message: string };

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

export function ShareDialog(props: {
  workspaceId: string;
  path: string;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [capability, setCapability] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    void bridge()
      .listWorkspaceShares({ workspaceId: props.workspaceId })
      .then((result) => {
        if (cancelled) return;
        setLoad({
          status: "ready",
          shares: result.shares.filter((share) => share.atomPath === props.path),
        });
      })
      .catch((cause) => {
        if (!cancelled) setLoad({ status: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId, props.path]);

  const shares = load.status === "ready" ? load.shares : [];
  const canSubmit = useMemo(() => email.trim().length > 0 && !busy, [busy, email]);

  async function createShare() {
    if (!canSubmit) return;
    const recipientEmail = email.trim();
    setBusy(true);
    setMessage(null);
    setInviteEmail(null);
    try {
      const result = await bridge().createWorkspaceShare({
        workspaceId: props.workspaceId,
        atomPath: props.path,
        recipientEmail,
        capability,
      });
      setLoad((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              shares: [
                result.share,
                ...current.shares.filter((share) => share.shareId !== result.share.shareId),
              ],
            }
          : current,
      );
      setEmail("");
      setMessage(`Shared with ${result.share.recipientEmail}.`);
    } catch (cause) {
      const text = errorMessage(cause);
      if (/invite|no user/i.test(text)) {
        setInviteEmail(recipientEmail);
        setMessage("That email is not a verified dohc user yet.");
      } else {
        setMessage(text);
      }
    } finally {
      setBusy(false);
    }
  }

  async function createInvite() {
    if (!inviteEmail || busy) return;
    setBusy(true);
    try {
      await bridge().createWorkspaceInvite({
        workspaceId: props.workspaceId,
        email: inviteEmail,
      });
      setMessage(`Invitation sent to ${inviteEmail}.`);
      setInviteEmail(null);
      setEmail("");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(share: WorkspaceShareRow) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await bridge().revokeWorkspaceShare({
        workspaceId: props.workspaceId,
        shareId: share.shareId,
      });
      setLoad((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              shares: current.shares.filter((row) => row.shareId !== share.shareId),
            }
          : current,
      );
      setMessage(`Revoked access for ${share.recipientEmail}.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="share-dialog"
      className="flex w-[min(520px,calc(100vw-32px))] flex-col rounded-md border border-line bg-panel text-sm text-ink shadow-lg"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <Share2 size={15} aria-hidden className="text-subtle" />
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">Share file</h2>
          <p className="m-0 truncate font-mono text-[11px] text-subtle">{props.path}</p>
        </div>
        <button
          type="button"
          aria-label="Close share dialog"
          onClick={props.onClose}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <X size={13} aria-hidden />
        </button>
      </header>

      <div className="space-y-3 p-4">
        <form
          className="grid grid-cols-[1fr_92px_auto] gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createShare();
          }}
        >
          <input
            data-testid="share-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@example.com"
            className="h-8 min-w-0 rounded border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-ink"
          />
          <select
            data-testid="share-capability"
            value={capability}
            onChange={(event) => setCapability(event.target.value as "view" | "edit")}
            className="h-8 rounded border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-ink"
          >
            <option value="view">View</option>
            <option value="edit">Edit</option>
          </select>
          <button
            type="submit"
            disabled={!canSubmit}
            className="h-8 rounded bg-accent px-3 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-40"
          >
            Share
          </button>
        </form>

        {message ? (
          <div data-testid="share-message" className="text-xs text-muted">
            {message}
            {inviteEmail ? (
              <button
                type="button"
                data-testid="share-invite"
                onClick={() => void createInvite()}
                disabled={busy}
                className="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink hover:bg-line/50 disabled:opacity-40"
              >
                <MailPlus size={12} aria-hidden />
                Invite instead
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="rounded border border-line">
          <div className="flex h-8 items-center border-b border-line px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Current access
          </div>
          {load.status === "loading" ? (
            <div className="px-3 py-4 text-xs text-subtle">Loading shares...</div>
          ) : load.status === "error" ? (
            <div data-testid="share-load-error" className="px-3 py-4 text-xs text-danger">
              {load.message}
            </div>
          ) : shares.length === 0 ? (
            <div className="px-3 py-4 text-xs text-subtle">Only you have access.</div>
          ) : (
            <ul className="m-0 max-h-60 list-none overflow-y-auto p-0">
              {shares.map((share) => (
                <li
                  key={share.shareId}
                  data-testid="share-row"
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 truncate text-xs text-ink">
                    {share.recipientEmail}
                  </span>
                  <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">
                    {share.capability}
                  </span>
                  <button
                    type="button"
                    aria-label={`Revoke ${share.recipientEmail}`}
                    onClick={() => void revoke(share)}
                    disabled={busy}
                    className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={12} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

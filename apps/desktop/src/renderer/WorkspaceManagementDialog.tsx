import { MailPlus, Trash2, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  WorkspaceInviteRow,
  WorkspaceMemberRow,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      members: WorkspaceMemberRow[];
      invites: WorkspaceInviteRow[];
    }
  | { status: "error"; message: string };

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function displayIdentity(row: WorkspaceMemberRow): string {
  return row.email ?? row.userId;
}

export function WorkspaceManagementDialog(props: {
  workspaceId: string;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    setLoad({ status: "loading" });
    setMessage(null);
    try {
      const [members, invites] = await Promise.all([
        bridge().listWorkspaceMembers({ workspaceId: props.workspaceId }),
        bridge().listWorkspaceInvites({ workspaceId: props.workspaceId }),
      ]);
      setLoad({
        status: "ready",
        members: members.members,
        invites: invites.invites,
      });
    } catch (cause) {
      setLoad({ status: "error", message: errorMessage(cause) });
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    void Promise.all([
      bridge().listWorkspaceMembers({ workspaceId: props.workspaceId }),
      bridge().listWorkspaceInvites({ workspaceId: props.workspaceId }),
    ])
      .then(([members, invites]) => {
        if (cancelled) return;
        setLoad({
          status: "ready",
          members: members.members,
          invites: invites.invites,
        });
      })
      .catch((cause) => {
        if (!cancelled) setLoad({ status: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId]);

  const members = load.status === "ready" ? load.members : [];
  const invites = load.status === "ready" ? load.invites : [];
  const canInvite = useMemo(() => email.trim().length > 0 && !busy, [busy, email]);

  async function invite() {
    if (!canInvite) return;
    const invitedEmail = email.trim();
    setBusy(true);
    setMessage(null);
    try {
      const result = await bridge().createWorkspaceInvite({
        workspaceId: props.workspaceId,
        email: invitedEmail,
      });
      setEmail("");
      if (result.invite.status === "pending") {
        setLoad((current) =>
          current.status === "ready"
            ? {
                status: "ready",
                members: current.members,
                invites: [
                  result.invite,
                  ...current.invites.filter(
                    (row) => row.inviteId !== result.invite.inviteId,
                  ),
                ],
              }
            : current,
        );
        setMessage(`Invitation sent to ${result.invite.email}.`);
      } else {
        await refresh();
        setMessage(`${result.invite.email} is now a workspace member.`);
      }
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inviteRow: WorkspaceInviteRow) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await bridge().revokeWorkspaceInvite({
        workspaceId: props.workspaceId,
        inviteId: inviteRow.inviteId,
      });
      setLoad((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              members: current.members,
              invites: current.invites.filter(
                (row) => row.inviteId !== inviteRow.inviteId,
              ),
            }
          : current,
      );
      setMessage(`Revoked invite for ${inviteRow.email}.`);
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="workspace-management-dialog"
      className="flex w-[min(620px,calc(100vw-32px))] flex-col rounded-md border border-line bg-panel text-sm text-ink shadow-lg"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <Users size={15} aria-hidden className="text-subtle" />
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">Workspace members</h2>
          <p className="m-0 truncate font-mono text-[11px] text-subtle">
            {props.workspaceId}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close workspace members"
          onClick={props.onClose}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <X size={13} aria-hidden />
        </button>
      </header>

      <div className="space-y-3 p-4">
        <form
          className="grid grid-cols-[1fr_auto] gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <input
            data-testid="workspace-invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@example.com"
            className="h-8 min-w-0 rounded border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-ink"
          />
          <button
            type="submit"
            data-testid="workspace-invite-submit"
            disabled={!canInvite}
            className="inline-flex h-8 items-center gap-1.5 rounded bg-accent px-3 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-40"
          >
            <MailPlus size={12} aria-hidden />
            Invite
          </button>
        </form>

        {message ? (
          <div data-testid="workspace-management-message" className="text-xs text-muted">
            {message}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <section className="min-w-0 rounded border border-line">
            <div className="flex h-8 items-center border-b border-line px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Members
            </div>
            {load.status === "loading" ? (
              <div className="px-3 py-4 text-xs text-subtle">Loading members...</div>
            ) : load.status === "error" ? (
              <div
                data-testid="workspace-management-error"
                className="px-3 py-4 text-xs text-danger"
              >
                {load.message}
              </div>
            ) : members.length === 0 ? (
              <div className="px-3 py-4 text-xs text-subtle">No members found.</div>
            ) : (
              <ul className="m-0 max-h-64 list-none overflow-y-auto p-0">
                {members.map((member) => (
                  <li
                    key={member.userId}
                    data-testid="workspace-member-row"
                    className="flex h-10 items-center gap-2 border-b border-line px-3 last:border-b-0"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded bg-line/50 text-[11px] font-semibold uppercase text-muted">
                      {displayIdentity(member).slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-ink">
                        {displayIdentity(member)}
                      </span>
                      <span className="block text-[10px] uppercase tracking-wide text-subtle">
                        {member.role}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="min-w-0 rounded border border-line">
            <div className="flex h-8 items-center border-b border-line px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Pending invites
            </div>
            {load.status === "loading" ? (
              <div className="px-3 py-4 text-xs text-subtle">Loading invites...</div>
            ) : load.status === "error" ? (
              <div className="px-3 py-4 text-xs text-subtle">Unavailable.</div>
            ) : invites.length === 0 ? (
              <div className="px-3 py-4 text-xs text-subtle">No pending invites.</div>
            ) : (
              <ul className="m-0 max-h-64 list-none overflow-y-auto p-0">
                {invites.map((inviteRow) => (
                  <li
                    key={inviteRow.inviteId}
                    data-testid="workspace-invite-row"
                    className="flex h-10 items-center gap-2 border-b border-line px-3 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-ink">
                        {inviteRow.email}
                      </span>
                      <span className="block text-[10px] uppercase tracking-wide text-subtle">
                        {inviteRow.role}
                      </span>
                    </span>
                    <button
                      type="button"
                      data-testid="workspace-revoke-invite"
                      disabled={busy}
                      aria-label={`Revoke invite for ${inviteRow.email}`}
                      title="Revoke invite"
                      onClick={() => void revoke(inviteRow)}
                      className="grid size-6 shrink-0 place-items-center rounded text-subtle hover:bg-line/50 hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 size={12} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

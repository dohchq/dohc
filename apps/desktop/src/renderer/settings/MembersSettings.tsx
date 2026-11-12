import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleCheck, CloudOff, LoaderCircle, LogIn, LogOut, Mail, RotateCcw, Search, ShieldCheck, ShieldOff, UserMinus, UserX } from "lucide-react";
import { actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import {
  memberPermissions,
  type MemberLevel,
  type WorkspaceMembersView,
  type WorkspacePerson,
} from "@dohc/security-contract/workspace-members";
import type { MembersRequest, MembersResult } from "@dohc/cli/members";
import { bridge } from "../bridge";
import { SYNC_SIGN_IN_EXPIRED, SYNC_UNCONFIRMED_ACCOUNT } from "../cloudSyncWords";
import { ipcErrorMessage } from "../ipcError";
import { JOINED_WORKSPACE_LIMIT } from "../joinedWorkspaceLimit";
import { relativeTime } from "../relativeTime";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CopyButton, CopyField, type CopySecret } from "../ui/CopyButton";
import { EmptyState, FieldError, PrimaryButton, RetryRow, SecondaryButton } from "../ui/controls";
import { MoreMenu, type MoreMenuItem } from "../ui/MoreMenu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { serverName } from "../workbench/accessReason";
import { relayPresentation } from "../workbench/actorPresentation";
import { ChatAvatar } from "../workbench/ChatAvatar";
import type { CloudSettings } from "./CloudSyncSettings";
import { SettingRow, SettingsSection, SwitchControl } from "./SettingRow";

type ReportError = (message: string, cause?: unknown, retry?: () => Promise<void>, details?: undefined, identity?: string) => void;

export const LEVEL_WORDS: Record<MemberLevel, string> = {
  view: "Members can read everything and open apps.",
  comment: "Members can read everything, post in Groups, and comment on files.",
  edit: "Members can read, comment, and edit documents and Collections.",
};
const ROLE_WORDS = { owner: "Owner", admin: "Admin", member: "Member" } as const;
const LINK_SECRET: CopySecret = { what: "the invite link", again: "Copy it again from Settings, in Members." };
// Past this many entries the page offers a filter.
const FILTER_FROM = 9;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

// Why the page cannot list anyone yet, from the shell's read of this
// workspace's server connection. The relay decides everything after `ready`.
export type MembersGate =
  | { kind: "checking" }
  | { kind: "unreadable" }
  | { kind: "not-synced" }
  | { kind: "signed-out"; server: string | null }
  | { kind: "other-server"; server: string }
  | { kind: "other-account" }
  | { kind: "expired" }
  | { kind: "ready"; account: string };

function sameServer(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

export function membersGate(cloud: CloudSettings | undefined): MembersGate {
  const status = cloud?.status;
  if (!cloud || !status) return cloud?.unreadable ? { kind: "unreadable" } : { kind: "checking" };
  // A paused workspace keeps its place on the server, so its Members still load.
  if (!status.workspaceSynced && !status.syncPause) return { kind: "not-synced" };
  if (!status.connected) return { kind: "signed-out", server: status.workspaceServerUrl ?? null };
  if (status.workspaceSynced) {
    if (status.workspaceServerUrl && status.serverUrl && !sameServer(status.workspaceServerUrl, status.serverUrl)) {
      return { kind: "other-server", server: status.workspaceServerUrl };
    }
    if (!status.workspaceSyncConnected) return { kind: "other-account" };
    if (cloud.signInExpired) return { kind: "expired" };
  }
  return { kind: "ready", account: `${status.serverUrl ?? ""}\n${status.email ?? ""}` };
}

type Load =
  | { status: "loading" }
  | { status: "ready"; view: WorkspaceMembersView }
  | { status: "failed"; message: string }
  | { status: "refused" }
  | { status: "left"; workspaceName: string };

// What a running action is for: a person's row, or one of the page's controls.
type PendingKey = string;
const keyOf = (request: MembersRequest): PendingKey => {
  switch (request.action) {
    case "role":
    case "remove":
    case "letBackIn":
      return `person:${request.person}`;
    default:
      return request.action;
  }
};

const FALLBACK: Record<MembersRequest["action"], string> = {
  list: "dohc could not load Members.",
  invite: "dohc could not send the invite.",
  level: "dohc could not change what members can do.",
  role: "dohc could not change this person's role.",
  remove: "dohc could not remove this person.",
  letBackIn: "dohc could not let this person back in.",
  link: "dohc could not change the invite link.",
  leave: "dohc could not leave this workspace.",
  end: "dohc could not end membership.",
};

/**
 * Settings › Members: who is in this workspace, invites, the invite link, and
 * the member level. Every answer belongs to the workspace and the signed-in
 * account it was asked for, and a change of either drops it.
 */
export function MembersSettings(props: {
  workspaceId: string;
  // The folder's name, until the server names the workspace.
  workspaceName: string;
  cloud?: CloudSettings;
  onOpenSync: () => void;
  onError?: ReportError;
  onClearError?: (identity: string) => void;
}) {
  const { workspaceId } = props;
  const gate = membersGate(props.cloud);
  const account = gate.kind === "ready" ? gate.account : null;
  const scopeKey = account === null ? null : `${workspaceId}\n${account}`;
  // Bumped when the workspace or the account changes and when the page
  // closes, so an answer that arrives after any of them paints nothing.
  const scope = useRequestSequence([workspaceId, account]);
  const closed = useRef(false);
  useEffect(() => () => {
    closed.current = true;
  }, []);
  const report = useRef({ onError: props.onError, onClearError: props.onClearError });
  report.current = { onError: props.onError, onClearError: props.onClearError };

  const [load, setLoad] = useState<{ key: string; load: Load } | null>(null);
  const [pending, setPending] = useState<{ key: string; items: ReadonlyMap<PendingKey, MembersRequest> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The owner ended membership here. The page says so above what it lists
  // next, until another change goes through.
  const [ended, setEnded] = useState<string | null>(null);
  // Views apply in the order their requests went out, so an older answer that
  // arrives late cannot undo a newer change.
  const issued = useRef(0);
  const applied = useRef(0);
  const listIdentity = `settings-members:${workspaceId}`;

  const showView = (key: string, order: number, view: WorkspaceMembersView) => {
    if (order < applied.current) return;
    applied.current = order;
    setLoad({ key, load: { status: "ready", view } });
  };

  useEffect(() => {
    if (scopeKey === null) return;
    const token = scope.current();
    const order = ++issued.current;
    setLoad((current) => (current?.key === scopeKey && current.load.status === "ready" ? current : { key: scopeKey, load: { status: "loading" } }));
    bridge().workspaceMembers({ workspaceId, request: { action: "list" } }).then(
      (result) => {
        if (!scope.isCurrent(token)) return;
        report.current.onClearError?.(listIdentity);
        if (result.status === "ready") showView(scopeKey, order, result.view);
        else if (order >= applied.current) setLoad({ key: scopeKey, load: { status: "refused" } });
      },
      (cause: unknown) => {
        if (!scope.isCurrent(token)) return;
        const message = ipcErrorMessage(cause, FALLBACK.list);
        setLoad({ key: scopeKey, load: { status: "failed", message } });
        report.current.onError?.(message, cause, async () => setAttempt((count) => count + 1), undefined, listIdentity);
      },
    );
  }, [scopeKey, attempt]);
  useEffect(() => () => report.current.onClearError?.(listIdentity), [listIdentity]);

  const run = useCallback(async (request: MembersRequest): Promise<boolean> => {
    if (scopeKey === null) return false;
    const token = scope.current();
    const order = ++issued.current;
    const key = keyOf(request);
    const identity = `settings-members:${workspaceId}:${key}`;
    setPending((current) => {
      const items = new Map(current?.key === scopeKey ? current.items : []);
      items.set(key, request);
      return { key: scopeKey, items };
    });
    const settle = () => {
      if (!scope.isCurrent(token)) return;
      setPending((current) => {
        if (current?.key !== scopeKey || !current.items.has(key)) return current;
        const items = new Map(current.items);
        items.delete(key);
        return { key: scopeKey, items };
      });
    };
    let result: MembersResult;
    try {
      result = await bridge().workspaceMembers({ workspaceId, request });
    } catch (cause) {
      settle();
      // A failure still reports when closing Settings cut it off; another
      // workspace or account never hears it.
      if (scope.isCurrent(token) || (closed.current && scope.isCutOff(token))) {
        report.current.onError?.(ipcErrorMessage(cause, FALLBACK[request.action]), cause, async () => {
          if (scope.isCurrent(token) || closed.current) await run(request);
        }, undefined, identity);
      }
      return false;
    }
    settle();
    if (!scope.isCurrent(token)) return true;
    report.current.onClearError?.(identity);
    if (request.action !== "end") setEnded((current) => (current === scopeKey ? null : current));
    if (result.status === "ready") showView(scopeKey, order, result.view);
    else if (result.status === "refused") setLoad({ key: scopeKey, load: { status: "refused" } });
    else if (request.action === "leave") {
      applied.current = order;
      setLoad((current) => ({
        key: scopeKey,
        load: { status: "left", workspaceName: current?.load.status === "ready" ? current.load.view.workspaceName : props.workspaceName },
      }));
    } else {
      // Ended: the people this page listed are gone, so it shows none of
      // them while it reads the owner's page again.
      applied.current = order;
      setEnded(scopeKey);
      setLoad({ key: scopeKey, load: { status: "loading" } });
      setAttempt((count) => count + 1);
    }
    return true;
  }, [scopeKey, workspaceId, props.workspaceName]);

  const shown = load?.key === scopeKey ? load.load : { status: "loading" as const };
  const shownPending = pending?.key === scopeKey ? pending.items : EMPTY_PENDING;

  return (
    <div data-testid="settings-members">
      <MembersGateView gate={gate} cloud={props.cloud} onOpenSync={props.onOpenSync}>
        <MembersLoadView
          load={shown}
          pending={shownPending}
          workspaceName={props.workspaceName}
          ended={ended !== null && ended === scopeKey}
          onRetry={() => setAttempt((count) => count + 1)}
          onOpenSync={props.onOpenSync}
          run={run}
        />
      </MembersGateView>
    </div>
  );
}

const EMPTY_PENDING: ReadonlyMap<PendingKey, MembersRequest> = new Map();

function MembersGateView(props: { gate: MembersGate; cloud: CloudSettings | undefined; onOpenSync: () => void; children: ReactNode }) {
  const { gate, cloud } = props;
  switch (gate.kind) {
    case "ready":
      return <>{props.children}</>;
    case "checking":
      return <SkeletonRows rows={3} label="Checking your server connection…" testId="settings-members-checking" />;
    case "unreadable":
      return (
        <RetryRow testId="settings-members-unreadable" onRetry={() => cloud?.onChanged()}>
          dohc could not read this workspace's sync status.
        </RetryRow>
      );
    case "not-synced":
      return (
        <GateState reason="not-synced" icon={CloudOff} action={{ label: "Set up sync", run: props.onOpenSync, primary: true }}>
          Turn on sync to invite people to this workspace.
        </GateState>
      );
    case "signed-out":
      return (
        <GateState reason="signed-out" icon={LogIn} action={cloud ? { label: "Connect server", run: cloud.onConnect, primary: true } : undefined}>
          {gate.server
            ? <>Connect to <span className="font-medium text-ink">{serverName(gate.server)}</span> to see who is in this workspace.</>
            : "Connect your server to see who is in this workspace."}
        </GateState>
      );
    case "other-server":
      return (
        <GateState reason="other-server" icon={CloudOff} action={{ label: "Sync and sharing", run: props.onOpenSync }}>
          This workspace syncs with <span className="font-medium text-ink">{serverName(gate.server)}</span>. Connect to it to see who is in this workspace.
        </GateState>
      );
    case "other-account":
      return (
        <GateState reason="other-account" icon={CloudOff} action={{ label: "Sync and sharing", run: props.onOpenSync }}>
          {SYNC_UNCONFIRMED_ACCOUNT} Resume sync to see who is in this workspace.
        </GateState>
      );
    case "expired":
      return (
        <GateState reason="expired" icon={LogIn} action={cloud?.onSignInAgain ? { label: "Sign in again", run: cloud.onSignInAgain, primary: true } : undefined}>
          {SYNC_SIGN_IN_EXPIRED}
        </GateState>
      );
  }
}

function GateState(props: {
  reason: string;
  icon: typeof CloudOff;
  action?: { label: string; run: () => void; primary?: boolean } | undefined;
  testId?: string;
  children: ReactNode;
}) {
  const Button = props.action?.primary ? PrimaryButton : SecondaryButton;
  return (
    <div data-testid={props.testId ?? "settings-members-gate"} data-reason={props.reason} className="flex min-h-48 flex-col pt-8">
      <EmptyState icon={props.icon} title={props.children}>
        {props.action ? <Button onClick={props.action.run}>{props.action.label}</Button> : null}
      </EmptyState>
    </div>
  );
}

export function MembersLoadView(props: {
  load: Load;
  pending: ReadonlyMap<PendingKey, MembersRequest>;
  workspaceName: string;
  // Membership ended from this page, and nothing has changed since.
  ended?: boolean;
  onRetry: () => void;
  onOpenSync: () => void;
  run: (request: MembersRequest) => Promise<boolean>;
}) {
  return (
    <>
      {props.ended ? <EndedNotice /> : null}
      <MembersLoadState {...props} />
    </>
  );
}

function MembersLoadState(props: Parameters<typeof MembersLoadView>[0]) {
  const { load } = props;
  switch (load.status) {
    case "loading":
      return <MembersSkeleton />;
    case "failed":
      return (
        <div data-testid="settings-members-failed" className="rounded-lg border border-line bg-panel p-1">
          <RetryRow testId="settings-members-retry" onRetry={props.onRetry}>{load.message}</RetryRow>
        </div>
      );
    case "refused":
      return (
        <GateState testId="settings-members-refused" reason="refused" icon={ShieldOff} action={{ label: "Sync and sharing", run: props.onOpenSync }}>
          This account isn't in this workspace anymore, or can't see who is in it.
        </GateState>
      );
    case "left":
      return (
        <div data-testid="settings-members-left" className="flex min-h-48 flex-col pt-8">
          <EmptyState icon={LogOut} title={<>You left <span className="font-medium text-ink">{load.workspaceName}</span>.</>} />
        </div>
      );
    case "ready":
      return <MembersPage view={load.view} pending={props.pending} ended={props.ended} run={props.run} />;
  }
}

// Said in place of the people the page listed. Focus lands on it, since the
// End membership control that had it is gone.
function EndedNotice() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} role="status" data-testid="settings-members-ended"
      className="mb-8 flex items-start gap-3 rounded-lg border border-line bg-panel p-3">
      <CircleCheck size={16} aria-hidden className="mt-0.5 shrink-0 text-success" />
      <div className="min-w-0">
        <p className="m-0 text-[13px] font-medium text-ink">Membership ended</p>
        <p className="m-0 mt-1 text-[12px] text-muted">Everyone except you lost access. To work with people again, invite them by email or turn on the invite link.</p>
      </div>
    </div>
  );
}

// The page's shape while it loads: the Invite card's rows, then People.
function MembersSkeleton() {
  const bar = "block h-2 rounded bg-skeleton";
  return (
    <div role="status" data-testid="settings-members-loading" className="dohc-reveal-if-slow">
      <span className="sr-only">Loading Members…</span>
      <div aria-hidden>
        <span className={`${bar} mb-4 mt-1 w-14`} />
        <div className="rounded-lg border border-line bg-panel px-5">
          {["w-28", "w-20", "w-24"].map((width) => (
            <div key={width} className="flex flex-col gap-3 border-b border-line py-5 last:border-b-0">
              <span className={`${bar} ${width}`} />
              <span className={`${bar} w-[62%]`} />
            </div>
          ))}
        </div>
        <span className={`${bar} mb-4 mt-10 w-16`} />
        <div className="rounded-lg border border-line bg-panel">
          {["w-32", "w-24", "w-28"].map((width) => (
            <div key={width} className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
              <span className="size-8 shrink-0 rounded-full bg-skeleton" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className={`${bar} ${width}`} />
                <span className={`${bar} w-40`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type Confirm =
  | { kind: "remove"; person: WorkspacePerson }
  | { kind: "admin"; person: WorkspacePerson }
  | { kind: "reset" }
  | { kind: "leave" }
  | { kind: "end" };

/** The page for a view the relay answered. The states page and tests draw it too. */
export function MembersPage(props: {
  view: WorkspaceMembersView;
  pending: ReadonlyMap<PendingKey, MembersRequest>;
  ended?: boolean | undefined;
  run: (request: MembersRequest) => Promise<boolean>;
}) {
  const { view, pending, run } = props;
  const can = memberPermissions(view.viewer.role);
  const manages = view.viewer.role !== "member";
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const groups = useMemo(() => {
    const active: WorkspacePerson[] = [];
    const invited: WorkspacePerson[] = [];
    const removed: WorkspacePerson[] = [];
    for (const person of view.people) {
      if (person.state === "active") active.push(person);
      else if (person.state === "invited") invited.push(person);
      else removed.push(person);
    }
    return { active, invited, removed };
  }, [view.people]);
  const total = view.people.length;
  const filtering = total >= FILTER_FROM;
  const needle = filtering ? deferredQuery.trim().toLowerCase() : "";
  const shown = useMemo(() => {
    const match = (person: WorkspacePerson) =>
      !needle || (person.name ?? "").toLowerCase().includes(needle) || (person.email ?? "").toLowerCase().includes(needle);
    return {
      active: groups.active.filter(match),
      invited: groups.invited.filter(match),
      removed: groups.removed.filter(match),
    };
  }, [groups, needle]);
  const nothingMatches = needle !== "" && shown.active.length + shown.invited.length + shown.removed.length === 0;
  const alone = groups.active.length === 1 && groups.invited.length === 0 && groups.removed.length === 0;

  const busy = (key: PendingKey) => pending.has(key);
  const pendingLevel = pending.get("level");
  const pendingLink = pending.get("link");
  const level = pendingLevel?.action === "level" ? pendingLevel.level : view.memberLevel;
  const linkOn = pendingLink?.action === "link" ? pendingLink.change !== "turn-off" : (view.inviteLink?.enabled ?? false);

  const rowMenu = (person: WorkspacePerson): MoreMenuItem[] => {
    if (person.memberId === view.viewer.memberId || person.role === "owner") return [];
    if (person.state === "invited") {
      return can.removeMembers ? [{ label: "Remove invite", danger: true, onSelect: () => void run({ action: "remove", person: person.memberId }) }] : [];
    }
    if (person.state !== "active") return [];
    const items: MoreMenuItem[] = [];
    if (can.setAdmins) {
      items.push(person.role === "admin"
        ? { label: "Make member", onSelect: () => void run({ action: "role", person: person.memberId, role: "member" }) }
        : { label: "Make admin", onSelect: () => setConfirm({ kind: "admin", person }) });
    }
    if (person.role === "admin" ? can.removeAdmins : can.removeMembers) {
      items.push({ label: "Remove from workspace", danger: true, onSelect: () => setConfirm({ kind: "remove", person }) });
    }
    return items;
  };

  return (
    <div data-testid="settings-members-page" data-viewer-role={view.viewer.role}>
      {manages ? (
        <SettingsSection title="Invite">
          <InviteRow
            people={view.people}
            busy={busy("invite")}
            link={{ url: linkOn ? view.inviteLink?.url ?? null : null, busy: busy("link") }}
            onInvite={(email) => run({ action: "invite", email })}
            onTurnOnLink={() => void run({ action: "link", change: "turn-on" })}
          />
          <SettingRow
            title="Invite link"
            testId="settings-members-link"
            // The switch stays on the title's line at every width; what it
            // makes sits under the words. -mr-4 cancels the text column's
            // margin, so the switch lines up with the other rows' controls.
            detail={(
              <span className="-mr-4 ml-auto flex shrink-0 items-center gap-2">
                <SwitchControl
                  label="Invite link"
                  checked={linkOn}
                  busy={busy("link")}
                  disabled={busy("link")}
                  onChange={(on) => void run({ action: "link", change: on ? "turn-on" : "turn-off" })}
                />
              </span>
            )}
            description={linkOn ? "Anyone with the link can join as a member." : "Turn it on to let anyone with the link join as a member."}
            aside={view.inviteLink?.url && linkOn ? (
              <div className="flex max-w-md flex-wrap items-center gap-2">
                <div className="min-w-0 flex-[1_1_12rem]">
                  <CopyField label="Copy invite link" copiedLabel="Invite link copied" copyTestId="settings-members-link-copy"
                    getText={() => view.inviteLink?.url ?? null} sensitive={LINK_SECRET}>
                    <span data-testid="settings-members-link-url" title={view.inviteLink.url}>{view.inviteLink.url}</span>
                  </CopyField>
                </div>
                {view.inviteLink.enabled ? (
                  <SecondaryButton size="row" data-testid="settings-members-link-reset" disabled={busy("link")} onClick={() => setConfirm({ kind: "reset" })}>
                    Reset link
                  </SecondaryButton>
                ) : null}
              </div>
            ) : undefined}
          />
          <SettingRow
            title="Member level"
            testId="settings-members-level"
            description={(
              <>
                <span data-testid="settings-members-level-words">{LEVEL_WORDS[level]}</span>
                <span data-testid="settings-members-limit" className="mt-1 block">{JOINED_WORKSPACE_LIMIT.members}</span>
              </>
            )}
          >
            {/* The spinner's place is kept while idle, so the control never moves. */}
            <span aria-hidden className="grid size-3 shrink-0 place-items-center">
              {busy("level") ? <LoaderCircle data-testid="settings-members-level-busy" size={12} className="animate-spin text-subtle" /> : null}
            </span>
            <SegmentedControl
              label="Member level"
              testId="settings-members-level-control"
              value={level}
              disabled={busy("level")}
              options={[
                { value: "view", label: "View" },
                { value: "comment", label: "Comment" },
                { value: "edit", label: "Edit" },
              ]}
              onChange={(next) => {
                if (next !== view.memberLevel) void run({ action: "level", level: next });
              }}
            />
          </SettingRow>
        </SettingsSection>
      ) : (
        <SettingsSection>
          <SettingRow title="What members can do" testId="settings-members-level"
            description={<span data-testid="settings-members-level-words">{LEVEL_WORDS[view.memberLevel]}</span>} />
        </SettingsSection>
      )}

      {filtering ? (
        <div className="relative mt-8 max-w-xs">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            spellCheck={false}
            data-testid="settings-members-filter"
            aria-label="Filter people"
            placeholder={manages ? "Name or email" : "Name"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 w-full rounded-md border border-line bg-bg pl-7 pr-2 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
          />
        </div>
      ) : null}
      {nothingMatches ? (
        <p data-testid="settings-members-no-match" className="m-0 mt-4 text-[13px] text-muted">{`No one matches "${deferredQuery.trim()}".`}</p>
      ) : null}

      <PeopleGroup title="People" count={groups.active.length} shown={shown.active} testId="settings-members-people" first={!filtering}>
        {(person) => (
          <PersonRow key={person.memberId} person={person} viewer={view.viewer.memberId} showEmail={manages} actions={manages}
            busy={busy(`person:${person.memberId}`)} menu={rowMenu(person)} />
        )}
      </PeopleGroup>
      {alone && manages && !props.ended ? (
        <p data-testid="settings-members-alone" className="m-0 mt-2 px-3 text-[12px] text-muted">
          Only you are in this workspace. Invite people by email, or send them the invite link.
        </p>
      ) : null}
      {manages ? (
        <>
          <PeopleGroup title="Invites" count={groups.invited.length} shown={shown.invited} testId="settings-members-invites">
            {(person) => (
              <PersonRow key={person.memberId} person={person} viewer={view.viewer.memberId} showEmail actions
                busy={busy(`person:${person.memberId}`)} menu={rowMenu(person)} />
            )}
          </PeopleGroup>
          <PeopleGroup title="Removed" count={groups.removed.length} shown={shown.removed} testId="settings-members-removed">
            {(person) => (
              <PersonRow key={person.memberId} person={person} viewer={view.viewer.memberId} showEmail actions
                busy={busy(`person:${person.memberId}`)} menu={[]}
                action={
                  <SecondaryButton size="row" data-testid="settings-members-let-back-in" disabled={busy(`person:${person.memberId}`)}
                    onClick={() => void run({ action: "letBackIn", person: person.memberId })}>
                    Let back in
                  </SecondaryButton>
                } />
            )}
          </PeopleGroup>
        </>
      ) : null}

      <SettingsSection>
        {can.endForEveryone && !alone ? (
          <SettingRow title="End membership" testId="settings-members-end"
            description="Everyone except you loses access. Your workspace stays on this computer.">
            <SecondaryButton data-testid="settings-members-end-open" disabled={busy("end")} onClick={() => setConfirm({ kind: "end" })}>
              {busy("end") ? "Ending…" : "End membership"}
            </SecondaryButton>
          </SettingRow>
        ) : can.leave ? (
          <SettingRow title="Leave this workspace" testId="settings-members-leave"
            description="You lose access until someone invites you again.">
            <SecondaryButton data-testid="settings-members-leave-open" disabled={busy("leave")} onClick={() => setConfirm({ kind: "leave" })}>
              {busy("leave") ? "Leaving…" : "Leave"}
            </SecondaryButton>
          </SettingRow>
        ) : null}
      </SettingsSection>

      {confirm ? <MembersConfirm confirm={confirm} workspaceName={view.workspaceName} onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          switch (confirm.kind) {
            case "remove": return void run({ action: "remove", person: confirm.person.memberId });
            case "admin": return void run({ action: "role", person: confirm.person.memberId, role: "admin" });
            case "reset": return void run({ action: "link", change: "reset" });
            case "leave": return void run({ action: "leave" });
            case "end": return void run({ action: "end" });
          }
        }} /> : null}
    </div>
  );
}

function MembersConfirm(props: { confirm: Confirm; workspaceName: string; onCancel: () => void; onConfirm: () => void }) {
  const { confirm } = props;
  const plain = { onCancel: props.onCancel, onConfirm: props.onConfirm, cancelTestId: "settings-members-confirm-cancel", confirmTestId: "settings-members-confirm" };
  const common = { ...plain, intent: "danger" as const };
  switch (confirm.kind) {
    case "remove":
      return (
        <ConfirmDialog {...common} testId="settings-members-confirm-remove" icon={UserMinus}
          title={`Remove ${displayName(confirm.person)} from ${props.workspaceName}?`} confirmLabel="Remove">
          <p className="m-0">Copies already on their computers stay with them. You can let them back in from Removed.</p>
        </ConfirmDialog>
      );
    case "admin":
      return (
        <ConfirmDialog {...plain} testId="settings-members-confirm-admin" icon={ShieldCheck}
          title={`Make ${displayName(confirm.person)} an admin?`} confirmLabel="Make admin">
          <p className="m-0">Admins can invite and remove members, change the invite link and member level, and see emails.</p>
        </ConfirmDialog>
      );
    case "reset":
      return (
        <ConfirmDialog {...common} testId="settings-members-confirm-reset" icon={RotateCcw} title="Reset the invite link?" confirmLabel="Reset link">
          <p className="m-0">The current link stops working. People who already joined stay.</p>
        </ConfirmDialog>
      );
    case "leave":
      return (
        <ConfirmDialog {...common} testId="settings-members-confirm-leave" icon={LogOut} title={`Leave ${props.workspaceName}?`} confirmLabel="Leave">
          <p className="m-0">You lose access to this workspace. To come back, you need an invite or the invite link.</p>
        </ConfirmDialog>
      );
    case "end":
      return (
        <ConfirmDialog {...common} testId="settings-members-confirm-end" icon={UserX} title="End membership for everyone?" confirmLabel="End membership">
          <p className="m-0">Everyone except you loses access, and the list of people, including Removed, is deleted. This cannot be undone. To bring people back, invite them again.</p>
        </ConfirmDialog>
      );
  }
}

function displayName(person: WorkspacePerson): string {
  return person.name?.trim() || person.email || "this person";
}

function InviteRow(props: {
  people: readonly WorkspacePerson[];
  busy: boolean;
  // The invite link while it is on, and whether a change to it is running.
  link: { url: string | null; busy: boolean };
  onInvite: (email: string) => Promise<boolean>;
  onTurnOnLink: () => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The address the last invite went to. dohc sends no email, so the row
  // says how that person gets in.
  const [sent, setSent] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const check = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return "Enter an email address.";
    if (!EMAIL.test(trimmed) || trimmed.length > 320) return "Enter an email address, such as sam@example.com.";
    const known = props.people.find((person) => person.email?.toLowerCase() === trimmed.toLowerCase());
    if (known?.state === "active") return `${trimmed} is already in this workspace.`;
    if (known?.state === "invited") return `${trimmed} already has an invite.`;
    if (known?.state === "removed") return `${trimmed} was removed. Let them back in from Removed.`;
    return null;
  };
  return (
    <SettingRow
      title="Invite by email"
      testId="settings-members-invite"
      aside={
        <form
          noValidate
          className="flex max-w-md flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.busy) return;
            const problem = check(email);
            setError(problem);
            if (problem) {
              input.current?.focus();
              return;
            }
            const submitted = email.trim();
            setSent(null);
            void props.onInvite(submitted).then((done) => {
              if (!done) return;
              setSent(submitted);
              // An address typed while the invite ran stays.
              setEmail((current) => (current.trim() === submitted ? "" : current));
            });
          }}
        >
          <div className="flex gap-2">
            <input
              ref={input}
              type="email"
              spellCheck={false}
              autoComplete="off"
              aria-label="Email address"
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
              data-testid="settings-members-invite-email"
              data-unsaved={email.trim() ? true : undefined}
              placeholder="sam@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => setError(email.trim() ? check(email) : null)}
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink aria-invalid:border-danger"
            />
            <PrimaryButton type="submit" data-testid="settings-members-invite-send" disabled={props.busy} className="shrink-0">
              {props.busy ? "Inviting…" : "Invite"}
            </PrimaryButton>
          </div>
          {error ? <FieldError id={errorId} testId="settings-members-invite-error">{error}</FieldError> : null}
          <div role="status" className="empty:hidden">
            {sent ? (
              <p data-testid="settings-members-invite-sent" className="m-0 text-[12px] text-muted">
                Invited <span className="font-medium text-ink">{sent}</span>. dohc doesn't send email. They join when they sign in to dohc
                with this address, so send them the invite link.
              </p>
            ) : null}
          </div>
          {sent ? (
            <div className="flex">
              {props.link.url ? (
                <CopyButton label="Copy invite link" copiedLabel="Invite link copied" testId="settings-members-invite-sent-copy"
                  getText={() => props.link.url} sensitive={LINK_SECRET} />
              ) : (
                <SecondaryButton size="row" data-testid="settings-members-invite-sent-link" disabled={props.link.busy} onClick={props.onTurnOnLink}>
                  Turn on invite link
                </SecondaryButton>
              )}
            </div>
          ) : null}
        </form>
      }
    />
  );
}

function PeopleGroup(props: {
  title: string;
  count: number;
  shown: readonly WorkspacePerson[];
  testId: string;
  first?: boolean;
  children: (person: WorkspacePerson) => ReactNode;
}) {
  if (props.count === 0 || props.shown.length === 0) return null;
  return (
    <section aria-label={props.title} data-testid={props.testId} className={props.first === false ? "mt-4" : "mt-8"}>
      <h4 className="m-0 mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
        {props.title}
        <span className="text-[12px] font-normal tabular-nums text-subtle">{props.count}</span>
      </h4>
      <ul className="m-0 list-none rounded-lg border border-line bg-panel p-0">{props.shown.map(props.children)}</ul>
    </section>
  );
}

function PersonRow(props: {
  person: WorkspacePerson;
  viewer: string;
  showEmail: boolean;
  busy: boolean;
  menu: readonly MoreMenuItem[];
  // Whether the list has row actions, so a row without one keeps the column.
  actions: boolean;
  action?: ReactNode;
}) {
  const { person } = props;
  const self = person.memberId === props.viewer;
  const invited = person.state === "invited";
  const removed = person.state === "removed";
  const name = person.name?.trim() || null;
  const title = name ?? person.email ?? "No name";
  const second = invited
    ? ["Joins when they sign in", person.invitedAtMs !== null ? `Invited ${relativeTime(person.invitedAtMs)}` : null].filter(Boolean).join(" · ")
    : removed
      ? [props.showEmail && name ? person.email : null, person.removedAtMs !== null ? `Removed ${relativeTime(person.removedAtMs)}` : "Removed"].filter(Boolean).join(" · ")
      : props.showEmail && name ? person.email : null;
  return (
    <li
      data-testid="settings-members-row"
      data-member-id={person.memberId}
      data-state={person.state}
      aria-busy={props.busy || undefined}
      // Off-screen rows of a long list skip layout and paint.
      className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 [contain-intrinsic-size:auto_48px] [content-visibility:auto] last:border-b-0"
    >
      {invited ? (
        <span aria-hidden className="inline-grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-subtle bg-bg text-subtle">
          <Mail size={14} strokeWidth={1.9} />
        </span>
      ) : (
        <ChatAvatar name={title} kind="human" size="row" presentation={relayPresentation(actorHueSlot(person.memberId), self)}
          className={removed ? "opacity-60" : undefined} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate text-[13px] font-medium ${removed ? "text-muted" : "text-ink"}`} title={title}>{title}</span>
          {self ? <span className="shrink-0 text-[12px] text-subtle">You</span> : null}
        </div>
        {second ? <div className="truncate text-[12px] text-muted" title={second}>{second}</div> : null}
      </div>
      {!invited && !removed ? (
        <span data-testid="settings-members-role" className="shrink-0 text-[12px] text-muted">{ROLE_WORDS[person.role]}</span>
      ) : null}
      {props.action}
      {props.busy ? (
        <span className="grid size-6 shrink-0 place-items-center" data-testid="settings-members-row-busy">
          <LoaderCircle size={14} aria-hidden className="animate-spin text-subtle" />
        </span>
      ) : props.menu.length > 0 ? (
        <MoreMenu label={`Actions for ${title}`} items={props.menu} testId="settings-members-row-menu" width={184} topLayer />
      ) : props.action || !props.actions ? null : (
        <span aria-hidden className="size-6 shrink-0" />
      )}
    </li>
  );
}

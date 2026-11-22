import { CloudOff, CloudUpload, LogIn, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { withErrorWords } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { SYNC_UNCONFIRMED_ACCOUNT } from "./cloudSyncWords";
import { EmailShareForm } from "./EmailShareForm";
import { invitationCanBeBrowserLink, nextInvitationCopy } from "./invitationCopy";
import { notSentWords } from "./notSentWords";
import { invitedByEmailWords } from "./shareAccess";
import { INVITATION_SECRET, SHARE_CODE_SECRET } from "./shareCopySecrets";
import {
  isShareAccess,
  PersonAccessRow,
  PersonRemovalError,
  removePersonAccess,
  resendInvitationEntry,
  useInvitationResend,
  useLocalPeople,
  type ChangedAccess,
  type ListedPerson,
} from "./sharePerson";
import type { ShareRemovalNotices } from "./shell/useShareRemovalNotices";
import { IconButton, PrimaryButton, RetryRow, SectionLabel } from "./ui/controls";
import { useCopy } from "./ui/CopyButton";
import { NameLine } from "./ui/NameLine";
import { splitPath } from "./ui/PathLine";
import {
  rowMatchesTarget,
  shareScope,
  targetLabel,
  useRelayShareLinkPane,
} from "./useRelayShareLinkPane";
import {
  accessReasonForLane,
  serverName,
  type AccessContext,
  type AccessReason,
} from "./workbench/accessReason";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

export type RelayShareTarget =
  | { kind: "paths"; paths: [string, ...string[]]; label?: string }
  | { kind: "version"; versionId: string; versionName?: string };

// Fits the dialog under Overlay's 6rem top and above its 1rem bottom and the
// toasts, so a long link pane grows it downward and its body scrolls.
const DIALOG_HEIGHT_CLASS = "max-h-[calc(100vh_-_7rem_-_var(--dohc-toast-room,0px))]";

const NO_PEOPLE: readonly ListedPerson[] = [];

type GrantsOfScope = { scope: string; grantIds: readonly string[] };
const grantsIn = (held: GrantsOfScope, scope: string) =>
  held.scope === scope ? held.grantIds : [];

type InvitationPart = "invitation" | "code";

type InvitationClick = {
  part: InvitationPart;
  resolve: (text: string | null) => void;
  reject: (error: unknown) => void;
};

function useInvitation(
  person: Pick<ListedPerson, "shareId" | "grantId">,
  onEnded: () => void,
  onCodeOnly: () => void,
): (part: InvitationPart) => Promise<string | null> {
  const { shareId, grantId } = person;
  const asked = useRef<InvitationClick | null>(null);
  const { retry } = useWorkspaceQuery(useWorkspaceSession(), {
    key: `${shareId}\0${grantId}`,
    manual: true,
    load: async (signal) => {
      const click = asked.current;
      asked.current = null;
      signal.addEventListener("abort", () => click?.resolve(null), { once: true });
      try {
        const details = await bridge().getShareCopyDetails({ shareId, grantId });
        if (signal.aborted) return details.status;
        if (details.status === "ended") {
          onEnded();
          click?.resolve(null);
        } else {
          if (!details.browserInvitationUrl) onCodeOnly();
          click?.resolve(
            click.part === "code"
              ? details.shareCode
              : (details.browserInvitationUrl ?? details.shareCode),
          );
        }
        return details.status;
      } catch (error) {
        if (!signal.aborted) click?.reject(error);
        throw error;
      }
    },
  });
  return (part) =>
    new Promise<string | null>((resolve, reject) => {
      const newest = nextInvitationCopy();
      const click: InvitationClick = {
        part,
        resolve: (text) => resolve(newest() ? text : null),
        reject: (error) => (newest() ? reject(error) : resolve(null)),
      };
      asked.current?.resolve(null);
      asked.current = click;
      void retry();
      if (asked.current === click) {
        asked.current = null;
        resolve(null);
      }
    });
}

// The people this selection was shared with, from the listing the Sharing
// view reads: `invited` by email, and `onLinkShares`, whom the links list.
// `scope` names the workspace and the selection. The list is read while
// sharing can work, and again whenever `revision` changes.
function useSharedPeople(input: {
  workspaceId: string;
  target: RelayShareTarget;
  scope: string;
  read: boolean;
  revision: number;
}) {
  const { workspaceId, target, scope, read, revision } = input;
  const query = useWorkspaceQuery(useWorkspaceSession(), {
    // Sharing that stops retires the read under way.
    key: `${scope}\0${read ? "read" : "held"}`,
    manual: true,
    load: async (signal) => {
      // A share made a moment ago is already being listed; this waits for it.
      await bridge()
        .requestAccessRefresh({ workspaceId, reason: "sharing-open" })
        .catch(() => undefined);
      const invited: ListedPerson[] = [];
      const onLinkShares: ListedPerson[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let restarted = false;
      while (!signal.aborted) {
        const answer = await bridge().listSharingAccess({
          workspaceId,
          lane: "granted",
          ...(cursor ? { cursor } : {}),
        });
        if (answer.coverage.kind === "unavailable") {
          // A page cursor belongs to the listing it came from. When that
          // listing changed, main refuses the cursor, so read from the start.
          if (cursor === undefined || restarted)
            throw new Error("dohc could not list this workspace's shares.");
          restarted = true;
          invited.length = 0;
          onLinkShares.length = 0;
          seen.clear();
          cursor = undefined;
          continue;
        }
        for (const row of answer.rows) {
          const { selector } = row.kind === "share" ? row : { selector: null };
          if (
            row.kind !== "share" ||
            (row.via !== "named" && row.via !== "dependent") ||
            row.status !== "active" ||
            selector === null ||
            selector.kind !== undefined
          )
            continue;
          if (
            !rowMatchesTarget(
              { selector: { paths: selector.paths, versionId: selector.versionId } },
              target,
            )
          )
            continue;
          (row.via === "named" ? invited : onLinkShares).push({
            shareId: row.shareId,
            grantId: row.grantId,
            name: row.recipientEmail ?? row.recipientUserId ?? "Unnamed person",
            email: row.recipientEmail,
            access: isShareAccess(row.access) ? row.access : null,
            generation: row.generation,
            signedIn: row.recipientUserId !== null,
          });
        }
        if (answer.nextCursor === null) break;
        if (seen.has(answer.nextCursor))
          throw new Error("dohc could not list all of this workspace's shares.");
        seen.add(answer.nextCursor);
        cursor = answer.nextCursor;
      }
      return { invited, onLinkShares };
    },
  });
  const { retry } = query;
  useEffect(() => {
    if (read) void retry();
  }, [read, retry, revision]);
  return {
    people: query.value?.invited ?? NO_PEOPLE,
    onLinkShares: query.value?.onLinkShares ?? NO_PEOPLE,
    read: query.value != null,
    failed: query.error !== null,
    load: retry,
  };
}

export function RelayShareDialog(props: {
  workspaceId: string;
  target: RelayShareTarget;
  onClose: () => void;
  // Ending a link or a person's access: the shell shows the notice and its Undo.
  shareRemovals?: ShareRemovalNotices;
  // The shell's useDisconnectedLinkAgents set, so a link's Agents list leaves them out.
  disconnectedAgents?: ReadonlySet<string>;
  // What About's Access reads, so Share names the same cause.
  accessContext: AccessContext;
  server: string | null;
  // New notes the server has no file for until their open editor is left.
  notSentWhileOpen?: readonly string[];
}) {
  // The form shows but takes no input while a cause dohc can name stops a
  // share, or while it is still read. Nothing is read from the server until
  // then. Main still refuses a share it cannot make, as when sync stops while
  // the dialog is open.
  const reason = accessReasonForLane(props.accessContext.facts, "granted");
  const held = reason !== "unexplained";
  const scope = shareScope(props.workspaceId, props.target);
  const [invitedRevision, setInvitedRevision] = useState(0);
  const scopeNow = useRef(scope);
  scopeNow.current = scope;
  const [removedHere, setRemovedHere] = useState<GrantsOfScope>({ scope, grantIds: [] });
  const removedNow = grantsIn(removedHere, scope);
  const [invitedByCodeOnly, setInvitedByCodeOnly] = useState<GrantsOfScope>({
    scope,
    grantIds: [],
  });
  const invited = useSharedPeople({
    workspaceId: props.workspaceId,
    target: props.target,
    scope,
    read: !held,
    revision: invitedRevision,
  });
  const loadInvited = invited.load;
  const reloadInvited = () => setInvitedRevision((revision) => revision + 1);
  const local = useLocalPeople(scope, invited.people, invited.read);
  const independent = useLocalPeople(scope, invited.onLinkShares, invited.read);
  const linkPane = useRelayShareLinkPane({
    workspaceId: props.workspaceId,
    target: props.target,
    visible: !held,
    onClose: props.onClose,
    people: {
      answered: independent.answered,
      changed: (person) => {
        independent.keep(person);
        reloadInvited();
      },
      removed: independent.retire,
    },
    ...(props.shareRemovals ? { shareRemovals: props.shareRemovals } : {}),
    ...(props.disconnectedAgents ? { disconnectedAgents: props.disconnectedAgents } : {}),
  });
  const invitedPeople = (
    held ? [] : [...local.answered(invited.people), ...local.unlisted(invited.people)]
  ).filter(
    (person) =>
      !linkPane.peopleGrantIds.has(person.grantId) && !removedNow.includes(person.grantId),
  );
  const invitedFailed = !held && invited.failed;

  // While the body scrolls, the title sits in a band with a rule. The band
  // keeps the dialog's 20px inset, so only the rule comes in.
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScrolls(body.scrollHeight > body.clientHeight));
    observer.observe(body);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      data-testid="share-dialog"
      data-scrolls={scrolls ? "" : undefined}
      className={`dohc-elevated flex w-120 max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-line bg-panel ${scrolls ? "" : "gap-3 p-5"} ${DIALOG_HEIGHT_CLASS}`}
    >
      <div
        className={`flex items-center gap-2 ${scrolls ? "border-b border-line px-5 pb-4 pt-5" : ""}`}
      >
        <ShareTitle target={props.target} />
        <IconButton aria-label="Close" title="Close" onClick={linkPane.close}>
          <X size={13} aria-hidden />
        </IconButton>
      </div>

      {/* A control's halo draws inset here, where the scroller would clip it. */}
      <div
        ref={bodyRef}
        data-testid="share-dialog-body"
        className={`relative min-h-0 overflow-y-auto [&_:focus-visible]:-outline-offset-2 ${scrolls ? "px-5 pb-5 pt-4" : "-mx-5 -my-1 px-5 py-1"}`}
      >
        <div ref={contentRef} className="flex flex-col gap-3">
          <ShareSetup
            reason={reason}
            context={props.accessContext}
            server={props.server}
            onLeave={linkPane.close}
          />
          {held ? null : <NotSent target={props.target} notSent={props.notSentWhileOpen ?? []} />}

          <div
            inert={held || undefined}
            className={held ? "flex flex-col gap-6 opacity-50" : "flex flex-col gap-6"}
          >
            <EmailShareForm
              key={scope}
              workspaceId={props.workspaceId}
              target={props.target}
              retiredGrantIds={local.retired}
              onCreated={({ browserInvitation, ...person }) => {
                local.keep({ ...person, email: person.name, generation: 1 });
                if (!browserInvitation && invitationCanBeBrowserLink(person.access, props.target))
                  setInvitedByCodeOnly((current) => ({
                    scope,
                    grantIds: [...grantsIn(current, scope), person.grantId],
                  }));
                reloadInvited();
              }}
            />

            {invitedPeople.length > 0 || invitedFailed || linkPane.people !== null ? (
              <section
                data-testid="share-people"
                className="flex flex-col gap-1"
                aria-labelledby="share-people-heading"
              >
                <SectionLabel as="h3" id="share-people-heading" className="m-0">
                  People with access
                </SectionLabel>
                {invitedFailed ? (
                  <RetryRow testId="share-people-failed" onRetry={() => void loadInvited()}>
                    dohc could not load the people you invited by email.
                  </RetryRow>
                ) : null}
                {invitedPeople.map((person) => {
                  const removed = (gone: boolean) => {
                    if (scopeNow.current !== scope) return;
                    setRemovedHere((current) => {
                      const others = grantsIn(current, scope).filter(
                        (grantId) => grantId !== person.grantId,
                      );
                      return { scope, grantIds: gone ? [...others, person.grantId] : others };
                    });
                    if (gone) local.retire(person.grantId);
                    reloadInvited();
                  };
                  return (
                    <InvitedPersonRow
                      key={person.grantId}
                      workspaceId={props.workspaceId}
                      target={props.target}
                      person={person}
                      shareRemovals={props.shareRemovals}
                      shareCodeToo={
                        invitationCanBeBrowserLink(person.access, props.target) &&
                        !grantsIn(invitedByCodeOnly, scope).includes(person.grantId)
                      }
                      onEnded={() => {
                        local.retire(person.grantId);
                        void loadInvited();
                      }}
                      onCodeOnly={() => {
                        if (scopeNow.current !== scope) return;
                        if (!invitationCanBeBrowserLink(person.access, props.target)) return;
                        setInvitedByCodeOnly((current) => {
                          const known = grantsIn(current, scope);
                          return known.includes(person.grantId)
                            ? current
                            : { scope, grantIds: [...known, person.grantId] };
                        });
                      }}
                      onAccessChanged={(changed) => {
                        local.keep({ ...person, ...changed });
                        reloadInvited();
                      }}
                      onRemoved={() => removed(true)}
                      onRestored={() => removed(false)}
                    />
                  );
                })}
                {linkPane.people}
              </section>
            ) : null}

            {linkPane.content}
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareTitle(props: { target: RelayShareTarget }) {
  const { target } = props;
  const className = "m-0 flex min-w-0 flex-1 gap-1 text-base font-semibold text-ink";
  if (target.kind === "version") {
    const words = `Share version "${target.versionName ?? target.versionId}"`;
    return (
      <h2 className={className} title={words}>
        <span className="truncate">{words}</span>
      </h2>
    );
  }
  const [first, ...rest] = target.paths;
  const name =
    target.label ?? (rest.length > 0 ? `${target.paths.length} items` : splitPath(first).name);
  return (
    <h2 className={className}>
      {"Share "}
      <NameLine name={name || first} title={target.paths.join(", ")} />
    </h2>
  );
}

function InvitedPersonRow(props: {
  workspaceId: string;
  target: RelayShareTarget;
  person: ListedPerson;
  shareRemovals: ShareRemovalNotices | undefined;
  shareCodeToo: boolean;
  onEnded: () => void;
  onCodeOnly: () => void;
  onAccessChanged: (changed: ChangedAccess) => void;
  onRemoved: () => void;
  onRestored: () => void;
}) {
  const { person, workspaceId, shareRemovals } = props;
  const invitation = useInvitation(person, props.onEnded, props.onCodeOnly);
  const invitationCopy = useCopy({
    getText: () => invitation("invitation"),
    words: { copied: "Invitation copied" },
    sensitive: INVITATION_SECRET,
  });
  const codeCopy = useCopy({
    getText: () => invitation("code"),
    words: { copied: "Share code copied" },
    sensitive: SHARE_CODE_SECRET,
  });
  const [copiedLast, setCopiedLast] = useState<InvitationPart>("invitation");
  const copied = copiedLast === "code" ? codeCopy : invitationCopy;
  const resend = useInvitationResend(workspaceId, person, "on-row");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const subject = `${person.name}'s access to ${targetLabel(props.target)}`;

  async function remove() {
    setRemoving(true);
    setRemoveError(null);
    try {
      await removePersonAccess({
        workspaceId,
        person,
        subject,
        shareRemovals,
        restored: props.onRestored,
      });
      props.onRemoved();
    } catch (cause) {
      const message = `dohc could not end ${subject}.`;
      if (shown.current) setRemoveError(withErrorWords(message, cause));
      else shareRemovals?.failed({ workspaceId, message, cause, retry: () => void remove() });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <PersonAccessRow
      testId={`share-invited-${person.grantId}`}
      workspaceId={workspaceId}
      target={props.target}
      person={person}
      detail={
        <>
          {copied.feedback !== null ? (
            <span className={copied.feedback === "failed" ? "text-danger" : undefined}>
              {copied.words[copied.feedback]}
            </span>
          ) : resend.words !== null ? (
            <span className={resend.failed ? "text-danger" : undefined}>{resend.words}</span>
          ) : (
            invitedByEmailWords(person.signedIn)
          )}
          <span role="status" aria-live="polite" className="sr-only">
            {copied.feedback === null && resend.words !== null ? resend.words : copied.announcement}
          </span>
        </>
      }
      busy={removing}
      actions={[
        {
          id: "copy-invitation",
          label: "Copy invitation",
          testId: `share-copy-invitation-${person.grantId}`,
          onSelect: () => {
            setCopiedLast("invitation");
            resend.forget();
            invitationCopy.copy();
          },
        },
        resendInvitationEntry(resend, `share-resend-invitation-${person.grantId}`),
        ...(props.shareCodeToo
          ? [
              {
                id: "copy-code",
                label: "Copy share code",
                testId: `share-copy-code-${person.grantId}`,
                onSelect: () => {
                  setCopiedLast("code");
                  resend.forget();
                  codeCopy.copy();
                },
              },
            ]
          : []),
        {
          id: "remove",
          label: "Remove access",
          danger: true,
          testId: `share-remove-${person.grantId}`,
          onSelect: () => void remove(),
        },
      ]}
      onAccessChanged={props.onAccessChanged}
    >
      {removeError ? (
        <PersonRemovalError grantId={person.grantId} busy={removing} onRetry={() => void remove()}>
          {removeError}
        </PersonRemovalError>
      ) : null}
    </PersonAccessRow>
  );
}

// Why sharing cannot work yet, with the one action that changes it: the
// one About's Access offers for the same cause.
function ShareSetup(props: {
  reason: AccessReason;
  context: AccessContext;
  server: string | null;
  onLeave: () => void;
}) {
  const { context, server } = props;
  switch (props.reason) {
    case "checking":
    case "unexplained":
      return null;
    case "not-synced":
      return (
        <SetupBand
          reason="not-synced"
          icon={CloudOff}
          action="Set up sync"
          run={context.openSyncSettings}
          onLeave={props.onLeave}
        >
          <p className="m-0">Sharing needs sync.</p>
        </SetupBand>
      );
    case "signed-out":
      return (
        <SetupBand
          reason="signed-out"
          icon={LogIn}
          action="Connect server"
          run={context.connect}
          onLeave={props.onLeave}
        >
          <p className="m-0">
            Not connected to{" "}
            {server === null ? (
              "this workspace's server"
            ) : (
              <span className="font-medium">{serverName(server)}</span>
            )}
            .
          </p>
          <p className="m-0 text-muted">Others may have access.</p>
        </SetupBand>
      );
    case "other-account":
      return (
        <SetupBand
          reason="other-account"
          icon={CloudOff}
          action="Sync and sharing"
          run={context.openSyncSettings}
          onLeave={props.onLeave}
        >
          <p className="m-0">{SYNC_UNCONFIRMED_ACCOUNT} Resume sync to share.</p>
        </SetupBand>
      );
  }
}

// A link to a new note shows no file until the note's open editor is left.
function NotSent(props: { target: RelayShareTarget; notSent: readonly string[] }) {
  const words =
    props.target.kind === "paths" ? notSentWords(props.target.paths, props.notSent) : null;
  if (!words) return null;
  return (
    <div
      data-testid="share-not-sent"
      className="flex items-center gap-2 rounded-lg bg-panel-2 p-2 text-[12px] leading-4 text-ink"
    >
      <CloudUpload size={14} aria-hidden className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="m-0">{words.state}</p>
        <p className="m-0 text-muted">{words.next}</p>
      </div>
    </div>
  );
}

// The action opens its own place, so the dialog closes first.
function SetupBand(props: {
  reason: AccessReason;
  icon: LucideIcon;
  action: string;
  run: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div
      data-testid="share-setup"
      data-reason={props.reason}
      className="flex items-center gap-2 rounded-lg bg-panel-2 p-2 text-[12px] leading-4 text-ink"
    >
      <Icon size={14} aria-hidden className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">{props.children}</div>
      <PrimaryButton
        size="compact"
        className="shrink-0"
        onClick={() => {
          props.onLeave();
          props.run();
        }}
      >
        {props.action}
      </PrimaryButton>
    </div>
  );
}

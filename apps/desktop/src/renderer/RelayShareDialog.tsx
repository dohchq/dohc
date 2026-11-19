import { CloudOff, CloudUpload, LogIn, X, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { bridge } from "./bridge";
import { SYNC_UNCONFIRMED_ACCOUNT } from "./cloudSyncWords";
import { EmailShareForm } from "./EmailShareForm";
import { ipcErrorMessage } from "./ipcError";
import { notSentWords } from "./notSentWords";
import { INVITATION_SECRET } from "./shareCopySecrets";
import {
  isShareAccess,
  PersonAccessRow,
  type ChangedAccess,
  type SharedPerson,
} from "./sharePerson";
import type { ShareRemovalNotices } from "./shell/useShareRemovalNotices";
import { FieldError, IconButton, PrimaryButton, RetryRow, SectionLabel } from "./ui/controls";
import { useCopy } from "./ui/CopyButton";
import { NameLine } from "./ui/NameLine";
import { splitPath } from "./ui/PathLine";
import { rowMatchesTarget, targetLabel, useRelayShareLinkPane } from "./useRelayShareLinkPane";
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

type InvitedPerson = SharedPerson & { generation: number | null };

const listedSince = (person: InvitedPerson, changed: ChangedAccess) =>
  person.generation !== null && person.generation >= changed.generation;

function shownAccess(person: InvitedPerson, changed: ChangedAccess | undefined) {
  return changed && !listedSince(person, changed) ? changed.access : person.access;
}

type InvitationClick = {
  resolve: (text: string | null) => void;
  reject: (error: unknown) => void;
};

let newestInvitationCopy = 0;

function useInvitation(
  person: Pick<InvitedPerson, "shareId" | "grantId">,
  reload: () => Promise<unknown>,
): () => Promise<string | null> {
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
          void reload();
          click?.resolve(null);
        } else click?.resolve(details.browserInvitationUrl ?? details.shareCode);
        return details.status;
      } catch (error) {
        if (!signal.aborted) click?.reject(error);
        throw error;
      }
    },
  });
  return () =>
    new Promise<string | null>((resolve, reject) => {
      const copy = ++newestInvitationCopy;
      const newest = () => copy === newestInvitationCopy;
      const click: InvitationClick = {
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

// The people this selection was shared with by email, from the listing the
// Sharing view reads. `scope` names the workspace and the selection. The
// list is read while sharing can work, and again whenever `revision` changes.
function useInvitedPeople(input: {
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
      const people: InvitedPerson[] = [];
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
          people.length = 0;
          seen.clear();
          cursor = undefined;
          continue;
        }
        for (const row of answer.rows) {
          const { selector } = row.kind === "share" ? row : { selector: null };
          if (
            row.kind !== "share" ||
            row.via !== "named" ||
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
          people.push({
            shareId: row.shareId,
            grantId: row.grantId,
            name: row.recipientEmail ?? row.recipientUserId ?? "Unnamed person",
            email: row.recipientEmail,
            access: isShareAccess(row.access) ? row.access : null,
            generation: row.generation,
          });
        }
        if (answer.nextCursor === null) break;
        if (seen.has(answer.nextCursor))
          throw new Error("dohc could not list all of this workspace's shares.");
        seen.add(answer.nextCursor);
        cursor = answer.nextCursor;
      }
      return people;
    },
  });
  const { retry } = query;
  useEffect(() => {
    if (read) void retry();
  }, [read, retry, revision]);
  return { people: query.value ?? [], failed: query.error !== null, load: retry };
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
  const linkPane = useRelayShareLinkPane({
    workspaceId: props.workspaceId,
    target: props.target,
    visible: !held,
    onClose: props.onClose,
    ...(props.shareRemovals ? { shareRemovals: props.shareRemovals } : {}),
    ...(props.disconnectedAgents ? { disconnectedAgents: props.disconnectedAgents } : {}),
  });
  // A person invited in this dialog shows at once, before the listing has them.
  const [invitedHere, setInvitedHere] = useState<{ scope: string; people: InvitedPerson[] }>({
    scope: linkPane.scope,
    people: [],
  });
  const [invitedRevision, setInvitedRevision] = useState(0);
  const [changedAccess, setChangedAccess] = useState<{
    scope: string;
    byGrant: Readonly<Record<string, ChangedAccess>>;
  }>({ scope: linkPane.scope, byGrant: {} });
  const accessNow = changedAccess.scope === linkPane.scope ? changedAccess.byGrant : {};
  const [removedHere, setRemovedHere] = useState<{ scope: string; grantIds: readonly string[] }>({
    scope: linkPane.scope,
    grantIds: [],
  });
  const removedNow = removedHere.scope === linkPane.scope ? removedHere.grantIds : [];
  const invited = useInvitedPeople({
    workspaceId: props.workspaceId,
    target: props.target,
    scope: linkPane.scope,
    read: !held,
    revision: invitedRevision,
  });
  const loadInvited = invited.load;
  const listedNow = invited.people;
  useEffect(() => {
    setChangedAccess((current) => {
      const kept = Object.entries(current.byGrant).filter(
        ([grantId, changed]) =>
          !listedNow.some((person) => person.grantId === grantId && listedSince(person, changed)),
      );
      return kept.length === Object.keys(current.byGrant).length
        ? current
        : { ...current, byGrant: Object.fromEntries(kept) };
    });
  }, [listedNow]);
  const listed = held ? [] : invited.people;
  const invitedPeople = [
    ...listed,
    ...(held || invitedHere.scope !== linkPane.scope ? [] : invitedHere.people).filter(
      (person) => !listed.some((known) => known.grantId === person.grantId),
    ),
    // A share with links lists its people through its links.
  ].filter(
    (person) =>
      !linkPane.peopleShareIds.has(person.shareId) && !removedNow.includes(person.grantId),
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
      className={`dohc-elevated flex w-105 flex-col rounded-xl border border-line bg-panel ${scrolls ? "" : "gap-3 p-5"} ${DIALOG_HEIGHT_CLASS}`}
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
        className={`min-h-0 overflow-y-auto [&_:focus-visible]:-outline-offset-2 ${scrolls ? "px-5 pb-5 pt-4" : "-mx-5 -my-1 px-5 py-1"}`}
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
              key={linkPane.scope}
              workspaceId={props.workspaceId}
              target={props.target}
              removedGrantIds={removedNow}
              onCreated={(person) => {
                const scope = linkPane.scope;
                setInvitedHere((current) => ({
                  scope,
                  people: [
                    ...(current.scope === scope ? current.people : []),
                    { ...person, email: person.name, generation: 1 },
                  ],
                }));
                setInvitedRevision((revision) => revision + 1);
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
                  const scope = linkPane.scope;
                  const removed = (gone: boolean) => {
                    setRemovedHere((current) => {
                      const others = (current.scope === scope ? current.grantIds : []).filter(
                        (grantId) => grantId !== person.grantId,
                      );
                      return { scope, grantIds: gone ? [...others, person.grantId] : others };
                    });
                    if (gone)
                      setInvitedHere((current) => ({
                        ...current,
                        people: current.people.filter((here) => here.grantId !== person.grantId),
                      }));
                    setInvitedRevision((revision) => revision + 1);
                  };
                  return (
                    <InvitedPersonRow
                      key={person.grantId}
                      workspaceId={props.workspaceId}
                      target={props.target}
                      person={{
                        ...person,
                        access: shownAccess(person, accessNow[person.grantId]),
                      }}
                      reload={loadInvited}
                      shareRemovals={props.shareRemovals}
                      onAccessChanged={(changed) => {
                        setChangedAccess((current) => ({
                          scope,
                          byGrant: {
                            ...(current.scope === scope ? current.byGrant : {}),
                            [person.grantId]: changed,
                          },
                        }));
                        setInvitedRevision((revision) => revision + 1);
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
  person: InvitedPerson;
  reload: () => Promise<unknown>;
  shareRemovals: ShareRemovalNotices | undefined;
  onAccessChanged: (changed: ChangedAccess) => void;
  onRemoved: () => void;
  onRestored: () => void;
}) {
  const { person, workspaceId, shareRemovals } = props;
  const invitation = useInvitation(person, props.reload);
  const copied = useCopy({
    getText: invitation,
    words: { copied: "Invitation copied" },
    sensitive: INVITATION_SECRET,
  });
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removeErrorId = useId();
  const subject = `the share of ${targetLabel(props.target)} with ${person.name}`;

  async function remove() {
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await bridge().revokeRelayShare({ shareId: person.shareId });
      shareRemovals?.removed({
        workspaceId,
        shareId: person.shareId,
        undo: result.undo,
        message: result.undo
          ? `Ended ${subject}.`
          : `${subject[0]!.toUpperCase()}${subject.slice(1)} has already ended.`,
        restoredMessage: `Restored ${subject}.`,
        restored: props.onRestored,
      });
      props.onRemoved();
    } catch (cause) {
      const message = `dohc could not end ${subject}.`;
      if (shareRemovals)
        shareRemovals.failed({ workspaceId, message, cause, retry: () => void remove() });
      else setRemoveError(ipcErrorMessage(cause, message));
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
          {copied.feedback === null ? (
            "Invited by email"
          ) : (
            <span className={copied.feedback === "failed" ? "text-danger" : undefined}>
              {copied.words[copied.feedback]}
            </span>
          )}
          <span role="status" aria-live="polite" className="sr-only">
            {copied.announcement}
          </span>
        </>
      }
      busy={removing}
      actions={[
        {
          id: "copy-invitation",
          label: "Copy invitation",
          testId: `share-copy-invitation-${person.grantId}`,
          onSelect: copied.copy,
        },
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
        <FieldError id={removeErrorId} testId={`share-remove-error-${person.grantId}`}>
          {removeError}
        </FieldError>
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

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ResendRelayShareInvitationResult, ShareAccess } from "../ipc/bridgeContract";
import { AutomationShareNote, useAutomationShareCheck } from "./automationShareCheck";
import { bridge } from "./bridge";
import { accessOptions, invitationEmailNote } from "./EmailShareForm";
import { ipcErrorMessage } from "./ipcError";
import type { RelayShareTarget } from "./RelayShareDialog";
import {
  SHARE_ACCESS_WORDS,
  SHARE_ROW_INSET,
  ShareAccessMenu,
  ShareOptionsMenu,
  SharePersonRow,
} from "./shareAccess";
import type { ShareRemovalNotices } from "./shell/useShareRemovalNotices";
import {
  ShellErrorReporter,
  ShellNoticeClear,
  type ReportShellFailure,
} from "./shell/useShellError";
import { FieldError, SecondaryButton } from "./ui/controls";
import type { MenuEntry } from "./ui/Menu";
import { useRequestSequence } from "./useRequestSequence";

export type SharedPerson = {
  shareId: string;
  grantId: string;
  name: string;
  email: string | null;
  access: ShareAccess | null;
  signedIn?: boolean;
};

export type ChangedAccess = { access: ShareAccess; generation: number };

export const isShareAccess = (access: string | null): access is ShareAccess =>
  access !== null && Object.hasOwn(SHARE_ACCESS_WORDS, access);

export type ListedPerson = SharedPerson & { generation: number | null };
export type AnsweredPerson = SharedPerson & { generation: number };
type LocalPerson = { person: AnsweredPerson; listed: boolean };
type LocalPeople = {
  scope: string;
  visit: number;
  byGrant: Readonly<Record<string, LocalPerson>>;
  retired: readonly string[];
};

const NO_LOCAL_PEOPLE: Readonly<Record<string, LocalPerson>> = {};
const NO_RETIRED: readonly string[] = [];
const noLocalPeople = (scope: string, visit = 0): LocalPeople => ({
  scope,
  visit,
  byGrant: NO_LOCAL_PEOPLE,
  retired: NO_RETIRED,
});

const isVersioned = (person: ListedPerson | undefined): person is AnsweredPerson =>
  person !== undefined && person.generation !== null;

/**
 * The people Share knows from the relay's own answers: a person invited here,
 * or one whose access changed here. `listing` is the newest list of grants
 * with their generations that was read, and a failed read leaves it as it
 * was. `read` is false while no list has been read, and then `listing`
 * says nothing about who has access. An answer stands while that list holds
 * the grant at an older generation, or not yet. A grant the list has held and
 * a later list leaves out has ended, so it goes and joins `retired`.
 */
export function useLocalPeople(scope: string, listing: readonly ListedPerson[], read: boolean) {
  const [held, setHeld] = useState(() => noLocalPeople(scope));
  const visiting = held.scope === scope ? held : noLocalPeople(scope, held.visit + 1);
  if (visiting !== held) setHeld(visiting);
  const { byGrant, retired, visit } = visiting;
  const newestListing = useRef(listing);
  newestListing.current = listing;
  const visitNow = useRef(visit);
  visitNow.current = visit;
  useEffect(() => {
    if (!read) return;
    setHeld((current) => {
      if (current.scope !== scope) return current;
      let changed = false;
      const kept: Record<string, LocalPerson> = {};
      const leftOut: string[] = [];
      for (const [grantId, local] of Object.entries(current.byGrant)) {
        const listed = listing.some((person) => person.grantId === grantId);
        if (listed === local.listed) kept[grantId] = local;
        else {
          changed = true;
          if (listed) kept[grantId] = { ...local, listed };
          else if (!current.retired.includes(grantId)) leftOut.push(grantId);
        }
      }
      return changed
        ? { ...current, byGrant: kept, retired: [...current.retired, ...leftOut] }
        : current;
    });
  }, [listing, read, scope]);
  return {
    /**
     * The people given, each at the access of the newest source that carries a
     * generation: the person as given, their grant in `listing`, or the
     * relay's answer. A person none of them knows keeps the access given.
     */
    answered(people: readonly ListedPerson[]): ListedPerson[] {
      return people.map((person) => {
        const newest = [
          person,
          listing.find((listed) => listed.grantId === person.grantId),
          byGrant[person.grantId]?.person,
        ]
          .filter(isVersioned)
          .reduce<AnsweredPerson | null>(
            (best, known) => (best === null || known.generation > best.generation ? known : best),
            null,
          );
        return newest
          ? { ...person, access: newest.access, generation: newest.generation }
          : person;
      });
    },
    /** The people known only from an answer, whom no list holds yet. */
    unlisted(listed: readonly ListedPerson[]): ListedPerson[] {
      return Object.values(byGrant)
        .map((local) => local.person)
        .filter((person) => !listed.some((known) => known.grantId === person.grantId));
    },
    /** The grants that ended: retired here, or left out by a list that had held them. */
    retired,
    keep(person: AnsweredPerson) {
      if (visitNow.current !== visit) return;
      const listed = newestListing.current.some((known) => known.grantId === person.grantId);
      setHeld((current) => {
        if (current.visit !== visit) return current;
        return {
          ...current,
          byGrant: { ...current.byGrant, [person.grantId]: { person, listed } },
        };
      });
    },
    retire(grantId: string) {
      if (visitNow.current !== visit) return;
      setHeld((now) => {
        if (now.visit !== visit) return now;
        return {
          ...now,
          byGrant: Object.fromEntries(
            Object.entries(now.byGrant).filter(([kept]) => kept !== grantId),
          ),
          retired: now.retired.includes(grantId) ? now.retired : [...now.retired, grantId],
        };
      });
    },
  };
}

export async function removePersonAccess(input: {
  workspaceId: string;
  person: Pick<SharedPerson, "shareId" | "grantId">;
  subject: string;
  shareRemovals: ShareRemovalNotices | undefined;
  restored: () => void;
}): Promise<void> {
  const { workspaceId, person, subject } = input;
  const result = await bridge().revokeRelayShareGrant({
    workspaceId,
    shareId: person.shareId,
    grantId: person.grantId,
  });
  input.shareRemovals?.removed({
    workspaceId,
    shareId: person.shareId,
    undo: result.undo,
    message: `Ended ${subject}.`,
    restoredMessage: `Restored ${subject}.`,
    restored: input.restored,
  });
}

export function PersonRemovalError(props: {
  grantId: string;
  busy: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <FieldError id={id} testId={`share-remove-error-${props.grantId}`}>
        {props.children}
      </FieldError>
      <SecondaryButton
        size="compact"
        disabled={props.busy}
        aria-describedby={id}
        data-testid={`share-remove-retry-${props.grantId}`}
        onClick={props.onRetry}
      >
        Try again
      </SecondaryButton>
    </div>
  );
}

export const accessNoticeIdentity = (grantId: string) => `share-access:${grantId}`;

let accessChanges = 0;
const newestAccessSuccess = new Map<string, number>();

/**
 * Takes a turn for one change of a grant's level, wherever it is made.
 * `succeeded` records that it worked. `superseded` says a change of the same
 * grant that began later has worked since, so this one's failure is no longer
 * worth a Try again.
 */
export function nextAccessChange(grantId: string) {
  const turn = ++accessChanges;
  return {
    succeeded: () => {
      newestAccessSuccess.set(grantId, Math.max(turn, newestAccessSuccess.get(grantId) ?? 0));
    },
    superseded: () => (newestAccessSuccess.get(grantId) ?? 0) > turn,
  };
}

function reportAccessChangeFailure(change: {
  workspaceId: string;
  person: Pick<SharedPerson, "shareId" | "grantId" | "name">;
  access: ShareAccess;
  cause: unknown;
  turn: ReturnType<typeof nextAccessChange>;
  report: ReportShellFailure;
  clear: ((identity: string) => void) | null;
}): void {
  const { workspaceId, person, access, report, clear } = change;
  if (change.turn.superseded()) return;
  const identity = accessNoticeIdentity(person.grantId);
  report({
    message: `dohc could not change ${person.name}'s access.`,
    cause: change.cause,
    identity,
    retry: () => {
      const turn = nextAccessChange(person.grantId);
      void bridge()
        .retuneRelayShareGrant({
          workspaceId,
          shareId: person.shareId,
          grantId: person.grantId,
          access,
        })
        .then(
          () => {
            turn.succeeded();
            clear?.(identity);
          },
          (cause: unknown) => reportAccessChangeFailure({ ...change, cause, turn }),
        );
    },
  });
}

export const invitationEmailNoticeIdentity = (grantId: string) =>
  `share-invitation-email:${grantId}`;

const SENDING_INVITATION = "Sending the email…";

function invitationResendWords(answer: ResendRelayShareInvitationResult): string {
  switch (answer.invitationEmail) {
    case "sent":
      return "Email invite sent.";
    case "unavailable":
      return "This server sends no email.";
    case "limit":
      return invitationEmailNote(answer);
    case "recent":
      return "Tried a moment ago. Try again in a minute.";
    case "failed":
      return "The email could not be sent.";
  }
}

type InvitationResendState = ResendRelayShareInvitationResult | "sending";
const invitationResends = new Map<string, InvitationResendState>();
const invitationResendRows = new Map<string, Set<() => void>>();

function setInvitationResend(grantId: string, state: InvitationResendState | null): void {
  if (state === null) invitationResends.delete(grantId);
  else invitationResends.set(grantId, state);
  for (const changed of invitationResendRows.get(grantId) ?? []) changed();
}

function showInvitationResend(grantId: string, changed: () => void): () => void {
  const rows = invitationResendRows.get(grantId) ?? new Set();
  invitationResendRows.set(grantId, rows.add(changed));
  return () => {
    rows.delete(changed);
    queueMicrotask(() => {
      if (rows.size > 0 || invitationResendRows.get(grantId) !== rows) return;
      invitationResendRows.delete(grantId);
      if (invitationResends.get(grantId) !== "sending") invitationResends.delete(grantId);
    });
  };
}

type InvitationResend = {
  workspaceId: string;
  person: Pick<SharedPerson, "shareId" | "grantId" | "name">;
  report: ReportShellFailure | null;
  clear: ((identity: string) => void) | null;
  failure: "on-row" | "on-row-and-reported";
};

function resendInvitation(resend: InvitationResend): void | false {
  const { workspaceId, person } = resend;
  const { grantId } = person;
  if (invitationResends.get(grantId) === "sending") return false;
  setInvitationResend(grantId, "sending");
  void bridge()
    .resendRelayShareInvitation({ workspaceId, shareId: person.shareId, grantId })
    .then(
      (answer) => ({ answer, cause: undefined }),
      (cause: unknown) => ({ answer: { invitationEmail: "failed" as const }, cause }),
    )
    .then(({ answer, cause }) => {
      setInvitationResend(grantId, answer);
      const identity = invitationEmailNoticeIdentity(grantId);
      const onRow = (invitationResendRows.get(grantId)?.size ?? 0) > 0;
      if (answer.invitationEmail === "sent") resend.clear?.(identity);
      else if (
        !onRow ||
        (answer.invitationEmail === "failed" && resend.failure === "on-row-and-reported")
      )
        resend.report?.({
          message: `dohc could not email ${person.name} their invitation.`,
          cause:
            answer.invitationEmail === "failed" ? cause : new Error(invitationResendWords(answer)),
          identity,
          retry: () => resendInvitation(resend),
        });
    });
}

/**
 * Resend invitation for one person's row. `words` is what the row's detail
 * line says: that the email is being sent, then the server's answer, until
 * `forget`, the next send, or the person's last row going. Every row of the
 * person reads the same send, however it was started. `failure` says where a
 * send that failed goes while a row of the person shows: Share keeps it on
 * the row, and the Sharing page also reports it to the shell with Try again.
 * With no row showing, any answer but "sent" goes to the shell.
 */
export function useInvitationResend(
  workspaceId: string,
  person: Pick<SharedPerson, "shareId" | "grantId" | "name">,
  failure: InvitationResend["failure"],
) {
  const { shareId, grantId, name } = person;
  const report = useContext(ShellErrorReporter);
  const clear = useContext(ShellNoticeClear);
  const state = useSyncExternalStore(
    useCallback((changed: () => void) => showInvitationResend(grantId, changed), [grantId]),
    () => invitationResends.get(grantId) ?? null,
  );
  return {
    sending: state === "sending",
    failed: state !== null && state !== "sending" && state.invitationEmail === "failed",
    words:
      state === null
        ? null
        : state === "sending"
          ? SENDING_INVITATION
          : invitationResendWords(state),
    forget: () => {
      if (invitationResends.has(grantId) && invitationResends.get(grantId) !== "sending")
        setInvitationResend(grantId, null);
    },
    send: () =>
      void resendInvitation({
        workspaceId,
        person: { shareId, grantId, name },
        report,
        clear,
        failure,
      }),
  };
}

export function resendInvitationEntry(
  resend: Pick<ReturnType<typeof useInvitationResend>, "sending" | "send">,
  testId: string,
): MenuEntry {
  return {
    id: "resend-invitation",
    label: "Resend invitation",
    testId,
    disabled: resend.sending,
    ...(resend.sending ? { description: "dohc is sending the email." } : {}),
    onSelect: resend.send,
  };
}

export function PersonAccessRow(props: {
  testId: string;
  workspaceId: string;
  target: RelayShareTarget;
  person: SharedPerson;
  detail?: ReactNode;
  actions: readonly MenuEntry[];
  busy?: boolean;
  onAccessChanged: (changed: ChangedAccess) => void;
  children?: ReactNode;
}) {
  const { person, target, workspaceId } = props;
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<ShareAccess | null>(null);
  const errorId = useId();
  const requests = useRequestSequence([workspaceId]);
  const report = useContext(ShellErrorReporter);
  const clearNotice = useContext(ShellNoticeClear);
  const automations = useAutomationShareCheck(workspaceId, target);
  const options = useMemo(() => {
    const offered = accessOptions(target).map(({ value, description }) => ({
      value,
      description,
      testId: `share-person-access-${person.grantId}-${value}`,
    }));
    return person.access === "comment"
      ? [offered[0]!, { value: "comment" as const }, ...offered.slice(1)]
      : offered;
  }, [person.access, person.grantId, target.kind]);
  const shareOf = (access: ShareAccess) => ({
    recipientEmail: person.email,
    recipientName: person.name,
    access,
    shareId: person.shareId,
  });
  const note = asked ? automations.noteFor(shareOf(asked)) : null;
  const busy = changing || props.busy === true;

  async function change(access: ShareAccess) {
    if (busy || access === person.access) return;
    const token = requests.next();
    const current = () => requests.isCurrent(token);
    const turn = nextAccessChange(person.grantId);
    setError(null);
    setAsked(access);
    setChanging(true);
    try {
      const share = shareOf(access);
      if (automations.asks(share) && !(await automations.mayShare(share, current))) return;
      const changed = await bridge().retuneRelayShareGrant({
        workspaceId,
        shareId: person.shareId,
        grantId: person.grantId,
        access,
      });
      turn.succeeded();
      clearNotice?.(accessNoticeIdentity(person.grantId));
      if (!current()) return;
      props.onAccessChanged({ access: changed.access, generation: changed.generation });
      setAsked(null);
      automations.forget();
    } catch (cause) {
      if (current())
        setError(ipcErrorMessage(cause, `dohc could not change ${person.name}'s access.`));
      else if (report && requests.isCutOff(token))
        reportAccessChangeFailure({
          workspaceId,
          person,
          access,
          cause,
          turn,
          report,
          clear: clearNotice,
        });
    } finally {
      if (current()) setChanging(false);
    }
  }

  const under = [
    note?.warning ? <AutomationShareNote key="note" note={note} /> : null,
    error ? (
      <FieldError key="error" id={errorId} testId={`share-person-error-${person.grantId}`}>
        {error}
      </FieldError>
    ) : null,
  ].filter((part) => part !== null);

  return (
    <div data-testid={props.testId} className="flex flex-col gap-1">
      <SharePersonRow name={person.name} detail={props.detail}>
        {person.access ? (
          <span className="-mr-2 flex shrink-0">
            <ShareAccessMenu
              label={`Access for ${person.name}`}
              access={person.access}
              options={options}
              actions={props.actions}
              disabled={busy}
              testId={`share-person-access-${person.grantId}`}
              width={288}
              align="end"
              onPick={(access) => void change(access)}
            />
          </span>
        ) : (
          <ShareOptionsMenu
            label={`Options for ${person.name}`}
            items={props.actions}
            disabled={busy}
            testId={`share-person-options-${person.grantId}`}
          />
        )}
      </SharePersonRow>
      {under.length > 0 || props.children ? (
        <div className={`flex flex-col gap-1 ${SHARE_ROW_INSET}`}>
          {under}
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

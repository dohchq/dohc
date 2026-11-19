import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ShareAccess } from "../ipc/bridgeContract";
import { AutomationShareNote, useAutomationShareCheck } from "./automationShareCheck";
import { bridge } from "./bridge";
import { accessOptions } from "./EmailShareForm";
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
import { FieldError, SecondaryButton } from "./ui/controls";
import type { MenuEntry } from "./ui/Menu";
import { useRequestSequence } from "./useRequestSequence";

export type SharedPerson = {
  shareId: string;
  grantId: string;
  name: string;
  email: string | null;
  access: ShareAccess | null;
};

export type ChangedAccess = { access: ShareAccess; generation: number };

export const isShareAccess = (access: string | null): access is ShareAccess =>
  access !== null && access in SHARE_ACCESS_WORDS;

export type ListedPerson = SharedPerson & { generation: number | null };
export type AnsweredPerson = SharedPerson & { generation: number };
type LocalPerson = { person: AnsweredPerson; listed: boolean };
type LocalPeople = {
  scope: string;
  byGrant: Readonly<Record<string, LocalPerson>>;
  retired: readonly string[];
};

const NO_LOCAL_PEOPLE: Readonly<Record<string, LocalPerson>> = {};
const NO_RETIRED: readonly string[] = [];
const noLocalPeople = (scope: string): LocalPeople => ({
  scope,
  byGrant: NO_LOCAL_PEOPLE,
  retired: NO_RETIRED,
});

const isVersioned = (person: ListedPerson | undefined): person is AnsweredPerson =>
  person !== undefined && person.generation !== null;

/**
 * The people Share knows from the relay's own answers: a person invited here,
 * or one whose access changed here. `listing` is the newest list of grants
 * with their generations that was read, and a failed read leaves it as it
 * was. An answer stands while that list holds the grant at an older
 * generation, or not yet. A grant the list has held and a later list leaves
 * out has ended, so it goes and joins `retired`.
 */
export function useLocalPeople(scope: string, listing: readonly ListedPerson[]) {
  const [held, setHeld] = useState(() => noLocalPeople(scope));
  const { byGrant, retired } = held.scope === scope ? held : noLocalPeople(scope);
  const newestListing = useRef(listing);
  newestListing.current = listing;
  useEffect(() => {
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
        ? { scope, byGrant: kept, retired: [...current.retired, ...leftOut] }
        : current;
    });
  }, [listing, scope]);
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
      const listed = newestListing.current.some((known) => known.grantId === person.grantId);
      setHeld((current) => {
        const now = current.scope === scope ? current : noLocalPeople(scope);
        return { ...now, byGrant: { ...now.byGrant, [person.grantId]: { person, listed } } };
      });
    },
    retire(grantId: string) {
      setHeld((current) => {
        const now = current.scope === scope ? current : noLocalPeople(scope);
        return {
          scope,
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
      if (!current()) return;
      props.onAccessChanged({ access: changed.access, generation: changed.generation });
      setAsked(null);
      automations.forget();
    } catch (cause) {
      if (current())
        setError(ipcErrorMessage(cause, `dohc could not change ${person.name}'s access.`));
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

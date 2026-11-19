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

const NO_LOCAL_PEOPLE: Readonly<Record<string, LocalPerson>> = {};

const listedSince = (listed: ListedPerson, answered: AnsweredPerson) =>
  listed.generation !== null && listed.generation >= answered.generation;

/**
 * The people Share knows from the relay's own answers: a person invited here,
 * or one whose access changed here. `listing` is the newest list of grants
 * with their generations that was read, and a failed read leaves it as it
 * was. An answer stands until that list holds the grant at the answer's
 * generation or a later one. A grant the list has held and a later list
 * leaves out has ended, so it goes.
 */
export function useLocalPeople(scope: string, listing: readonly ListedPerson[]) {
  const [held, setHeld] = useState<{
    scope: string;
    byGrant: Readonly<Record<string, LocalPerson>>;
  }>({ scope, byGrant: NO_LOCAL_PEOPLE });
  const byGrant = held.scope === scope ? held.byGrant : NO_LOCAL_PEOPLE;
  const newestListing = useRef(listing);
  newestListing.current = listing;
  useEffect(() => {
    setHeld((current) => {
      if (current.scope !== scope) return current;
      let changed = false;
      const kept: Record<string, LocalPerson> = {};
      for (const [grantId, local] of Object.entries(current.byGrant)) {
        const listed = listing.find((person) => person.grantId === grantId);
        if (listed ? listedSince(listed, local.person) : local.listed) changed = true;
        else if (listed && !local.listed) {
          changed = true;
          kept[grantId] = { ...local, listed: true };
        } else kept[grantId] = local;
      }
      return changed ? { scope, byGrant: kept } : current;
    });
  }, [listing, scope]);
  return {
    /** The listed people, each at the access the relay answered while the list is older. */
    answered(listed: readonly ListedPerson[]): ListedPerson[] {
      return listed.map((person) => {
        const answered = byGrant[person.grantId]?.person;
        return answered && !listedSince(person, answered)
          ? { ...person, access: answered.access }
          : person;
      });
    },
    /** The people known only from an answer, whom no list holds yet. */
    unlisted(listed: readonly ListedPerson[]): ListedPerson[] {
      return Object.values(byGrant)
        .map((local) => local.person)
        .filter((person) => !listed.some((known) => known.grantId === person.grantId));
    },
    keep(person: AnsweredPerson) {
      const listed = newestListing.current.some((known) => known.grantId === person.grantId);
      setHeld((current) => ({
        scope,
        byGrant: {
          ...(current.scope === scope ? current.byGrant : NO_LOCAL_PEOPLE),
          [person.grantId]: { person, listed },
        },
      }));
    },
    drop(grantId: string) {
      setHeld((current) => {
        if (current.scope !== scope || !(grantId in current.byGrant)) return current;
        return {
          scope,
          byGrant: Object.fromEntries(
            Object.entries(current.byGrant).filter(([held]) => held !== grantId),
          ),
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

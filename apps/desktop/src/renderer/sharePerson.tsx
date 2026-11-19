import { useId, useMemo, useState, type ReactNode } from "react";
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
import { FieldError } from "./ui/controls";
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
      if (
        person.email !== null &&
        automations.asks(share) &&
        !(await automations.mayShare(share, current))
      )
        return;
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

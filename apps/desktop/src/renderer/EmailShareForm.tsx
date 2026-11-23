import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isComposingKey } from "./ui/keys";
import type {
  CreateRelaySharePayload,
  CreateRelayShareResult,
  ShareAccess,
} from "../ipc/bridgeContract";
import { AutomationShareNote, useAutomationShareCheck } from "./automationShareCheck";
import type { RelayShareTarget } from "./RelayShareDialog";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { PrimaryButton } from "./ui/controls";
import { CopyButton } from "./ui/CopyButton";
import { nextInvitationCopy } from "./invitationCopy";
import { SHARE_ACCESS_DESCRIPTIONS, ShareAccessMenu } from "./shareAccess";
import { INVITATION_SECRET } from "./shareCopySecrets";
import { useRequestSequence } from "./useRequestSequence";

export function accessOptions(
  _target: RelayShareTarget,
): ReadonlyArray<{ value: ShareAccess; description: string; testId: string }> {
  return (["view", "edit"] as const).map((value) => ({
    value,
    description: SHARE_ACCESS_DESCRIPTIONS[value],
    testId: `share-access-${value}`,
  }));
}

function whyNoEmail(
  result: Pick<CreateRelayShareResult, "invitationEmail" | "invitationEmailLimit">,
): string {
  const limit = result.invitationEmailLimit;
  if (result.invitationEmail === "limit" && limit)
    return `No email sent: ${limit.sent} of ${limit.limit} invitation emails used in the last ${limit.windowHours} ${limit.windowHours === 1 ? "hour" : "hours"}.`;
  if (result.invitationEmail === "failed") return "dohc could not send the email.";
  return "Copy the invitation and send it to them.";
}

export function EmailShareForm(props: {
  workspaceId: string;
  target: RelayShareTarget;
  // People whose invitation this form no longer offers to copy: their access
  // was removed here, or it ended.
  retiredGrantIds?: readonly string[];
  // A share was made, so whoever lists this selection's people shows them.
  onCreated?: (person: {
    shareId: string;
    grantId: string;
    name: string;
    access: ShareAccess;
    browserInvitation: boolean;
  }) => void;
}) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<ShareAccess>("view");
  const [phase, setPhase] = useState<"idle" | "checking" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [made, setInvited] = useState<{
    result: CreateRelayShareResult;
    share: { recipientEmail: string; access: ShareAccess };
  } | null>(null);
  const invited = made && !props.retiredGrantIds?.includes(made.result.grantId) ? made : null;
  const emailId = useId();
  const form = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // RelayShareDialog keys this form by the canonical target, so changing the
  // target unmounts it and drops its pending work.
  const requests = useRequestSequence([props.workspaceId]);
  const automations = useAutomationShareCheck(props.workspaceId, props.target);
  useEffect(() => {
    setInvited(null);
    setPhase("idle");
    setError(null);
  }, [props.workspaceId]);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    const free = focused === null || focused === document.body;
    if (made && (free || form.current?.contains(focused))) field.current?.focus();
  }, [made]);

  const busy = phase !== "idle";
  const canSubmit = useMemo(() => email.trim().length > 2 && !busy, [busy, email]);
  const share = { recipientEmail: email.trim(), access };
  const note = automations.noteFor(share);
  const invitedNote = invited ? automations.noteFor(invited.share) : null;
  const options = accessOptions(props.target);

  // An edit during the automation check drops it, so Invite always acts on
  // the share on screen. Once the share is being made, the fields wait.
  function edit(apply: () => void) {
    if (phase === "checking") {
      requests.next();
      setPhase("idle");
    }
    apply();
  }

  async function createShare() {
    if (!canSubmit) return;
    const token = requests.next();
    const current = () => requests.isCurrent(token);
    const asked = { ...share };
    const warned = automations.noteFor(asked)?.warning != null;
    setError(null);
    if (automations.asks(asked)) {
      setPhase("checking");
      if (!(await automations.mayShare(asked, current))) {
        if (current()) setPhase("idle");
        return;
      }
    }
    setPhase("creating");
    try {
      const payload: CreateRelaySharePayload = {
        workspaceId: props.workspaceId,
        recipientEmail: asked.recipientEmail,
        access: asked.access,
        ...(props.target.kind === "version"
          ? { versionId: props.target.versionId }
          : { paths: props.target.paths }),
      };
      const result = await bridge().createRelayShare(payload);
      if (current()) {
        if (warned) automations.forget();
        setInvited({ result, share: asked });
        setEmail("");
        props.onCreated?.({
          shareId: result.shareId,
          grantId: result.grantId,
          name: result.recipientEmail,
          access: asked.access,
          browserInvitation: result.browserInvitationUrl !== undefined,
        });
      }
    } catch (cause) {
      if (current()) setError(ipcErrorMessage(cause));
    } finally {
      if (current()) setPhase("idle");
    }
  }

  return (
    <div ref={form} className="flex flex-col">
      <div className="flex flex-col gap-1">
        <label htmlFor={emailId} className="text-[12px] font-medium text-muted">
          Invite by email
        </label>
        <div className="flex items-center gap-2">
          <input
            ref={field}
            id={emailId}
            data-testid="share-email"
            type="email"
            value={email}
            disabled={phase === "creating"}
            onChange={(event) => {
              const next = event.currentTarget.value;
              edit(() => setEmail(next));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isComposingKey(event)) void createShare();
            }}
            placeholder="name@example.com"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
          />
          <ShareAccessMenu
            label="Access"
            access={access}
            options={options}
            disabled={phase === "creating"}
            testId="share-access"
            width={288}
            align="end"
            onPick={(next) => edit(() => setAccess(next))}
          />
          <PrimaryButton
            type="button"
            className="shrink-0"
            data-testid="share-create"
            disabled={!canSubmit}
            onClick={() => void createShare()}
          >
            {phase === "checking"
              ? "Checking automations…"
              : phase === "creating"
                ? "Inviting…"
                : note?.warning
                  ? "Invite anyway"
                  : "Invite"}
          </PrimaryButton>
        </div>
      </div>

      {note?.warning || note?.failed ? (
        <div className="mt-2">
          <AutomationShareNote note={note} />
        </div>
      ) : null}
      {error ? (
        <p data-testid="share-error" role="alert" className="m-0 mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div
        data-testid="share-invited"
        className={invited ? "mt-2 flex min-h-6 flex-wrap items-center gap-2" : undefined}
      >
        <p role="status" className="m-0 min-w-48 flex-1 text-[12px] leading-4 text-muted">
          {invited ? (
            invited.result.invitationEmail === "sent" ? (
              <>
                Email invitation sent to{" "}
                <span className="break-words text-ink">{invited.result.recipientEmail}</span>.
              </>
            ) : (
              <>
                Invited{" "}
                <span className="break-words text-ink">{invited.result.recipientEmail}</span>.{" "}
                {whyNoEmail(invited.result)}
              </>
            )
          ) : null}
        </p>
        {invited ? (
          <CopyButton
            key={invited.result.grantId}
            label="Copy invitation"
            copiedLabel="Invitation copied"
            sensitive={INVITATION_SECRET}
            testId="share-invitation-copy"
            getText={() => {
              nextInvitationCopy();
              return invited.result.browserInvitationUrl ?? invited.result.shareCode;
            }}
          />
        ) : null}
      </div>
      {invitedNote?.failed ? (
        <div className="mt-2">
          <AutomationShareNote note={invitedNote} />
        </div>
      ) : null}
    </div>
  );
}

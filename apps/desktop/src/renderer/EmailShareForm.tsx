import { useEffect, useId, useMemo, useState } from "react";
import { isComposingKey } from "./ui/keys";
import type { CreateRelaySharePayload, CreateRelayShareResult, ShareAccess } from "../ipc/bridgeContract";
import { AutomationShareNote, useAutomationShareCheck } from "./automationShareCheck";
import type { RelayShareTarget } from "./RelayShareDialog";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { CopyField } from "./ui/CopyButton";
import { ShareAccessMenu } from "./shareAccess";
import { BROWSER_INVITATION_SECRET, SHARE_CODE_SECRET } from "./shareCopySecrets";
import { useRequestSequence } from "./useRequestSequence";

const READS = "They can read only what you selected";
const HISTORY = "They can see the full History.";

// What each level gives, said where a person chooses it. Only a share of
// files can be edited live in a browser.
function accessOptions(target: RelayShareTarget): ReadonlyArray<{ value: ShareAccess; description: string; testId: string }> {
  const live = target.kind === "paths" ? " In a browser, they can change shared Markdown files live when available." : "";
  return [
    { value: "view", description: `${READS}.`, testId: "share-access-view" },
    { value: "edit", description: `${READS}, and send you changes to accept.${live} ${HISTORY}`, testId: "share-access-edit" },
  ];
}

export function EmailShareForm(props: {
  workspaceId: string;
  target: RelayShareTarget;
  onDone: () => void;
  // A share was made, so whoever lists this selection's people shows them.
  onCreated?: (person: { shareId: string; grantId: string; name: string; access: ShareAccess }) => void;
}) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<ShareAccess>("view");
  const [phase, setPhase] = useState<"idle" | "checking" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateRelayShareResult | null>(null);
  const emailId = useId();
  // RelayShareDialog keys this form by the canonical target, so changing the
  // target unmounts it and drops its pending work.
  const requests = useRequestSequence([props.workspaceId]);
  const automations = useAutomationShareCheck(props.workspaceId, props.target);
  useEffect(() => {
    setCreated(null); setPhase("idle"); setError(null);
  }, [props.workspaceId]);

  const busy = phase !== "idle";
  const canSubmit = useMemo(() => email.trim().length > 2 && !busy, [busy, email]);
  const share = { recipientEmail: email.trim(), access };
  const note = automations.noteFor(share);
  const options = useMemo(() => accessOptions(props.target), [props.target.kind]);

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
        setCreated(result);
        props.onCreated?.({ shareId: result.shareId, grantId: result.grantId, name: result.recipientEmail, access: asked.access });
      }
    } catch (cause) {
      if (current()) setError(ipcErrorMessage(cause));
    } finally {
      if (current()) setPhase("idle");
    }
  }

  return (
    <>
      {created === null ? (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={emailId} className="text-[12px] font-medium text-muted">Invite by email</label>
            <div className="flex items-center gap-2">
              <input
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

          {note?.warning ? <AutomationShareNote note={note} /> : null}
        </>
      ) : (
        <>
          {created.browserInvitationUrl && (
            <>
              <p className="m-0 text-xs leading-relaxed text-muted">
                Send this browser invitation to {created.recipientEmail}. The recipient must sign in with the invited account.
              </p>
              <CopyField label="Copy browser invitation" copiedLabel="Browser invitation copied"
                sensitive={BROWSER_INVITATION_SECRET} copyTestId="share-browser-invitation-copy"
                getText={() => created.browserInvitationUrl ?? null}>
                <code data-testid="share-browser-invitation" data-grant-id={created.grantId} title={created.browserInvitationUrl}>
                  {created.browserInvitationUrl}
                </code>
              </CopyField>
              <p className="m-0 text-xs leading-relaxed text-muted">
                Browser editing lets them change shared Markdown files live when available. Other files use changes you accept.
              </p>
            </>
          )}
          <p className="m-0 text-xs leading-relaxed text-muted">
            Send this code to{" "}
            <span className="font-medium text-ink">{created.recipientEmail}</span> —
            they paste it in dohc under “Open a share”.
          </p>
          <CopyField copyTestId="share-code-copy" getText={() => created.shareCode} sensitive={SHARE_CODE_SECRET}>
            <code data-testid="share-code" title={created.shareCode}>{created.shareCode}</code>
          </CopyField>
          <p className="m-0 text-[11px] leading-relaxed text-subtle">
            You can end this share anytime from Sharing.
          </p>
          <SecondaryButton
            type="button"
            className="self-end"
            data-testid="share-done"
            onClick={props.onDone}
          >
            Done
          </SecondaryButton>
        </>
      )}

      {note?.failed ? <AutomationShareNote note={note} /> : null}
      {error ? (
        <p data-testid="share-error" role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

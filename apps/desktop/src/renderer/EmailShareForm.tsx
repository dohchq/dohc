import { useEffect, useMemo, useState } from "react";
import { isComposingKey } from "./ui/keys";
import type { CreateRelaySharePayload, CreateRelayShareResult, ShareAccess } from "../ipc/bridgeContract";
import { AutomationShareNote, useAutomationShareCheck } from "./automationShareCheck";
import type { RelayShareTarget } from "./RelayShareDialog";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { CopyField } from "./ui/CopyButton";
import { BROWSER_INVITATION_SECRET, SHARE_CODE_SECRET } from "./shareCopySecrets";
import { useRequestSequence } from "./useRequestSequence";

const ACCESS_OPTIONS: ReadonlyArray<{
  value: ShareAccess;
  label: string;
  helper: string;
}> = [
  {
    value: "view",
    label: "View",
    helper: "They can read only what you selected.",
  },
  {
    value: "edit",
    label: "Edit",
    helper: "They can read only what you selected, and send you changes to accept.",
  },
];

export function EmailShareForm(props: {
  workspaceId: string;
  target: RelayShareTarget;
  visible: boolean;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<ShareAccess>("view");
  const [phase, setPhase] = useState<"idle" | "checking" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateRelayShareResult | null>(null);
  // RelayShareDialog keys this form by the canonical target. Switching panes
  // keeps pending work; changing the target unmounts and invalidates it.
  const requests = useRequestSequence([props.workspaceId]);
  const automations = useAutomationShareCheck(props.workspaceId, props.target);
  useEffect(() => {
    setCreated(null); setPhase("idle"); setError(null);
  }, [props.workspaceId]);

  const busy = phase !== "idle";
  const canSubmit = useMemo(() => email.trim().length > 2 && !busy, [busy, email]);
  const share = { recipientEmail: email.trim(), access };
  const note = automations.noteFor(share);

  // An edit during the automation check drops it, so Create always acts on
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
      if (current()) setCreated(result);
    } catch (cause) {
      if (current()) setError(ipcErrorMessage(cause));
    } finally {
      if (current()) setPhase("idle");
    }
  }

  if (!props.visible) return null;

  return (
    <>
      {created === null ? (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-subtle">Access</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Access">
              {ACCESS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={access === option.value}
                  data-testid={`share-access-${option.value}`}
                  disabled={phase === "creating"}
                  onClick={() => edit(() => setAccess(option.value))}
                  className={`flex-1 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-50 ${
                    access === option.value
                      ? "border-ink bg-panel-2 text-ink"
                      : "border-line bg-panel text-muted hover:text-ink"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p
              data-testid="share-access-helper"
              className="m-0 text-[11px] leading-relaxed text-subtle"
            >
              {ACCESS_OPTIONS.find((option) => option.value === access)?.helper}
            </p>
            {access === "edit" && (
              <p className="m-0 text-[11px] leading-relaxed text-subtle">
                People who can edit can see the full History.
              </p>
            )}
          </div>

          {access === "edit" && props.target.kind === "paths" && (
            <p className="m-0 text-xs leading-relaxed text-muted">
              Browser editing lets them change shared Markdown files live when available. Other files use changes you accept.
            </p>
          )}

          <label className="block text-[11px] font-medium text-subtle">
            Share with (email)
            <input
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
              className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
            />
          </label>
          {note?.warning ? <AutomationShareNote note={note} /> : null}
          <PrimaryButton
            type="button"
            data-testid="share-create"
            disabled={!canSubmit}
            onClick={() => void createShare()}
          >
            {phase === "checking"
              ? "Checking automations…"
              : phase === "creating"
                ? "Creating share…"
                : note?.warning
                  ? "Create share anyway"
                  : "Create share"}
          </PrimaryButton>
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
            You can end this share anytime from Settings → Cloud.
          </p>
          <SecondaryButton
            type="button"
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

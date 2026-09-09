import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CreateRelaySharePayload, CreateRelayShareResult, ShareAccess } from "../ipc/bridgeContract";
import type { RelayShareTarget } from "./RelayShareDialog";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { useRequestSequence } from "./useRequestSequence";

const ACCESS_OPTIONS: ReadonlyArray<{
  value: ShareAccess;
  label: string;
  helper: string;
}> = [
  {
    value: "view",
    label: "View",
    helper: "They can read what you selected.",
  },
  {
    value: "edit",
    label: "Edit",
    helper: "They can read what you selected and send you changes to accept.",
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateRelayShareResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [invitationCopied, setInvitationCopied] = useState(false);
  // RelayShareDialog keys this form by the canonical target. Switching panes
  // keeps pending work; changing the target unmounts and invalidates it.
  const requests = useRequestSequence([props.workspaceId]);
  useEffect(() => {
    setCreated(null); setBusy(false); setError(null); setCopied(false); setInvitationCopied(false);
  }, [props.workspaceId]);

  const canSubmit = useMemo(() => email.trim().length > 2 && !busy, [busy, email]);

  async function createShare() {
    if (!canSubmit) return;
    const token = requests.next();
    setBusy(true);
    setError(null);
    try {
      const payload: CreateRelaySharePayload = {
        workspaceId: props.workspaceId,
        recipientEmail: email.trim(),
        access,
        ...(props.target.kind === "version"
          ? { versionId: props.target.versionId }
          : { paths: props.target.paths }),
      };
      const result = await bridge().createRelayShare(payload);
      if (requests.isCurrent(token)) setCreated(result);
    } catch (cause) {
      if (requests.isCurrent(token)) setError(ipcErrorMessage(cause));
    } finally {
      if (requests.isCurrent(token)) setBusy(false);
    }
  }

  async function copyCode() {
    if (!created) return;
    const token = requests.current();
    try {
      await bridge().writeClipboardText({ text: created.shareCode });
      if (requests.isCurrent(token)) setCopied(true);
    } catch {
      // The code stays visible for manual selection.
    }
  }

  async function copyInvitation() {
    if (!created?.browserInvitationUrl) return;
    const token = requests.current();
    try {
      await bridge().writeClipboardText({ text: created.browserInvitationUrl });
      if (requests.isCurrent(token)) setInvitationCopied(true);
    } catch {
      // The invitation stays visible for manual selection.
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
                  onClick={() => setAccess(option.value)}
                  className={`flex-1 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
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
          </div>

          <p className="m-0 text-xs leading-relaxed text-muted">
            They can read only what you selected.
          </p>
          {access === "edit" && props.target.kind === "paths" && (
            <p className="m-0 text-xs leading-relaxed text-muted">
              When configured, browser editing lets them change shared Markdown files live. Other files use changes you accept.
            </p>
          )}

          <label className="block text-[11px] font-medium text-subtle">
            Share with (email)
            <input
              data-testid="share-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createShare();
              }}
              placeholder="name@example.com"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
            />
          </label>
          <PrimaryButton
            type="button"
            data-testid="share-create"
            disabled={!canSubmit}
            onClick={() => void createShare()}
          >
            {busy ? "Creating share…" : "Create share"}
          </PrimaryButton>
        </>
      ) : (
        <>
          {created.browserInvitationUrl && (
            <>
              <p className="m-0 text-xs leading-relaxed text-muted">
                Send this browser invitation to {created.recipientEmail}. The recipient must sign in with the invited account.
              </p>
              <code data-testid="share-browser-invitation" data-grant-id={created.grantId}
                className="min-w-0 break-all rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] text-ink">
                {created.browserInvitationUrl}
              </code>
              <SecondaryButton type="button" data-testid="share-browser-invitation-copy" onClick={() => void copyInvitation()}>
                {invitationCopied ? "Browser invitation copied" : "Copy browser invitation"}
              </SecondaryButton>
              <p className="m-0 text-xs leading-relaxed text-muted">
                Browser editing supports shared Markdown files when available. Other files use changes you accept.
              </p>
            </>
          )}
          <p className="m-0 text-xs leading-relaxed text-muted">
            Send this code to{" "}
            <span className="font-medium text-ink">{created.recipientEmail}</span> —
            they paste it in dohc under “Open a share”.
          </p>
          <div className="flex items-start gap-2">
            <code
              data-testid="share-code"
              className="min-w-0 flex-1 break-all rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] leading-snug text-ink"
            >
              {created.shareCode}
            </code>
            <button
              type="button"
              data-testid="share-code-copy"
              onClick={() => void copyCode()}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-transparent px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
            >
              {copied ? (
                <Check size={12} aria-hidden />
              ) : (
                <Copy size={12} aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
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

      {error ? (
        <p data-testid="share-error" role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

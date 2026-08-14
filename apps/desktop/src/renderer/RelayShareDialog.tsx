import { Check, Copy, Share2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ShareAccess } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { IconButton, PrimaryButton } from "./ui/controls";

// The grant side of a relay share (PR 18): pick who gets it, create the
// grant, hand back the copyable share code. The selection (a file, a folder,
// or a version) was made where the user clicked — this dialog only confirms
// and addresses it.

export interface RelayShareTarget {
  path?: string;
  paths?: string[];
  label?: string;
  versionId?: string;
  versionName?: string;
}

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

// The levels this dialog offers, in order. Comment's chat rights land here
// with #646 PR2, so Comment is now selectable. Edit's document writes land
// with PR3, so Edit stays unselectable: an option that promised a right the
// relay still refuses would be the dialog lying about the grant.
const ACCESS_OPTIONS: ReadonlyArray<{
  value: ShareAccess;
  label: string;
  helper: string;
  ready: boolean;
}> = [
  {
    value: "view",
    label: "View",
    helper: "They can read what you selected.",
    ready: true,
  },
  {
    value: "comment",
    label: "Comment",
    helper: "They can read what you selected and chat about it.",
    ready: true,
  },
  {
    value: "edit",
    label: "Edit",
    helper: "They can read, chat, and edit what you selected.",
    ready: false,
  },
];

export function RelayShareDialog(props: {
  workspaceId: string;
  target: RelayShareTarget;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<ShareAccess>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    shareCode: string;
    recipientEmail: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const subject = props.target.versionId
    ? `version “${props.target.versionName ?? props.target.versionId}”`
    : (props.target.label ?? props.target.path ?? "this selection");

  const canSubmit = useMemo(() => email.trim().length > 2 && !busy, [busy, email]);

  async function createShare() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge().createRelayShare({
        workspaceId: props.workspaceId,
        recipientEmail: email.trim(),
        access,
        ...(props.target.paths
          ? { paths: props.target.paths }
          : props.target.path
            ? { paths: [props.target.path] }
            : {}),
        ...(props.target.versionId ? { versionId: props.target.versionId } : {}),
      });
      setCreated({ shareCode: result.shareCode, recipientEmail: result.recipientEmail });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!created) return;
    try {
      await bridge().writeClipboardText({ text: created.shareCode });
      setCopied(true);
    } catch {
      // The code stays visible for manual selection.
    }
  }

  return (
    <div
      data-testid="share-dialog"
      className="dohc-elevated flex w-105 flex-col gap-3 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <Share2 size={14} aria-hidden className="text-subtle" />
        <h2 className="m-0 flex-1 text-sm font-semibold text-ink">Share</h2>
        <IconButton aria-label="Close" onClick={props.onClose}>
          <X size={13} aria-hidden />
        </IconButton>
      </div>

      <p className="m-0 text-xs leading-relaxed text-muted">
        {props.target.versionId ? (
          <>Share {subject}.</>
        ) : (
          <>
            Share <code className="font-mono text-[11px] text-ink">{subject}</code>.
          </>
        )}
      </p>

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
                  disabled={!option.ready}
                  data-testid={`share-access-${option.value}`}
                  onClick={() => setAccess(option.value)}
                  className={`flex-1 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    access === option.value
                      ? "border-ink bg-panel-2 text-ink"
                      : "border-line bg-panel text-muted enabled:hover:text-ink"
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
            {ACCESS_OPTIONS.some((option) => !option.ready) ? (
              <p
                data-testid="share-access-pending"
                className="m-0 text-[11px] leading-relaxed text-subtle"
              >
                Edit is not ready yet.
              </p>
            ) : null}
          </div>

          <p className="m-0 text-xs leading-relaxed text-muted">
            They see what you selected — nothing else — and your later edits arrive
            when they refresh.
          </p>

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
              className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-subtle focus:border-ink"
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
          <p className="m-0 text-xs leading-relaxed text-muted">
            Send this code to{" "}
            <span className="font-medium text-ink">{created.recipientEmail}</span> — they
            paste it in dohc under “Open a share”.
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
              {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="m-0 text-[11px] leading-relaxed text-subtle">
            You can end this share anytime from Settings → Cloud.
          </p>
          <button
            type="button"
            data-testid="share-done"
            onClick={props.onClose}
            className="rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
          >
            Done
          </button>
        </>
      )}

      {error ? (
        <p data-testid="share-error" role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

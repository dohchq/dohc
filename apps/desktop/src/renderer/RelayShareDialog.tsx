import { Check, Copy, Share2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { bridge } from "./bridge";
import { PrimaryButton } from "./ui/controls";

// The grant side of a relay share (PR 18): pick who gets it, create the
// grant, hand back the copyable share code. The selection (a file, a folder,
// or a version) was made where the user clicked — this dialog only confirms
// and addresses it.

export interface RelayShareTarget {
  path?: string;
  versionId?: string;
  versionName?: string;
}

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function RelayShareDialog(props: {
  workspaceId: string;
  target: RelayShareTarget;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    shareCode: string;
    recipientEmail: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const subject = props.target.versionId
    ? `version “${props.target.versionName ?? props.target.versionId}”`
    : (props.target.path ?? "this workspace");

  const canSubmit = useMemo(() => email.trim().length > 2 && !busy, [busy, email]);

  async function createShare() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge().createRelayShare({
        workspaceId: props.workspaceId,
        recipientEmail: email.trim(),
        ...(props.target.path ? { paths: [props.target.path] } : {}),
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
        <button
          type="button"
          aria-label="Close"
          onClick={props.onClose}
          className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
        >
          <X size={13} aria-hidden />
        </button>
      </div>

      <p className="m-0 text-xs leading-relaxed text-muted">
        {props.target.versionId ? (
          <>Share {subject} as a read-only live view.</>
        ) : (
          <>
            Share <code className="font-mono text-[11px] text-ink">{subject}</code> as a
            read-only live view.
          </>
        )}{" "}
        They see what you selected — nothing else — and your later edits arrive when
        they refresh.
      </p>

      {created === null ? (
        <>
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

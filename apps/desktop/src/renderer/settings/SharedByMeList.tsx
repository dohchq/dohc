import { Copy, Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { RelayShareGrantedRow } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// "Shared by me" (PR 18): the management list for relay share grants. Lives
// in Settings → Cloud. Calm inventory: what's shared, with whom, and one
// honest way to end it.

type LoadState =
  | { status: "loading" }
  | { status: "ready"; shares: RelayShareGrantedRow[] }
  | { status: "error"; message: string };

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function selectorLabel(share: RelayShareGrantedRow): string {
  if (share.selector.versionId) {
    const suffix = share.selector.paths.length > 0
      ? ` (${share.selector.paths.join(", ")})`
      : "";
    return `Version ${share.selector.versionId === "main" ? "Main" : share.selector.versionId}${suffix}`;
  }
  return share.selector.paths.join(", ") || "Everything";
}

export function SharedByMeList() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);

  async function refresh() {
    try {
      const result = await bridge().listRelayShares();
      setLoad({ status: "ready", shares: result.granted });
    } catch (cause) {
      setLoad({ status: "error", message: errorMessage(cause) });
    }
  }

  useEffect(() => {
    void refresh();
    // Load once per mount; revokes refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(shareId: string) {
    setBusyShareId(shareId);
    try {
      await bridge().revokeRelayShare({ shareId });
      await refresh();
    } catch (cause) {
      setLoad({ status: "error", message: errorMessage(cause) });
    } finally {
      setBusyShareId(null);
    }
  }

  async function copyCode(share: RelayShareGrantedRow) {
    try {
      await bridge().writeClipboardText({ text: share.shareCode });
      setCopiedShareId(share.shareId);
    } catch {
      // Non-fatal; the row keeps its copy affordance.
    }
  }

  if (load.status === "loading") {
    return <p className="m-0 text-[11px] text-subtle">Loading your shares…</p>;
  }
  if (load.status === "error") {
    return (
      <p data-testid="shared-by-me-error" className="m-0 text-[11px] text-subtle">
        {load.message}
      </p>
    );
  }
  if (load.shares.length === 0) {
    return (
      <p data-testid="shared-by-me-empty" className="m-0 text-[11px] text-subtle">
        Nothing shared yet. Right-click a file and choose “Share…” to give someone
        a read-only view.
      </p>
    );
  }
  return (
    <ul
      className="m-0 list-none divide-y divide-line overflow-hidden rounded-lg border border-line p-0"
      data-testid="shared-by-me-list"
    >
      {load.shares.map((share) => (
        <li
          key={share.shareId}
          data-testid="shared-by-me-row"
          data-share-id={share.shareId}
          data-revoked={share.revokedAtMs !== null || undefined}
          className="flex items-center gap-2 bg-panel px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11px] text-ink">
              {selectorLabel(share)}
            </div>
            <div className="truncate text-[11px] text-subtle">
              {share.revokedAtMs !== null
                ? `Ended — was shared with ${share.recipientEmail ?? share.recipientUserId}`
                : `Shared with ${share.recipientEmail ?? share.recipientUserId}`}
            </div>
          </div>
          {share.revokedAtMs === null ? (
            <>
              <button
                type="button"
                data-testid="shared-by-me-copy"
                onClick={() => void copyCode(share)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                {copiedShareId === share.shareId ? (
                  <Check size={11} aria-hidden />
                ) : (
                  <Copy size={11} aria-hidden />
                )}
                {copiedShareId === share.shareId ? "Copied" : "Copy code"}
              </button>
              <button
                type="button"
                data-testid="shared-by-me-revoke"
                disabled={busyShareId === share.shareId}
                onClick={() => void revoke(share.shareId)}
                className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:text-danger disabled:opacity-50"
              >
                {busyShareId === share.shareId ? "Ending…" : "End share"}
              </button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

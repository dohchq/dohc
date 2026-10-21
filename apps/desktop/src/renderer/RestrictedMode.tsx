import { ShieldAlert } from "lucide-react";
import { AGENTS_RESTRICTED_MESSAGE } from "../agents/agentToolCatalog";
import { EmptyState, PrimaryButton, SecondaryButton } from "./ui/controls";

export const RESTRICTED_APP_WORDS = "In Restricted Mode, dohc does not run this app's code.";
// Shown through the shell's error hook, with Try again. Until main answers,
// nothing that runs app code starts.
export const TRUST_READ_FAILED_MESSAGE = "dohc could not read whether it trusts this workspace.";
const RESTRICTED_WORKSPACE_WORDS = "In Restricted Mode, dohc does not run this workspace's app code.";

// The workspace's Restricted Mode, beside its save state in the title bar.
// It opens main's trust dialog.
export function RestrictedModeIndicator(props: { asking: boolean; onTrust: () => void }) {
  return (
    <button
      type="button"
      data-testid="restricted-mode-indicator"
      title={RESTRICTED_WORKSPACE_WORDS}
      disabled={props.asking}
      onClick={props.onTrust}
      className="titlebar-no-drag flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-wait"
    >
      <ShieldAlert size={12} strokeWidth={1.9} aria-hidden className="shrink-0 text-warning" />
      <span className="whitespace-nowrap">Restricted Mode</span>
    </button>
  );
}

// What an app shows in place of a preview that would run its code. A band
// above the static preview when the app has one, a centered state when not.
// Trust workspace opens main's dialog; the person answers there.
export function RestrictedModeState(props: {
  variant: "band" | "page";
  asking: boolean;
  onTrust: () => void;
}) {
  if (props.variant === "band") {
    return <RestrictedModeBand testId="restricted-mode-state" words={RESTRICTED_APP_WORDS} {...props} />;
  }
  return (
    <EmptyState
      data-testid="restricted-mode-state"
      data-variant="page"
      icon={ShieldAlert}
      tone="warning"
      title={RESTRICTED_APP_WORDS}
    >
      <PrimaryButton size="compact" disabled={props.asking} onClick={props.onTrust}>
        Trust workspace
      </PrimaryButton>
    </EmptyState>
  );
}

// Above Chats in a workspace whose agent Restricted Mode holds back.
export function RestrictedAgentsBand(props: { asking: boolean; onTrust: () => void }) {
  return <RestrictedModeBand testId="restricted-agents-state" words={AGENTS_RESTRICTED_MESSAGE} {...props} />;
}

function RestrictedModeBand(props: { testId: string; words: string; asking: boolean; onTrust: () => void }) {
  return (
    <div
      data-testid={props.testId}
      data-variant="band"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-[12px] text-muted"
    >
      <ShieldAlert size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-warning" />
      <span className="min-w-0 truncate" title={props.words}>{props.words}</span>
      <SecondaryButton
        size="compact"
        className="ml-auto shrink-0"
        disabled={props.asking}
        onClick={props.onTrust}
      >
        Trust workspace
      </SecondaryButton>
    </div>
  );
}

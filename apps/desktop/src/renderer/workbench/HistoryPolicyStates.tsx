import { EyeOff, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { HistoryPolicyUnreadableResult, WorkspacePolicyPath } from "../../ipc/bridgeContract";
import { CopyDetailsButton, errorDetails } from "../shell/copyDetails";
import { EmptyState, SecondaryButton } from "../ui/controls";

// The two ways History's rules keep a change out of sight. Each is a state of
// the surface that shows History, so it is drawn there, beside the control
// that reads again once the person has changed the rules.

export function historyHiddenWords(unreadable: readonly WorkspacePolicyPath[]): string {
  const files = unreadable.filter((path) => path !== ".dohc");
  if (files.length === 0) {
    return "dohc can't read this workspace's .dohc folder, so History is hidden. Fix the folder, then try again.";
  }
  return `dohc can't read ${files.join(" and ")}, so History is hidden. Fix the ${files.length > 1 ? "files" : "file"}, then try again.`;
}

// A side panel or a whole tab: the words keep a readable width in both.
function PolicyState(props: { testId: string; icon: ReactNode; words: string; children: ReactNode }) {
  return (
    <div data-testid={props.testId} className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col">
      <EmptyState icon={props.icon} title={props.words}>
        <div className="flex items-center gap-1">{props.children}</div>
      </EmptyState>
    </div>
  );
}

// The rules cannot be read, so History shows nothing. The parser's own words
// go into Copy details only, beside Try again as on the toast.
export function HistoryHiddenState(props: {
  result: HistoryPolicyUnreadableResult;
  onRetry: () => void;
  testId: string;
}) {
  const words = historyHiddenWords(props.result.unreadable);
  return (
    <PolicyState
      testId={props.testId}
      icon={<TriangleAlert size={20} strokeWidth={1.9} aria-hidden className="text-danger" />}
      words={words}
    >
      <SecondaryButton onClick={props.onRetry}>Try again</SecondaryButton>
      <CopyDetailsButton
        iconOnly
        details={() =>
          errorDetails([["Error", words], ...props.result.policyErrors.map((error) => ["Cause", error] as const)])
        }
      />
    </PolicyState>
  );
}

// The change is in History, but the rules no longer track a file it touched.
export function HistoryUntrackedState(props: { onRetry: () => void; testId: string }) {
  return (
    <PolicyState
      testId={props.testId}
      icon={<EyeOff size={20} strokeWidth={1.9} aria-hidden className="text-subtle" />}
      words="History no longer tracks this file, so this change is hidden. To show it, track the file in .dohc/files.toml."
    >
      <SecondaryButton onClick={props.onRetry}>Try again</SecondaryButton>
    </PolicyState>
  );
}

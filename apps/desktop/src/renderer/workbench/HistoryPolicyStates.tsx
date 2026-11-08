import { EyeOff, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { HistoryPolicyUnreadableResult, WorkspacePolicyFile, WorkspacePolicyPath } from "../../ipc/bridgeContract";
import { errorDetails } from "../shell/copyDetails";
import { CopyButton } from "../ui/CopyButton";
import { EmptyState, SecondaryButton } from "../ui/controls";

// The two ways History's rules keep a change out of sight. Each is a state of
// the surface that shows History, so it is drawn there, beside the control
// that reads again once the person has changed the rules.

function unreadableFiles(unreadable: readonly WorkspacePolicyPath[]): WorkspacePolicyFile[] {
  return unreadable.filter((path): path is WorkspacePolicyFile => path !== ".dohc");
}

// What dohc can't read, and what the person fixes.
function unreadableWords(unreadable: readonly WorkspacePolicyPath[]): { what: string; fix: string } {
  const files = unreadableFiles(unreadable);
  if (files.length === 0) return { what: "this workspace's .dohc folder", fix: "Fix the folder" };
  return { what: files.join(" and "), fix: files.length > 1 ? "Fix the files" : "Fix the file" };
}

export function historyHiddenWords(unreadable: readonly WorkspacePolicyPath[]): string {
  const { what, fix } = unreadableWords(unreadable);
  return `dohc can't read ${what}, so History is hidden. ${fix}, then try again.`;
}

// A Stop and restore row, which already names the file it is about.
export function restoreRulesUnreadableWords(unreadable: readonly WorkspacePolicyPath[]): string {
  const { what, fix } = unreadableWords(unreadable);
  return `dohc could not restore this file because it can't read ${what}. ${fix}, then try again.`;
}

// The first step on each panel: the rules file to fix, named on its button.
function OpenRulesFile(props: { file: WorkspacePolicyFile; onOpenFile: (file: WorkspacePolicyFile) => void }) {
  return (
    <SecondaryButton onClick={() => props.onOpenFile(props.file)}>
      {`Open ${props.file.slice(".dohc/".length)}`}
    </SecondaryButton>
  );
}

// A side panel or a whole tab; EmptyState keeps the words a readable width.
// In a narrow panel the controls wrap to a second line.
function PolicyState(props: {
  testId: string;
  icon: LucideIcon;
  tone?: "danger";
  words: string;
  children: ReactNode;
}) {
  return (
    <EmptyState data-testid={props.testId} icon={props.icon} tone={props.tone} title={props.words}>
      <div className="flex flex-wrap items-center justify-center gap-1">{props.children}</div>
    </EmptyState>
  );
}

// The rules cannot be read, so History shows nothing. Open goes to the first
// file it names; an unreadable .dohc folder has no file to open. The parser's
// own words go into Copy details only, beside Try again as on the toast.
export function HistoryHiddenState(props: {
  result: HistoryPolicyUnreadableResult;
  onOpenFile: (file: WorkspacePolicyFile) => void;
  onRetry: () => void;
  testId: string;
}) {
  const words = historyHiddenWords(props.result.unreadable);
  const file = unreadableFiles(props.result.unreadable)[0];
  return (
    <PolicyState
      testId={props.testId}
      icon={TriangleAlert}
      tone="danger"
      words={words}
    >
      {file ? <OpenRulesFile file={file} onOpenFile={props.onOpenFile} /> : null}
      <SecondaryButton onClick={props.onRetry}>Try again</SecondaryButton>
      <CopyButton
        iconOnly
        pinName
        label="Copy details"
        getText={() =>
          errorDetails([["Error", words], ...props.result.policyErrors.map((error) => ["Cause", error] as const)])
        }
      />
    </PolicyState>
  );
}

// The change is in History, but the rules no longer track a file it touched.
export function HistoryUntrackedState(props: {
  onOpenFile: (file: WorkspacePolicyFile) => void;
  onRetry: () => void;
  testId: string;
}) {
  return (
    <PolicyState
      testId={props.testId}
      icon={EyeOff}
      words="History no longer tracks this file, so this change is hidden. To show it, track the file in .dohc/files.toml."
    >
      <OpenRulesFile file=".dohc/files.toml" onOpenFile={props.onOpenFile} />
      <SecondaryButton onClick={props.onRetry}>Try again</SecondaryButton>
    </PolicyState>
  );
}

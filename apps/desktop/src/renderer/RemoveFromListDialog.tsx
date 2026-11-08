import { ListMinus } from "lucide-react";
import type { WorkspaceSummary } from "../ipc/bridgeContract";
import { workspaceName } from "./Titlebar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { removalFacts } from "./workspaceRemoval";

export const REMOVE_FAILED = "dohc could not remove this workspace from the list.";

// Asks before a workspace that holds more than its place leaves the list,
// and says what goes with it. Manage workspaces asks with this, and so does
// the screen for a workspace dohc can't open. A removal in progress can't be
// cancelled.
export function RemoveFromListDialog(props: {
  workspace: WorkspaceSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      icon={ListMinus}
      title={`Remove ${workspaceName(props.workspace)} from this list?`}
      confirmLabel={props.busy ? "Removing…" : "Remove from list"}
      confirmDisabled={props.busy}
      testId="workspace-remove-confirm"
      cancelTestId="workspace-remove-cancel"
      confirmTestId="workspace-remove-confirm-button"
      onCancel={() => {
        if (!props.busy) props.onCancel();
      }}
      onConfirm={props.onConfirm}
    >
      {removalFacts(props.workspace).map((fact) => (
        <p key={fact} className="m-0">{fact}</p>
      ))}
      {props.error ? (
        <p data-testid="workspace-remove-error" role="alert" className="m-0 text-danger">
          {props.error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

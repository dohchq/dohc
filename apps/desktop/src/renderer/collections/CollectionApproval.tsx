import type { DatasetApproval } from "@dohc/cli/dataset";
import { SecondaryButton } from "../ui/controls";

function approver(approvedBy: NonNullable<DatasetApproval["approvedBy"]>) {
  if (approvedBy.name === null) return "a former Admin";
  return `${approvedBy.name} · ${approvedBy.former ? "former Admin" : "Admin"}`;
}

export function CollectionApprovedBy({
  approvedBy,
}: {
  approvedBy: NonNullable<DatasetApproval["approvedBy"]>;
}) {
  return (
    <span
      data-testid="collection-approved-by"
      title={`Approved ${new Date(approvedBy.approvedAtMs).toLocaleString()}`}
      className="min-w-0 truncate text-[12px] text-muted"
    >
      Approved by {approver(approvedBy)}
    </span>
  );
}

export function ConfirmApprovalNotice({
  approval,
  confirming,
  onConfirm,
}: {
  approval: DatasetApproval;
  confirming: boolean;
  onConfirm(): void;
}) {
  const name = approval.approvedBy?.name;
  return (
    <div
      role="group"
      aria-label="Rules approved by a former Admin"
      data-testid="collection-confirm-approval"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3 text-[12px] text-muted"
    >
      <span className="min-w-0 flex-1">
        {name
          ? `These rules keep running, approved by ${name}, who is no longer an Admin.`
          : "These rules keep running, approved by a former Admin."}
      </span>
      <SecondaryButton
        size="row"
        disabled={confirming}
        title="Records you as the person who approved these rules. Nothing else changes."
        onClick={onConfirm}
      >
        {confirming ? "Confirming…" : "Confirm approval"}
      </SecondaryButton>
    </div>
  );
}

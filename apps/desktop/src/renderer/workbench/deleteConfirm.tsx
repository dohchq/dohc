import type { ReactNode } from "react";
import { basenameOf } from "../path";

// What the delete dialog says for these paths. Explorer opens it, and the
// states page draws the same dialog.
export function deleteConfirmText(
  paths: readonly string[],
  shareView: { granterEmail: string | null } | null,
): { title: string; confirmLabel: string; intent: "danger"; details: ReactNode; children: ReactNode } {
  return {
    title: `Delete ${paths.length === 1 ? basenameOf(paths[0]!) : `${paths.length} items`}?`,
    confirmLabel: "Delete",
    intent: "danger",
    details:
      paths.length > 1 ? (
        <ul className="m-0 mt-3 max-h-36 list-none overflow-auto rounded border border-line bg-bg p-0">
          {paths.map((path) => (
            <li key={path} className="border-b border-line px-2 py-1 text-[12px] text-muted last:border-b-0">
              <span className="break-all">{path}</span>
            </li>
          ))}
        </ul>
      ) : null,
    children: (
      <p className="m-0 mt-2 text-[13px] text-muted">
        {shareView
          ? `${paths.length === 1 ? "It goes" : "They go"} from your copy now. There is no trash to restore ${
              paths.length === 1 ? "it" : "them"
            } from. ${
              shareView.granterEmail ?? "The person who shared it"
            } still ${paths.length === 1 ? "has it" : "has them"} until you send the change and they accept it. You can take the change back before then.`
          : `${paths.length === 1 ? "It moves" : "They move"} to the system trash, or to this workspace's .dohc/local/trash folder whenever the system trash refuses, and can be restored from there.`}
      </p>
    ),
  };
}

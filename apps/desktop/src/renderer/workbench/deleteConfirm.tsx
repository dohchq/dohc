import type { ReactNode } from "react";
import { Folder } from "lucide-react";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { basenameOf, dirnameOf } from "../path";
import { FileGlyph, listedFileKind } from "../ui/KindGlyph";

// What the delete dialog says for these paths. Only a share view asks before
// a delete, because its delete has no trash behind it. Explorer opens it, and
// the states page draws the same dialog.
export function deleteConfirmText(
  paths: readonly string[],
  shareView: { granterEmail: string | null },
  fileByPath?: ReadonlyMap<string, WorkspaceFileEntry>,
  isFolderPath?: (path: string) => boolean,
): { title: string; confirmLabel: string; intent: "danger"; details: ReactNode; children: ReactNode } {
  return {
    title: `Delete ${paths.length === 1 ? basenameOf(paths[0]!) : `${paths.length} items`}?`,
    confirmLabel: "Delete",
    intent: "danger",
    details:
      paths.length > 1 ? (
        // Seven rows show; the rest scroll.
        <ul className="m-0 max-h-[204px] list-none overflow-auto rounded-lg border border-line bg-bg p-1">
          {paths.map((path) => (
            <li key={path} title={path} className="flex h-7 items-center gap-2 rounded-md px-2">
              {isFolderPath?.(path) ? (
                <Folder size={14} aria-hidden className="shrink-0 text-subtle" />
              ) : (
                <FileGlyph
                  kind={listedFileKind(path, fileByPath?.get(path)?.kind)}
                  icon={fileByPath?.get(path)?.icon}
                  size={14}
                  className="text-subtle"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{basenameOf(path)}</span>
              <span className="max-w-[45%] shrink-0 truncate text-[12px] text-subtle">{dirnameOf(path)}</span>
            </li>
          ))}
        </ul>
      ) : null,
    children: (
      <p>
        {`${paths.length === 1 ? "It goes" : "They go"} from your copy now. There is no trash to restore ${
          paths.length === 1 ? "it" : "them"
        } from. ${
          shareView.granterEmail ?? "The person who shared it"
        } still ${paths.length === 1 ? "has it" : "has them"} until you send the change and they accept it. You can take the change back before then.`}
      </p>
    ),
  };
}

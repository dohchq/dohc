import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { checkLossyNote } from "../editor/lossyNote";

export type RecordSourceCheck =
  | { state: "checking" }
  | { state: "clear"; contentHash: string }
  | { state: "lossy" }
  | { state: "unreadable" };

const CHECKING: RecordSourceCheck = { state: "checking" };

// A record's file, checked in the note-check worker before a field write
// opens its session: setting a field on a lossy note (CONTEXT.md) would
// rewrite the parts dohc can't show. A failed or partial read refuses too,
// and a check that fails counts as lossy, as it does for an opening note.
export function useRecordSourceCheck(workspaceId: string, path: string): RecordSourceCheck {
  const key = `${workspaceId}\u0000${path}`;
  const [result, setResult] = useState<{ key: string; check: RecordSourceCheck } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => bridge().readWorkspaceText({ workspaceId, relativePath: path }))
      .then(
        async (read): Promise<RecordSourceCheck> => {
          if (read.truncated || read.contentHash === null) return { state: "unreadable" };
          const lossy = await checkLossyNote(read.contentHash, read.text).catch(() => true);
          return lossy ? { state: "lossy" } : { state: "clear", contentHash: read.contentHash };
        },
        (): RecordSourceCheck => ({ state: "unreadable" }),
      )
      .then((check) => {
        if (live) setResult({ key, check });
      });
    return () => {
      live = false;
    };
  }, [key, workspaceId, path]);
  return result?.key === key ? result.check : CHECKING;
}

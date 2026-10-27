import { History as HistoryIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
// The label alone, so the document view does not load the table and board code.
import { recordLabel } from "@dohc/collection-views/record-label";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import { isWorkspaceUpdatingError } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { SecondaryButton } from "../ui/controls";
import { RecordButton } from "./RecordButton";
import { useAutomationButtons, type ReportButtonError } from "./useAutomationButtons";
import type { RecordHistoryTarget } from "./useRecordHistory";

// The record view's row above the record's properties, for a file that is a
// record in a Collection: its Button fields, and History. Main says which
// record the file is. What each button does comes only from the
// Collection's button store, which the table shares. The shell holds the
// History dialog, so a failed read's Try again in Notices outlives this view.

export function RecordButtonsRow(props: {
  workspaceId: string;
  path: string;
  onError: ReportButtonError;
  onNotice: (message: string) => void;
  onOpenHistory: (record: RecordHistoryTarget) => void;
  // Told which record the file is, as main answers, or that it is none.
  onRecord?: (record: { workspaceId: string; path: string; id: string } | null) => void;
}) {
  const { workspaceId, path } = props;
  const [found, setFound] = useState<{ record: CollectionRecord; collectionPath: string; fields: string[] } | null>(null);
  const buttons = useAutomationButtons({
    workspaceId, of: found === null || found.fields.length === 0 ? null : { collectionPath: found.collectionPath }, onError: props.onError, onNotice: props.onNotice,
  });
  const requests = useRef(0);
  // Rises when the files that decide what the buttons do change.
  const [settings, setSettings] = useState(0);
  const report = useRef(props.onError);
  report.current = props.onError;
  const tell = useRef(props.onRecord);
  tell.current = props.onRecord;

  useEffect(() => {
    let alive = true;
    const read = async () => {
      const request = ++requests.current;
      try {
        const result = await bridge().listRecordButtons({ workspaceId, path });
        // A slower answer for an earlier read, or another file, never lands.
        if (!alive || request !== requests.current) return;
        setFound(result.record === null ? null : { record: result.record, collectionPath: result.collectionPath, fields: result.fields });
        tell.current?.(result.record === null ? null : { workspaceId, path, id: result.record.id });
      } catch (error) {
        if (!alive || request !== requests.current) return;
        setFound(null);
        tell.current?.(null);
        // The engine is still reading a new workspace's files. Main announces
        // the end as activity for the whole workspace, which reads again below.
        if (isWorkspaceUpdatingError(error)) return;
        report.current("dohc could not read this record's buttons.", error, () => void read());
      }
    };
    void read();
    const folderOf = (file: string) => file.split("/").slice(0, -1).join("/");
    const folder = folderOf(path);
    // The files that decide its buttons: its Collection's collection.yaml
    // and automations.yaml, at or above its folder.
    const decides = (changed: string) => {
      const name = changed.split("/").at(-1);
      if (name !== "collection.yaml" && name !== "automations.yaml") return false;
      const dir = folderOf(changed);
      return folder === dir || folder.startsWith(`${dir}/`);
    };
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId !== undefined && event.workspaceId !== workspaceId) return;
      const paths = event.paths ?? [];
      const buttonsChanged = paths.length === 0 || paths.some(decides);
      if (!buttonsChanged && !paths.includes(path)) return;
      void read();
      // A save of the record itself changes its name, not what its buttons do.
      if (buttonsChanged) setSettings((count) => count + 1);
    });
    return () => {
      alive = false;
      requests.current += 1;
      unsubscribe();
    };
  }, [workspaceId, path]);

  useEffect(() => {
    void buttons?.refresh();
  }, [buttons, settings]);

  if (found === null) return null;
  const label = recordLabel(found.record);
  return (
    // In the page's column, as the title and properties are.
    <div data-testid="record-buttons" className="box-border w-full px-14 pb-2">
      <div className="mx-auto flex max-w-[720px] flex-wrap items-center gap-1.5">
        {buttons === null ? null : found.fields.map((field) => (
          <RecordButton key={field} buttons={buttons} field={field} recordId={found.record.id} recordLabel={label} />
        ))}
        <SecondaryButton
          size="compact"
          data-testid="record-history-open"
          aria-haspopup="dialog"
          className="ml-auto inline-flex items-center gap-1.5"
          onClick={() => props.onOpenHistory({ collectionPath: found.collectionPath, recordId: found.record.id, recordName: label })}
        >
          <HistoryIcon size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
          History
        </SecondaryButton>
      </div>
    </div>
  );
}

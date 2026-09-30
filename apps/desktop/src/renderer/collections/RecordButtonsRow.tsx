import { History as HistoryIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
// The label alone, so the document view does not load the table and board code.
import { recordLabel } from "@dohc/collection-views/record-label";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import { bridge } from "../bridge";
import { SecondaryButton } from "../ui/controls";
import { RecordButton } from "./RecordButton";
import { useAutomationButtons, type ReportButtonError } from "./useAutomationButtons";
import type { RecordHistoryTarget } from "./useRecordHistory";

// The record view's row above the record's properties, for a file that is a
// record in a Collection: its Button fields, and History. Main says which
// record the file is and what each button does. The shell holds the History
// dialog, so a failed read's Try again in Notices outlives this view.

export function RecordButtonsRow(props: {
  workspaceId: string;
  path: string;
  onError: ReportButtonError;
  onNotice: (message: string) => void;
  onOpenHistory: (record: RecordHistoryTarget) => void;
}) {
  const { workspaceId, path } = props;
  const [found, setFound] = useState<{ record: CollectionRecord; collectionPath: string; fields: string[] } | null>(null);
  const buttons = useAutomationButtons({
    workspaceId, of: found === null || found.fields.length === 0 ? null : { collectionPath: found.collectionPath }, onError: props.onError, onNotice: props.onNotice,
  });
  const answer = useRef<Awaited<ReturnType<ReturnType<typeof bridge>["listRecordButtons"]>> | null>(null);
  const requests = useRef(0);
  const report = useRef(props.onError);
  report.current = props.onError;

  useEffect(() => {
    let alive = true;
    const read = async () => {
      const request = ++requests.current;
      try {
        const result = await bridge().listRecordButtons({ workspaceId, path });
        // A slower answer for an earlier read, or another file, never lands.
        if (!alive || request !== requests.current) return;
        answer.current = result;
        setFound(result.record === null ? null : {
          record: result.record, collectionPath: result.collectionPath, fields: result.buttons.map((button) => button.field),
        });
      } catch (error) {
        if (!alive || request !== requests.current) return;
        setFound(null);
        report.current("dohc could not read this record's buttons.", error, () => void read());
      }
    };
    void read();
    const folderOf = (file: string) => file.split("/").slice(0, -1).join("/");
    const folder = folderOf(path);
    // The record itself, or the files that decide its buttons: its
    // Collection's collection.yaml and automations.yaml, at or above its folder.
    const decides = (changed: string) => {
      if (changed === path) return true;
      const name = changed.split("/").at(-1);
      if (name !== "collection.yaml" && name !== "automations.yaml") return false;
      const dir = folderOf(changed);
      return folder === dir || folder.startsWith(`${dir}/`);
    };
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId !== undefined && event.workspaceId !== workspaceId) return;
      if (event.paths?.length && !event.paths.some(decides)) return;
      void read();
    });
    return () => {
      alive = false;
      requests.current += 1;
      unsubscribe();
    };
  }, [workspaceId, path]);

  // The store for this Collection takes the states the read carried.
  useEffect(() => {
    const result = answer.current;
    if (buttons && result && result.record !== null && result.collectionPath === found?.collectionPath) buttons.show(result.buttons);
  }, [buttons, found]);

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

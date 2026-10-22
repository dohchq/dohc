import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  MAX_RETAINED_COPIES_PER_DELETE,
  type RetainedCopiesSummary,
  type RetainedCopy,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useRequestSequence } from "../useRequestSequence";

// Old copies below this size stay out of Notices. It is never a reason to
// delete them; only a person or an agent does that.
export const RETAINED_COPIES_NOTICE_BYTES = 256 * 1024 * 1024;

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Logical size, which a delete may not fully free on disk. */
export function retainedCopiesSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

export function oldFileCopies(count: number): string {
  return `${count.toLocaleString("en-US")} old file ${count === 1 ? "copy" : "copies"}`;
}

export function retainedCopiesNotice(summary: RetainedCopiesSummary): { title: string; message: string } {
  return {
    title: oldFileCopies(summary.count),
    message: `They take up ${retainedCopiesSize(summary.bytes)}. dohc can't check whether another program still uses these copies on this drive.`,
  };
}

export const RETAINED_COPIES_ACTION = "Delete copies…";
export const RETAINED_COPIES_NOT_YET = "dohc can't delete these old file copies yet: they changed recently or dohc still needs them.";

export function retainedCopiesDeleted(answer: { deleted: number; skipped: number }): string {
  const deleted = `Deleted ${oldFileCopies(answer.deleted)}`;
  return answer.skipped === 0
    ? deleted
    : `${deleted}. ${answer.skipped.toLocaleString("en-US")} stay because they changed or dohc still needs them.`;
}

// This computer's profile keeps which workspaces were told, so the toast
// comes once each time the copies pass the size, not on every launch.
const storageKey = (workspaceId: string) => `dohc:retained-copies-notice:${workspaceId}`;
// A dismissed row stays dismissed while the copies stay above the size.
const dismissed = new Set<string>();

export function forgetRetainedCopiesNoticesForTests(): void {
  dismissed.clear();
}

function toldBefore(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function remember(key: string, told: boolean): void {
  try {
    if (told) localStorage.setItem(key, new Date().toISOString());
    else localStorage.removeItem(key);
  } catch {
    // Refused storage toasts again next launch.
  }
}

/**
 * One warning per workspace when the engine keeps more old file copies on a
 * drive that cannot tell it whether a program still uses them than
 * RETAINED_COPIES_NOTICE_BYTES. The row updates in place; it toasts once
 * when the copies pass that size. Its action lists the copies a delete may
 * remove and asks before deleting them. Every answer that lands after the
 * window changed workspaces is dropped.
 */
export function useRetainedCopiesNotice(input: {
  workspaceId: string;
  workspaceName: string;
  summary: RetainedCopiesSummary | undefined;
  show: (notice: {
    title: string;
    message: string;
    action: { label: string; run: () => void };
    onDismiss: () => void;
  } | null, toast: boolean) => void;
  showDone: (message: string) => void;
  report: (notice: { message: string; tone?: "warning"; retry: () => void }) => void;
  reportError: (fallback: string, error: unknown, retry: () => void) => void;
}): ReactNode {
  const { workspaceId, workspaceName, summary } = input;
  const latest = useRef(input);
  latest.current = input;
  // Rises when the workspace changes: an answer for the last workspace
  // shows nothing in this one.
  const workspace = useRequestSequence([workspaceId]);
  const [pending, setPending] = useState<{
    workspaceId: string;
    workspaceName: string;
    copies: readonly RetainedCopy[];
  } | null>(null);
  useEffect(() => setPending(null), [workspaceId]);

  const start = useCallback(() => {
    const epoch = workspace.current();
    const askedFor = workspaceId;
    const name = workspaceName;
    bridge().listRetainedCopies({ workspaceId: askedFor }).then((listed) => {
      if (!workspace.isCurrent(epoch)) return;
      if (listed.copies.length === 0) {
        latest.current.report({ tone: "warning", message: RETAINED_COPIES_NOT_YET, retry: start });
        return;
      }
      setPending({ workspaceId: askedFor, workspaceName: name, copies: listed.copies });
    }, (error: unknown) => {
      if (!workspace.isCurrent(epoch)) return;
      latest.current.reportError("dohc could not list old file copies.", error, start);
    });
  }, [workspace, workspaceId, workspaceName]);

  const count = summary?.count ?? 0;
  const bytes = summary?.bytes ?? 0;
  const key = storageKey(workspaceId);
  const show = useCallback((current: RetainedCopiesSummary) => {
    if (current.count === 0 || current.bytes < RETAINED_COPIES_NOTICE_BYTES) {
      dismissed.delete(key);
      remember(key, false);
      latest.current.show(null, false);
      return;
    }
    if (dismissed.has(key)) return;
    const toast = !toldBefore(key);
    if (toast) remember(key, true);
    latest.current.show({
      ...retainedCopiesNotice(current),
      action: { label: RETAINED_COPIES_ACTION, run: start },
      onDismiss: () => dismissed.add(key),
    }, toast);
  }, [key, start]);
  useEffect(() => {
    if (summary === undefined) return;
    show({ count, bytes });
  }, [summary === undefined, count, bytes, show]);

  const confirm = useCallback(async () => {
    const asked = pending;
    setPending(null);
    if (!asked) return;
    const epoch = workspace.current();
    const total = { deleted: 0, skipped: 0, failed: 0 };
    let remaining: RetainedCopiesSummary | null = null;
    try {
      for (let at = 0; at < asked.copies.length; at += MAX_RETAINED_COPIES_PER_DELETE) {
        const answer = await bridge().deleteRetainedCopies({
          workspaceId: asked.workspaceId,
          copies: asked.copies.slice(at, at + MAX_RETAINED_COPIES_PER_DELETE).map(({ id, revision }) => ({ id, revision })),
          acceptLateWriteRisk: true,
        });
        // A window that changed workspaces stops asking: the person is no
        // longer watching this delete.
        if (!workspace.isCurrent(epoch)) return;
        total.deleted += answer.deleted;
        total.skipped += answer.skipped;
        total.failed += answer.failed;
        remaining = answer.remaining;
      }
    } catch (error) {
      if (!workspace.isCurrent(epoch)) return;
      if (remaining) show(remaining);
      latest.current.reportError("dohc could not delete old file copies.", error, start);
      return;
    }
    if (remaining) show(remaining);
    if (total.failed > 0) {
      latest.current.report({ message: `dohc could not delete ${oldFileCopies(total.failed)}.`, retry: start });
    }
    if (total.deleted > 0) latest.current.showDone(retainedCopiesDeleted(total));
    else if (total.failed === 0) latest.current.report({ tone: "warning", message: RETAINED_COPIES_NOT_YET, retry: start });
  }, [pending, show, start, workspace]);

  return pending ? (
    <ConfirmDialog
      intent="danger"
      testId="retained-copies-confirm"
      cancelTestId="retained-copies-cancel"
      confirmTestId="retained-copies-delete"
      title={`Delete ${oldFileCopies(pending.copies.length)} from ${pending.workspaceName}?`}
      confirmLabel="Delete copies"
      onCancel={() => setPending(null)}
      onConfirm={() => void confirm()}
    >
      <p className="m-0 mt-2 text-[13px] text-muted">
        Close other programs that use this workspace first. A program that still uses one of these copies may lose
        what it writes next. This can't be undone.
      </p>
    </ConfirmDialog>
  ) : null;
}

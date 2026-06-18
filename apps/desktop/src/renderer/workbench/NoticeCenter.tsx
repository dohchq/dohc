import {
  AlertTriangle,
  Bell,
  Bot,
  Check,
  CloudOff,
  Download,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

type Notice = {
  id: "sync-conflict" | "cloud-disconnected" | "agent-active" | "update-ready";
  tone: "danger" | "warning" | "success" | "neutral";
  title: string;
  body: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  Icon: typeof Bell;
};

function toneClass(tone: Notice["tone"]): string {
  if (tone === "danger") return "text-danger";
  if (tone === "warning") return "text-warning";
  if (tone === "success") return "text-success";
  return "text-subtle";
}

export function NoticeCenter(props: {
  syncStatus: SyncStatusResult | null;
  agentActive: boolean;
  conflictSummaries: string[];
  onOpenHistory: () => void;
  onOpenAgent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(
    () =>
      bridge().onUpdateState((update) => {
        if (update.status === "ready") setUpdateMessage(update.message);
      }),
    [],
  );

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (centerRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const notices = useMemo<Notice[]>(() => {
    const next: Notice[] = [];
    const state = props.syncStatus?.state;
    const conflictCount = props.syncStatus?.conflictCount ?? 0;

    if (state === "conflict") {
      next.push({
        id: "sync-conflict",
        tone: "danger",
        title: conflictCount > 1 ? `${conflictCount} sync conflicts` : "Sync conflict",
        body:
          props.conflictSummaries[0] ??
          "Both versions were kept. Review history to choose what stays.",
        action: { label: "Review", onClick: props.onOpenHistory },
        Icon: AlertTriangle,
      });
    } else if (state === "cloud-disconnected") {
      next.push({
        id: "cloud-disconnected",
        tone: "warning",
        title: "Cloud disconnected",
        body: "Local work is safe. Reconnect dohc Cloud when you want sync again.",
        Icon: CloudOff,
      });
    }

    if (props.agentActive) {
      next.push({
        id: "agent-active",
        tone: "success",
        title: "Agent running",
        body: "Workspace changes from this run will be attributed in history.",
        action: { label: "Open", onClick: props.onOpenAgent },
        Icon: Bot,
      });
    }

    if (updateMessage) {
      next.push({
        id: "update-ready",
        tone: "neutral",
        title: "Update ready",
        body: updateMessage,
        Icon: Download,
      });
    }

    return next;
  }, [
    props.agentActive,
    props.conflictSummaries,
    props.onOpenAgent,
    props.onOpenHistory,
    props.syncStatus,
    updateMessage,
  ]);

  const count = notices.length;

  return (
    <>
      {updateMessage ? (
        <div
          data-testid="update-toast"
          role="status"
          className="fixed bottom-9 right-3 z-30 flex max-w-md items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink shadow-sm"
        >
          <span>{updateMessage}</span>
          <button
            type="button"
            aria-label="Dismiss update notice"
            onClick={() => setUpdateMessage(null)}
            className="grid size-4 shrink-0 place-items-center rounded text-subtle hover:text-ink"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      {open ? (
        <div
          ref={centerRef}
          data-testid="notice-center"
          role="dialog"
          aria-label="Notices"
          className={`fixed right-3 z-20 flex w-[min(360px,calc(100vw-24px))] flex-col rounded-md border border-line bg-panel text-xs text-ink shadow-sm ${
            updateMessage ? "bottom-20" : "bottom-9"
          }`}
        >
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <Bell size={13} aria-hidden className="text-subtle" />
            <span className="font-semibold uppercase tracking-wide text-muted">
              Notices
            </span>
            {count > 0 ? (
              <span
                data-testid="notice-center-count"
                className="ml-auto rounded-full bg-ink px-1.5 text-[10px] font-semibold leading-4 text-bg"
              >
                {count}
              </span>
            ) : null}
          </header>
          {count === 0 ? (
            <div className="flex h-20 items-center gap-2 px-3 text-subtle">
              <Check size={14} aria-hidden />
              All clear
            </div>
          ) : (
            <ul className="m-0 max-h-80 list-none overflow-y-auto p-0">
              {notices.map((notice) => (
                <li
                  key={notice.id}
                  data-testid={`notice-${notice.id}`}
                  className="flex gap-2 border-b border-line px-3 py-2 last:border-b-0"
                >
                  <notice.Icon
                    size={14}
                    aria-hidden
                    className={`mt-0.5 shrink-0 ${toneClass(notice.tone)}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[12px] font-medium text-ink">
                        {notice.title}
                      </span>
                      {notice.action ? (
                        <button
                          type="button"
                          onClick={() => {
                            notice.action?.onClick();
                            setOpen(false);
                          }}
                          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
                        >
                          {notice.action.label}
                        </button>
                      ) : null}
                    </div>
                    <p className="m-0 mt-0.5 line-clamp-3 text-[11px] leading-snug text-muted">
                      {notice.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <button
        ref={toggleRef}
        type="button"
        data-testid="notice-center-toggle"
        aria-label={count > 0 ? `Notices (${count})` : "Notices"}
        title="Notices"
        onClick={() => setOpen((value) => !value)}
        className="relative grid size-5 place-items-center rounded text-muted hover:bg-line/50 hover:text-ink"
      >
        <Bell size={13} aria-hidden />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 h-3 min-w-3 rounded-full bg-ink px-0.5 text-center text-[8px] font-semibold leading-3 text-bg"
          >
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>
    </>
  );
}

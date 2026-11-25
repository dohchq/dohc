import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "dohc/app";
import { Copy, RefreshCw, Undo2, X } from "./spectator/Icons";

interface Toast {
  id: number;
  tone: "done" | "warning" | "danger";
  matchId?: string;
  tournamentId?: string;
  sticky?: boolean;
  title: string;
  message: string;
  action?: { label: string; undo?: boolean; run(): void };
}

type ToastInput = Omit<Toast, "id">;

export function useToasts(shownId: string | undefined) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());
  const shownRef = useRef(shownId);
  shownRef.current = shownId;

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) window.clearTimeout(timer);
      active.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const arm = useCallback(
    (toast: Pick<Toast, "id" | "action">) => {
      window.clearTimeout(timers.current.get(toast.id));
      timers.current.set(
        toast.id,
        window.setTimeout(() => dismiss(toast.id), toast.action ? 10000 : 6000),
      );
    },
    [dismiss],
  );
  const push = useCallback(
    (toast: ToastInput) => {
      const id = ++nextId.current;
      setToasts((current) => [
        ...current.filter((shown) => toast.tone !== "done" || shown.tone !== "done").slice(-4),
        { ...toast, id, tournamentId: toast.tournamentId ?? shownRef.current },
      ]);
      if (toast.tone !== "danger" && !toast.sticky) arm({ id, action: toast.action });
    },
    [arm],
  );
  const drop = useCallback(
    (test: (toast: Toast) => boolean) =>
      setToasts((current) => current.filter((toast) => !test(toast))),
    [],
  );
  const hold = (id: number) => {
    if (!timers.current.has(id)) return;
    window.clearTimeout(timers.current.get(id));
    timers.current.set(id, 0);
  };
  const resume = (toast: Toast, box: HTMLElement) => {
    if (!timers.current.has(toast.id)) return;
    if (box.matches(":hover") || box.contains(document.activeElement)) return;
    arm(toast);
  };

  return { toasts, push, dismiss, drop, hold, resume };
}

export function Toasts({
  toaster,
  shownId,
}: {
  toaster: ReturnType<typeof useToasts>;
  shownId: string | undefined;
}) {
  const { toasts, dismiss, hold, resume } = toaster;
  return (
    <div className="co-toasts" aria-live="polite">
      {toasts
        .filter((toast) => !toast.tournamentId || toast.tournamentId === shownId)
        .map((toast) => (
          <div
            key={toast.id}
            className={`co-toast is-${toast.tone}`}
            role={toast.tone === "danger" ? "alert" : undefined}
            onPointerEnter={() => hold(toast.id)}
            onPointerLeave={(event) => resume(toast, event.currentTarget)}
            onFocus={() => hold(toast.id)}
            onBlur={(event) => {
              const box = event.currentTarget;
              window.requestAnimationFrame(() => resume(toast, box));
            }}
          >
            <div className="co-toast-text">
              <strong>{toast.title}</strong>
              {toast.message.split("\n").map((line, index) => (
                <span key={index} className="co-toast-line">
                  {line}
                </span>
              ))}
            </div>
            <div className="co-toast-actions">
              {toast.action ? (
                <button
                  type="button"
                  className="co-btn is-quiet"
                  onClick={() => {
                    dismiss(toast.id);
                    toast.action?.run();
                  }}
                >
                  {toast.action.undo ? <Undo2 size={13} /> : <RefreshCw size={13} />}
                  {toast.action.label}
                </button>
              ) : null}
              {toast.tone !== "done" ? (
                <button
                  type="button"
                  className="co-icon-btn"
                  aria-label="Copy the error"
                  title="Copy the error"
                  onClick={() =>
                    void copyText(`${toast.title}. ${toast.message}`).catch(() => undefined)
                  }
                >
                  <Copy size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="co-icon-btn"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

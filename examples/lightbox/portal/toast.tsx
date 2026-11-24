import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "info" | "danger";
  readonly retry?: () => void;
}

type Show = (message: string, options?: { tone?: Toast["tone"]; retry?: () => void }) => void;

const ToastContext = createContext<Show>(() => undefined);

export function useToast(): Show {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback<Show>(
    (message, options) => {
      const id = next.current++;
      setToasts((current) => [...current.slice(-2), { id, message, tone: options?.tone ?? "info", retry: options?.retry }]);
      setTimeout(() => dismiss(id), options?.tone === "danger" ? 9000 : 4000);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="lb-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`lb-toast lb-toast-${toast.tone}`}>
            <span>{toast.message}</span>
            {toast.retry ? (
              <button
                type="button"
                className="lb-toast-action"
                onClick={() => {
                  dismiss(toast.id);
                  toast.retry?.();
                }}
              >
                Try again
              </button>
            ) : null}
            <button type="button" className="lb-toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

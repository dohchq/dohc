import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CloseGlyph } from "./glyphs";

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "info" | "danger";
  readonly action?: { readonly label: string; run(): void };
}

type Show = (
  message: string,
  options?: { tone?: Toast["tone"]; retry?: () => void; undo?: () => void },
) => () => void;

const ToastContext = createContext<Show>(() => () => undefined);
const StackContext = createContext<{
  toasts: readonly Toast[];
  dismiss(id: number): void;
  claim(): () => void;
}>({
  toasts: [],
  dismiss: () => undefined,
  claim: () => () => undefined,
});

export function useToast(): Show {
  return useContext(ToastContext);
}

export function ToastStack() {
  const { toasts, dismiss, claim } = useContext(StackContext);
  useEffect(claim, [claim]);
  return (
    <div className="lb-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`lb-toast lb-toast-${toast.tone}`}>
          <span>{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className="lb-toast-action"
              onClick={() => {
                dismiss(toast.id);
                toast.action?.run();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="lb-toast-close"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismiss(toast.id)}
          >
            <CloseGlyph size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );
  const show = useCallback<Show>(
    (message, options) => {
      const id = next.current++;
      const action = options?.retry
        ? { label: "Try again", run: options.retry }
        : options?.undo
          ? { label: "Undo", run: options.undo }
          : undefined;
      setToasts((current) => [
        ...current.slice(-2),
        { id, message, tone: options?.tone ?? "info", action },
      ]);
      setTimeout(() => dismiss(id), options?.tone === "danger" ? 9000 : action ? 7000 : 4000);
      return () => dismiss(id);
    },
    [dismiss],
  );
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((count) => count + 1);
    return () => setClaims((count) => count - 1);
  }, []);
  const stack = useMemo(() => ({ toasts, dismiss, claim }), [toasts, dismiss, claim]);
  return (
    <ToastContext.Provider value={show}>
      <StackContext.Provider value={stack}>
        {children}
        {claims ? null : <Inline toasts={toasts} dismiss={dismiss} />}
      </StackContext.Provider>
    </ToastContext.Provider>
  );
}

function Inline({ toasts, dismiss }: { toasts: readonly Toast[]; dismiss(id: number): void }) {
  return (
    <StackContext.Provider value={{ toasts, dismiss, claim: noClaim }}>
      <ToastStack />
    </StackContext.Provider>
  );
}

const noClaim = () => () => undefined;

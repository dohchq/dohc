import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { mutationKey, useApp } from "dohc/app";
import { Check, CircleX, Plus, RotateCcw, TriangleAlert } from "dohc/icons";
import { CopyButton, cx, problem, type AccountType } from "./shared";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  role: string | null;
  isBank: boolean;
  archived: boolean;
  balanceCents: number;
}
export interface Overview {
  today: string;
  fiscalStartMonth: number;
  currency: string;
  currencies: string[];
  accounts: Account[];
  cash: Account[];
  cashCents: number;
  receivables: { open: number; openCents: number; overdue: number; overdueCents: number };
  newBankRows: number;
  duplicateBankRows: number;
  draftInvoices: number;
  missingReceipts: number;
  recent: Array<{
    id: string;
    number: number;
    date: string;
    currency: string;
    memo: string;
    totalCents: number;
    source: string;
    reversal: boolean;
    reversed: boolean;
  }>;
  periods: {
    total: number;
    current: { id: string; startDate: string; endDate: string; status: "open" | "locked" } | null;
    unlocked: number;
    nextToLock: string | null;
    lockedThrough: string | null;
  };
  yearToDate: {
    incomeCents: number;
    expenseCents: number;
    netIncomeCents: number;
    months: Array<{ month: string; incomeCents: number; expenseCents: number }>;
  };
  hasPeriods: boolean;
}

export type View =
  | "overview"
  | "register"
  | "bank"
  | "invoices"
  | "accounts"
  | "reports"
  | "periods";
export interface Route {
  view: View;
  account?: string;
  show?: string;
  entry?: string;
  invoice?: string;
  q?: string;
}

interface BooksValue {
  overview: Overview | undefined;
  accounts: Account[];
  currency: string;
  route: Route;
  go: (route: Route) => void;
  compose: () => void;
}
export const BooksContext = createContext<BooksValue | null>(null);
export function useBooksContext() {
  const value = useContext(BooksContext);
  if (!value) throw new Error("Books context is missing.");
  return value;
}

export interface Toast {
  id: number;
  message: string;
  tone?: "done" | "error";
  detail?: string;
  action?: { label: string; run: () => void };
  undo?: () => void;
}
const ToastContext = createContext<(toast: Omit<Toast, "id">) => void>(() => {});
const ClearToastsContext = createContext<() => void>(() => {});
export const useToast = () => useContext(ToastContext);
export const useClearToasts = () => useContext(ClearToastsContext);

export function Toasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback(
    (id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)),
    [],
  );
  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = next.current++;
    setToasts((list) => [
      ...list.filter((item) => item.tone === "error").slice(-2),
      { ...toast, id },
    ]);
  }, []);
  const clear = useCallback(
    () =>
      setToasts((list) => {
        const kept = list.filter((toast) => toast.tone === "error");
        return kept.length === list.length ? list : kept;
      }),
    [],
  );
  return (
    <ToastContext.Provider value={push}>
      <ClearToastsContext.Provider value={clear}>
        {children}
        <div className="b-toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <ToastRow key={toast.id} toast={toast} dismiss={dismiss} />
          ))}
        </div>
      </ClearToastsContext.Provider>
    </ToastContext.Provider>
  );
}
function ToastRow({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const onDismiss = () => dismiss(toast.id);
  useEffect(() => {
    if (held || toast.tone === "error") return;
    const timer = setTimeout(() => dismiss(toast.id), toast.action || toast.undo ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [held, toast, dismiss]);
  return (
    <div
      className={cx("b-toast", toast.tone === "error" && "is-error")}
      role={toast.tone === "error" ? "alert" : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setFocused(false)}
    >
      {toast.tone === "error" ? (
        <TriangleAlert size={15} aria-hidden />
      ) : (
        <Check size={15} aria-hidden />
      )}
      <div className="b-toast-text">
        <span>{toast.message}</span>
        {toast.detail ? <span className="b-toast-detail">{toast.detail}</span> : null}
      </div>
      {toast.undo ? (
        <button
          type="button"
          className="b-toast-action"
          onClick={() => {
            onDismiss();
            toast.undo!();
          }}
        >
          Undo
        </button>
      ) : null}
      {toast.action ? (
        <button
          type="button"
          className="b-toast-action"
          onClick={() => {
            onDismiss();
            toast.action!.run();
          }}
        >
          {toast.tone === "error" ? <RotateCcw size={13} aria-hidden /> : null}
          {toast.action.label}
        </button>
      ) : null}
      {toast.tone === "error" ? (
        <CopyButton
          className="b-toast-action"
          size={13}
          text={`${toast.message} ${toast.detail ?? ""}`.trim()}
        />
      ) : null}
      <button type="button" className="b-icon-btn" aria-label="Dismiss" onClick={onDismiss}>
        <CircleX size={15} aria-hidden />
      </button>
    </div>
  );
}

export function useMutate() {
  const app = useApp();
  return useCallback(
    async <T,>(operation: string, input: unknown, key = mutationKey(operation)) =>
      (await app.invoke<T>(operation, input, key)).result,
    [app],
  );
}

export function useAction() {
  const mutate = useMutate();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(
    async function run<T>(
      operation: string,
      input: unknown,
      options: { done?: string; failed?: string; after?: (result: T) => void } = {},
    ): Promise<T | undefined> {
      setPending(operation);
      try {
        const result = await mutate<T>(operation, input);
        if (options.done) toast({ message: options.done });
        options.after?.(result);
        return result;
      } catch (error) {
        toast({
          tone: "error",
          message: options.failed ?? "That didn't go through.",
          detail: problem(error),
          action: { label: "Try again", run: () => void run(operation, input, options) },
        });
        return undefined;
      } finally {
        setPending(null);
      }
    },
    [mutate, toast],
  );
  return { run, pending };
}

export function Topbar({
  title,
  meta,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  const { compose } = useBooksContext();
  return (
    <header className="b-top">
      <div className="b-top-title">
        <h1>{title}</h1>
        {meta ? <span className="b-top-meta">{meta}</span> : null}
      </div>
      <div className="b-top-actions">
        {children}
        <button
          type="button"
          className="b-icon-btn b-top-compose"
          aria-label="New journal entry"
          onClick={compose}
        >
          <Plus size={18} aria-hidden />
        </button>
      </div>
    </header>
  );
}

export const MOD =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘"
    : "Ctrl";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="b-kbd">{children}</kbd>;
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="b-empty">
      {icon ? <div className="b-empty-icon">{icon}</div> : null}
      <p className="b-empty-title">{title}</p>
      {children ? <p className="b-empty-text">{children}</p> : null}
      {action}
    </div>
  );
}

export function typing(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
function activates(event: globalThis.KeyboardEvent) {
  return (
    (event.key === "Enter" || event.key === " ") &&
    event.target instanceof HTMLElement &&
    Boolean(event.target.closest("button, a[href], summary, [role=button], [role=tab]"))
  );
}
export function modalOpen() {
  return Boolean(document.querySelector(".kit-modal"));
}

export function useKeys(
  handler: (event: globalThis.KeyboardEvent) => void,
  active = true,
  capture = false,
) {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!active) return;
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target) || modalOpen() || activates(event)) return;
      ref.current(event);
    };
    window.addEventListener("keydown", listener, capture);
    return () => window.removeEventListener("keydown", listener, capture);
  }, [active, capture]);
}

interface PickerProps {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  placeholder?: string;
  filter?: (account: Account) => boolean;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  hint?: string;
  className?: string;
}

export function AccountPicker({
  accounts,
  value,
  onChange,
  label,
  placeholder = "Account",
  filter,
  inputRef,
  onKeyDown,
  autoFocus,
  hint,
  className,
}: PickerProps) {
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const own = useRef<HTMLInputElement | null>(null);
  const selected = accounts.find((account) => account.id === value);
  const matches = useMemo(() => {
    const usable = accounts.filter((account) => !account.archived && (!filter || filter(account)));
    const needle = (query ?? "").trim().toLowerCase();
    if (!needle) return usable;
    return usable
      .filter(
        (account) =>
          account.id.toLowerCase().startsWith(needle) ||
          account.name.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          Number(b.id.toLowerCase().startsWith(needle)) -
          Number(a.id.toLowerCase().startsWith(needle)),
      );
  }, [accounts, filter, query]);
  const options = matches.slice(0, 60);
  useEffect(() => {
    if (open && options[active])
      document
        .getElementById(`${listId}-${options[active]!.id}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, options, listId]);
  const show = () => {
    if (own.current) setRect(own.current.getBoundingClientRect());
    setOpen(true);
  };
  const choose = (account: Account | undefined) => {
    if (account) onChange(account.id);
    else if (query !== null && !query.trim()) onChange("");
    setQuery(null);
    setOpen(false);
  };
  const width = rect ? Math.max(rect.width, 280) : 0;
  const below = rect ? window.innerHeight - rect.bottom - 8 : 0;
  const place = rect
    ? {
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width: Math.min(width, window.innerWidth - 16),
        ...(below < 200 && rect.top > below
          ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.min(280, rect.top - 12) }
          : { top: rect.bottom + 4, maxHeight: Math.min(280, below) }),
      }
    : undefined;
  return (
    <div className={cx("b-picker", className)}>
      <input
        ref={(node) => {
          own.current = node;
          if (typeof inputRef === "function") inputRef(node);
          else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = node;
        }}
        className="b-input"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && options[active] ? `${listId}-${options[active]!.id}` : undefined
        }
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={query ?? (selected ? `${selected.id} ${selected.name}` : "")}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => choose(undefined)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          show();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) show();
            else setActive((index) => Math.min(options.length - 1, index + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            event.stopPropagation();
            choose(query !== null && !query.trim() ? undefined : options[active]);
          } else if (event.key === "Tab" && open && query?.trim()) {
            choose(options[active]);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setQuery(null);
          }
          onKeyDown?.(event);
        }}
      />
      {hint && !open ? <span className="b-picker-hint">{hint}</span> : null}
      {open && rect ? (
        <ul id={listId} role="listbox" aria-label={label} className="b-picker-list" style={place}>
          {options.length ? (
            options.map((account, index) => (
              <li
                key={account.id}
                id={`${listId}-${account.id}`}
                role="option"
                aria-selected={index === active}
                className={cx("b-picker-option", index === active && "is-active")}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(account);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="b-code">{account.id}</span>
                <span className="b-picker-name">{account.name}</span>
                <span className="b-picker-type">{account.type}</span>
              </li>
            ))
          ) : (
            <li className="b-picker-none">No account matches “{query}”</li>
          )}
          {matches.length > options.length ? (
            <li className="b-picker-none" role="presentation">
              Type to narrow {matches.length - options.length} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export function useInitialFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return ref;
}

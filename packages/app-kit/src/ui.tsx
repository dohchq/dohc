import "./tokens.css";
import "./ui.css";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export type Tone = "neutral" | "success" | "warning" | "danger";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export interface AppShellProps {
  readonly width?: "narrow" | "default" | "wide";
  readonly className?: string;
  readonly children: ReactNode;
}

export function AppShell({ width = "default", className, children }: AppShellProps) {
  return (
    <main
      className={cx(
        "kit-shell",
        width === "narrow" && "kit-shell-narrow",
        width === "wide" && "kit-shell-wide",
        className,
      )}
    >
      {children}
    </main>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly eyebrow?: string;
  readonly actions?: ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow, actions }: PageHeaderProps) {
  return (
    <header className="kit-header">
      <div>
        {eyebrow ? <p className="kit-eyebrow">{eyebrow}</p> : null}
        <h1 className="kit-title">{title}</h1>
        {subtitle ? <p className="kit-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="kit-actions">{actions}</div> : null}
    </header>
  );
}

export interface GridProps {
  readonly cols?: 1 | 2 | 3 | 4 | "auto";
  readonly gap?: number;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Grid({ cols = "auto", gap, className, children }: GridProps) {
  const style: CSSProperties | undefined = gap === undefined ? undefined : { gap };
  return (
    <div className={cx("kit-grid", `kit-grid-${cols}`, className)} style={style}>
      {children}
    </div>
  );
}

export interface StackProps {
  readonly direction?: "vertical" | "horizontal";
  readonly gap?: number;
  readonly align?: CSSProperties["alignItems"];
  readonly justify?: CSSProperties["justifyContent"];
  readonly wrap?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Stack({
  direction = "vertical",
  gap = 12,
  align,
  justify,
  wrap,
  className,
  children,
}: StackProps) {
  return (
    <div
      className={cx("kit-stack", className)}
      style={{
        flexDirection: direction === "horizontal" ? "row" : "column",
        gap,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? "wrap" : undefined,
      }}
    >
      {children}
    </div>
  );
}

export interface CardProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Card({ title, subtitle, action, className, children }: CardProps) {
  return (
    <section className={cx("kit-card", className)}>
      {title || subtitle || action ? (
        <div className="kit-card-head">
          <div>
            {title ? <h2 className="kit-card-title">{title}</h2> : null}
            {subtitle ? <p className="kit-card-subtitle">{subtitle}</p> : null}
          </div>
          {action ? <div className="kit-actions">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface BadgeProps {
  readonly tone?: Tone;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Badge({ tone = "neutral", className, children }: BadgeProps) {
  return (
    <span className={cx("kit-badge", tone !== "neutral" && `kit-tone-${tone}`, className)}>
      {children}
    </span>
  );
}

export interface StatCardProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly delta?: string;
  readonly tone?: Tone;
  readonly hint?: string;
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function StatCard({
  label,
  value,
  delta,
  tone = "neutral",
  hint,
  footer,
  className,
}: StatCardProps) {
  return (
    <div className={cx("kit-card", "kit-stat", className)}>
      <span className="kit-stat-label">{label}</span>
      <div className="kit-stat-row">
        <span className="kit-stat-value">{value}</span>
        {delta ? <Badge tone={tone}>{delta}</Badge> : null}
      </div>
      {hint ? <span className="kit-stat-hint">{hint}</span> : null}
      {footer ? <div>{footer}</div> : null}
    </div>
  );
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly content?: ReactNode;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly label?: string;
}

export function Tabs({ items, value, onChange, label = "Sections" }: TabsProps) {
  const baseId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = items.find((item) => item.id === value) ?? items[0];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = items[next];
    if (!target) return;
    onChange(target.id);
    refs.current[next]?.focus();
  };

  return (
    <Stack gap={14}>
      <div className="kit-tabs-list" role="tablist" aria-label={label}>
        {items.map((item, index) => {
          const selected = item.id === active?.id;
          return (
            <button
              key={item.id}
              ref={(node) => {
                refs.current[index] = node;
              }}
              id={`${baseId}-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={item.content !== undefined ? `${baseId}-panel-${item.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              className="kit-tab"
              onClick={() => onChange(item.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {active?.content !== undefined ? (
        <div
          id={`${baseId}-panel-${active.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${active.id}`}
        >
          {active.content}
        </div>
      ) : null}
    </Stack>
  );
}

export interface ProgressBarProps {
  readonly value: number;
  readonly max?: number;
  readonly target?: number;
  readonly label?: string;
  readonly valueLabel?: string;
  readonly tone?: Tone;
}

export function ProgressBar({
  value,
  max = 100,
  target,
  label,
  valueLabel,
  tone,
}: ProgressBarProps) {
  const safeMax = max > 0 ? max : 1;
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100));
  const resolvedTone: Tone = tone ?? (value > safeMax ? "danger" : "neutral");
  const targetPct =
    target !== undefined && safeMax > 0
      ? Math.max(0, Math.min(100, (target / safeMax) * 100))
      : null;

  return (
    <div className="kit-progress">
      {label || valueLabel ? (
        <div className="kit-progress-head">
          <span>{label}</span>
          {valueLabel ? <span className="kit-progress-value">{valueLabel}</span> : null}
        </div>
      ) : null}
      <div
        className="kit-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={safeMax}
      >
        <div
          className={cx(
            "kit-progress-fill",
            resolvedTone !== "neutral" && `kit-progress-fill-${resolvedTone}`,
          )}
          style={{ width: `${pct}%` }}
        />
        {targetPct !== null ? (
          <div className="kit-progress-target" style={{ left: `${targetPct}%` }} />
        ) : null}
      </div>
    </div>
  );
}

export interface CalloutProps {
  readonly tone?: Tone;
  readonly title?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

export function Callout({ tone = "neutral", title, action, children }: CalloutProps) {
  return (
    <div
      className={cx("kit-callout", tone !== "neutral" && `kit-tone-${tone}`)}
      role={tone === "danger" ? "alert" : "status"}
    >
      <div>
        {title ? <p className="kit-callout-title">{title}</p> : null}
        <div className="kit-callout-body">{children}</div>
      </div>
      {action ? <div className="kit-actions">{action}</div> : null}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="kit-empty">
      <p className="kit-empty-title">{title}</p>
      {description ? <p className="kit-empty-body">{description}</p> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export interface SkeletonProps {
  readonly height?: number;
  readonly width?: string | number;
}

export function Skeleton({ height = 16, width = "100%" }: SkeletonProps) {
  return <span className="kit-skeleton" aria-hidden="true" style={{ height, width }} />;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "primary" | "secondary" | "ghost" | "danger";
  readonly size?: "sm" | "md";
  readonly loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx("kit-btn", `kit-btn-${variant}`, size === "sm" && "kit-btn-sm", className)}
    >
      {children}
    </button>
  );
}

export interface FieldProps {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  const messageId = useId();
  return (
    <div className="kit-field">
      <label className="kit-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span id={messageId} className="kit-field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={messageId} className="kit-field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("kit-input", className)} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx("kit-select", className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("kit-textarea", className)} />;
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly label: string;
}

export function Checkbox({ label, className, id, ...props }: CheckboxProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <label className={cx("kit-checkbox-row", className)} htmlFor={fieldId}>
      <input {...props} id={fieldId} type="checkbox" className="kit-checkbox" />
      <span>{label}</span>
    </label>
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisibleFocusable(element: HTMLElement): boolean {
  if (element.tabIndex < 0) return false;
  if (element.matches(":disabled")) return false;
  if (element.closest("[hidden],[inert]")) return false;
  if (getComputedStyle(element).visibility === "hidden") return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.style.display === "none" ||
      getComputedStyle(current).display === "none"
    ) {
      return false;
    }
  }
  return true;
}

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function Modal({ open, title, onClose, footer, children }: ModalProps) {
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const previousFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        isVisibleFocusable,
      );
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === dialog || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!dialog) return;
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
          isVisibleFocusable,
        );
        (focusables[0] ?? dialog).focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="kit-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className="kit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="kit-modal-head">
          <h2 id={titleId} className="kit-modal-title">
            {title}
          </h2>
          <Button variant="ghost" size="sm" onClick={() => onCloseRef.current()} aria-label="Close">
            Close
          </Button>
        </div>
        {children}
        {footer ? <div className="kit-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface DataTableColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly align?: "left" | "right";
  readonly render?: (row: T) => ReactNode;
  readonly sortValue?: (row: T) => string | number | null | undefined;
}

export interface DataTableProps<T> {
  readonly rows: readonly T[];
  readonly columns: readonly DataTableColumn<T>[];
  readonly rowKey: (row: T, index: number) => string;
  readonly loading?: boolean;
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly searchText?: (row: T) => string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading = false,
  searchable = false,
  searchPlaceholder = "Filter rows",
  searchText,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  onRowClick,
}: DataTableProps<T>) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" } | null>(null);

  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const filtered = !trimmed
      ? [...rows]
      : rows.filter((row) => {
          const text = searchText
            ? searchText(row)
            : columns
                .map((column) => {
                  const value = column.sortValue
                    ? column.sortValue(row)
                    : (row as Record<string, unknown>)[column.key];
                  return value === null || value === undefined ? "" : String(value);
                })
                .join(" ");
          return text.toLowerCase().includes(trimmed);
        });
    if (!sort) return filtered;
    const column = columns.find((item) => item.key === sort.key);
    if (!column) return filtered;
    const read = (row: T) =>
      column.sortValue ? column.sortValue(row) : (row as Record<string, unknown>)[column.key];
    return filtered.sort((a, b) => {
      const av = read(a);
      const bv = read(b);
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.direction === "asc" ? cmp : -cmp;
    });
  }, [columns, rows, searchText, sort, trimmed]);

  const toggleSort = (key: string) => {
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  };

  return (
    <div>
      {searchable ? (
        <div className="kit-table-tools">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="kit-table-search"
          />
        </div>
      ) : null}
      {loading ? (
        <Stack gap={8}>
          <Skeleton height={32} />
          <Skeleton height={32} />
          <Skeleton height={32} />
        </Stack>
      ) : visible.length === 0 ? (
        <EmptyState
          title={trimmed && rows.length > 0 ? "No matching rows" : emptyTitle}
          description={trimmed && rows.length > 0 ? "Try a different filter." : emptyDescription}
        />
      ) : (
        <div className="kit-table-wrap">
          <table className="kit-table">
            <thead>
              <tr>
                {columns.map((column) => {
                  const active = sort?.key === column.key ? sort.direction : null;
                  const sortable = Boolean(column.sortValue);
                  return (
                    <th
                      key={column.key}
                      className={column.align === "right" ? "kit-table-right" : undefined}
                      aria-sort={
                        active === "asc" ? "ascending" : active === "desc" ? "descending" : "none"
                      }
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className="kit-table-sort"
                          onClick={() => toggleSort(column.key)}
                        >
                          <span>{column.header}</span>
                          <span aria-hidden="true">
                            {active === "asc" ? "↑" : active === "desc" ? "↓" : "↕"}
                          </span>
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <tr
                  key={rowKey(row, index)}
                  className={onRowClick ? "kit-table-row-clickable" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={column.align === "right" ? "kit-table-right" : undefined}
                    >
                      {column.render
                        ? column.render(row)
                        : String((row as Record<string, unknown>)[column.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function formatCurrency(amount: number, currency = "USD", locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
  }).format(amount);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(undefined, options).format(value);
}

export function formatPercent(ratio: number, digits = 0): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(ratio);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDate(
  value: string | number | Date,
  style: "short" | "medium" | "long" = "medium",
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: style }).format(date);
}

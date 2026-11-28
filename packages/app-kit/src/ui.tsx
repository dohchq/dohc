import "./tokens.css";
import "./ui.css";
import {
  Fragment,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const GLYPHS = {
  x: "M18 6 6 18M6 6l12 12",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-3.5-3.5",
  sort: "m8 9 4-4 4 4m-8 6 4 4 4-4",
  asc: "m7 14 5-5 5 5",
  desc: "m7 10 5 5 5-5",
  success: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3 9 2 2 4-4",
  warning:
    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01",
  danger: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v4m0 4h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 13v-4m0-4h.01",
} as const;

function Glyph({ name, size = 16 }: { name: keyof typeof GLYPHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPHS[name]} />
    </svg>
  );
}

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
  readonly dot?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Badge({ tone = "neutral", dot = false, className, children }: BadgeProps) {
  return (
    <span className={cx("kit-badge", tone !== "neutral" && `kit-tone-${tone}`, className)}>
      {dot ? <span className="kit-badge-dot" aria-hidden="true" /> : null}
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
      {items.map((item) =>
        item.content !== undefined ? (
          <div
            key={item.id}
            id={`${baseId}-panel-${item.id}`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${item.id}`}
            hidden={item.id !== active?.id}
          >
            {item.content}
          </div>
        ) : null,
      )}
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
  const numericValue = Number.isFinite(value) ? value : 0;
  const clampedValue = Math.max(0, Math.min(safeMax, numericValue));
  const pct = (clampedValue / safeMax) * 100;
  const resolvedTone: Tone = tone ?? (numericValue > safeMax ? "danger" : "neutral");
  const targetPct =
    target !== undefined && safeMax > 0
      ? Math.max(0, Math.min(100, (target / safeMax) * 100))
      : null;
  const ariaValueText =
    numericValue > safeMax || numericValue < 0
      ? (valueLabel ?? `${numericValue} of ${safeMax}`)
      : undefined;

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
        aria-valuenow={clampedValue}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuetext={ariaValueText}
      >
        <div
          className={cx(
            "kit-progress-fill",
            resolvedTone !== "neutral" && `kit-progress-fill-${resolvedTone}`,
          )}
          style={{ width: `${pct}%` }}
        />
        {targetPct !== null ? (
          <div
            className="kit-progress-target"
            style={{ "--kit-target-pct": `${targetPct}%` } as CSSProperties}
          />
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
      <div className="kit-callout-main">
        <Glyph name={tone === "neutral" ? "info" : tone} />
        <div>
          {title ? <p className="kit-callout-title">{title}</p> : null}
          <div className="kit-callout-body">{children}</div>
        </div>
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

export interface ButtonProps extends ComponentProps<"button"> {
  readonly variant?: "primary" | "secondary" | "ghost" | "danger";
  readonly size?: "sm" | "md";
  readonly loading?: boolean;
  readonly iconOnly?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  iconOnly = false,
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
      className={cx(
        "kit-btn",
        `kit-btn-${variant}`,
        size === "sm" && "kit-btn-sm",
        iconOnly && "kit-btn-icon",
        className,
      )}
    >
      {loading ? <span className="kit-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export interface FieldProps {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly children: ReactNode;
}

const NON_CONTROL_TAGS = new Set(["div", "span", "section", "fieldset", "p", "ul", "ol"]);

export function Field({ label, htmlFor, hint, error, required = false, children }: FieldProps) {
  const messageId = useId();
  let enhancedChildren = children;
  if (
    isValidElement<{
      "aria-describedby"?: string;
      "aria-invalid"?: boolean | "true" | "false";
      "aria-required"?: boolean | "true" | "false";
      required?: boolean;
    }>(children) &&
    children.type !== Fragment
  ) {
    const isControl =
      !(typeof children.type === "string" && NON_CONTROL_TAGS.has(children.type)) &&
      children.type !== Stack &&
      children.type !== Grid;
    const next: Record<string, unknown> = {};
    if (error || hint) {
      const ids = children.props["aria-describedby"]?.split(/\s+/).filter(Boolean) ?? [];
      next["aria-describedby"] = Array.from(new Set([...ids, messageId])).join(" ");
    }
    if (isControl && error && children.props["aria-invalid"] === undefined) {
      next["aria-invalid"] = true;
    }
    if (isControl && required && !children.props.required && !children.props["aria-required"]) {
      next["aria-required"] = true;
    }
    if (Object.keys(next).length > 0) enhancedChildren = cloneElement(children, next);
  }

  return (
    <div className="kit-field">
      <label className={cx("kit-field-label", required && "kit-field-required")} htmlFor={htmlFor}>
        {label}
      </label>
      {enhancedChildren}
      {error ? (
        <span id={messageId} className="kit-field-error" role="alert">
          <Glyph name="danger" size={13} />
          <span>{error}</span>
        </span>
      ) : hint ? (
        <span id={messageId} className="kit-field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cx("kit-input", className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={cx("kit-select", className)} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={cx("kit-textarea", className)} />;
}

export interface DateFieldProps extends Omit<
  ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max"
> {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly min?: string;
  readonly max?: string;
}

function dateProblem(text: string, min?: string, max?: string): string | null {
  if (text === "") return null;
  if (!parseIsoDate(text)) return "Enter a date as YYYY-MM-DD";
  if ((!min || text >= min) && (!max || text <= max)) return null;
  if (min && max) return `Enter a date from ${min} to ${max}`;
  return min ? `Enter a date on or after ${min}` : `Enter a date on or before ${max}`;
}

function stepDate(text: string, days: number, min?: string, max?: string): string {
  const now = new Date();
  const date =
    parseIsoDate(text) ?? utcDate(now.getFullYear(), now.getMonth() + 1, now.getDate() - days);
  date.setUTCDate(date.getUTCDate() + days);
  const next = toIsoDate(date);
  return max && next > max ? max : min && next < min ? min : next;
}

export function DateField({
  value,
  onChange,
  min,
  max,
  ref,
  className,
  onBlur,
  onKeyDown,
  ...props
}: DateFieldProps) {
  const field = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => field.current!, []);
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [sent, setSent] = useState(value);
  const [checked, setChecked] = useState(false);
  if (value !== seen) {
    setSeen(value);
    if (value !== sent) setText(value);
    setSent(value);
  }
  const problem = dateProblem(text, min, max);
  useLayoutEffect(() => field.current?.setCustomValidity(problem ?? ""), [problem]);

  const commit = (next: string) => {
    setText(next);
    const date = next && !dateProblem(next, min, max) ? next : "";
    setSent(date);
    if (date !== value) onChange(date);
  };

  return (
    <input
      placeholder="YYYY-MM-DD"
      autoComplete="off"
      spellCheck={false}
      {...props}
      ref={field}
      type="text"
      value={text}
      aria-invalid={checked && problem ? true : props["aria-invalid"]}
      className={cx("kit-input", "kit-date-field", className)}
      onChange={(event) => {
        setChecked(false);
        commit(event.target.value);
      }}
      onBlur={(event) => {
        setChecked(true);
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || props.readOnly) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        commit(stepDate(text, event.key === "ArrowUp" ? 1 : -1, min, max));
      }}
    />
  );
}

export interface CheckboxProps extends Omit<ComponentProps<"input">, "type"> {
  readonly label: string;
  readonly description?: string;
}

export function Checkbox({ label, description, className, id, ...props }: CheckboxProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const labelId = description ? `${fieldId}-label` : undefined;
  const descId = description ? `${fieldId}-desc` : undefined;
  const describedBy = descId
    ? [props["aria-describedby"], descId].filter(Boolean).join(" ")
    : props["aria-describedby"];
  return (
    <label className={cx("kit-checkbox-row", className)} htmlFor={fieldId}>
      <input
        {...props}
        id={fieldId}
        type="checkbox"
        aria-labelledby={props["aria-labelledby"] ?? labelId}
        aria-describedby={describedBy}
        className="kit-checkbox"
      />
      <span className="kit-control-copy">
        <span id={labelId}>{label}</span>
        {description ? (
          <span id={descId} className="kit-control-desc">
            {description}
          </span>
        ) : null}
      </span>
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
  readonly description?: string;
  readonly size?: "sm" | "md" | "lg";
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

const openModalStack: Element[] = [];

export function Modal({
  open,
  title,
  description,
  size = "md",
  onClose,
  footer,
  children,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  const previousFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    openModalStack.push(dialog);
    const isTopModal = () => openModalStack[openModalStack.length - 1] === dialog;
    if (!dialog.contains(document.activeElement)) dialog.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isTopModal()) return;
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
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
      if (!isTopModal()) return;
      const owner = event.target instanceof Element ? event.target.closest(".kit-modal") : null;
      if (owner === dialog || (owner && !openModalStack.includes(owner))) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        isVisibleFocusable,
      );
      (focusables[0] ?? dialog).focus();
    };

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const wasTop = isTopModal();
      const index = openModalStack.lastIndexOf(dialog);
      if (index >= 0) openModalStack.splice(index, 1);
      if (wasTop && !dialog.isConnected && previousFocus.current?.isConnected) {
        previousFocus.current.focus();
      }
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
        className={cx("kit-modal", size !== "md" && `kit-modal-${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="kit-modal-head">
          <div>
            <h2 id={titleId} className="kit-modal-title">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="kit-modal-desc">
                {description}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onCloseRef.current()}
            aria-label="Close"
            title="Close"
          >
            <Glyph name="x" size={15} />
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

const INTERACTIVE_CELL_SELECTOR =
  'a, button, input, label, select, textarea, summary, [role="button"], [role="link"]';

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
          <div className="kit-table-search-wrap">
            <Glyph name="search" size={14} />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="kit-table-search"
            />
          </div>
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
                          <Glyph name={active ?? "sort"} size={13} />
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
                  onClick={
                    onRowClick
                      ? (event) => {
                          const interactive =
                            event.target instanceof Element
                              ? event.target.closest(INTERACTIVE_CELL_SELECTOR)
                              : null;
                          if (interactive && event.currentTarget.contains(interactive)) return;
                          onRowClick(row);
                        }
                      : undefined
                  }
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

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function toIsoDate(date: Date): string {
  const pad = (part: number, length: number) => String(part).padStart(length, "0");
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

function parseIsoDate(value: string): Date | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const date = utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
  return toIsoDate(date) === value ? date : null;
}

export function formatDate(
  value: string | number | Date,
  style: "short" | "medium" | "long" = "medium",
): string {
  if (typeof value === "string" && DATE_ONLY_PATTERN.test(value)) {
    const day = parseIsoDate(value);
    return day
      ? new Intl.DateTimeFormat(undefined, { dateStyle: style, timeZone: "UTC" }).format(day)
      : value;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: style }).format(date);
}
